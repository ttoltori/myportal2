import { parseHTML } from "linkedom";
import { applySpec, stripNoise, type CrawlSpec, type ExtractedRow, type FieldSelector } from "../extract";
import type { PageReadResult } from "./llm-read";

// 합성한 스펙이 맞는지 LLM이 보고한 값과 대조한다. 정답지가 그 페이지에서 나오므로
// "어떤 DOM이 목록처럼 보이는가"를 코드가 맞히려 들지 않는다 (설계서 §5-5).
// 순수 함수이며 외부 호출이 없다. 어떤 입력에서도 예외를 던지지 않는다 —
// 이 모듈이 던지면 분석 전체가 죽기 때문에 깨진 스펙은 ok=false로 환원한다.

export interface VerifyScore {
  // applySpec 결과 행 수
  itemCount: number;
  // itemSelector가 매칭한 요소 수 (상한 100)
  matchedCount: number;
  // LLM이 보고한 항목 수
  reportedCount: number;
  // 매칭된 요소 중 실제로 행이 된 비율. applyDomSpec은 제목을 못 찾은 요소를 건너뛰므로,
  // 셀렉터가 메뉴까지 과포함하면 이 값이 떨어진다. 제목 일치율만으로는 과포함을 못 잡는다 —
  // 보고한 12개 제목이 500행 안에 전부 있으면 일치율은 100%이기 때문이다.
  rowYield: number;
  // 보고한 제목이 추출 결과에 있는 비율
  titleMatchRate: number;
  fieldRates: Record<string, { fill: number; match: number }>;
  ok: boolean;
}

// ── 임계치 (설계서 §5-5) ──

// 이보다 적은 행으로는 "목록"이라 부를 수 없다.
const MIN_ROWS = 3;
// LLM은 항목을 최대 12건만 보고하지만 실제 목록은 50건일 수 있다.
// 기준을 보고 수에 비례시키면 정상 목록의 기대치만 부풀므로 10건에서 끊는다.
const ROW_TARGET_CAP = 10;
const MIN_ROW_RATIO = 0.7;
const MIN_ROW_YIELD = 0.6;
const MIN_TITLE_MATCH_RATE = 0.8;
const MIN_FIELD_FILL = 0.3;
const MIN_FIELD_MATCH = 0.5;

// applyDomSpec이 항목을 자르는 개수. 그쪽 상수가 export되지 않아 값을 맞춰 둔다.
// 어긋나면 rowYield의 분모가 달라져 판정이 틀린다.
const MAX_APPLIED_ITEMS = 100;

// 0.6 같은 임계치를 부동소수점 나눗셈 결과와 비교할 때 경계값이 틀어지지 않게 한다.
const RATE_EPSILON = 1e-9;

// 값을 직접 비교할 수 없는 필드(href·src 등 속성값)의 일치율.
// 눈에 보이는 텍스트와 속성값은 원래 다르므로 "틀렸다"는 증거가 아니다. 채움률만으로 판정한다.
const UNVERIFIABLE_MATCH = 1;

type ReadItem = PageReadResult["items"][number];

const BROKEN_FIELD_RATE = { fill: 0, match: 0 };

function atLeast(value: number, threshold: number): boolean {
  return value >= threshold - RATE_EPSILON;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

// 공백을 접고 소문자로 맞춘다. selector-synthesis의 normalizeText와 같은 방식이다.
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// 비교 방향은 추출된 값 ⊇ LLM 텍스트 단방향이다. selector-synthesis의 textMatches와 같다.
// 반대 방향까지 허용하면 한 칸 밀린 짧은 요소("2")가 LLM의 긴 텍스트("2026년 …")에
// 포함되어 어긋난 셀렉터가 통과한다. 빈 텍스트는 아무것과도 일치시키지 않는다 —
// 빈 문자열은 모든 값에 포함되므로 그대로 두면 검증이 무력해진다.
function containsText(extracted: string, reported: string): boolean {
  const want = normalize(reported);
  return want !== "" && normalize(extracted).includes(want);
}

// ── 스펙 해석 ──

// applySpec과 같은 문서(stripNoise 적용)에서 센다. 그래야 분모가 행을 만든 요소 집합과 같다.
// 문법이 깨진 셀렉터는 querySelectorAll이 던지므로 null로 돌려준다.
function countMatchedItems(html: string, itemSelector: string): number | null {
  try {
    const { document } = parseHTML(html);
    stripNoise(document);
    return Math.min(document.querySelectorAll(itemSelector).length, MAX_APPLIED_ITEMS);
  } catch {
    return null;
  }
}

// applySpec은 필드 셀렉터를 보호 없이 실행한다. 문법이 깨진 필드 하나가 수집 전체를
// 던지게 하지 않도록, 실행 전에 걸러서 그 필드만 실패로 처리한다.
function splitFieldsBySyntax(fields: Record<string, FieldSelector>): {
  usable: Record<string, FieldSelector>;
  broken: string[];
} {
  const probe = parseHTML("<div></div>").document.createElement("div");
  const usable: Record<string, FieldSelector> = {};
  const broken: string[] = [];
  for (const [key, field] of Object.entries(fields)) {
    try {
      probe.querySelector(field.selector);
      usable[key] = field;
    } catch {
      broken.push(key);
    }
  }
  return { usable, broken };
}

// ── 보고 항목 ↔ 추출 행 대응 ──

interface ItemRowPair {
  item: ReadItem;
  // 제목이 일치하는 행. 없으면 null.
  row: ExtractedRow | null;
}

// 제목 텍스트로 보고 항목마다 대응하는 행을 찾는다. 같은 제목이 여러 번 나오는 목록에서
// 항목이 한 행에 몰리면 필드 값 대조가 어긋나므로, 아직 쓰지 않은 행을 먼저 고른다.
// 쓸 행이 없으면 이미 쓴 행이라도 제목은 "있는 것"으로 본다 (제목 일치율의 정의).
function pairItemsWithRows(items: ReadItem[], rows: ExtractedRow[]): ItemRowPair[] {
  const claimed = new Set<ExtractedRow>();
  return items.map((item) => {
    const hits = rows.filter((row) => containsText(row.title, item.titleText));
    const row = hits.find((r) => !claimed.has(r)) ?? hits[0] ?? null;
    if (row) claimed.add(row);
    return { item, row };
  });
}

// ── 필드 지표 ──

function hasValue(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function rateField(
  key: string,
  selector: FieldSelector,
  rows: ExtractedRow[],
  pairs: ItemRowPair[],
): { fill: number; match: number } {
  const fill = ratio(rows.filter((r) => hasValue(r.attrs[key])).length, rows.length);
  // attr이 있으면 값이 눈에 보이는 텍스트가 아니라 속성(href·src·datetime)이다.
  if (selector.attr !== undefined) return { fill, match: UNVERIFIABLE_MATCH };

  let compared = 0;
  let matched = 0;
  for (const { item, row } of pairs) {
    const reported = item.fields.find((f) => f.key === key)?.text ?? "";
    // 행을 못 찾았거나 LLM이 텍스트를 적지 않은 항목은 대조할 근거가 없다.
    if (!row || normalize(reported) === "") continue;
    compared += 1;
    const extracted = row.attrs[key];
    if (typeof extracted === "string" && containsText(extracted, reported)) matched += 1;
  }
  return { fill, match: compared === 0 ? UNVERIFIABLE_MATCH : matched / compared };
}

// ── 판정 ──

function rowCountPasses(itemCount: number, reportedCount: number): boolean {
  const target = Math.min(reportedCount, ROW_TARGET_CAP);
  return itemCount >= MIN_ROWS && atLeast(itemCount, target * MIN_ROW_RATIO);
}

function failedVerification(
  spec: CrawlSpec,
  reportedCount: number,
): { rows: ExtractedRow[]; score: VerifyScore } {
  const fieldRates: VerifyScore["fieldRates"] = {};
  for (const key of Object.keys(spec.fields ?? {})) fieldRates[key] = { ...BROKEN_FIELD_RATE };
  return {
    rows: [],
    score: { itemCount: 0, matchedCount: 0, reportedCount, rowYield: 0, titleMatchRate: 0, fieldRates, ok: false },
  };
}

export function verifySpec(
  html: string,
  pageUrl: string,
  spec: CrawlSpec,
  read: PageReadResult,
): { rows: ExtractedRow[]; score: VerifyScore } {
  const reportedCount = read.items.length;
  if (!spec.itemSelector) return failedVerification(spec, reportedCount);

  const matchedCount = countMatchedItems(html, spec.itemSelector);
  if (matchedCount === null) return failedVerification(spec, reportedCount);

  const { usable, broken } = splitFieldsBySyntax(spec.fields ?? {});
  let rows: ExtractedRow[];
  try {
    rows = applySpec(html, { ...spec, fields: usable }, pageUrl);
  } catch {
    return failedVerification(spec, reportedCount);
  }

  const pairs = pairItemsWithRows(read.items, rows);
  const itemCount = rows.length;
  const rowYield = ratio(itemCount, matchedCount);
  const titleMatchRate = ratio(pairs.filter((p) => p.row !== null).length, reportedCount);

  const fieldRates: VerifyScore["fieldRates"] = {};
  for (const [key, selector] of Object.entries(spec.fields ?? {})) {
    fieldRates[key] = broken.includes(key) ? { ...BROKEN_FIELD_RATE } : rateField(key, selector, rows, pairs);
  }

  const ok =
    rowCountPasses(itemCount, reportedCount) &&
    atLeast(rowYield, MIN_ROW_YIELD) &&
    atLeast(titleMatchRate, MIN_TITLE_MATCH_RATE);

  return { rows, score: { itemCount, matchedCount, reportedCount, rowYield, titleMatchRate, fieldRates, ok } };
}

// 임계치 미달 필드를 뺀 새 스펙. 입력 스펙은 건드리지 않는다 — 호출자가 원본을 보존해야 할 수 있다.
// 점수에 없는 필드는 판단 근거가 없으므로 남긴다.
export function pruneFailedFields(spec: CrawlSpec, score: VerifyScore): CrawlSpec {
  if (!spec.fields) return { ...spec };
  const kept: Record<string, FieldSelector> = {};
  for (const [key, field] of Object.entries(spec.fields)) {
    const rate = score.fieldRates[key];
    if (rate && !(atLeast(rate.fill, MIN_FIELD_FILL) && atLeast(rate.match, MIN_FIELD_MATCH))) continue;
    kept[key] = { ...field };
  }
  return { ...spec, fields: kept };
}
