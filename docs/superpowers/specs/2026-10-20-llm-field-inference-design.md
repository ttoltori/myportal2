# LLM 기반 추출 필드 추론 설계

작성일: 2026-10-20
대상: 소스 등록 화면(`/add-source`)의 분석 단계 및 추출 명세 생성 경로

## 1. 배경과 문제

소스 등록 시 `analyzeUrl`은 추출 전략을 ①힌트 → ②RSS/Atom → ③JSON-LD → ④DOM 휴리스틱 순으로 시도한다. 이 중 ④가 대부분의 한국 공고/게시판 사이트를 담당하는데, `generateSpec`이 만드는 스펙은 다음과 같다.

```ts
// src/server/features/crawl/extract.ts — evaluateBuckets
const spec: CrawlSpec = {
  strategy: "html",
  itemSelector: bucket.itemSelector,
  fields: {},            // ← 항상 빈 객체
};
```

`fields`가 비어 있으므로 `applyDomSpec`은 `title`(앵커 텍스트), `link`(href), `publishedAt`(항목 전체 텍스트의 날짜 정규식)만 채우고 `attrs`는 늘 `{}`다. 결과적으로 사용자는 **제목과 링크만 있는 소스**를 등록하게 되고, 목록에 함께 표시되는 접수기간·주최기관·지원금액·대상·상태 같은 메타 정보가 전부 버려진다.

반면 **수집 경로는 이미 준비되어 있다.** `spec.fields`에 셀렉터 맵이 들어오면 `applyDomSpec`(extract.ts:641)이 그대로 `attrs`로 추출하고, `source_fields` → 데스크 상세 패널 → `role=deadline` 기반 '마감 임박' 뷰·D-day·다이제스트까지 흘러간다. 비어 있는 것은 **"필드 셀렉터 맵을 누가 만들어 주느냐"** 하나뿐이다.

이 설계는 그 구멍을 OpenAI API로 메운다.

## 2. 목표와 비목표

### 목표

- DOM 휴리스틱이 목록을 찾은 경우, 항목 안의 추가 필드를 LLM이 추론해 `spec.fields`를 채운다.
- 휴리스틱이 목록을 못 찾아 지금 `outcome="detail"`로 끝나는 경우, LLM이 `itemSelector`까지 추론해 구제한다.
- 추론된 필드에 한글 표시명과 역할(`deadline`/`summary` 등)을 붙여, 기존 마감일 기능에 추가 작업 없이 연결한다.
- LLM 호출은 명세 생성·복구 시점에만 발생하고, 정기 수집에서는 발생하지 않는다 (요건정의서 CRAWL-03).

### 비목표

- 정기 수집 시점의 LLM 호출 (CRAWL-03 위반).
- 항목별 상세 페이지 방문·분석 (수집 비용·시간이 선형 증가).
- LLM이 생성한 코드 실행 — LLM은 **셀렉터 문자열만** 반환한다 (CRAWL-01).
- 카테고리·태그 자동 제안 (NFR-L1에 있지만 이 설계의 범위 밖. 후속 과제).

### 성공 기준

1. `fields`가 채워진 스펙으로 `applySpec`을 실행하면 `attrs`에 2개 이상의 필드가 들어온다 (필드가 실제로 존재하는 목록 사이트 기준).
2. `LLM_API_KEY`가 비어 있을 때 분석 결과가 현재와 **완전히 동일하다**.
3. LLM이 타임아웃·오류·상한 초과로 실패해도 분석은 성공하고, 휴리스틱 결과가 그대로 반환된다.
4. LLM이 잘못된 셀렉터를 반환해도 저장되지 않는다 (검증 단계에서 폐기).

## 3. 전체 흐름

```text
analyzeUrl(userId, url, hint)
  1. URL 검증·정규화                            (변경 없음)
  2. 기존 소스 중복 확인                          (변경 없음)
  3. robots.txt                                 (변경 없음)
  4. fetchPage                                  (변경 없음)
  5. detectExtraction → rss | structured | html (변경 없음)
  6. 브라우저 렌더링 재시도                        (변경 없음)
  ────────────────────────────────────────────────────────
  7. ★ enrichWithLlm(outcome, html, pageUrl, userId, sourceId=null)
       ├ A. outcome 있음 + strategy === "html"  → 필드 보강
       │     itemSelector 매칭 상위 3개 항목의 축약 HTML → inferFields()
       │     ← { fields: [{ key, label, selector, attr?, type, role }] }
       ├ B. outcome 없음  (지금 outcome="detail"로 끝나는 경로)
       │     축약한 페이지 전체 → inferListAndFields()
       │     ← { itemSelector, fields: [...] }
       └ C. strategy === "rss" | "structured"   → 건너뜀 (셀렉터 개념 없음)
  8. ★ validateInferredFields(): applySpec 재실행 → 통과분만 병합
  9. fieldsFromRows(rows, spec) → preview.fields
```

LLM 호출 지점은 세 곳으로 한정한다.

| 지점 | 호출 함수 | purpose | user_id |
|---|---|---|---|
| 소스 등록 분석 (`POST /v1/sources/analyze`) | `analyzeUrl` | `analyze-fields` / `analyze-rescue` | 로그인 사용자 |
| 명세 다시 만들기 (`POST /v1/sources/:id/rebuild-spec`) | `rebuildSpec` | `rebuild` | 로그인 사용자 |
| 수집 자가복구 (`collector.repairSpec`) | `repairSpec` | `self-repair` | `null` (시스템) |

정기 수집(`collectSource` → `applySpec`)은 저장된 셀렉터만 사용하므로 코드 변경도, LLM 비용도 없다.

## 4. 모듈 구성

```text
src/server/features/crawl/llm/
├─ llm-client.ts       chatJson() — 전송·타임아웃·JSON 파싱·zod 검증·1회 재시도
├─ field-inference.ts  inferFields() / inferListAndFields() / validateInferredFields()
├─ enrich.ts           enrichWithLlm() — 상한 확인 → 추론 → 검증 → 단계 생성을 묶는 진입점
├─ html-digest.ts      digestItems() / digestPage() — LLM 입력용 DOM 축약
├─ usage.sql.ts        일별 상한·이력 SQL 상수
└─ usage.ts            checkLlmQuota() / recordLlmCall()
```

`enrich.ts`의 `enrichWithLlm()`이 §3 흐름의 7~8단계를 담당하는 유일한 진입점이다. `analyze.ts`, `sources.ts`(rebuildSpec), `collector.ts`(repairSpec) 세 호출처는 이 함수만 부르고, 반환된 `AnalyzeStep`을 자기 단계 목록에 넣거나(analyze) 버린다(rebuild/self-repair). 호출처가 상한·오류·폴백 규칙을 각자 구현하지 않게 하려는 분리다.

```ts
export interface EnrichResult {
  spec: CrawlSpec;              // LLM 반영 또는 입력 그대로
  rows: ExtractedRow[];
  fieldSource: "llm" | "heuristic";
  step: AnalyzeStep;            // 사용자에게 보일 "AI 필드 분석" 단계
}

// base가 null이면 구제(rescue) 모드, 있으면 보강(enrich) 모드.
// 어떤 실패에도 예외를 던지지 않는다 — base가 null이고 구제도 실패하면 null을 반환한다.
export async function enrichWithLlm(args: {
  html: string;
  pageUrl: string;
  base: { spec: CrawlSpec; rows: ExtractedRow[] } | null;
  userId: string | null;
  sourceId: string | null;
  purpose: "analyze-fields" | "analyze-rescue" | "rebuild" | "self-repair";
}): Promise<EnrichResult | null>;
```

### 4.1 `llm-client.ts` — 전송 계층

프로바이더 비의존·myportal 비의존으로 작성한다. myportal의 타입을 import하지 않으므로, 세 번째 서비스에서 같은 패턴이 필요해지면 파일 이동만으로 `shared-packages/packages/llm-client`(`@ttoltori/llm-client`)로 추출할 수 있다 (CLAUDE.md §21: 세 번 이상 반복될 때 공통화 검토 — 현재 `tube_digest/lib/openai.ts`와 합쳐 2번째).

```ts
export interface ChatJsonOptions {
  baseUrl: string;        // 기본 https://api.openai.com/v1
  apiKey: string;
  model: string;          // 기본 gpt-4o-mini
  system: string;
  user: string;
  maxTokens?: number;     // 기본 2000
  temperature?: number;   // 기본 0
  timeoutMs?: number;     // 기본 20000
}

export interface ChatJsonResult<T> {
  data: T;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}

export async function chatJson<T>(
  schema: ZodType<T>,
  opts: ChatJsonOptions,
): Promise<ChatJsonResult<T>>;
```

**`openai` SDK를 쓰지 않고 `fetch`로 직접 호출한다.** 필요한 엔드포인트는 `POST {baseUrl}/chat/completions` 하나뿐이고, CLAUDE.md §22가 라이브러리 추가를 제한한다. `response_format: { type: "json_object" }`를 사용하고, `AbortSignal.timeout(timeoutMs)`로 타임아웃을 건다. 의존성 추가는 없다.

동작:

1. 요청 → 응답 본문에서 `choices[0].message.content` 추출 → `JSON.parse` → `schema.safeParse`.
2. 파싱 또는 검증 실패 시 **1회만** 재시도한다. 재시도 메시지에는 원래 user 프롬프트 뒤에 실패 사유와 "코드 블록 없이 JSON 객체만 출력하라"는 지시를 덧붙인다 (NFR-L2).
3. 재시도도 실패하면 `LlmError`를 던진다. HTTP 오류·타임아웃도 `LlmError`로 통일한다. HTTP 오류는 재시도하지 않는다 — 스키마 실패와 달리 프롬프트를 고쳐도 해결되지 않는다.

`LlmError`는 `AppError`가 **아니다** — 호출자가 반드시 잡아서 폴백해야 하는 내부 오류이며, API 응답 envelope로 새어 나가면 안 된다.

### 4.2 `html-digest.ts` — 입력 축약 (NFR-L3)

토큰 사용량을 줄이면서 셀렉터 추론에 필요한 정보는 보존한다. linkedom `parseHTML`을 사용하고, `extract.ts`의 `stripNoise`와 같은 기조로 동작한다.

공통 전처리:

- `script`, `style`, `svg`, `noscript`, `iframe`, 주석 제거.
- **`class`, `id`, `data-*`, `href`, `src`, `datetime`, `title` 속성은 보존한다** — 셀렉터 생성에 필수다. 그 외 속성(`style`, `onclick` 본문, `aria-*` 등)은 제거한다.
- 텍스트 노드는 80자에서 절단하고 `…`을 붙인다.
- 연속 공백은 1칸으로 접는다.

| 함수 | 입력 | 출력 | 상한 |
|---|---|---|---|
| `digestItems(html, itemSelector)` | 전체 HTML + 항목 셀렉터 | `querySelectorAll` 결과의 **문서 순서 앞 3개**의 `outerHTML`을 축약해 이어붙인 문자열 | 항목당 2KB, 총 6KB |
| `digestPage(html)` | 전체 HTML | `body` 아래에서 `header`/`nav`/`footer`/`aside`를 뺀 뒤 축약한 문자열 | 20KB |

상한을 넘으면 문자 단위로 절단한다. 태그가 깨질 수 있으나 LLM은 셀렉터 패턴만 보므로 허용한다.

### 4.3 `field-inference.ts` — 추론과 검증

#### 응답 스키마 (zod)

```ts
const inferredFieldSchema = z.object({
  key:      z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),  // attrs 키 — 영소문자 스네이크
  label:    z.string().min(1).max(40),                   // 한글 표시명
  selector: z.string().min(1).max(200),
  attr:     z.string().max(40).optional(),               // 생략 시 textContent
  type:     fieldTypeSchema,                             // api-contracts의 FieldType
  role:     fieldRoleSchema,                             // api-contracts의 FieldRole
});

const inferFieldsResponseSchema = z.object({
  fields: z.array(inferredFieldSchema).max(12),
});

const inferListResponseSchema = z.object({
  itemSelector: z.string().min(1).max(200),
  fields: z.array(inferredFieldSchema).max(12),
});
```

`key`를 `^[a-z][a-z0-9_]{0,31}$`로 제한하는 이유: `attrs`의 jsonb 키가 되고 데스크 상세 패널과 `source_fields.key`로 흘러가므로, 한글·공백·특수문자가 섞이면 SQL·UI 양쪽에서 문제가 된다. 사람이 읽는 이름은 `label`이 담당한다.

`role`은 `title`/`link`/`published`를 LLM이 반환해도 **`none`으로 강제한다** — 이 세 역할은 `fieldsFromRows`가 고정 필드로 이미 생성하며, 중복되면 데스크 렌더링이 깨진다. 유효한 추가 역할은 `deadline`, `summary`, `none`뿐이다.

#### 프롬프트 방침

시스템 프롬프트는 한국어로 작성하고 다음 요지를 담는다.

- 역할: 한국어 웹 목록 페이지에서 **CSS 셀렉터를 설계하는 전문가**.
- 주어진 것은 목록 항목 HTML 샘플이고, 각 항목에서 반복적으로 나타나는 메타 정보를 찾는 것이 과제다.
- 셀렉터는 **항목 요소를 기준으로 한 상대 셀렉터**여야 한다 — `querySelector`가 항목 엘리먼트에서 호출된다.
- 제목·링크·게시일은 이미 처리되므로 **제외**한다.
- 찾아야 하는 것: 접수기간/마감일, 주최·주관 기관, 지원금·상금, 응모 대상, 분야·부문, 상태(접수중/마감), 조회수, 첨부 여부 등 **그 목록에 실제로 있는 것만**. 없는 필드를 추측해 만들지 않는다.
- 접수기간처럼 시작·종료가 한 문자열에 들어있으면 `type: "date_range"`, `role: "deadline"`.
- 단일 마감일이면 `type: "date"` 또는 `"datetime"`, `role: "deadline"`.
- 요약·발췌문이면 `role: "summary"`.
- 그 외는 `role: "none"`.
- `temperature: 0`, `response_format: json_object`.

구제 경로(`inferListAndFields`)는 추가로 "반복되는 목록 항목의 CSS 셀렉터(`itemSelector`)를 먼저 찾아라. 네비게이션 메뉴·사이드바·푸터의 반복 링크는 목록이 아니다"를 포함한다.

#### 검증 — `validateInferredFields()`

LLM 출력은 **반드시 실행해 검증한 뒤에만** 채택한다.

```ts
export function validateInferredFields(
  html: string,
  pageUrl: string,
  baseSpec: CrawlSpec,              // itemSelector가 확정된 스펙
  inferred: InferredField[],
  mode: "enrich" | "rescue",
): { spec: CrawlSpec; rows: ExtractedRow[]; accepted: InferredField[] } | null;
```

절차:

1. `inferred`를 `baseSpec.fields`에 병합한 후보 스펙을 만든다.
2. `applySpec(html, 후보스펙, pageUrl)`을 실행한다. 샘플은 앞 20건을 본다.
3. 필드별 폐기 조건:
   - `document.querySelector(selector)`가 예외를 던진다 (잘못된 셀렉터 문법) → 그 필드만 버린다. `applyDomSpec`이 이미 `try/catch`로 감싸고 있으나, 검증 단계에서 명시적으로 확인해 폐기 사유를 남긴다.
   - 샘플 20건 중 값이 채워진 비율이 **30% 미만** → 그 필드만 버린다 (우연히 한두 항목에만 걸린 셀렉터).
   - `key`가 `title`/`link`/`published`와 충돌 → 그 필드만 버린다.
4. 전체 폐기 조건:
   - `mode === "rescue"`에서 `rows.length < 3` → `null` 반환. 기존대로 `outcome="detail"`.
   - `mode === "rescue"`에서 `title` 채움률 **80% 미만** → `null` 반환.

   `mode === "enrich"`에는 전체 폐기 조건이 없다. 보강 경로는 `baseSpec.itemSelector`를 바꾸지 않고 `fields`만 더하므로 `rows.length`와 `title`/`link` 값이 구조적으로 변하지 않는다 — 추출되는 항목 수를 LLM이 줄일 방법이 없다. 따라서 필드 단위 폐기만으로 충분하다.
5. 통과한 필드가 0개면 `null`을 반환한다. 호출자는 휴리스틱 결과를 그대로 쓴다.

### 4.4 `usage.ts` — 일별 상한 (NFR-L4)

```ts
export async function checkLlmQuota(userId: string | null): Promise<boolean>;
export async function recordLlmCall(entry: LlmCallEntry): Promise<void>;
```

- `userId`가 있으면: 당일(`created_at >= current_date`) `ok = true` 건수가 `LLM_DAILY_LIMIT`(기본 50) 미만일 때만 통과.
- `userId`가 `null`(self-repair/cron)이면: 같은 조건으로 `LLM_DAILY_LIMIT_SYSTEM`(기본 200)을 적용.
- 상한 초과 시 호출을 **건너뛴다**. 분석은 실패시키지 않고 단계 `warn`으로만 알린다.
- `recordLlmCall`은 성공·실패 모두 기록한다. 기록 실패가 분석을 깨뜨리면 안 되므로 `try/catch`로 삼키고 서버 로그만 남긴다.

날짜 경계는 DB의 `current_date`(서버 타임존)를 쓴다. 사용자 타임존별 정산은 과잉이다 — 목적은 비용 폭주 방지이지 정확한 과금이 아니다.

## 5. 스펙 포맷 확장

`CrawlSpec.fields`의 자료구조(`Record<string, FieldSelector>`)는 유지하고 `FieldSelector`에 메타만 추가한다.

```ts
// src/server/features/crawl/extract.ts
export interface FieldSelector {
  selector: string;
  attr?: string;
  // ↓ 추가 — LLM이 추론한 표시 메타. 없으면 fieldsFromRows가 기존 추정으로 폴백한다.
  label?: string;
  type?: FieldType;
  role?: FieldRole;
}

export interface CrawlSpec {
  strategy: "rss" | "structured" | "html";
  feedUrl?: string;
  itemSelector?: string;
  fields?: Record<string, FieldSelector>;
  hint?: string;
  render?: boolean;
  // ↓ 추가 — 필드 맵의 출처. UI 배지와 운영 추적용.
  fieldSource?: "llm" | "heuristic";
}
```

**하위호환**: 기존에 저장된 스펙은 `fields`가 `{}`이고 새 키가 없다. `label`/`type`/`role`이 `undefined`면 `fieldsFromRows`가 지금의 추정 로직을 쓴다. 마이그레이션으로 기존 스펙을 건드리지 않는다.

`FieldType`/`FieldRole`은 `@myportal/api-contracts`에서 import한다. `extract.ts`는 이미 백엔드 전용 모듈이므로 계약 패키지 참조에 문제가 없다.

### `fieldsFromRows` 확장

```ts
// 변경 전: fieldsFromRows(rows: ExtractedRow[]): SourceField[]
// 변경 후:
export function fieldsFromRows(
  rows: ExtractedRow[],
  spec?: CrawlSpec | null,
): SourceField[];
```

고정 3개 필드(title/link/published)는 그대로 생성한다. 추가 키마다:

| 항목 | spec에 FieldSelector 메타가 있을 때 | 없을 때 (기존 동작) |
|---|---|---|
| `label` | `fs.label` | `key` 그대로 |
| `type` | `fs.type` | `guessFieldType(sample)` |
| `role` | `fs.role` | `key === "deadline" ? "deadline" : "none"` |

호출처는 `analyze.ts:438` 한 곳(preview 생성)뿐이므로 2번째 인자를 optional로 두면 기존 코드가 깨지지 않는다. 소스 등록(`createSourceWithBaseline`)이 쓰는 `source_fields`는 프론트엔드가 보낸 `CreateSourceRequest.fields`에서 오고, 그 값은 미리보기 필드를 사용자가 수정한 결과다 — 즉 추론된 라벨·역할이 분석 응답 → 화면 → 등록 요청을 거쳐 그대로 저장된다. 별도 연결 작업이 필요 없다.

## 6. 환경변수

기존에 예약되어 있던 이름을 그대로 쓴다 (`.env.example`, `src/server/config/env.ts`에 이미 존재). OpenAI 호환 엔드포인트를 받으므로 이름을 `OPENAI_*`로 바꾸지 않는다.

```env
# LLM 기반 추출 필드 추론. 비우면 DOM 휴리스틱만 사용한다(기존 동작과 동일).
LLM_API_BASE=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4o-mini

# 사용자별 일별 LLM 호출 상한 (비용 폭주 방지)
LLM_DAILY_LIMIT=50
# 시스템 경로(수집 자가복구 등) 일별 상한
LLM_DAILY_LIMIT_SYSTEM=200
```

`env.ts` 변경:

```ts
llmApiBase: (process.env.LLM_API_BASE ?? "").trim() || "https://api.openai.com/v1",
llmApiKey: (process.env.LLM_API_KEY ?? "").trim(),
llmModel: (process.env.LLM_MODEL ?? "").trim() || "gpt-4o-mini",
llmDailyLimit: int(process.env.LLM_DAILY_LIMIT, 50),
llmDailyLimitSystem: int(process.env.LLM_DAILY_LIMIT_SYSTEM, 200),
```

빈 문자열을 미설정으로 처리하는 기존 `env.ts` 관례(`CRAWL_USER_AGENT` 주석 참조)를 따른다.

```ts
export function hasLlm(): boolean {
  return Boolean(env.llmApiKey);
}
```

`validateEnv()`는 변경하지 않는다 — LLM은 선택 기능이므로 미설정이 시작 실패가 되어서는 안 된다.

## 7. 데이터베이스

`database/migrations/myportal/003_llm_calls.sql` 1장을 추가한다. 적용된 마이그레이션(001, 002)은 수정하지 않는다 (CLAUDE.md §19).

```sql
-- LLM 호출 이력. 일별 상한 판정(NFR-L4)과 비용 추적에 사용한다.
create table if not exists myportal.llm_calls (
    id                uuid primary key default gen_random_uuid(),
    -- 시스템 경로(수집 자가복구)는 null. 사용자 삭제 시 이력은 남긴다.
    user_id           uuid references myportal.users(id) on delete set null,
    source_id         uuid references myportal.sources(id) on delete set null,
    -- analyze-fields | analyze-rescue | rebuild | self-repair
    purpose           text not null,
    model             text not null,
    prompt_tokens     integer,
    completion_tokens integer,
    duration_ms       integer,
    ok                boolean not null,
    error_code        text,
    created_at        timestamptz not null default now()
);

-- 일별 상한 판정 쿼리(user_id + created_at 범위)용
create index if not exists llm_calls_user_created_idx
    on myportal.llm_calls (user_id, created_at desc);
create index if not exists llm_calls_created_idx
    on myportal.llm_calls (created_at desc);
```

`on delete set null`을 쓰는 이유: 사용자나 소스가 삭제되어도 비용 이력은 보존해야 한다. `user_id`가 null이 되면 시스템 호출과 구분되지 않지만, 상한 판정은 당일 데이터만 보므로 실무적 영향이 없다.

SQL은 `src/server/features/crawl/llm/usage.sql.ts`에 상수로 둔다 (CLAUDE.md §12). 모든 외부 값은 파라미터 바인딩한다.

## 8. API 계약 변경

`packages/api-contracts/src/index.ts`:

```ts
export const analyzeResultSchema = z.object({
  // ... 기존 필드 전부 유지
  // 미리보기 필드 메타의 출처. "llm"이면 등록 화면에 'AI 추론' 배지를 표시한다.
  fieldSource: z.enum(["llm", "heuristic"]).nullable(),
});
```

`fieldSource`가 두 곳(`CrawlSpec.fieldSource`, `AnalyzeResult.fieldSource`)에 있는 이유를 분명히 한다.

- `CrawlSpec.fieldSource`는 **저장되는 사실**이다. `crawl_specs.spec` jsonb에 들어가 나중에 "이 소스의 필드는 AI가 만든 것인가"를 답한다. `rebuildSpec`·self-repair가 스펙을 교체할 때 갱신된다.
- `AnalyzeResult.fieldSource`는 **이번 분석 응답의 표시용 값**이며, 그 분석이 만든 스펙의 `fieldSource`를 그대로 복사한다. 목록을 못 찾아 `preview`가 `null`이면 `null`이다.

둘이 갈라질 일은 없다 — 전자가 원본이고 후자는 사본이다. 프론트엔드가 `preview.spec`을 열어 보지 않게 하려고 응답 최상위에 올린다.

`errorCodes.LLM_QUOTA_EXCEEDED`는 **이미 정의되어 있다** (index.ts:448). 추가 오류 코드는 없다. 이 코드는 `analyzeResult.errorCode`로 반환하지 않는다 — 상한 초과는 분석 실패가 아니라 단계 `warn`이므로, `AnalyzeStep.detail` 문자열로만 사용자에게 보인다.

`@myportal/myportal-api-client`는 변경이 없다 — `analyze` 함수의 응답 타입이 `AnalyzeResult`를 그대로 쓴다.

### 함수 시그니처 변경

일별 상한이 사용자 단위이므로 `analyzeUrl`이 `userId`를 받아야 한다.

```ts
// 변경 전: analyzeUrl(rawUrl: string, hint?: string)
// 변경 후:
export async function analyzeUrl(
  userId: string,
  rawUrl: string,
  hint?: string,
): Promise<AnalyzeResult>;
```

라우트는 이미 `getUserId(c)`를 쓸 수 있다 (`/v1/*`에 세션 게이트가 걸려 있다).

```ts
.post("/sources/analyze", async (c) => {
  const body = analyzeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw validationError("유효한 URL을 입력해주세요.", body.error.issues);
  return success(c, await analyzeUrl(getUserId(c), body.data.url, body.data.hint));
})
```

`rebuildSpec(userId, sourceId)`은 이미 `userId`를 받으므로 시그니처 변경이 없다. `repairSpec`은 시스템 경로이므로 `userId=null`로 호출한다.

## 9. 오류 처리 — LLM은 순수 가산

**원칙: LLM이 무엇을 하든 분석은 실패하지 않는다.** LLM 경로 전체를 `try/catch`로 감싸고, 어떤 실패도 분석 단계 하나의 `warn`으로 환원한다.

| 상황 | 분석 단계 표시 | 결과 |
|---|---|---|
| `LLM_API_KEY` 미설정 | `warn` · "AI 분석이 설정되지 않았습니다 — 건너뜀" | 휴리스틱 결과 그대로 |
| 일별 상한 초과 | `warn` · "일별 AI 분석 한도를 초과했습니다" | 휴리스틱 결과 그대로 |
| 타임아웃 (20s) | `warn` · "AI 분석 시간이 초과되었습니다" | 휴리스틱 결과 그대로 |
| HTTP 4xx/5xx | `warn` · "AI 분석 호출에 실패했습니다" | 휴리스틱 결과 그대로 |
| JSON/스키마 검증 2회 실패 | `warn` · "AI 응답을 해석할 수 없습니다" | 휴리스틱 결과 그대로 |
| 모든 필드가 검증에서 폐기 | `warn` · "추론된 필드가 유효하지 않습니다" | 휴리스틱 결과 그대로 |
| 보강 성공 | `ok` · "필드 6개 추론" | `spec.fields` 채워짐, `fieldSource="llm"` |
| 구제 성공 | `ok` · "AI가 목록 패턴을 찾았습니다 (24개 항목)" | `outcome="list"`로 전환 |

오류 메시지에 프로바이더 원문·스택·API 키를 절대 포함하지 않는다 (CLAUDE.md §15, 요건정의서 §9). `LlmError`의 원문은 서버 로그에만 남긴다.

`repairSpec`/`rebuildSpec`에서도 같다 — LLM 실패는 기존 휴리스틱 재생성 결과로 폴백하고, 둘 다 실패할 때만 기존처럼 `EXTRACTION_FAILED`를 던진다.

## 10. 프론트엔드 변경 (최소)

`src/app/add-source/page.tsx`:

1. 분석 단계 목록은 `result.steps`를 그대로 렌더하므로 **코드 변경 없이** "AI 필드 분석" 단계가 추가된다.
2. 미리보기 테이블의 구조는 변경하지 않는다. LLM이 추론한 한글 라벨·타입·역할이 이미 채워진 상태로 뜨고, 사용자는 지금처럼 표시명·역할·숨김을 수정할 수 있다 (SRC-07).
3. 미리보기 헤더(`최근 N건 · 필드 M개 · {fetchStrategy}`)에 `result.fieldSource === "llm"`일 때 `· AI 추론` 배지를 덧붙인다.

배지 스타일은 `DESIGN.md`/`디자인컨셉.md`의 신문·전보 톤을 따른다 — 라운드·그림자·그래디언트 없이 1px 테두리와 소문자 캡션으로 처리한다.

## 11. 테스트 (CLAUDE.md §20)

실제 네트워크 호출 테스트는 만들지 않는다. `fetch`를 모킹해 **검증 로직**을 겨눈다 — 핵심 비즈니스 규칙은 "LLM을 믿지 않는 방법"이다.

### `src/server/features/crawl/llm/field-inference.test.ts`

- 유효한 응답 → 필드가 `spec.fields`에 병합되고 `label`/`type`/`role`이 보존된다.
- 문법이 깨진 셀렉터(`"div[["`)가 섞인 응답 → 그 필드만 버려지고 나머지는 채택된다.
- 20건 중 3건만 채워지는 셀렉터(채움률 15%) → 그 필드만 버려진다.
- `key: "title"`을 반환 → 그 필드만 버려진다(고정 필드 충돌).
- `role: "title"`을 반환 → `role`이 `"none"`으로 강제된다.
- `mode="rescue"`에서 `itemSelector`가 2건만 매칭 → `null` 반환(전체 폐기).
- `mode="rescue"`에서 title 채움률 60% → `null` 반환(전체 폐기).
- 통과 필드가 0개 → `null` 반환.

### `src/server/features/crawl/llm/llm-client.test.ts`

- 첫 응답이 비(非)JSON → 1회 재시도 후 성공하면 데이터 반환.
- 재시도도 실패 → `LlmError`.
- HTTP 500 → `LlmError`, 재시도하지 않는다(스키마 실패와 구분).
- 응답의 `usage` 토큰 수가 결과에 담긴다.

### `src/server/features/crawl/llm/html-digest.test.ts`

- `script`/`style`/주석이 제거된다.
- `class`/`id`/`data-*`/`href`가 보존된다.
- 긴 텍스트 노드가 80자에서 절단된다.
- `digestItems`가 상위 3개 항목만, 크기 상한 내로 반환한다.

### `src/server/features/crawl/llm/usage.test.ts`

- 당일 성공 호출이 상한 미만이면 통과, 같거나 넘으면 차단.
- `ok=false` 건은 상한 계산에 포함되지 않는다.
- `userId=null`은 시스템 상한을 적용한다.

### `src/server/features/crawl/extract.test.ts` (기존 파일 보강)

- `fields`에 `label`/`type`/`role` 메타가 있는 스펙으로 `applySpec` → `attrs`가 올바르게 채워진다.
- `fieldsFromRows(rows, spec)`가 spec 메타를 우선하고, 메타가 없으면 기존 추정으로 폴백한다.

### 하지 않는 테스트

- 실제 OpenAI API 호출 (비용·불안정).
- 프롬프트 문구 자체의 단위 테스트 (의미 없음).
- 얇은 라우트 래퍼 (CLAUDE.md §20).

## 12. 구현 순서

1. `003_llm_calls.sql` 마이그레이션 추가 → `pnpm db:migrate`.
2. `env.ts`에 LLM 설정·상한 추가, `.env.example` 주석 갱신("예약된 값" 문구 제거).
3. `llm/llm-client.ts` + 테스트.
4. `llm/html-digest.ts` + 테스트.
5. `llm/usage.sql.ts`, `llm/usage.ts` + 테스트.
6. `extract.ts`의 `FieldSelector`/`CrawlSpec` 확장, `fieldsFromRows(rows, spec?)` 확장 + 테스트 보강.
7. `llm/field-inference.ts` (프롬프트 + 검증) + 테스트.
8. `analyze.ts`에 보강(A)·구제(B) 경로 연결, `analyzeUrl(userId, ...)` 시그니처 변경.
9. `sources.routes.ts`에서 `getUserId(c)` 전달.
10. `sources.ts`의 `rebuildSpec`, `collector.ts`의 `repairSpec`에 LLM 경로 연결.
11. `api-contracts`에 `fieldSource` 추가, `add-source/page.tsx`에 배지 추가.
12. `pnpm test` → `pnpm lint` → `pnpm typecheck` 전부 통과 (CLAUDE.md §25).
13. `docs/시스템설계서.md` §4 수집 아키텍처와 `docs/개발자가이드.md` 환경변수 절 갱신.

## 13. 설계 판단 기록

**왜 셀렉터 생성이고 항목 직접 추출이 아닌가**: 요건정의서 CRAWL-03이 "LLM은 명세 생성 시점과 복구 시점에만 호출한다"로 못박았다. 셀렉터는 한 번 만들면 수집 때마다 재사용되므로 소스당 LLM 비용이 1회로 고정된다. 항목을 매번 LLM으로 뽑으면 비용이 `소스 수 × 수집 횟수`로 선형 증가한다.

**왜 휴리스틱을 남기는가**: RSS·JSON-LD로 이미 정확한 결과가 나오는 사이트에서 LLM을 부를 이유가 없고, `LLM_API_KEY` 없이도 서비스가 완전히 동작해야 한다. 휴리스틱은 폴백이 아니라 1차 경로다.

**왜 검증이 그렇게 빽빽한가**: LLM은 그럴듯한 셀렉터를 자신 있게 틀린다. 틀린 셀렉터가 `crawl_specs`에 저장되면 이후 모든 수집이 조용히 빈 `attrs`를 만들고, 사용자는 원인을 알 수 없다. 저장 전에 실제로 실행해 채움률을 보는 것이 유일하게 믿을 수 있는 검사다.

**왜 `openai` SDK가 아닌가**: 엔드포인트 하나(`/chat/completions`)에 의존성 하나를 추가하는 거래가 CLAUDE.md §22의 기준("직접 구현하는 것보다 유지보수 비용이 낮다")을 만족하지 않는다. `fetch`로 40줄이면 끝나고, `LLM_API_BASE`로 OpenAI 호환 엔드포인트를 그대로 받는 이점이 따라온다.

**왜 `@ttoltori/llm-client`를 지금 만들지 않는가**: `tube_digest/lib/openai.ts`와 합쳐 2번째 사용이다. CLAUDE.md §21은 세 번째에서 공통화를 검토하라고 한다. 대신 `llm-client.ts`에 myportal 타입을 일절 두지 않아, 3번째 사용이 생기면 파일 이동만으로 `shared-packages`로 추출된다.

## 14. 범위 밖 후속 과제

- 카테고리·태그 자동 제안 (NFR-L1) — `analyzeResult.suggested`가 현재 빈 값으로 나가고 있다.
- 항목 상세 페이지 분석으로 목록에 없는 필드 보강.
- `@ttoltori/llm-client` 공통 패키지 추출 (3번째 사용 시점).
- `llm_calls` 기반 비용 대시보드.
