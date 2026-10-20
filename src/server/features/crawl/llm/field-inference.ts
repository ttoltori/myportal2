import {
  fieldRoleSchema,
  fieldTypeSchema,
  type FieldRole,
  type FieldType,
} from "@myportal/api-contracts";
import { parseHTML } from "linkedom";
import { z } from "zod";
import {
  applySpec,
  type CrawlSpec,
  type ExtractedRow,
  type FieldSelector,
} from "../extract";
import { digestItems, digestPage } from "./html-digest";
import { chatJson, LlmError, type ChatJsonResult } from "./llm-client";

// ── 응답 스키마 ──

const MAX_FIELDS = 12;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

// key는 attrs jsonb 키이자 source_fields.key가 되므로 영소문자 스네이크로 제한한다.
// 사람이 읽는 이름은 label이 담당한다.
const inferredFieldSchema = z.object({
  key: z.string().regex(FIELD_KEY_PATTERN),
  label: z.string().min(1).max(40),
  selector: z.string().min(1).max(200),
  attr: z.string().max(40).optional(),
  type: fieldTypeSchema,
  role: fieldRoleSchema,
});

const inferFieldsResponseSchema = z.object({
  fields: z.array(inferredFieldSchema).max(MAX_FIELDS),
});

const inferListResponseSchema = z.object({
  itemSelector: z.string().min(1).max(200),
  fields: z.array(inferredFieldSchema).max(MAX_FIELDS),
});

export interface InferredField {
  key: string;
  label: string;
  selector: string;
  attr?: string;
  type: FieldType;
  role: FieldRole;
}

export interface ValidatedFields {
  spec: CrawlSpec;
  rows: ExtractedRow[];
  accepted: InferredField[];
  rejected: { key: string; reason: string }[];
}

// env에서 읽은 값을 호출자가 전달한다 — 이 모듈은 env를 import하지 않는다.
export interface LlmModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ── 프롬프트 ──

const FIELD_INFERENCE_RULES = `당신은 한국어 웹 목록 페이지에서 CSS 셀렉터를 설계하는 전문가입니다.
주어진 것은 목록 항목 HTML 샘플이며, 각 항목에서 반복적으로 나타나는 메타 정보를 찾아 셀렉터로 반환하는 것이 과제입니다.

규칙:
- 셀렉터는 항목 요소를 기준으로 한 상대 셀렉터여야 합니다. 항목 엘리먼트에서 querySelector가 호출되므로 항목 자신이나 항목 바깥 요소를 가리키면 안 됩니다.
- 제목·링크·게시일은 이미 처리되므로 제외합니다. 이 세 가지는 필드로 반환하지 마십시오.
- 찾아야 하는 것: 접수기간/마감일, 주최·주관 기관, 지원금·상금, 응모 대상, 분야·부문, 상태(접수중/마감), 조회수, 첨부 여부 등 그 목록에 실제로 있는 것만 반환합니다. 없는 필드를 추측해서 만들지 마십시오.
- 접수기간처럼 시작일과 종료일이 한 문자열에 들어 있으면 type은 "date_range", role은 "deadline"으로 지정합니다.
- 단일 마감일이면 type은 "date" 또는 "datetime", role은 "deadline"으로 지정합니다.
- 요약·발췌문이면 role은 "summary"로 지정합니다.
- 그 외의 필드는 role을 "none"으로 지정합니다.
- 텍스트가 아니라 속성 값이 필요하면 attr에 속성 이름을 적고(예: 링크의 "href"), 텍스트면 attr을 생략합니다. 링크 값이면 type은 "url"입니다.
- key는 영소문자로 시작하는 영소문자·숫자·밑줄 조합(최대 32자)이고 서로 달라야 합니다. label은 사람이 읽는 한글 표시명입니다.
- 필드는 최대 ${MAX_FIELDS}개까지만 반환합니다.
- type은 ${fieldTypeSchema.options.join(", ")} 중에서, role은 deadline, summary, none 중에서 고릅니다.

응답은 JSON 객체 하나만 출력합니다.`;

const FIELDS_RESPONSE_FORMAT = `응답 형식: {"fields":[{"key":"...","label":"...","selector":"...","attr":"(선택)","type":"...","role":"..."}]}`;

const LIST_RESPONSE_FORMAT = `응답 형식: {"itemSelector":"...","fields":[{"key":"...","label":"...","selector":"...","attr":"(선택)","type":"...","role":"..."}]}`;

const SYSTEM_PROMPT_FIELDS = `${FIELD_INFERENCE_RULES}\n\n${FIELDS_RESPONSE_FORMAT}`;

const SYSTEM_PROMPT_LIST = `${FIELD_INFERENCE_RULES}

추가 과제: 필드를 찾기 전에, 이 페이지에서 반복되는 목록 항목의 CSS 셀렉터(itemSelector)를 먼저 찾으십시오.
- 네비게이션 메뉴, 사이드바, 푸터의 반복 링크는 목록이 아닙니다.
- 본문의 게시글/공고 항목 하나를 정확히 가리키는 셀렉터여야 하며, 위 필드 셀렉터는 이 항목 요소를 기준으로 한 상대 셀렉터입니다.
- 목록을 찾을 수 없으면 가장 가능성 높은 후보를 반환하되 필드는 비워도 됩니다.

${LIST_RESPONSE_FORMAT}`;

// ── 검증 ──

const SAMPLE_SIZE = 20;
const MIN_FIELD_FILL_RATE = 0.3;
const MIN_RESCUE_ROWS = 3;
const MIN_RESCUE_TITLE_RATE = 0.8;
// applyDomSpec이 한 번에 추출하는 최대 항목 수
const MAX_EXTRACTED_ITEMS = 100;
// fieldsFromRows가 고정 필드로 이미 만드는 키
const RESERVED_KEYS = new Set(["title", "link", "published"]);
// 위 고정 필드와 겹치는 역할은 데스크 렌더링을 깨뜨리므로 none으로 내린다.
const RESERVED_ROLES = new Set<FieldRole>(["title", "link", "published"]);

type Rejection = { key: string; reason: string };

function isValidSelector(document: Document, selector: string): boolean {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function toFieldSelector(f: InferredField): FieldSelector {
  const fs: FieldSelector = {
    selector: f.selector,
    label: f.label,
    type: f.type,
    role: f.role,
  };
  if (f.attr) fs.attr = f.attr;
  return fs;
}

// 키 충돌·중복·문법·역할을 걸러 실행 전 후보를 만든다.
function prefilter(
  document: Document,
  inferred: InferredField[],
  rejected: Rejection[],
): InferredField[] {
  const seen = new Set<string>();
  const candidates: InferredField[] = [];
  for (const f of inferred) {
    if (RESERVED_KEYS.has(f.key)) {
      rejected.push({ key: f.key, reason: "고정 필드 key와 충돌" });
      continue;
    }
    // 중복은 첫 번째만 채택한다. 첫 항목이 이후 검증에서 탈락해도 뒤 항목으로 대체하지 않는다.
    if (seen.has(f.key)) {
      rejected.push({ key: f.key, reason: "중복 key — 첫 번째 필드만 채택" });
      continue;
    }
    seen.add(f.key);
    if (!isValidSelector(document, f.selector)) {
      rejected.push({ key: f.key, reason: "셀렉터 문법 오류" });
      continue;
    }
    candidates.push({
      ...f,
      role: RESERVED_ROLES.has(f.role) ? "none" : f.role,
    });
  }
  return candidates;
}

function fillRate(sample: ExtractedRow[], key: string): number {
  if (sample.length === 0) return 0;
  const filled = sample.filter((r) => r.attrs[key] !== undefined).length;
  return filled / sample.length;
}

function buildSpec(baseSpec: CrawlSpec, fields: InferredField[]): CrawlSpec {
  const merged: Record<string, FieldSelector> = { ...baseSpec.fields };
  for (const f of fields) merged[f.key] = toFieldSelector(f);
  return { ...baseSpec, fields: merged, fieldSource: "llm" };
}

// 구제 모드에서 LLM이 제안한 itemSelector가 진짜 목록인지 판정한다.
// applySpec은 제목을 못 찾은 항목을 건너뛰므로, rows 수를 매칭된 항목 수로 나눠 제목 채움률로 본다.
function rescueListIsValid(
  document: Document,
  baseSpec: CrawlSpec,
  rows: ExtractedRow[],
): boolean {
  if (rows.length < MIN_RESCUE_ROWS) return false;
  let matched: number;
  try {
    matched = Math.min(
      document.querySelectorAll(baseSpec.itemSelector ?? "").length,
      MAX_EXTRACTED_ITEMS,
    );
  } catch {
    return false;
  }
  if (matched === 0) return false;
  const titled = rows.filter((r) => r.title.trim() !== "").length;
  return titled / matched >= MIN_RESCUE_TITLE_RATE;
}

// LLM 출력은 반드시 실행해 검증한 뒤에만 채택한다.
export function validateInferredFields(
  html: string,
  pageUrl: string,
  baseSpec: CrawlSpec,
  inferred: InferredField[],
  mode: "enrich" | "rescue",
): ValidatedFields | null {
  const { document } = parseHTML(html);
  const rejected: Rejection[] = [];
  const candidates = prefilter(document, inferred, rejected);

  const trialRows = applySpec(html, buildSpec(baseSpec, candidates), pageUrl);
  // enrich는 itemSelector를 바꾸지 않으므로 항목 수가 변할 수 없어 전체 폐기 조건이 없다.
  if (mode === "rescue" && !rescueListIsValid(document, baseSpec, trialRows)) {
    return null;
  }

  const sample = trialRows.slice(0, SAMPLE_SIZE);
  const accepted: InferredField[] = [];
  for (const f of candidates) {
    const rate = fillRate(sample, f.key);
    if (rate < MIN_FIELD_FILL_RATE) {
      rejected.push({
        key: f.key,
        reason: `채움률 ${Math.round(rate * 100)}% — 임계치 ${MIN_FIELD_FILL_RATE * 100}% 미만`,
      });
      continue;
    }
    accepted.push(f);
  }
  // enrich는 폴백할 휴리스틱 결과가 있으므로 필드를 하나도 못 건지면 포기한다.
  // rescue는 폴백이 없다 — 유효한 itemSelector를 찾은 것만으로도 목록 등록이
  // 가능해지므로(제목·링크만 있는 게시판이 구제 대상의 다수다) 필드 0개를 성공으로 본다.
  if (mode === "enrich" && accepted.length === 0) return null;

  const spec = buildSpec(baseSpec, accepted);
  // 폐기된 필드를 뺀 최종 스펙으로 다시 추출해 rows가 저장될 스펙과 일치하게 한다.
  const rows = applySpec(html, spec, pageUrl);
  return { spec, rows, accepted, rejected };
}

// ── 추론 호출 ──

const NO_ITEM_HTML_MESSAGE = "추론할 항목 HTML이 없습니다";

// 빈 HTML 등 파서가 던지는 입력도 "축약 결과 없음"으로 환원해 호출 전에 걸러낸다.
function safeDigest(build: () => string): string {
  try {
    return build();
  } catch {
    return "";
  }
}

export async function inferFields(
  html: string,
  itemSelector: string,
  model: LlmModelConfig,
): Promise<ChatJsonResult<{ fields: InferredField[] }>> {
  const digest = safeDigest(() => digestItems(html, itemSelector));
  if (!digest) throw new LlmError(NO_ITEM_HTML_MESSAGE, "schema");
  return chatJson(inferFieldsResponseSchema, {
    ...model,
    system: SYSTEM_PROMPT_FIELDS,
    user: `목록 항목 HTML 샘플 (항목 셀렉터: ${itemSelector}):\n\n${digest}`,
  });
}

export async function inferListAndFields(
  html: string,
  model: LlmModelConfig,
): Promise<ChatJsonResult<{ itemSelector: string; fields: InferredField[] }>> {
  const digest = safeDigest(() => digestPage(html));
  if (!digest) throw new LlmError(NO_ITEM_HTML_MESSAGE, "schema");
  return chatJson(inferListResponseSchema, {
    ...model,
    system: SYSTEM_PROMPT_LIST,
    user: `페이지 HTML (축약본):\n\n${digest}`,
  });
}
