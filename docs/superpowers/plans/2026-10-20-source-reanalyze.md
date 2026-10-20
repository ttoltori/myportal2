# 소스 재분석·재적용 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 등록된 소스를 다시 분석해 새 스펙과 발견된 필드를 미리보기로 보여주고, 사용자가 라벨·역할을 고쳐 확정하면 `crawl_specs`·`source_fields`를 갱신하고 기존 항목에 백필한다.

**Architecture:** `analyzeUrl`의 가운데(robots → fetch → 추출 → LLM 보강)를 `analyzeListing` 코어로 뽑아 등록과 재분석이 공유한다. 분석(`reanalyze`)과 적용(`apply-spec`)을 두 엔드포인트로 나눠 미리보기 단계에서는 DB를 건드리지 않는다. 백필은 `dedupe_hash`에 제목이 섞여 있는 탓에 `normalized_url`을 1차 매칭 키로 쓰고 해시까지 함께 갱신한다.

**Tech Stack:** TypeScript, Next.js App Router, React 19, Hono, Zod, linkedom, pg, vitest. 신규 npm 의존성 **없음**.

**Spec:** [docs/superpowers/specs/2026-10-20-source-reanalyze-design.md](../specs/2026-10-20-source-reanalyze-design.md)

## Global Constraints

- 신규 npm 의존성을 추가하지 않는다.
- `reanalyze`는 `crawl_specs`·`source_fields`·`items`·`sources`에 **쓰기를 하지 않는다**. `llm_calls` 기록만 예외다(비용이 발생했으므로).
- `apply-spec`은 클라이언트가 보낸 `spec`을 신뢰하지 않고 추출을 재실행해 검증한다. 추출 0건이면 아무것도 저장하지 않고 `EXTRACTION_FAILED` 422.
- 외부 I/O(fetch/render)는 트랜잭션 **밖**에서 수행한다.
- 백필 1차 매칭 키는 `normalized_url`, URL이 없는 행만 `dedupe_hash`로 매칭한다.
- 백필은 `title`·`published_at`·`excerpt`·`attrs`·`dedupe_hash`를 **함께** 갱신한다.
- 사용자가 보낸 `fields` 목록에 없는 기존 `source_fields` 행은 **건드리지 않는다**.
- 신규 삽입분은 `is_baseline=false`이고, **적용을 실행한 사용자에게만** 읽음 마킹한다.
- `rebuild-spec` 라우트·`rebuildSpec()`·API 클라이언트의 `rebuildSpec`을 제거한다. `collector.ts`의 `repairSpec`은 **건드리지 않는다**.
- SQL은 전부 파라미터 바인딩, `select *` 금지, SQL 상수는 `*.sql.ts`에 둔다 (CLAUDE.md §11, §12).
- `any` 금지. 외부 입력은 zod로 검증한다 (CLAUDE.md §16, §23).
- 테스트는 소스 옆 `*.test.ts`. 실제 네트워크·DB 접속 테스트를 만들지 않는다.
- UI는 `DESIGN.md`의 신문·전보 톤 — 1px 테두리, 라운드·그림자·그래디언트 금지.
- 커밋 메시지는 한글로, "왜" 변경했는지 드러나게 쓴다 (CLAUDE.md §27).
- `fields` 상한 30개. `hint`는 `trim().min(2).max(500)`.

## Review Focus

스펙이 함축하지만 어느 태스크의 테스트도 짚지 않는 입력들. 각 줄의 테스트를 담당 태스크에 넣었다.

1. **`normalized_url`이 같은 기존 항목이 2건 있으면 둘 중 어느 것을 갱신할지 정해지지 않았다** — 과거에 제목이 달라 중복 삽입됐던 경우다. 스펙은 해시 충돌만 다룬다. → Task 5에서 `collected_at`이 가장 오래된 것만 갱신하는 테스트.
2. **추출 행 2건이 같은 `normalized_url`을 가지면 한 기존 항목을 두 번 갱신한다** — 목록에 같은 링크가 두 번 나오는 페이지(공지 고정 + 본문 반복)에서 발생한다. → Task 5에서 첫 행만 반영하고 두 번째는 건너뛰는 테스트.
3. **`fields`에 `key`가 중복되면 `insertField` 업서트가 조용히 하나를 덮는다** — 사용자가 패널에서 라벨을 고치다 같은 key를 만들 수 있다. → Task 5에서 중복 key를 `VALIDATION_ERROR`로 거부하는 테스트.
4. **`paused` 상태 소스를 적용하면 `status='ok'`로 덮어써 일시정지가 풀린다** — 스펙 §5 3-e가 `status='ok'`를 무조건 쓴다. → Task 5에서 `paused`는 유지하고 `fail`만 `ok`로 바꾸는 테스트.
5. **`reanalyze`가 `outcome: "detail"`일 때 패널이 적용 버튼을 열어두면 `preview: null`을 보낸다** — `applySpecRequestSchema`가 `spec: z.unknown()`이라 `null`도 통과한다. → Task 4에서 `spec`이 `null`/비객체면 `VALIDATION_ERROR`로 거부하는 테스트.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/server/features/crawl/analyze.ts` (수정) | `analyzeListing` 코어 분리, `analyzeUrl`은 조립만 |
| `src/server/features/crawl/collector.ts` (수정) | `extractRows`에 `export` 추가 (그 외 변경 없음) |
| `packages/api-contracts/src/index.ts` (수정) | reanalyze/applySpec 요청·응답 스키마 4개 |
| `src/server/features/sources/reanalyze.ts` (신규) | `reanalyzeSource`, `applySpecForSource` |
| `src/server/features/sources/reanalyze.sql.ts` (신규) | 백필·필드 조회 SQL 상수 |
| `src/server/features/sources/sources.ts` (수정) | `rebuildSpec()` 제거 |
| `src/server/routes/sources.routes.ts` (수정) | 라우트 2개 추가, `rebuild-spec` 제거 |
| `packages/myportal-api-client/src/index.ts` (수정) | `reanalyze`/`applySpec` 추가, `rebuildSpec` 제거 |
| `src/components/field-preview-table.tsx` (신규) | 필드 편집 표 — 등록 화면과 재분석 패널이 공유 |
| `src/app/add-source/page.tsx` (수정) | 인라인 표를 공통 컴포넌트로 교체 |
| `src/app/sources/[id]/page.tsx` (수정) | '다시 분석' 버튼 + 인라인 패널 |

`reanalyze.ts`를 `sources.ts`(249줄)에 넣지 않고 새 파일로 두는 이유: 백필 매칭 로직이 100줄 이상이고 `sources.ts`의 나머지(구독 조회·상세 조립)와 책임이 다르다.

## 태스크 의존 관계

```text
T1 analyzeListing 코어 분리        (단독)
T2 계약 + extractRows export       (단독, T1과 파일 겹치지 않음)
      ↓
T3 reanalyze.sql.ts + reanalyzeSource   (←T1,T2)
T4 applySpecForSource — 저장·검증        (←T2)
      ↓
T5 applySpecForSource — 백필 매칭        (←T4)
      ↓
T6 라우트 + API 클라이언트 + rebuild-spec 제거  (←T3,T5)
      ↓
T7 FieldPreviewTable 추출                (단독, 언제든)
      ↓
T8 소스 상세 재분석 패널                  (←T6,T7)
      ↓
T9 전체 검증 + 문서
```

T1·T2·T7은 서로 파일이 겹치지 않아 병렬 가능하다. T4와 T5를 쪼갠 이유: 저장 트랜잭션과 백필 매칭은 각각 독립적으로 리뷰·거부할 수 있고, 백필이 이 작업의 유일한 데이터 손상 지점이다.

---

### Task 1: `analyzeListing` 코어 분리

**Files:**
- Modify: `src/server/features/crawl/analyze.ts` (`analyzeUrl` 본문을 코어 + 조립으로 가름)
- Test: `src/server/features/crawl/analyze.test.ts` (기존 11건 유지 + 신규 2건)

**Interfaces:**
- Consumes: 기존 `detectExtraction`, `enrichWithLlm`, `fetchPage`, `renderPage`, `robotsAllowed`
- Produces:
  ```ts
  export interface ListingAnalysis {
    steps: AnalyzeStep[];
    pageTitle: string | null;
    outcome: AnalyzeOutcome | null;      // 기존 내부 타입. null = 목록 패턴 없음
    fieldSource: "llm" | "heuristic" | null;
    pageText: string | null;
    staticHtml: string;                  // parentCandidates용 정적 HTML
    finalUrl: string;
    blocked: { code: ErrorCode; detail: string } | null;
  }

  export async function analyzeListing(args: {
    userId: string;
    url: string;                          // 정규화된 URL
    hint?: string;
    sourceId: string | null;
    purpose: LlmPurpose;
  }): Promise<ListingAnalysis>;
  ```
  `AnalyzeOutcome`도 `export`한다 — T3이 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

기존 `analyze.test.ts`에 추가. `analyzeListing`을 직접 호출한다.

```ts
describe("analyzeListing", () => {
  it("robots 금지면 blocked에 ROBOTS_DISALLOWED를 담고 예외를 던지지 않는다", async () => {
    // robotsAllowed → false
    // → blocked.code === errorCodes.ROBOTS_DISALLOWED, outcome === null
  });

  it("fetch 실패면 blocked에 그 오류 코드를 담는다", async () => {
    // fetchPage가 AppError(URL_UNREACHABLE) → blocked.code === "URL_UNREACHABLE"
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze.test.ts`
Expected: FAIL — `analyzeListing`이 export되지 않음

- [ ] **Step 3: `analyzeListing` 추출**

현재 `analyzeUrl`의 3~7단계(robots, fetchPage, detectExtraction, 렌더링 재시도, `enrichWithLlm`)를 그대로 옮긴다. robots 금지와 fetch 실패는 **예외를 던지지 말고** `blocked`로 반환한다. 기존 `lastHtml`/`analyzed` 구분과 `carryOverSpecFlags` 호출은 코어 안에 남긴다.

- [ ] **Step 4: `analyzeUrl`을 조립으로 재작성**

URL 검증·정규화 → 중복 확인 → `analyzeListing({ userId, url: normalized, hint, sourceId: null, purpose })` → 응답 조립. `blocked.code`가 `ROBOTS_DISALLOWED`면 `outcome: "link-only"`, 그 외면 `outcome: "error"`. 나머지 분기(list/detail/exists/error)와 반환 필드는 **지금과 동일하게** 유지한다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze.test.ts`
Expected: PASS — 기존 11건 + 신규 2건 = 13건. **기존 11건이 하나도 깨지지 않아야 한다** (외부 동작 불변).

- [ ] **Step 6: 커밋**

```bash
git add src/server/features/crawl/analyze.ts src/server/features/crawl/analyze.test.ts
git commit -m "analyze 코어를 analyzeListing으로 분리 — 재분석이 중복확인 조기반환을 건너뛰고 같은 분석을 쓰게 하기 위함"
```

---

### Task 2: API 계약과 `extractRows` 공개

**Files:**
- Modify: `packages/api-contracts/src/index.ts` (소스 분석 절 뒤에 추가)
- Modify: `src/server/features/crawl/collector.ts:52` (`async function extractRows` → `export async function extractRows`)

**Interfaces:**
- Consumes: 기존 `analyzeStepSchema`, `sourceFieldSchema`, `fetchStrategySchema`
- Produces: 스펙 §4의 네 스키마와 추론 타입
  ```ts
  reanalyzeRequestSchema  / ReanalyzeRequest
  reanalyzeResultSchema   / ReanalyzeResult
  applySpecRequestSchema  / ApplySpecRequest
  applySpecResponseSchema / ApplySpecResponse
  ```
  그리고 `extractRows(source: { url; fetch_strategy; feed_url }, spec, html, contentType, finalUrl): Promise<ExtractedRow[]>`

- [ ] **Step 1: 스키마 추가**

스펙 §4의 블록을 그대로 쓴다. `reanalyzeResultSchema.outcome`은 `z.enum(["list","detail","link-only","error"])` — **`"exists"`를 넣지 않는다.** `applySpecRequestSchema`에 `backfill` 필드는 **없다**.

- [ ] **Step 2: `extractRows`에 export 추가**

시그니처는 이미 `{ url, fetch_strategy, feed_url }` 최소 인자를 받으므로 `export` 키워드만 붙인다. 본문은 변경하지 않는다.

- [ ] **Step 3: 타입 검사**

Run: `pnpm typecheck`
Expected: 오류 없음

- [ ] **Step 4: 커밋**

```bash
git add packages/api-contracts/src/index.ts src/server/features/crawl/collector.ts
git commit -m "재분석 API 계약 추가하고 extractRows를 공개 — 전략별 추출 분기를 재구현하지 않기 위함"
```

---

### Task 3: `reanalyzeSource` — 분석만, 저장 없음

**Files:**
- Create: `src/server/features/sources/reanalyze.ts`
- Create: `src/server/features/sources/reanalyze.sql.ts`
- Test: `src/server/features/sources/reanalyze.test.ts`

**Interfaces:**
- Consumes: `analyzeListing`, `ListingAnalysis`, `AnalyzeOutcome` (T1); `ReanalyzeResult` (T2); 기존 `sourcesSql.findById`, `sourcesSql.subscriptionForSource`, `sourcesSql.fieldsForSource`, `sourcesSql.latestActiveSpec`
- Produces:
  ```ts
  export async function reanalyzeSource(
    userId: string, sourceId: string, hint?: string,
  ): Promise<ReanalyzeResult>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`vi.mock`으로 `analyzeListing`·`getDb`를 교체한다. 실제 네트워크·DB 접속은 없다.

```ts
it("구독하지 않은 소스는 SOURCE_NOT_FOUND를 던진다", async () => {
  // subscriptionForSource → [] → AppError code SOURCE_NOT_FOUND, status 404
});

it("목록을 찾으면 preview와 fieldSource를 담아 반환한다", async () => {
  // analyzeListing → outcome 있음, fieldSource "llm"
  // → outcome "list", preview.fields 길이 > 0, fieldSource "llm"
});

it("목록을 못 찾으면 detail이고 preview는 null이다", async () => {
  // analyzeListing → outcome null, blocked null → outcome "detail", preview null
});

it("robots 금지면 link-only다", async () => {
  // blocked.code ROBOTS_DISALLOWED → outcome "link-only", errorCode 동일
});

it("fetch 실패면 error다", async () => {
  // blocked.code URL_UNREACHABLE → outcome "error"
});

it("currentFields에 현재 source_fields가 담긴다", async () => {
  // fieldsForSource → 3행 → currentFields 길이 3
});

it("저장된 spec.hint가 기본 힌트로 analyzeListing에 전달된다", async () => {
  // latestActiveSpec.spec.hint "공고" , 요청 hint 없음
  // → analyzeListing 호출 인자 hint === "공고"
});

it("요청 hint가 저장된 hint를 덮는다", async () => {
  // 저장 "공고", 요청 "장학" → analyzeListing 인자 hint === "장학"
});

it("purpose는 rebuild로 전달된다", async () => {
  // analyzeListing 인자 purpose === "rebuild", sourceId === 해당 소스 id
});

it("모든 outcome이 reanalyzeResultSchema를 통과한다", async () => {
  // list/detail/link-only/error 4가지 → reanalyzeResultSchema.parse가 던지지 않음
});

it("crawl_specs·source_fields에 쓰기를 하지 않는다", async () => {
  // query 호출 전부가 select임을 확인 (insert/update/delete 없음)
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/sources/reanalyze.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: `reanalyze.sql.ts` 작성**

`export const reanalyzeSql = { ... }` 하나로 둔다 — Task 5가 같은 객체에 백필 상수를 더한다. 이 태스크에서 필요한 상수만 넣고, 기존 `sourcesSql`에 있는 것(`findById`, `subscriptionForSource`, `fieldsForSource`, `latestActiveSpec`)은 재사용하고 중복 정의하지 않는다.

- [ ] **Step 4: `reanalyzeSource` 구현**

소스 조회·권한 확인은 `sources.ts`의 `findSubscribedSource`와 같은 규칙을 따른다(`subscriptionForSource`가 비면 `SOURCE_NOT_FOUND` 404). 저장된 활성 스펙에서 `hint`를 읽고 요청 `hint`가 있으면 그것을 쓴다. `pg`가 jsonb를 객체로 돌려주므로 문자열일 때만 `JSON.parse`한다(`rebuildSpec`의 기존 주석 참조). `blocked` → outcome 매핑은 T1 Step 4와 동일한 규칙이다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/sources/reanalyze.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/server/features/sources/reanalyze.ts src/server/features/sources/reanalyze.sql.ts src/server/features/sources/reanalyze.test.ts
git commit -m "소스 재분석 조회 기능 추가 — 미리보기 단계에서 DB를 건드리지 않아 취소가 공짜가 되게 함"
```

---

### Task 4: `applySpecForSource` — 검증과 저장

백필은 Task 5에서 붙인다. 이 태스크는 스펙·필드 저장까지다.

**Files:**
- Modify: `src/server/features/sources/reanalyze.ts`
- Modify: `src/server/features/sources/reanalyze.sql.ts`
- Test: `src/server/features/sources/reanalyze.test.ts`

**Interfaces:**
- Consumes: `extractRows`, `applySpec` (T2); `ApplySpecRequest`, `ApplySpecResponse` (T2); 기존 `sourcesSql.deactivateSpecs`, `insertSpec`, `insertField`, `insertManualAction`, `fetchPage`, `renderPage`
- Produces:
  ```ts
  export async function applySpecForSource(
    userId: string, sourceId: string, input: ApplySpecRequest,
  ): Promise<ApplySpecResponse>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it("spec이 null이면 VALIDATION_ERROR로 거부한다", async () => {
  // input.spec = null → AppError code VALIDATION_ERROR (저장 없음)
});

it("spec이 객체가 아니면 VALIDATION_ERROR로 거부한다", async () => {
  // input.spec = "문자열" → VALIDATION_ERROR
});

it("fields에 key가 중복되면 VALIDATION_ERROR로 거부한다", async () => {
  // fields에 key "org"가 2건 → VALIDATION_ERROR, insertField 미호출
});

it("추출이 0건이면 EXTRACTION_FAILED이고 스펙을 저장하지 않는다", async () => {
  // extractRows → [] → AppError code EXTRACTION_FAILED status 422
  // insertSpec 미호출
});

it("새 스펙을 maxVersion+1 버전·manual로 저장한다", async () => {
  // 기존 최대 버전 3 → insertSpec 인자 version 4, created_by "manual"
});

it("fields를 insertField로 업서트한다", async () => {
  // fields 4건 → insertField 4회, fieldsSaved === 4
});

it("사용자가 보낸 목록에 없는 기존 필드는 삭제하지 않는다", async () => {
  // query 호출에 source_fields delete가 없음
});

it("fetch_strategy를 요청값으로 저장한다", async () => {
  // fetchStrategy "rss" → sources update 파라미터에 "rss"
});

it("status가 fail이면 ok로 바꾸고 consecutive_failures를 0으로 만든다", async () => {
  // 기존 status "fail" → update 파라미터 status "ok", consecutive_failures 0
});

it("paused 소스는 status를 ok로 덮지 않는다", async () => {
  // 기존 status "pause" → update 파라미터 status "pause" (일시정지 유지)
});

it("spec.hint에 요청 hint를 저장한다", async () => {
  // hint "장학" → insertSpec의 JSON에 "hint":"장학"
});

it("manual_actions에 apply-spec을 기록한다", async () => {
  // insertManualAction 인자 action === "apply-spec"
});

it("fetch 실패면 스펙·필드는 저장하고 backfillFailed true로 응답한다", async () => {
  // fetchPage가 AppError → backfillFailed true, backfilled 0, insertSpec 호출됨
});

it("spec.render가 true면 renderPage로 페이지를 받는다", async () => {
  // input.spec.render true → renderPage 호출, fetchPage 미호출
});

it("fetchStrategy가 rss면 extractRows에 rss로 전달한다", async () => {
  // extractRows 호출 인자 source.fetch_strategy === "rss"
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/sources/reanalyze.test.ts`
Expected: FAIL — `applySpecForSource`가 export되지 않음

- [ ] **Step 3: 입력 검증 구현**

`spec`이 `null`이거나 `typeof !== "object"`거나 배열이면 `validationError("유효한 추출 명세가 아닙니다.")`. `fields`의 `key`에 중복이 있으면 `validationError("필드 키가 중복되었습니다.")`. 기존 `errors/error-codes.ts`의 `validationError` 헬퍼를 쓴다.

- [ ] **Step 4: 페이지 획득·추출 구현 (트랜잭션 밖)**

`input.spec.render === true`면 `renderPage`, 아니면 `fetchPage`. 그 결과를 `extractRows({ url, fetch_strategy: input.fetchStrategy, feed_url }, input.spec, html, contentType, finalUrl)`에 넘긴다. `fetchPage`/`renderPage`가 던지면 `backfillFailed = true`로 두고 추출을 건너뛴다. 추출을 수행했고 0건이면 `AppError(errorCodes.EXTRACTION_FAILED, ..., 422)`.

- [ ] **Step 5: 저장 트랜잭션 구현**

스펙 §5 3-a~3-f 순서대로. 백필(3-d)은 Task 5에서 채운다 — 지금은 `backfilled: 0, inserted: 0`을 반환한다. `status`는 기존 값이 `"pause"`면 유지하고 그 외에는 `"ok"`로 쓴다(Review Focus 4).

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/sources/reanalyze.test.ts`
Expected: PASS (11 + 15 = 26 tests)

- [ ] **Step 7: 커밋**

```bash
git add src/server/features/sources/reanalyze.ts src/server/features/sources/reanalyze.sql.ts src/server/features/sources/reanalyze.test.ts
git commit -m "재분석 결과 적용 기능 추가 — 클라이언트가 보낸 명세를 추출로 재검증한 뒤에만 저장함"
```

---

### Task 5: 백필 매칭

이 작업의 유일한 데이터 손상 지점이다.

**Files:**
- Modify: `src/server/features/sources/reanalyze.ts` (트랜잭션 3-d 채우기)
- Modify: `src/server/features/sources/reanalyze.sql.ts`
- Test: `src/server/features/sources/reanalyze.test.ts`

**Interfaces:**
- Consumes: `dedupeHash(sourceUrl, title)` from `../crawl/url`; Task 4의 `applySpecForSource`
- Produces: `applySpecForSource`가 `backfilled`/`inserted`에 실제 수치를 담는다. 새 SQL 상수:
  ```ts
  reanalyzeSql = {
    itemsForBackfill: `...`,   // id, normalized_url, dedupe_hash, collected_at
    updateItemFromRow: `...`,  // title, url, normalized_url, dedupe_hash, published_at, excerpt, attrs
    markReadForUser: `...`,
  }
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

픽스처: 기존 items 3건 — `{id:"i1", normalized_url:"https://x.kr/v/1", dedupe_hash:"h1", collected_at:"2026-01-01"}`, `i2`(`/v/2`,`h2`), `i3`(`normalized_url: null`, `h3`).

```ts
it("제목이 바뀐 항목을 normalized_url로 매칭해 중복 삽입하지 않는다", async () => {
  // 추출 행: { title:"새 제목", link:"https://x.kr/v/1", attrs:{org:"서울시"} }
  // → updateItemFromRow가 i1에 대해 호출, insertItem 미호출, backfilled 1, inserted 0
});

it("매칭된 항목의 dedupe_hash를 새 제목 기준으로 갱신한다", async () => {
  // update 파라미터의 dedupe_hash === dedupeHash("https://x.kr/v/1", "새 제목")
});

it("title·published_at·excerpt·attrs를 함께 갱신한다", async () => {
  // update 파라미터에 네 값이 모두 전달된다
});

it("URL이 없는 행은 dedupe_hash로 매칭한다", async () => {
  // 추출 행: { title:"제목3", link:null } — dedupeHash("", "제목3") === "h3"이 되게 픽스처 구성
  // → i3가 갱신된다
});

it("같은 normalized_url의 기존 항목이 2건이면 collected_at이 오래된 것만 갱신한다", async () => {
  // i1(2026-01-01)과 i1b(2026-02-01)이 같은 /v/1 → i1만 update, backfilled 1
});

it("추출 행 2건이 같은 normalized_url이면 첫 행만 반영한다", async () => {
  // 공지 고정 + 본문 반복으로 /v/1이 두 번 → update 1회
});

it("새 해시가 다른 기존 항목의 해시와 충돌하면 그 행을 건너뛴다", async () => {
  // i1의 새 해시가 i2의 h2와 같아짐 → i1 update 건너뜀, backfilled에 포함되지 않음
});

it("매칭되지 않은 행은 is_baseline=false로 삽입한다", async () => {
  // 새 링크 /v/9 → insertItem 파라미터의 is_baseline === false, inserted 1
});

it("신규 삽입분을 적용자의 item_states에 읽음으로 마킹한다", async () => {
  // markReadForUser가 userId와 새 item id로 호출된다
});

it("다른 사용자의 item_states는 만들지 않는다", async () => {
  // markReadForUser 호출의 user_id가 전부 적용자 id
});

it("백필된 기존 항목에는 읽음 마킹을 하지 않는다", async () => {
  // markReadForUser가 i1에 대해 호출되지 않는다 (사용자의 기존 읽음 상태 보존)
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/sources/reanalyze.test.ts`
Expected: FAIL — `backfilled`/`inserted`가 항상 0

- [ ] **Step 3: SQL 상수 추가**

`itemsForBackfill`은 `id, normalized_url, dedupe_hash, collected_at`만 선택한다(`select *` 금지). `markReadForUser`는 스펙 §6.2의 `on conflict (user_id, item_id) do nothing` 구문을 그대로 쓴다.

- [ ] **Step 4: 매칭 구현**

```text
1. itemsForBackfill로 기존 항목을 읽어 두 맵을 만든다
   - byUrl: normalized_url → collected_at이 가장 오래된 1건
   - byHash: dedupe_hash → 항목
   - usedItemIds, takenHashes(기존 해시 집합)를 함께 준비한다
2. 추출 행을 순서대로 돌며
   a. normalized_url이 있으면 byUrl에서, 없으면 dedupeHash("",title)로 byHash에서 찾는다
   b. 이미 usedItemIds에 있으면 건너뛴다 (추출 행 중복)
   c. 새 해시가 자기 자신이 아닌 다른 기존 항목의 해시와 같으면 건너뛴다 (unique 충돌)
   d. 찾았으면 updateItemFromRow, 못 찾았으면 insertItem(is_baseline=false)
3. insert로 id를 받은 항목만 markReadForUser
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/sources/reanalyze.test.ts`
Expected: PASS (26 + 11 = 37 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/server/features/sources/reanalyze.ts src/server/features/sources/reanalyze.sql.ts src/server/features/sources/reanalyze.test.ts
git commit -m "재적용 시 기존 항목에 새 필드를 백필 — dedupe_hash에 제목이 섞여 있어 URL을 1차 키로 쓰지 않으면 전량 중복 삽입이 됨"
```

---

### Task 6: 라우트·API 클라이언트와 `rebuild-spec` 제거

**Files:**
- Modify: `src/server/routes/sources.routes.ts:57-59` (`rebuild-spec` 제거, 라우트 2개 추가)
- Modify: `src/server/features/sources/sources.ts:182-238` (`rebuildSpec()` 제거)
- Modify: `packages/myportal-api-client/src/index.ts:158-163` (`rebuildSpec` 제거, 2개 추가)

**Interfaces:**
- Consumes: `reanalyzeSource` (T3), `applySpecForSource` (T5)
- Produces:
  ```ts
  // myportal-api-client
  sources.reanalyze(id: string, body?: ReanalyzeRequest): Promise<ReanalyzeResult>
  sources.applySpec(id: string, body: ApplySpecRequest): Promise<ApplySpecResponse>
  ```

- [ ] **Step 1: 라우트 교체**

`POST /sources/:id/rebuild-spec`을 지우고 둘을 추가한다. 두 라우트 모두 `reanalyzeRequestSchema`/`applySpecRequestSchema`로 body를 `safeParse`하고 실패 시 `validationError`를 던진다. 기존 `analyze` 라우트의 패턴을 그대로 따른다.

- [ ] **Step 2: `rebuildSpec()` 제거**

`sources.ts`에서 함수와 더 이상 쓰이지 않는 import(`enrichWithLlm`, `generateSpec`, `renderPage`, `fetchPage` 중 남지 않는 것)를 지운다. **`collector.ts`의 `repairSpec`은 건드리지 않는다.**

- [ ] **Step 3: API 클라이언트 교체**

`rebuildSpec`을 지우고 `reanalyze`/`applySpec`을 추가한다. 기존 `collectNow`의 호출 형태(`httpRequest` 래퍼)를 따른다.

- [ ] **Step 4: 검증**

Run: `pnpm typecheck`
Expected: 오류 없음 — `rebuildSpec` 참조가 남아 있으면 여기서 잡힌다 (`/sources/[id]/page.tsx`가 아직 쓰고 있으면 T8까지 임시로 주석 처리하지 말고, 이 태스크에서 해당 버튼 호출부를 함께 제거한다)

Run: `pnpm vitest run src/server/`
Expected: PASS — 기존 테스트가 깨지지 않음

- [ ] **Step 5: 커밋**

```bash
git add src/server/routes/sources.routes.ts src/server/features/sources/sources.ts packages/myportal-api-client/src/index.ts src/app/sources/\[id\]/page.tsx
git commit -m "rebuild-spec을 reanalyze·apply-spec으로 교체 — 확인 없이 즉시 저장하던 경로를 없애 사용자가 결과를 보고 고칠 수 있게 함"
```

---

### Task 7: `FieldPreviewTable` 공통 컴포넌트 추출

**Files:**
- Create: `src/components/field-preview-table.tsx`
- Modify: `src/app/add-source/page.tsx` (인라인 표를 컴포넌트 호출로 교체, `TYPE_OPTIONS`/`ROLE_OPTIONS` 이동)

**Interfaces:**
- Produces:
  ```ts
  export interface FieldPreviewTableProps {
    fields: SourceField[];
    rows: Record<string, unknown>[];
    onFieldsChange: (next: SourceField[]) => void;
  }
  export function FieldPreviewTable(props: FieldPreviewTableProps): JSX.Element;
  ```

- [ ] **Step 1: 컴포넌트 추출**

`add-source/page.tsx`의 미리보기 `<table>`(헤더의 라벨 input·타입 select·역할 select·표시 체크박스와 본문 샘플 행)을 그대로 옮긴다. `TYPE_OPTIONS`/`ROLE_OPTIONS` 상수도 함께 옮겨 컴포넌트에서 export한다. 스타일 값(`fontSize`, `border: "1px solid var(--rule)"`, `minWidth: 150`, `opacity: f.visible ? 1 : 0.4`)은 **바꾸지 않는다.**

- [ ] **Step 2: `add-source`에서 사용**

표가 있던 자리를 `<FieldPreviewTable fields={fields} rows={previewRows} onFieldsChange={setFields} />`로 바꾼다. 미리보기 헤더(`최근 N건 · 필드 M개 · 전략 · AI 추론`)는 페이지에 남긴다 — 재분석 패널은 다른 문구를 쓴다.

- [ ] **Step 3: 검증**

Run: `pnpm typecheck && pnpm lint`
Expected: 오류·경고 없음

Run: `pnpm build`
Expected: `/add-source`가 정상 컴파일된다

- [ ] **Step 4: 커밋**

```bash
git add src/components/field-preview-table.tsx src/app/add-source/page.tsx
git commit -m "필드 편집 표를 공통 컴포넌트로 추출 — 등록 화면과 재분석 패널이 같은 편집 UI를 쓰게 하기 위함"
```

---

### Task 8: 소스 상세 재분석 패널

**Files:**
- Modify: `src/app/sources/[id]/page.tsx`

**Interfaces:**
- Consumes: `api.sources.reanalyze`/`applySpec` (T6), `FieldPreviewTable` (T7)
- Produces: 없음

- [ ] **Step 1: 버튼 교체와 상태 추가**

'명세 다시 만들기' 버튼을 '다시 분석'으로 바꾼다. `fetchStrategy === "link"`면 비활성(기존 '지금 수집'과 같은 규칙). 상태: `reanalysis: ReanalyzeResult | null`, `panelFields: SourceField[]`, `panelHint: string`, `busy`.

- [ ] **Step 2: 패널 구현**

스펙 §9.2의 레이아웃대로. 구성 요소:
- 분석 단계 목록 — `add-source`의 steps 렌더와 같은 형태
- '목록 항목 힌트' 입력 — 저장된 값이 기본. 바꿔서 '다시 분석'을 재실행할 수 있다
- `<FieldPreviewTable fields={panelFields} rows={reanalysis.preview.rows} onFieldsChange={setPanelFields} />`
- `reanalysis.currentFields`에 있고 `reanalysis.preview.fields`에 없는 key의 개수를 세어, 0보다 크면 "이번 분석에서 발견되지 않은 기존 필드 N개는 유지됩니다"를 표시
- `[적용]` `[취소]` — `outcome !== "list"`거나 `preview`가 없으면 '적용'을 **비활성**한다 (Review Focus 5)

- [ ] **Step 3: 적용 처리**

`api.sources.applySpec(sourceId, { spec: preview.spec, fields: panelFields, fetchStrategy: preview.fetchStrategy, hint: panelHint || undefined })`. 성공하면 패널을 닫고 상세를 다시 불러오며 기존 `actionLog`에 `버전 N 적용 · 백필 N건 · 신규 N건`을 남긴다. `backfillFailed`면 `· 백필 실패(다음 수집에서 반영)`를 덧붙인다.

- [ ] **Step 4: 검증**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add src/app/sources/\[id\]/page.tsx
git commit -m "소스 상세에 재분석 패널 추가 — 수집 이력과 스펙 버전을 보면서 판단하도록 화면을 옮기지 않음"
```

---

### Task 9: 전체 검증과 문서

**Files:**
- Modify: `docs/시스템설계서.md`, `docs/개발자가이드.md`

- [ ] **Step 1: 전체 테스트**

Run: `pnpm test`
Expected: 전부 PASS. 실패하면 원인을 분석해 수정한다 (CLAUDE.md §25).

- [ ] **Step 2: lint·typecheck·build**

Run: `pnpm lint && pnpm typecheck && pnpm build`
Expected: 전부 통과

- [ ] **Step 3: `rebuild-spec` 잔존 참조 확인**

Run: `grep -rn "rebuild-spec\|rebuildSpec" src packages docs --include=*.ts --include=*.tsx --include=*.md`
Expected: `repairSpec`(자가복구)만 남고 `rebuildSpec`·`rebuild-spec` 참조는 문서의 과거 설명을 제외하고 없다. 문서에 남아 있으면 Step 4에서 고친다.

- [ ] **Step 4: `시스템설계서.md` 갱신**

§4 수집 아키텍처의 '명세 버전' 단락에서 `rebuild-spec`을 `reanalyze`/`apply-spec`으로 바꾸고, **재분석·재적용** 단락을 추가한다: 두 엔드포인트의 역할, 미리보기 단계에 쓰기가 없다는 점, 백필 매칭 규칙(`normalized_url` 1차 키 + `dedupe_hash` 동시 갱신 이유), 신규분 읽음 마킹, 공유 소스 영향.

- [ ] **Step 5: `개발자가이드.md` 갱신**

소스 관리 절에 '다시 분석' 사용법을 추가한다: 언제 쓰는지(LLM 도입 이전에 등록한 소스, 사이트 개편), 미리보기에서 무엇을 고칠 수 있는지, 적용이 기존 읽음·별표를 보존한다는 점, 백필이 목록에 남아 있는 항목까지만 닿는다는 한계.

- [ ] **Step 6: 커밋**

```bash
git add docs/시스템설계서.md docs/개발자가이드.md
git commit -m "재분석·재적용 흐름을 문서에 반영"
```
