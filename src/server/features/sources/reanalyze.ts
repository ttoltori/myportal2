import type {
  ApplySpecRequest,
  ApplySpecResponse,
  ReanalyzeResult,
  SourceField,
} from "@myportal/api-contracts";
import type { DatabaseClient } from "@ttoltori/database";
import { getDb } from "../../config/db";
import { AppError, errorCodes, validationError } from "../../errors/error-codes";
import { analyzeListing, fieldsFromRows } from "../crawl/analyze";
import { extractRows } from "../crawl/collector";
import type { CrawlSpec, ExtractedRow } from "../crawl/extract";
import { fetchProfileSchema, type FetchProfile } from "../crawl/analyze/profile";
import { fetchPage } from "../crawl/fetcher";
import { renderPage } from "../crawl/render";
import { dedupeHash, safeNormalize } from "../crawl/url";
import { reanalyzeSql } from "./reanalyze.sql";
import { findSubscribedSource, loadFetchProfile, saveFetchProfile } from "./sources";
import { sourcesSql } from "./sources.sql";

const PREVIEW_ROW_LIMIT = 10;
const SOURCE_STATUS_OK = "ok";
const SOURCE_STATUS_PAUSED = "pause";
const SPEC_CREATED_BY_MANUAL = "manual";
const ACTION_APPLY_SPEC = "apply-spec";
// collector.persistItems의 일반 수집 상한과 같다 — 백필이 정기 수집보다 많이 넣지 않게 한다.
const BACKFILL_ROW_LIMIT = 200;
const TITLE_MAX_LENGTH = 1000;
const EXCERPT_MAX_LENGTH = 500;

interface FieldRow {
  key: string;
  label: string;
  type: string;
  role: string;
  sort_order: number;
  visible: boolean;
}

function toSourceField(f: FieldRow): SourceField {
  return {
    key: f.key,
    label: f.label,
    type: f.type as SourceField["type"],
    role: f.role as SourceField["role"],
    visible: f.visible,
    sortOrder: f.sort_order,
  };
}

interface StoredHint {
  value: string;
  // 힌트를 입력한 시각. hintSetAt이 없는 구버전 스펙이면 null — 언제 입력했는지 알 수 없다.
  setAt: string | null;
}

function parseStoredSpec(spec: unknown): Record<string, unknown> | null {
  // pg는 jsonb를 이미 파싱된 객체로 반환하므로 문자열일 때만 JSON.parse한다.
  const parsed: unknown = typeof spec === "string" ? JSON.parse(spec) : spec;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

// 저장된 활성 스펙의 hint와 입력 시각. 목록 영역을 다시 같은 곳으로 찾게 하는 기본값이다.
function storedHintOf(spec: unknown): StoredHint | undefined {
  const parsed = parseStoredSpec(spec);
  if (!parsed) return undefined;
  const { hint, hintSetAt } = parsed;
  if (typeof hint !== "string" || hint.length === 0) return undefined;
  // 날짜로 읽히지 않는 값은 경과 일수를 계산할 수 없으므로 모르는 것으로 취급한다.
  const validSetAt =
    typeof hintSetAt === "string" && !Number.isNaN(Date.parse(hintSetAt)) ? hintSetAt : null;
  return { value: hint, setAt: validSetAt };
}

// 등록된 소스를 다시 분석해 미리보기를 만든다. 조회만 하고 저장하지 않는다 —
// 미리보기 단계에서 DB가 바뀌지 않아야 사용자의 '취소'가 되돌릴 것 없이 공짜가 된다.
// (LLM 호출 이력 llm_calls는 analyzeListing 안에서 기록된다.)
export async function reanalyzeSource(
  userId: string,
  sourceId: string,
  hint?: string,
): Promise<ReanalyzeResult> {
  // 권한 판정은 sources.ts와 같은 함수를 쓴다 — 소스 없음 404,
  // 구독 안 함 403. 규칙이 엔드포인트마다 갈리면 안 된다.
  const { source } = await findSubscribedSource(userId, sourceId);
  const db = getDb();

  const [activeSpec, fields] = await Promise.all([
    db.query<{ spec: unknown }>(sourcesSql.latestActiveSpec, [sourceId]),
    db.query<FieldRow>(sourcesSql.fieldsForSource, [sourceId]),
  ]);

  const stored = activeSpec.rows[0] ? storedHintOf(activeSpec.rows[0].spec) : undefined;
  // hint 생략은 "저장된 것을 쓴다", 빈 문자열은 "힌트 없이 간다"는 명시적 의사다.
  // 둘을 같게 취급하면 사용자가 낡은 힌트를 지울 방법이 없어진다.
  const effectiveHint =
    hint === undefined ? stored?.value : hint === "" ? undefined : hint;
  // 화면이 저장된 힌트를 입력란에 채워 보내므로, 값이 같으면 사용자가 새로 입력한 게 아니라
  // 저장된 것을 그대로 쓴 것이다. 이때만 원래 입력 시각을 이어 간다.
  const reusesStored = stored !== undefined && effectiveHint === stored.value;

  const listing = await analyzeListing({
    userId,
    url: String(source.normalized_url ?? source.url),
    hint: effectiveHint,
    // 입력 시각을 넘기지 않으면 재분석할 때마다 "지금"으로 덮어써져 낡음 표시가 영구히 사라진다.
    hintSetAt: reusesStored ? (stored.setAt ?? undefined) : undefined,
    sourceId,
    // 재분석 호출이 신규 등록(analyze-fields)과 섞이지 않도록 llm_calls에 rebuild로 구분해 남긴다.
    purpose: "rebuild",
  });

  const currentFields = fields.rows.map(toSourceField);
  // 개요를 만들기 전에 끝난 분석(접근 실패·피드)은 hintMatched가 null이라 판정할 수 없다.
  // 거짓 경고를 띄우지 않으려고 그때는 알리지 않는다.
  const storedHint =
    reusesStored && listing.hintMatched !== null
      ? { value: stored.value, setAt: stored.setAt, matchesPage: listing.hintMatched }
      : null;
  const base = {
    steps: listing.steps,
    pageTitle: listing.pageTitle,
    currentFields,
    pageText: listing.pageText,
  };

  if (listing.blocked) {
    return {
      ...base,
      outcome:
        listing.blocked.code === errorCodes.ROBOTS_DISALLOWED ? "link-only" : "error",
      preview: null,
      fieldSource: null,
      errorCode: listing.blocked.code,
      storedHint,
    };
  }

  const { outcome } = listing;
  if (!outcome) {
    return {
      ...base,
      steps: [
        ...base.steps,
        { label: "페이지 유형 판정", status: "warn", detail: "목록 패턴 없음" },
      ],
      outcome: "detail",
      preview: null,
      fieldSource: null,
      errorCode: errorCodes.PAGE_TYPE_UNKNOWN,
      storedHint,
    };
  }

  return {
    ...base,
    steps: [...base.steps, { label: "페이지 유형 판정", status: "ok", detail: "목록 페이지" }],
    outcome: "list",
    preview: {
      fields: fieldsFromRows(outcome.rows, outcome.spec),
      // analyzeUrl과 같은 모양 — 같은 FieldPreviewTable이 두 응답을 그대로 그린다.
      rows: outcome.rows.slice(0, PREVIEW_ROW_LIMIT).map((r) => ({
        title: r.title,
        link: r.link,
        published: r.publishedAt,
        ...r.attrs,
      })),
      fetchStrategy: outcome.strategy,
      spec: outcome.spec,
      profile: listing.profile,
    },
    fieldSource: listing.fieldSource,
    errorCode: null,
    storedHint,
  };
}

// ── 적용 ────────────────────────────────────────────────

// zod의 z.unknown()은 null·배열·원시값도 통과시키므로 여기서 직접 걸러낸다.
// 목록을 못 찾은 재분석(preview: null)이 그대로 적용으로 올 수 있기 때문이다.
function assertSpecObject(spec: unknown): asserts spec is Record<string, unknown> {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw validationError("유효한 추출 명세가 아닙니다.");
  }
}

// insertField가 (source_id, key) 업서트라 중복 key는 오류 없이 하나가 다른 하나를 덮는다.
function assertUniqueFieldKeys(fields: readonly SourceField[]): void {
  const keys = new Set(fields.map((f) => f.key));
  if (keys.size !== fields.length) {
    throw validationError("필드 키가 중복되었습니다.");
  }
}

// 페이지 조회·렌더 실패는 null로 돌려준다. 스펙은 유효할 수 있으므로
// 호출부가 백필만 건너뛰고 저장은 계속한다.
async function fetchAndExtract(
  source: Record<string, unknown>,
  spec: Record<string, unknown>,
  fetchStrategy: ApplySpecRequest["fetchStrategy"],
): Promise<ExtractedRow[] | null> {
  const url = String(source.normalized_url ?? source.url);
  let html: string;
  let contentType: string;
  let finalUrl: string;
  try {
    if (spec.render === true) {
      const page = await renderPage(url);
      ({ html, finalUrl } = page);
      contentType = "text/html";
    } else {
      const page = await fetchPage(url);
      ({ body: html, contentType, finalUrl } = page);
    }
  } catch {
    return null;
  }

  // RSS는 새 스펙이 가리키는 피드를 우선한다. 소스에 feed_url이 아직 없을 수 있다.
  const feedUrl =
    typeof spec.feedUrl === "string" ? spec.feedUrl : ((source.feed_url as string | null) ?? null);
  // 전략별 분기를 여기서 다시 쓰지 않는다 — 수집 경로와 어긋나지 않게 extractRows를 그대로 쓴다.
  return extractRows(
    { url, fetch_strategy: fetchStrategy, feed_url: feedUrl },
    spec as unknown as CrawlSpec,
    html,
    contentType,
    finalUrl,
  );
}

// ── 백필 ────────────────────────────────────────────────

interface ExistingItem {
  id: string;
  normalized_url: string | null;
  dedupe_hash: string;
  collected_at: string | Date;
}

// collector.persistItems와 같은 규칙 — 같은 항목이 두 경로에서 다른 excerpt를 갖지 않게 한다.
function excerptOf(attrs: Record<string, unknown>): string | null {
  const text = typeof attrs.description === "string" ? attrs.description : attrs.summary;
  return typeof text === "string" ? text.slice(0, EXCERPT_MAX_LENGTH) : null;
}

interface BackfillIndex {
  // normalized_url → collected_at이 가장 오래된 1건. 과거에 제목이 달라 중복 삽입된
  // 항목이 있으면 나머지는 건드리지 않는다(읽음·별표가 붙어 있을 수 있어 삭제도 하지 않는다).
  byUrl: Map<string, ExistingItem>;
  byHash: Map<string, ExistingItem>;
  // 현재 점유된 dedupe_hash → 항목 id. 갱신·삽입이 일어날 때마다 함께 바꾼다.
  hashOwner: Map<string, string>;
}

function indexExistingItems(items: readonly ExistingItem[]): BackfillIndex {
  const byUrl = new Map<string, ExistingItem>();
  const byHash = new Map<string, ExistingItem>();
  const hashOwner = new Map<string, string>();
  for (const it of items) {
    byHash.set(it.dedupe_hash, it);
    hashOwner.set(it.dedupe_hash, it.id);
    if (it.normalized_url === null) continue;
    const current = byUrl.get(it.normalized_url);
    if (!current || new Date(it.collected_at) < new Date(current.collected_at)) {
      byUrl.set(it.normalized_url, it);
    }
  }
  return { byUrl, byHash, hashOwner };
}

// 추출 행으로 기존 항목을 갱신하고, 없는 항목은 삽입해 적용자에게만 읽음 처리한다.
// dedupe_hash에 제목이 섞여 있으므로 normalized_url을 1차 키로 쓴다. 해시로만 찾으면
// 제목 추출이 달라진 소스에서 기존 항목 전량이 중복 삽입된다.
async function backfillItems(
  tx: DatabaseClient,
  userId: string,
  sourceId: string,
  extracted: readonly ExtractedRow[],
): Promise<{ backfilled: number; inserted: number }> {
  const { rows: existing } = await tx.query<ExistingItem>(reanalyzeSql.itemsForBackfill, [
    sourceId,
  ]);
  const { byUrl, byHash, hashOwner } = indexExistingItems(existing);
  const usedItemIds = new Set<string>();
  // 공지 고정 + 본문 반복처럼 같은 링크가 두 번 나오는 페이지는 첫 행만 반영한다.
  const seenUrls = new Set<string>();
  let backfilled = 0;
  let inserted = 0;

  for (const row of extracted.slice(0, BACKFILL_ROW_LIMIT)) {
    const normalizedUrl = row.link ? safeNormalize(row.link) : null;
    if (normalizedUrl !== null) {
      if (seenUrls.has(normalizedUrl)) continue;
      seenUrls.add(normalizedUrl);
    }
    const newHash = dedupeHash(normalizedUrl ?? "", row.title);
    // URL을 복원하지 못한 행만 해시로 찾는다. 이 경우 해시는 바뀌지 않는다.
    const match = normalizedUrl !== null ? byUrl.get(normalizedUrl) : byHash.get(newHash);

    if (match) {
      if (usedItemIds.has(match.id)) continue;
      // 새 해시가 다른 항목의 것이면 unique (source_id, dedupe_hash) 위반이다.
      const owner = hashOwner.get(newHash);
      if (owner !== undefined && owner !== match.id) continue;
      usedItemIds.add(match.id);
      await tx.query(reanalyzeSql.updateItemFromRow, [
        match.id,
        row.title.slice(0, TITLE_MAX_LENGTH),
        row.link,
        normalizedUrl,
        newHash,
        row.publishedAt,
        excerptOf(row.attrs),
        JSON.stringify(row.attrs),
      ]);
      hashOwner.delete(match.dedupe_hash);
      hashOwner.set(newHash, match.id);
      backfilled++;
      continue;
    }

    // 기준선은 '최초 등록 시점의 과거분'이라는 뜻이므로 is_baseline=false로 둔다.
    const { rows: ins } = await tx.query<{ id: string }>(sourcesSql.insertItem, [
      sourceId,
      row.title.slice(0, TITLE_MAX_LENGTH),
      row.link,
      normalizedUrl,
      newHash,
      row.publishedAt,
      excerptOf(row.attrs),
      JSON.stringify(row.attrs),
      false,
    ]);
    const insertedId = ins[0]?.id;
    // on conflict do nothing으로 행이 없으면 이미 있는 항목이다.
    if (insertedId === undefined) continue;
    hashOwner.set(newHash, insertedId);
    inserted++;
    // 내용은 과거의 것이므로 적용자의 "지난 방문 이후 신규"를 부풀리지 않게 읽음 처리한다.
    // 다른 구독자에게는 실제로 처음 보이는 항목이라 그들의 상태는 만들지 않는다.
    await tx.query(reanalyzeSql.markReadForUser, [userId, insertedId]);
  }

  return { backfilled, inserted };
}

// 클라이언트가 보낸 프로파일은 신뢰하지 않고 다시 검증한다. 프로파일은 수집 최적화
// 정보일 뿐이라, 형태가 맞지 않다고 적용 전체를 실패시키지 않고 기존 프로파일을 둔 채 진행한다.
// 원본 값은 임의 데이터라 로그에 싣지 않고 실패 위치와 코드만 요약한다.
function parseClientProfile(raw: unknown, sourceId: string): FetchProfile | null {
  if (raw == null) return null;
  const parsed = fetchProfileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const reasons = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}:${i.code}`)
    .join(", ");
  console.error(
    `[apply-spec] 수집 프로파일 검증 실패, 기존 프로파일 유지: source=${sourceId} issues=${reasons}`,
  );
  return null;
}

// 새 프로파일을 저장하지 못했는데 새 스펙은 렌더링을 요구하고 저장된 프로파일은 렌더링이 아니면,
// 수집기는 저장된 프로파일을 우선하므로(loadFetchProfile은 값이 있으면 스펙을 보지 않는다)
// 정적으로 가져와 조용히 0건이 된다. 평시 경로는 화면이 새 프로파일을 함께 보내 안전하지만,
// 재분석의 프로파일 측정이 실패한 채 적용하면 이 조합이 된다. 프로파일을 추측해 덮어쓰면
// 더 나쁘므로 동작은 바꾸지 않고 추적할 수 있게 경고만 남긴다.
// 저장된 값이 비었거나 손상된 경우는 loadFetchProfile이 새 스펙의 render로 유도하므로 해당하지 않는다.
function warnIfStaticProfileOverridesRender(
  source: Record<string, unknown>,
  spec: Record<string, unknown>,
  sourceId: string,
): void {
  if (spec.render !== true) return;
  // 스펙 인자는 저장된 값이 비었을 때의 유도용인데, 그 경우는 아래에서 걸러내므로 필요 없다.
  const stored = loadFetchProfile({ fetch_profile: source.fetch_profile }, null);
  if (stored.fallback !== "none" || stored.profile.mode === "rendered") return;
  console.warn(
    `[apply-spec] 새 스펙은 렌더링을 요구하지만 프로파일을 저장하지 못했고 저장된 프로파일은 ${stored.profile.mode}이다 — 수집이 정적으로 가져와 0건이 될 수 있다: source=${sourceId}`,
  );
}

// 저장할 스펙의 hint와 hintSetAt을 정한다. 불변식: hintSetAt은 힌트 문자열이 바뀔 때만 갱신된다.
// 재분석 화면은 저장된 힌트를 입력란에 채워 항상 문자열로 보내므로, "값이 왔다"를 새 입력으로
// 읽으면 적용할 때마다 시각이 리셋되어 낡음 경고가 영구히 사라진다. 그래서 클라이언트가
// 무엇을 보내든 서버가 저장된 힌트와 값을 비교해 정한다. 클라이언트 spec에 실려 온
// hint/hintSetAt은 믿지 않고 버린다. 요청의 세 가지 의사(계약 applySpecRequestSchema.hint):
//  - 생략 → 저장된 힌트와 입력 시각을 그대로 둔다. 힌트를 모르는 클라이언트가 적용해도
//    힌트가 조용히 사라지지 않는다.
//  - "" → 힌트를 삭제한다(hint와 hintSetAt을 모두 남기지 않는다).
//  - 저장된 힌트와 같은 문자열 → 저장된 hintSetAt을 보존한다. 구버전 스펙처럼 없었다면
//    없는 채로 둔다(없던 시각이 "지금"으로 생기면 오래된 힌트가 방금 입력된 것처럼 보인다).
//  - 다른 문자열 → 지금이 실제 입력 시점이다.
async function stampHint(
  sourceId: string,
  spec: Record<string, unknown>,
  inputHint: string | undefined,
): Promise<Record<string, unknown>> {
  const rest = { ...spec };
  delete rest.hint;
  delete rest.hintSetAt;
  if (inputHint === "") return rest;

  const active = await getDb().query<{ spec: unknown }>(sourcesSql.latestActiveSpec, [sourceId]);
  const stored = active.rows[0] ? storedHintOf(active.rows[0].spec) : undefined;
  if (inputHint === undefined || stored?.value === inputHint) {
    if (!stored) return rest;
    return stored.setAt === null
      ? { ...rest, hint: stored.value }
      : { ...rest, hint: stored.value, hintSetAt: stored.setAt };
  }
  return { ...rest, hint: inputHint, hintSetAt: new Date().toISOString() };
}

// 재분석 미리보기에서 사용자가 확정한 스펙·필드를 저장한다.
// 클라이언트가 보낸 spec을 신뢰하지 않고 추출을 다시 돌려 검증한 뒤에만 저장한다.
export async function applySpecForSource(
  userId: string,
  sourceId: string,
  input: ApplySpecRequest,
): Promise<ApplySpecResponse> {
  const { source } = await findSubscribedSource(userId, sourceId);

  const { spec } = input;
  assertSpecObject(spec);
  assertUniqueFieldKeys(input.fields);

  // 외부 I/O는 트랜잭션 밖에서 끝낸다 — 연결을 쥔 채 네트워크를 기다리지 않기 위함.
  const extracted = await fetchAndExtract(source, spec, input.fetchStrategy);
  if (extracted !== null && extracted.length === 0) {
    throw new AppError(
      errorCodes.EXTRACTION_FAILED,
      "이 명세로 목록을 추출할 수 없습니다.",
      422,
    );
  }
  const backfillFailed = extracted === null;

  // repairSpec이 이후 자가복구에서 힌트를 단서로 쓸 수 있도록 hint를 스펙에 싣는다.
  const specToSave = await stampHint(sourceId, spec, input.hint);
  const profile = parseClientProfile(input.profile, sourceId);
  if (!profile) warnIfStaticProfileOverridesRender(source, spec, sourceId);
  // 일시정지는 사용자의 의도이므로 적용이 풀어서는 안 된다.
  const status = source.status === SOURCE_STATUS_PAUSED ? SOURCE_STATUS_PAUSED : SOURCE_STATUS_OK;
  // 재분석이 새로 발견한 피드는 spec.feedUrl에만 있다. sources.feed_url에 옮기지
  // 않으면 수집 경로가 HTML 페이지를 피드로 읽어 영구히 0건을 반환한다.
  const discoveredFeedUrl =
    typeof (spec as { feedUrl?: unknown }).feedUrl === "string"
      ? (spec as { feedUrl: string }).feedUrl
      : null;

  return getDb().transaction(async (tx) => {
    const { rows: versionRows } = await tx.query<{ v: number }>(
      reanalyzeSql.maxSpecVersion,
      [sourceId],
    );
    const version = Number(versionRows[0]?.v ?? 0) + 1;

    await tx.query(sourcesSql.deactivateSpecs, [sourceId]);
    await tx.query(sourcesSql.insertSpec, [
      sourceId,
      version,
      JSON.stringify(specToSave),
      SPEC_CREATED_BY_MANUAL,
    ]);
    for (const f of input.fields) {
      await tx.query(sourcesSql.insertField, [
        sourceId,
        f.key,
        f.label,
        f.type,
        f.role,
        f.sortOrder,
        f.visible,
      ]);
    }

    // 프로파일은 스펙과 수명이 달라 따로 저장하되, 스펙과 함께 커밋되게 같은 트랜잭션에 둔다.
    if (profile) await saveFetchProfile(sourceId, profile, tx);

    // 백필(스펙 §5 3-d). 페이지 조회가 실패했으면 extracted가 null이라 건너뛴다.
    const backfill =
      extracted === null
        ? { backfilled: 0, inserted: 0 }
        : await backfillItems(tx, userId, sourceId, extracted);

    await tx.query(reanalyzeSql.updateSourceAfterApply, [
      sourceId,
      input.fetchStrategy,
      status,
      discoveredFeedUrl,
    ]);
    await tx.query(sourcesSql.insertManualAction, [userId, sourceId, ACTION_APPLY_SPEC]);

    return {
      version,
      fieldsSaved: input.fields.length,
      ...backfill,
      backfillFailed,
    };
  });
}
