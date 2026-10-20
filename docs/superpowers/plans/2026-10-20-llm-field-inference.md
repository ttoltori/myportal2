# LLM 기반 추출 필드 추론 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 소스 등록 분석이 제목·링크만 뽑던 한계를 없애고, OpenAI API로 목록 항목의 추가 메타 필드 셀렉터를 추론해 `spec.fields`를 채운다.

**Architecture:** LLM은 셀렉터 문자열만 반환하고, 저장 전에 `applySpec`으로 실제 실행해 채움률을 검증한다. 호출은 명세 생성·복구 시점(analyze / rebuild-spec / self-repair) 세 곳으로 한정하므로 정기 수집에는 LLM 비용이 없다. `llm/enrich.ts`의 `enrichWithLlm()` 하나가 상한 확인·추론·검증·단계 생성을 모두 담당하고, 세 호출처는 그 함수만 부른다. 어떤 실패도 예외가 아니라 `AnalyzeStep` warn으로 환원되어 기존 휴리스틱 결과가 그대로 반환된다.

**Tech Stack:** TypeScript, Next.js App Router, Hono, Zod, linkedom, pg, vitest. 신규 npm 의존성 **없음** — OpenAI는 `fetch`로 직접 호출한다.

**Spec:** [docs/superpowers/specs/2026-10-20-llm-field-inference-design.md](../specs/2026-10-20-llm-field-inference-design.md)

## Global Constraints

- 신규 npm 의존성을 추가하지 않는다. `openai` SDK를 쓰지 않고 `fetch` + `AbortSignal.timeout()`으로 호출한다 (CLAUDE.md §22).
- LLM은 셀렉터 문자열만 반환한다. 생성된 코드를 `eval`하거나 실행하지 않는다 (요건정의서 CRAWL-01).
- LLM 호출 지점은 `analyze` / `rebuild-spec` / `self-repair` 셋뿐이다. `collectSource`의 정기 수집 경로에는 LLM 코드가 들어가지 않는다 (CRAWL-03).
- `LLM_API_KEY`가 비어 있으면 모든 동작이 현재와 **완전히 동일**해야 한다.
- LLM 관련 실패는 절대 `AppError`로 승격되지 않는다. `LlmError`는 `llm/` 디렉터리 밖으로 전파되지 않는다.
- 오류 메시지·API 응답에 프로바이더 원문·스택·API 키를 넣지 않는다 (CLAUDE.md §15).
- SQL은 전부 파라미터 바인딩. `select *` 금지. SQL 상수는 `*.sql.ts`에 둔다 (CLAUDE.md §11, §12).
- 적용된 마이그레이션(001, 002)은 수정하지 않는다. 새 파일 `003_llm_calls.sql`을 추가한다 (CLAUDE.md §19).
- `any` 금지. 외부 데이터는 `unknown`으로 받고 zod로 검증한다 (CLAUDE.md §16, §23).
- 테스트 파일은 소스 옆에 `*.test.ts`로 둔다. 실제 네트워크·DB 호출 테스트는 만들지 않는다.
- 커밋 메시지는 한글로, "왜" 변경했는지가 드러나게 쓴다 (CLAUDE.md §27).
- 필드 상한: 소스당 12개. `key` 정규식: `^[a-z][a-z0-9_]{0,31}$`.
- 채움률 임계치: 필드 폐기 30% 미만, 구제 모드 title 80% 미만.
- 기본값: 모델 `gpt-4o-mini`, base `https://api.openai.com/v1`, temperature 0, maxTokens 2000, timeout 20000ms, `LLM_DAILY_LIMIT` 50, `LLM_DAILY_LIMIT_SYSTEM` 200.

## Review Focus

스펙이 함축하지만 어느 태스크의 테스트도 짚지 않는 입력들. 각 줄의 테스트를 해당 코드를 가진 태스크에 넣었다.

1. **`attr: "href"`로 추론된 url 타입 필드가 상대 경로로 저장된다** — `applyDomSpec`은 `spec.fields`의 값에 `absolutize`를 적용하지 않는다. `/notice/view?id=3` 같은 값이 `attrs`에 들어가 데스크에서 열리지 않는다. → Task 4에서 `type === "url"`인 필드를 절대 URL로 변환하는 테스트.
2. **잘못된 문법의 `itemSelector`로 `digestItems`를 부르면 예외가 전파된다** — `querySelectorAll("div[[")`는 던지고, `enrichWithLlm`이 아직 try로 감싸기 전 단계에서 터진다. → Task 3에서 빈 문자열 반환 테스트.
3. **LLM이 같은 `key`를 두 번 반환하면 하나가 조용히 사라진다** — `Record<string, FieldSelector>`로 병합하므로 뒤 항목이 앞을 덮어쓴다. 사용자는 필드 하나가 왜 없는지 알 수 없다. → Task 6에서 중복 key 중 첫 번째만 채택하고 나머지는 폐기 사유에 남기는 테스트.
4. **상한 판정 쿼리가 DB 오류로 실패할 때 무제한 호출이 열린다** — 스펙이 이 경우를 정하지 않았다. 비용 폭주 방지가 목적이므로 **fail-closed**(차단)로 결정한다. → Task 5에서 `query`가 reject할 때 `false` 반환 테스트.
5. **`analyzeUrl`의 조기 반환 5곳에 `fieldSource`를 빼먹으면 zod 검증이 실패한다** — error / exists / link-only / detail / list 반환 지점이 모두 `analyzeResultSchema`를 만족해야 한다. → Task 8에서 각 outcome의 반환값이 `analyzeResultSchema.parse`를 통과하는 테스트.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `database/migrations/myportal/003_llm_calls.sql` (신규) | `llm_calls` 테이블·인덱스 |
| `src/server/config/env.ts` (수정) | LLM 설정·상한 기본값, `hasLlm()` |
| `src/server/features/crawl/llm/llm-client.ts` (신규) | `chatJson()` — 전송·타임아웃·JSON 파싱·zod 검증·1회 재시도. myportal 타입 비의존 |
| `src/server/features/crawl/llm/html-digest.ts` (신규) | `digestItems()` / `digestPage()` — LLM 입력용 DOM 축약 |
| `src/server/features/crawl/llm/usage.sql.ts` (신규) | 상한·이력 SQL 상수 |
| `src/server/features/crawl/llm/usage.ts` (신규) | `checkLlmQuota()` / `recordLlmCall()` |
| `src/server/features/crawl/llm/field-inference.ts` (신규) | 프롬프트, 응답 스키마, `inferFields()` / `inferListAndFields()` / `validateInferredFields()` |
| `src/server/features/crawl/llm/enrich.ts` (신규) | `enrichWithLlm()` — 세 호출처의 유일한 진입점 |
| `src/server/features/crawl/extract.ts` (수정) | `FieldSelector`/`CrawlSpec` 확장, `fieldsFromRows(rows, spec?)`, url 필드 절대화 |
| `src/server/features/crawl/analyze.ts` (수정) | `analyzeUrl(userId, …)`, 보강·구제 경로 연결, `fieldSource` 반환 |
| `src/server/routes/sources.routes.ts` (수정) | `getUserId(c)` 전달 |
| `src/server/features/sources/sources.ts` (수정) | `rebuildSpec`에 LLM 경로 연결 |
| `src/server/features/crawl/collector.ts` (수정) | `repairSpec`에 LLM 경로 연결 |
| `packages/api-contracts/src/index.ts` (수정) | `analyzeResultSchema.fieldSource` |
| `src/app/add-source/page.tsx` (수정) | 'AI 추론' 배지 |

## 태스크 의존 관계

```text
그룹 1 (병렬):  T1 기반설정   T2 llm-client   T3 html-digest   T4 extract 확장
그룹 2 (병렬):  T5 usage (←T1)              T6 field-inference (←T2,T3,T4)
그룹 3:         T7 enrich (←T5,T6)
그룹 4 (병렬):  T8 analyze+routes+contracts (←T7)   T9 rebuild+self-repair (←T7)
그룹 5:         T10 UI 배지 (←T8)   T11 문서·launch.json
```

---

### Task 1: 기반 설정 — 마이그레이션과 환경변수

**Files:**
- Create: `database/migrations/myportal/003_llm_calls.sql`
- Modify: `src/server/config/env.ts:47-49` (기존 `llmApiBase`/`llmApiKey`/`llmModel` 3줄 교체), 끝에 `hasLlm()` 추가
- Modify: `.env.example` (LLM 블록의 "예약된 값" 주석 교체)
- Test: `src/server/config/env.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `env.llmApiBase`, `env.llmApiKey`, `env.llmModel`, `env.llmDailyLimit`, `env.llmDailyLimitSystem` (전부 `string`/`number`), `hasLlm(): boolean`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/server/config/env.test.ts`에 추가. 기존 파일의 `vi.resetModules()` + dynamic import 관례를 따른다.

```ts
describe("LLM 환경변수", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("빈 LLM_API_BASE는 OpenAI 기본 엔드포인트로 대체된다", async () => {
    vi.stubEnv("LLM_API_BASE", "");
    const { env } = await import("./env");
    expect(env.llmApiBase).toBe("https://api.openai.com/v1");
  });

  it("빈 LLM_MODEL은 gpt-4o-mini로 대체된다", async () => {
    vi.stubEnv("LLM_MODEL", "");
    const { env } = await import("./env");
    expect(env.llmModel).toBe("gpt-4o-mini");
  });

  it("LLM_DAILY_LIMIT 기본값은 50, 시스템 기본값은 200이다", async () => {
    vi.stubEnv("LLM_DAILY_LIMIT", "");
    vi.stubEnv("LLM_DAILY_LIMIT_SYSTEM", "");
    const { env } = await import("./env");
    expect(env.llmDailyLimit).toBe(50);
    expect(env.llmDailyLimitSystem).toBe(200);
  });

  it("hasLlm은 API 키 유무로만 판정한다", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const a = await import("./env");
    expect(a.hasLlm()).toBe(false);
    vi.resetModules();
    vi.stubEnv("LLM_API_KEY", "sk-test");
    const b = await import("./env");
    expect(b.hasLlm()).toBe(true);
  });

  it("LLM 미설정이 validateEnv를 실패시키지 않는다", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
    vi.stubEnv("LLM_API_KEY", "");
    const { validateEnv } = await import("./env");
    expect(() => validateEnv()).not.toThrow();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/config/env.test.ts`
Expected: FAIL — `env.llmDailyLimit`이 `undefined`, `hasLlm`이 export되지 않음

- [ ] **Step 3: `env.ts` 수정**

`llmApiBase`/`llmApiKey`/`llmModel` 3줄을 스펙 §6의 코드 블록대로 교체하고 `llmDailyLimit`/`llmDailyLimitSystem`을 추가한다. 빈 문자열을 미설정으로 처리하는 기존 `.trim() || 기본값` 관례를 따르고, 숫자는 기존 `int()` 헬퍼를 쓴다. 파일 끝에 `hasSupabaseAuth()` 옆으로 `hasLlm(): boolean`을 추가한다. `validateEnv()`는 **수정하지 않는다**.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/config/env.test.ts`
Expected: PASS

- [ ] **Step 5: 마이그레이션 작성**

`database/migrations/myportal/003_llm_calls.sql`에 스펙 §7의 SQL을 그대로 쓴다 (테이블 1개 + 인덱스 2개, 전부 `if not exists`).

- [ ] **Step 6: `.env.example` 갱신**

LLM 블록의 "예약된 값 (현재 코드에서는 사용되지 않음)" 2줄 주석을 스펙 §6의 블록으로 교체한다. `LLM_DAILY_LIMIT`/`LLM_DAILY_LIMIT_SYSTEM`을 포함한다.

- [ ] **Step 7: 마이그레이션 적용 확인**

Run: `pnpm db:migrate`
Expected: `003_llm_calls.sql` 적용 로그, 재실행 시 건너뜀. `DATABASE_URL`이 없으면 이 단계는 건너뛰고 Step 8로 간다 — SQL 문법은 Task 5의 쿼리 테스트가 간접 검증한다.

- [ ] **Step 8: 커밋**

```bash
git add database/migrations/myportal/003_llm_calls.sql src/server/config/env.ts src/server/config/env.test.ts .env.example
git commit -m "LLM 호출 이력 테이블과 환경변수 추가 — 일별 상한으로 비용 폭주를 막기 위함"
```

---

### Task 2: `llm-client.ts` — 전송 계층

**Files:**
- Create: `src/server/features/crawl/llm/llm-client.ts`
- Test: `src/server/features/crawl/llm/llm-client.test.ts`

**Interfaces:**
- Consumes: 없음 (zod만 import. **myportal 타입을 import하지 않는다** — 3번째 사용 시점에 파일 이동만으로 `shared-packages`로 추출하기 위함)
- Produces:
  ```ts
  export class LlmError extends Error {
    constructor(message: string, readonly kind: "http" | "timeout" | "schema");
  }
  export interface ChatJsonOptions {
    baseUrl: string; apiKey: string; model: string;
    system: string; user: string;
    maxTokens?: number; temperature?: number; timeoutMs?: number;
  }
  export interface ChatJsonResult<T> {
    data: T;
    promptTokens: number | null;
    completionTokens: number | null;
    durationMs: number;
  }
  export async function chatJson<T>(
    schema: ZodType<T>, opts: ChatJsonOptions,
  ): Promise<ChatJsonResult<T>>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`globalThis.fetch`를 `vi.fn()`으로 교체한다. 응답 헬퍼는 `(content: string, usage?) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) })`.

```ts
const schema = z.object({ fields: z.array(z.object({ key: z.string() })) });
const opts = { baseUrl: "https://api.test/v1", apiKey: "sk-x", model: "m", system: "s", user: "u" };

it("유효한 JSON 응답을 파싱해 반환한다", async () => {
  // 1회 호출, data.fields[0].key === "deadline"
});

it("응답의 usage 토큰 수를 결과에 담는다", async () => {
  // usage: { prompt_tokens: 120, completion_tokens: 45 }
  // → promptTokens === 120, completionTokens === 45
});

it("usage가 없으면 토큰 수는 null이다", async () => {
  // promptTokens === null
});

it("비JSON 응답이면 1회 재시도하고, 재시도가 성공하면 데이터를 반환한다", async () => {
  // 1차: "이건 JSON이 아닙니다", 2차: 유효 JSON
  // → fetch 2회 호출, data 반환
});

it("스키마에 맞지 않는 JSON이면 1회 재시도한다", async () => {
  // 1차: '{"wrong":1}', 2차: 유효 JSON → fetch 2회, data 반환
});

it("재시도도 실패하면 kind='schema'인 LlmError를 던진다", async () => {
  // 1차·2차 모두 비JSON → rejects LlmError, kind === "schema", fetch 2회
});

it("HTTP 500이면 재시도하지 않고 kind='http'인 LlmError를 던진다", async () => {
  // { ok: false, status: 500 } → rejects, kind === "http", fetch 1회
});

it("요청 본문에 모델·temperature 0·json_object 응답 형식이 들어간다", async () => {
  // fetch 첫 인자 URL === "https://api.test/v1/chat/completions"
  // body JSON: model "m", temperature 0, response_format.type "json_object"
  // 헤더 Authorization === "Bearer sk-x"
});

it("AbortError는 kind='timeout'인 LlmError로 변환된다", async () => {
  // fetch가 DOMException("", "AbortError")로 reject → kind === "timeout", fetch 1회
});

it("API 키가 오류 메시지에 노출되지 않는다", async () => {
  // HTTP 401 → err.message에 "sk-x"가 포함되지 않음
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/llm-client.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: `chatJson()` 구현**

스펙 §4.1의 동작 1~3을 구현한다. `AbortSignal.timeout(opts.timeoutMs ?? 20000)`을 `fetch`에 넘긴다. 재시도는 `kind === "schema"`일 때만 1회, user 프롬프트 뒤에 실패 사유와 "코드 블록 없이 JSON 객체만 출력하십시오."를 덧붙인다. `durationMs`는 `Date.now()` 차이로 측정한다. 오류 메시지는 `HTTP ${status}` 수준으로만 만들고 응답 본문·`apiKey`를 포함하지 않는다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/llm-client.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/llm/llm-client.ts src/server/features/crawl/llm/llm-client.test.ts
git commit -m "OpenAI 호환 JSON 응답 호출 계층 추가 — SDK 의존성 없이 fetch로 처리하고 스키마 실패만 1회 재시도"
```

---

### Task 3: `html-digest.ts` — 입력 축약

**Files:**
- Create: `src/server/features/crawl/llm/html-digest.ts`
- Test: `src/server/features/crawl/llm/html-digest.test.ts`

**Interfaces:**
- Consumes: `parseHTML` from `linkedom`
- Produces:
  ```ts
  export function digestItems(html: string, itemSelector: string): string;
  export function digestPage(html: string): string;
  export const ITEM_DIGEST_COUNT = 3;
  export const ITEM_DIGEST_BYTES = 2_048;
  export const ITEMS_DIGEST_BYTES = 6_144;
  export const PAGE_DIGEST_BYTES = 20_480;
  export const TEXT_NODE_LIMIT = 80;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it("script·style·주석을 제거한다", () => {
  // <script>alert(1)</script><style>.a{}</style><!--c--><li class="row">항목</li>
  // → "alert" 미포함, ".a{}" 미포함, "c" 주석 미포함, "항목" 포함
});

it("class·id·data-*·href를 보존한다", () => {
  // <li class="row" id="r1" data-pk="7"><a href="/v/7">제목</a></li>
  // → 'class="row"', 'id="r1"', 'data-pk="7"', 'href="/v/7"' 전부 포함
});

it("style·onclick 속성은 제거한다", () => {
  // <li style="color:red" onclick="go(1)">x</li> → "color:red" 미포함, "go(1)" 미포함
});

it("80자를 넘는 텍스트 노드를 절단한다", () => {
  // 200자 텍스트 → 결과에 "…" 포함, 원문 전체는 미포함
});

it("digestItems는 문서 순서 앞 3개 항목만 반환한다", () => {
  // li 10개(각 제목 항목1..항목10) → "항목1".."항목3" 포함, "항목4" 미포함
});

it("digestItems는 잘못된 문법의 셀렉터에 빈 문자열을 반환한다", () => {
  // itemSelector "div[[" → "" (예외를 던지지 않는다)
});

it("digestItems는 매칭이 없으면 빈 문자열을 반환한다", () => {
  // itemSelector ".none" → ""
});

it("digestItems는 총 크기 상한을 넘지 않는다", () => {
  // 각 5KB인 li 3개 → length <= ITEMS_DIGEST_BYTES
});

it("digestPage는 header·nav·footer·aside를 제외한다", () => {
  // <nav>메뉴</nav><main><li>본문항목</li></main><footer>푸터</footer>
  // → "메뉴"·"푸터" 미포함, "본문항목" 포함
});

it("digestPage는 크기 상한을 넘지 않는다", () => {
  // 100KB 본문 → length <= PAGE_DIGEST_BYTES
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/html-digest.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현**

스펙 §4.2의 공통 전처리를 내부 `digest(root: Element): string` 하나로 구현하고 두 공개 함수가 그것을 쓴다. 보존 속성 허용목록은 `["class", "id", "href", "src", "datetime", "title"]` + `data-` 접두사. `querySelectorAll` 호출은 `try/catch`로 감싼다 (Review Focus 2). 상한 초과 시 문자 단위 절단.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/html-digest.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/llm/html-digest.ts src/server/features/crawl/llm/html-digest.test.ts
git commit -m "LLM 입력용 DOM 축약 추가 — 셀렉터 생성에 필요한 class·data 속성만 남겨 토큰을 줄임"
```

---

### Task 4: `extract.ts` — 스펙 포맷 확장과 url 필드 절대화

**Files:**
- Modify: `src/server/features/crawl/extract.ts:5-21` (`FieldSelector`/`CrawlSpec`), `:641-651` (`applyDomSpec`의 추가 필드 루프)
- Modify: `src/server/features/crawl/analyze.ts:58-99` (`fieldsFromRows`)
- Test: `src/server/features/crawl/extract.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: `FieldType`, `FieldRole` from `@myportal/api-contracts`
- Produces:
  ```ts
  // extract.ts
  export interface FieldSelector {
    selector: string; attr?: string;
    label?: string; type?: FieldType; role?: FieldRole;
  }
  export interface CrawlSpec {
    /* 기존 전부 유지 */ fieldSource?: "llm" | "heuristic";
  }
  // analyze.ts
  export function fieldsFromRows(rows: ExtractedRow[], spec?: CrawlSpec | null): SourceField[];
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`extract.test.ts`에 추가. `fieldsFromRows`는 `analyze.ts`에서 import한다.

```ts
describe("fields 메타가 있는 스펙", () => {
  it("applySpec이 추가 필드를 attrs로 추출한다", () => {
    // li에 <span class="org">서울시</span><span class="due">2026-11-30</span>
    // spec.fields = { org: {selector:".org"}, deadline: {selector:".due"} }
    // → rows[0].attrs.org === "서울시", attrs.deadline === "2026-11-30"
  });

  it("type이 url인 필드의 상대 경로를 절대 URL로 바꾼다", () => {
    // <a class="file" href="/down/3">첨부</a>
    // spec.fields = { file: {selector:".file", attr:"href", type:"url"} }
    // pageUrl "https://x.kr/list" → attrs.file === "https://x.kr/down/3"
  });

  it("type이 url이 아닌 필드는 값을 그대로 둔다", () => {
    // 같은 셀렉터·attr에 type 생략 → attrs.file === "/down/3"
  });

  it("절대화할 수 없는 값은 필드를 비운다", () => {
    // attr "href"가 "javascript:void(0)" → attrs.file === undefined
  });
});

describe("fieldsFromRows", () => {
  it("spec의 label·type·role을 우선 사용한다", () => {
    // rows attrs { due: "2026-11-30" }
    // spec.fields.due = { selector:".due", label:"접수기간", type:"date_range", role:"deadline" }
    // → 해당 필드의 label "접수기간", type "date_range", role "deadline"
  });

  it("spec이 없으면 기존 추정으로 폴백한다", () => {
    // rows attrs { deadline: "2026-11-30", views: 12 }
    // spec 미전달 → deadline은 label "deadline"·role "deadline", views는 type "number"·role "none"
  });

  it("spec에 없는 attrs 키도 기존 추정으로 필드를 만든다", () => {
    // rows attrs { org:"서울시", extra:"x" }, spec.fields에 org만 있음
    // → extra 필드가 label "extra"·role "none"으로 생성된다
  });

  it("고정 3개 필드(title/link/published)가 항상 앞에 온다", () => {
    // fields[0].key "title", [1] "link", [2] "published", sortOrder 0,1,2
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/extract.test.ts`
Expected: FAIL — url 절대화 미구현, `fieldsFromRows`가 2번째 인자를 무시

- [ ] **Step 3: `extract.ts` 수정**

`FieldSelector`에 `label`/`type`/`role`, `CrawlSpec`에 `fieldSource`를 추가한다 (스펙 §5). `applyDomSpec`의 추가 필드 루프에서 `fs.type === "url"`이면 `absolutize(v, pageUrl)`를 적용하고, 결과가 `null`이면 그 필드를 넣지 않는다.

- [ ] **Step 4: `fieldsFromRows` 확장**

`analyze.ts`의 `fieldsFromRows`에 `spec?: CrawlSpec | null` 2번째 인자를 추가하고, 스펙 §5의 표대로 `spec.fields?.[key]`의 `label`/`type`/`role`을 우선 사용하고 없으면 기존 로직으로 폴백한다. 기존 호출부(같은 파일 `analyzeUrl`)는 Task 8에서 스펙을 넘기도록 바꾼다 — 이 태스크에서는 인자가 optional이므로 그대로 둔다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/extract.test.ts`
Expected: PASS (기존 테스트 전부 + 신규 8건)

- [ ] **Step 6: 커밋**

```bash
git add src/server/features/crawl/extract.ts src/server/features/crawl/extract.test.ts src/server/features/crawl/analyze.ts
git commit -m "스펙 필드에 표시 메타와 url 절대화 지원 추가 — 추론된 필드가 라벨·역할을 갖고 링크가 열리게 하기 위함"
```

---

### Task 5: `usage.ts` — 일별 호출 상한

**Files:**
- Create: `src/server/features/crawl/llm/usage.sql.ts`, `src/server/features/crawl/llm/usage.ts`
- Test: `src/server/features/crawl/llm/usage.test.ts`

**Interfaces:**
- Consumes: `getDb` from `../../../config/db`, `env` from `../../../config/env`
- Produces:
  ```ts
  export type LlmPurpose = "analyze-fields" | "analyze-rescue" | "rebuild" | "self-repair";
  export interface LlmCallEntry {
    userId: string | null; sourceId: string | null;
    purpose: LlmPurpose; model: string;
    promptTokens: number | null; completionTokens: number | null;
    durationMs: number; ok: boolean; errorCode: string | null;
  }
  export async function checkLlmQuota(userId: string | null): Promise<boolean>;
  export async function recordLlmCall(entry: LlmCallEntry): Promise<void>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`vi.mock("../../../config/db", () => ({ getDb: () => ({ query: queryMock }) }))`로 DB를 모킹한다. 실제 DB에 붙지 않는다.

```ts
it("당일 성공 호출이 상한 미만이면 통과한다", async () => {
  // query → { rows: [{ count: "49" }] }, LLM_DAILY_LIMIT 50 → true
});

it("상한과 같으면 차단한다", async () => {
  // count "50" → false
});

it("userId가 null이면 시스템 상한을 적용한다", async () => {
  // count "150", LLM_DAILY_LIMIT_SYSTEM 200 → true
  // 그리고 쿼리가 user_id is null 조건 SQL로 호출된다
});

it("userId가 있으면 user_id = $1로 파라미터 바인딩한다", async () => {
  // query 2번째 인자가 ["user-1"]
});

it("상한 판정 쿼리가 실패하면 차단한다", async () => {
  // query가 reject → false  (fail-closed: 비용 폭주 방지)
});

it("recordLlmCall이 성공·실패 모두 기록한다", async () => {
  // ok:false 엔트리 → insert 쿼리 호출, 파라미터에 false와 errorCode 포함
});

it("recordLlmCall의 DB 오류는 삼켜진다", async () => {
  // query가 reject → resolves (던지지 않는다)
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/usage.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: `usage.sql.ts` 작성**

상수 2개를 export한다. 컬럼을 명시하고 `select *`를 쓰지 않는다. 날짜 경계는 `created_at >= current_date`.

```ts
export const llmUsageSql = {
  countTodayByUser: `
    select count(*)::text as count
    from myportal.llm_calls
    where user_id = $1 and ok = true and created_at >= current_date
  `,
  countTodaySystem: `
    select count(*)::text as count
    from myportal.llm_calls
    where user_id is null and ok = true and created_at >= current_date
  `,
  insertCall: `
    insert into myportal.llm_calls
        (user_id, source_id, purpose, model, prompt_tokens, completion_tokens, duration_ms, ok, error_code)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `,
};
```

- [ ] **Step 4: `usage.ts` 구현**

스펙 §4.4대로 구현한다. `checkLlmQuota`는 `try/catch`에서 `false`를 반환하고(Review Focus 4) 서버 로그를 남긴다. `recordLlmCall`은 `try/catch`로 오류를 삼키고 로그만 남긴다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/usage.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/server/features/crawl/llm/usage.sql.ts src/server/features/crawl/llm/usage.ts src/server/features/crawl/llm/usage.test.ts
git commit -m "LLM 일별 호출 상한과 이력 기록 추가 — 판정 쿼리 실패 시에는 차단해 비용 폭주를 막음"
```

---

### Task 6: `field-inference.ts` — 추론과 검증

**Files:**
- Create: `src/server/features/crawl/llm/field-inference.ts`
- Test: `src/server/features/crawl/llm/field-inference.test.ts`

**Interfaces:**
- Consumes: `chatJson`, `LlmError`, `ChatJsonResult` (Task 2); `digestItems`, `digestPage` (Task 3); `CrawlSpec`, `FieldSelector`, `ExtractedRow`, `applySpec` (Task 4); `fieldTypeSchema`, `fieldRoleSchema` from `@myportal/api-contracts`
- Produces:
  ```ts
  export interface InferredField {
    key: string; label: string; selector: string; attr?: string;
    type: FieldType; role: FieldRole;
  }
  export interface ValidatedFields {
    spec: CrawlSpec; rows: ExtractedRow[];
    accepted: InferredField[]; rejected: { key: string; reason: string }[];
  }
  export function validateInferredFields(
    html: string, pageUrl: string, baseSpec: CrawlSpec,
    inferred: InferredField[], mode: "enrich" | "rescue",
  ): ValidatedFields | null;

  export async function inferFields(
    html: string, itemSelector: string, model: LlmModelConfig,
  ): Promise<ChatJsonResult<{ fields: InferredField[] }>>;

  export async function inferListAndFields(
    html: string, model: LlmModelConfig,
  ): Promise<ChatJsonResult<{ itemSelector: string; fields: InferredField[] }>>;

  // env에서 읽은 값을 그대로 전달받는다 — 이 모듈은 env를 import하지 않는다.
  export interface LlmModelConfig { baseUrl: string; apiKey: string; model: string; }
  ```

- [ ] **Step 1: 실패하는 테스트 작성 — `validateInferredFields`**

검증이 이 태스크의 핵심 비즈니스 규칙이다. `chatJson`은 `vi.mock`으로 교체한다.

목록 HTML 픽스처: `li.row` 20개. 각 항목에 `<a href="/v/N">제목N</a><span class="org">기관N</span>`. 3번째까지만 `<span class="rare">희귀</span>`를 가진다 (채움률 15%).

```ts
it("유효한 필드를 spec.fields에 병합하고 메타를 보존한다", () => {
  // inferred: [{ key:"org", label:"주최기관", selector:".org", type:"text", role:"none" }]
  // → accepted 1건, spec.fields.org.label === "주최기관", rows[0].attrs.org === "기관1"
});

it("문법이 깨진 셀렉터는 그 필드만 버린다", () => {
  // inferred: org(정상) + bad(selector "div[[")
  // → accepted ["org"], rejected에 { key:"bad" } 포함
});

it("채움률 30% 미만인 필드는 버린다", () => {
  // inferred: rare(selector ".rare", 20건 중 3건 = 15%)
  // → accepted 0건, rejected에 rare 포함 → 반환값 null
});

it("key가 고정 필드와 충돌하면 그 필드만 버린다", () => {
  // inferred: [{key:"title",...}, {key:"org",...}] → accepted ["org"]
});

it("role이 title/link/published면 none으로 강제한다", () => {
  // inferred: [{ key:"org", role:"title", ... }] → accepted[0].role === "none"
});

it("중복 key는 첫 번째만 채택한다", () => {
  // inferred: org(.org) + org(.other) → accepted 1건, selector ".org", rejected에 중복 사유
});

it("통과 필드가 0개면 null을 반환한다", () => {
  // inferred: [{ key:"nope", selector:".nothing", ... }] → null
});

it("rescue 모드에서 itemSelector 매칭이 3건 미만이면 null을 반환한다", () => {
  // baseSpec.itemSelector ".only-two" (2건) → null
});

it("rescue 모드에서 title 채움률 80% 미만이면 null을 반환한다", () => {
  // 20건 중 10건만 앵커·제목을 가진 픽스처 → null
});

it("enrich 모드는 rows가 3건 미만이어도 필드만 검증한다", () => {
  // li 2건 픽스처 + 정상 org 필드 → accepted 1건 (null 아님)
});
```

- [ ] **Step 2: 실패하는 테스트 작성 — 추론 함수**

```ts
it("inferFields는 축약된 항목 HTML을 user 프롬프트에 담아 호출한다", async () => {
  // chatJson 모킹 → 호출 인자 opts.user에 'class="org"' 포함, opts.model === "gpt-4o-mini"
});

it("inferFields는 itemSelector 매칭이 없으면 호출하지 않고 LlmError를 던진다", async () => {
  // digestItems가 "" → chatJson 미호출, rejects LlmError
});

it("inferListAndFields는 축약된 페이지 전체를 담아 호출한다", async () => {
  // opts.user에 본문 항목 텍스트 포함, nav 텍스트 미포함
});

it("두 프롬프트 모두 제목·링크·게시일을 제외하라고 지시한다", async () => {
  // opts.system에 "제목"·"링크"·"게시일" 포함
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/field-inference.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 4: 응답 스키마와 프롬프트 작성**

스펙 §4.3의 zod 스키마 3개(`inferredFieldSchema`, `inferFieldsResponseSchema`, `inferListResponseSchema`)를 그대로 쓴다. 시스템 프롬프트는 스펙 §4.3 "프롬프트 방침"의 항목들을 한국어 지시문으로 옮긴다. `inferListAndFields`의 시스템 프롬프트에 목록 판별 지시를 추가한다.

- [ ] **Step 5: `validateInferredFields` 구현**

스펙 §4.3 "검증" 절차 1~5를 구현한다. 폐기 사유를 `rejected`에 문자열로 남긴다(관측용). 채택된 필드로 만든 스펙에 `fieldSource: "llm"`을 설정한다. 중복 `key`는 첫 항목 채택(Review Focus 3).

- [ ] **Step 6: `inferFields`/`inferListAndFields` 구현**

`digestItems`/`digestPage`로 입력을 만들고 `chatJson`에 넘긴다. 축약 결과가 빈 문자열이면 `chatJson`을 부르지 않고 `LlmError("추론할 항목 HTML이 없습니다", "schema")`를 던진다.

- [ ] **Step 7: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/field-inference.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 8: 커밋**

```bash
git add src/server/features/crawl/llm/field-inference.ts src/server/features/crawl/llm/field-inference.test.ts
git commit -m "LLM 필드 추론과 셀렉터 검증 추가 — 저장 전 실제 실행으로 채움률을 확인해 틀린 셀렉터를 걸러냄"
```

---

### Task 7: `enrich.ts` — 유일한 진입점

**Files:**
- Create: `src/server/features/crawl/llm/enrich.ts`
- Test: `src/server/features/crawl/llm/enrich.test.ts`

**Interfaces:**
- Consumes: `hasLlm`, `env` (Task 1); `checkLlmQuota`, `recordLlmCall`, `LlmPurpose` (Task 5); `inferFields`, `inferListAndFields`, `validateInferredFields` (Task 6); `AnalyzeStep` from `@myportal/api-contracts`
- Produces: 스펙 §4의 `EnrichResult`와 `enrichWithLlm(args)` 시그니처 그대로

- [ ] **Step 1: 실패하는 테스트 작성**

의존 모듈 전부를 `vi.mock`으로 교체한다. 단계 라벨은 `"AI 필드 분석"` 고정.

```ts
const base = { spec: { strategy: "html", itemSelector: "li.row", fields: {} }, rows: [/* 5건 */] };

it("LLM 미설정이면 base를 그대로 돌려주고 warn 단계를 만든다", async () => {
  // hasLlm false → fieldSource "heuristic", step.status "warn",
  // step.detail에 "설정" 포함, chatJson 미호출
});

it("상한 초과면 base를 그대로 돌려주고 warn 단계를 만든다", async () => {
  // checkLlmQuota false → step.status "warn", detail에 "한도" 포함, 추론 미호출
});

it("보강 성공 시 채택 필드 수를 단계에 담는다", async () => {
  // accepted 3건 → step.status "ok", detail에 "3" 포함, fieldSource "llm"
});

it("구제 성공 시 추출 항목 수를 단계에 담는다", async () => {
  // base null, validated rows 24건 → step.status "ok", detail에 "24" 포함
});

it("LlmError가 나도 예외를 던지지 않고 base를 돌려준다", async () => {
  // inferFields reject → fieldSource "heuristic", step.status "warn"
});

it("base가 null이고 구제도 실패하면 null을 반환한다", async () => {
  // validateInferredFields null → 반환값 null
});

it("검증이 전부 폐기하면 base를 돌려준다", async () => {
  // base 있음 + validated null → fieldSource "heuristic", step.status "warn"
});

it("성공·실패 모두 recordLlmCall로 기록한다", async () => {
  // 성공: ok true + 토큰 수 전달 / LlmError: ok false + errorCode 전달
});

it("rss 전략은 호출하지 않는다", async () => {
  // base.spec.strategy "rss" → 추론 미호출, step.status "warn", fieldSource "heuristic"
});

it("오류 메시지에 프로바이더 원문이 들어가지 않는다", async () => {
  // LlmError("upstream: invalid_api_key sk-real") → step.detail에 "sk-real" 미포함
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/enrich.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: `enrichWithLlm` 구현**

순서: `hasLlm()` 확인 → `base.spec.strategy`가 `"html"`이 아니면 건너뜀 → `checkLlmQuota` → `base`가 있으면 `inferFields`(purpose 그대로) 없으면 `inferListAndFields` → `validateInferredFields(mode)` → `recordLlmCall`. 전체를 `try/catch`로 감싸고, 어떤 실패에서도 스펙 §9의 표에 적힌 단계 메시지를 그대로 쓴다. `base`가 `null`이고 구제도 실패하면 `null`, 그 외에는 항상 `EnrichResult`를 반환한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/llm/enrich.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/llm/enrich.ts src/server/features/crawl/llm/enrich.test.ts
git commit -m "LLM 보강 진입점 추가 — 세 호출처가 상한·폴백 규칙을 각자 구현하지 않도록 한 곳으로 모음"
```

---

### Task 8: `analyze.ts` 연결과 계약 변경

**Files:**
- Modify: `packages/api-contracts/src/index.ts:235-250` (`analyzeResultSchema`)
- Modify: `src/server/features/crawl/analyze.ts` (`analyzeUrl` 시그니처, 반환 5곳, 보강·구제 호출)
- Modify: `src/server/routes/sources.routes.ts:26-30`
- Test: `src/server/features/crawl/analyze.test.ts` (신규)

**Interfaces:**
- Consumes: `enrichWithLlm`, `EnrichResult` (Task 7); `fieldsFromRows(rows, spec)` (Task 4)
- Produces: `analyzeUrl(userId: string, rawUrl: string, hint?: string): Promise<AnalyzeResult>`; `AnalyzeResult.fieldSource: "llm" | "heuristic" | null`

- [ ] **Step 1: 실패하는 테스트 작성**

`fetchPage`·`renderPage`·`robotsAllowed`·`getDb`·`enrichWithLlm`을 `vi.mock`으로 교체한다. 네트워크·DB에 붙지 않는다. Review Focus 5를 겨눈다.

```ts
it("모든 outcome의 반환값이 analyzeResultSchema를 통과한다", async () => {
  // error / exists / link-only / detail / list 5가지를 각각 유발하고
  // analyzeResultSchema.parse(result)가 던지지 않음을 확인
});

it("목록 분석 성공 시 enrich 결과의 fieldSource를 응답에 담는다", async () => {
  // enrichWithLlm → fieldSource "llm" → result.fieldSource === "llm"
});

it("enrich가 돌려준 단계가 steps 마지막에 붙는다", async () => {
  // step.label === "AI 필드 분석"이 steps에 포함
});

it("preview.fields는 enrich된 스펙의 메타를 반영한다", async () => {
  // enrich spec.fields.org.label "주최기관" → preview.fields에 label "주최기관" 필드 존재
});

it("목록을 못 찾았고 구제도 실패하면 detail로 끝난다", async () => {
  // enrichWithLlm → null → outcome "detail", fieldSource null
});

it("목록을 못 찾았지만 구제가 성공하면 list로 전환된다", async () => {
  // enrichWithLlm → rows 24건 → outcome "list", preview 존재
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze.test.ts`
Expected: FAIL — `fieldSource`가 반환값에 없어 `analyzeResultSchema.parse`가 실패

- [ ] **Step 3: 계약에 `fieldSource` 추가**

`analyzeResultSchema`에 `fieldSource: z.enum(["llm", "heuristic"]).nullable()`을 추가한다 (스펙 §8).

- [ ] **Step 4: `analyzeUrl` 수정**

1번째 파라미터로 `userId: string`을 추가한다. 조기 반환 5곳 전부에 `fieldSource: null`을 넣는다. 추출 전략 감지 뒤(기존 "6. JS 렌더링 재시도" 다음)에 `enrichWithLlm`을 호출한다 — `outcome`이 있으면 `base`로 넘기고 purpose `"analyze-fields"`, 없으면 `base: null`과 purpose `"analyze-rescue"`. 반환된 `step`을 `steps`에 push한다. `outcome`이 없고 반환값도 `null`이면 기존 `detail` 경로를 그대로 탄다. `fieldsFromRows(outcome.rows, outcome.spec)`로 스펙을 함께 넘긴다.

- [ ] **Step 5: 라우트 수정**

`sources.routes.ts`의 analyze 핸들러에서 `analyzeUrl(getUserId(c), body.data.url, body.data.hint)`로 바꾼다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: 커밋**

```bash
git add packages/api-contracts/src/index.ts src/server/features/crawl/analyze.ts src/server/features/crawl/analyze.test.ts src/server/routes/sources.routes.ts
git commit -m "소스 분석에 LLM 필드 보강·목록 구제 연결 — 지금까지 상세 페이지로 포기했던 URL도 목록으로 등록되게 함"
```

---

### Task 9: `rebuildSpec`·`repairSpec` 연결

**Files:**
- Modify: `src/server/features/sources/sources.ts:181-238` (`rebuildSpec`)
- Modify: `src/server/features/crawl/collector.ts:84-110` (`repairSpec`)
- Test: `src/server/features/crawl/collector.test.ts` (신규)

**Interfaces:**
- Consumes: `enrichWithLlm` (Task 7)
- Produces: 시그니처 변경 없음. 두 함수가 저장하는 스펙에 `fields`와 `fieldSource`가 포함된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`enrichWithLlm`·`getDb`·`fetchPage`를 모킹한다.

```ts
it("repairSpec이 LLM 보강 스펙을 새 버전으로 저장한다", async () => {
  // enrichWithLlm → spec.fields에 org, fieldSource "llm"
  // → insertSpec 파라미터의 JSON에 "org"와 "llm" 포함, 생성방식 "self-repair"
});

it("repairSpec은 LLM 실패 시 휴리스틱 스펙을 저장한다", async () => {
  // enrichWithLlm → fieldSource "heuristic" → 저장은 진행되고 fields는 비어 있음
});

it("repairSpec은 userId null로 enrich를 호출한다", async () => {
  // enrichWithLlm 호출 인자 userId === null, purpose "self-repair"
});

it("rebuildSpec은 userId와 purpose rebuild로 enrich를 호출한다", async () => {
  // enrichWithLlm 호출 인자 userId === "user-1", purpose "rebuild"
});

it("rebuildSpec은 휴리스틱과 LLM 모두 실패하면 EXTRACTION_FAILED를 던진다", async () => {
  // generateSpec null + enrichWithLlm null → AppError code EXTRACTION_FAILED
});

it("render가 필요한 소스는 새 스펙에도 render true가 유지된다", async () => {
  // 기존 spec.render true → 저장된 JSON에 "render":true
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/collector.test.ts`
Expected: FAIL — `enrichWithLlm`이 호출되지 않음

- [ ] **Step 3: `repairSpec` 수정**

`generateSpec` 결과를 `base`로 `enrichWithLlm({ purpose: "self-repair", userId: null, sourceId })`에 넘긴다. `generateSpec`이 `null`이면 `base: null`로 구제를 시도한다. 반환값이 `null`이면 기존대로 `null`을 반환한다. 기존 `prevSpec?.render` 유지 로직은 그대로 두고, enrich 반환 스펙에도 같은 처리를 적용한다.

- [ ] **Step 4: `rebuildSpec` 수정**

같은 방식으로 `enrichWithLlm({ purpose: "rebuild", userId, sourceId })`를 끼운다. 둘 다 실패할 때만 기존 `EXTRACTION_FAILED`를 던진다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/collector.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: 정기 수집 경로에 LLM이 없음을 확인**

Run: `grep -rn "llm" src/server/features/crawl/collector.ts`
Expected: `repairSpec` 안의 참조만 나온다. `collectSource`/`extractRows` 본문에는 없다 (CRAWL-03).

- [ ] **Step 7: 커밋**

```bash
git add src/server/features/sources/sources.ts src/server/features/crawl/collector.ts src/server/features/crawl/collector.test.ts
git commit -m "명세 재생성과 수집 자가복구에도 LLM 보강 적용 — 사이트 개편 후 필드가 조용히 사라지지 않게 함"
```

---

### Task 10: 등록 화면 'AI 추론' 배지

**Files:**
- Modify: `src/app/add-source/page.tsx:476-479` (미리보기 헤더)

**Interfaces:**
- Consumes: `AnalyzeResult.fieldSource` (Task 8)
- Produces: 없음

- [ ] **Step 1: 배지 추가**

미리보기 헤더의 `최근 {previewRows.length}건 · 필드 {fields.length}개 · {result.preview.fetchStrategy}` 뒤에 `result.fieldSource === "llm"`일 때만 `· AI 추론`을 덧붙인다. 같은 `font-mono text-ink-2 / fontSize 11` 스타일을 쓰고, 라운드·그림자·그래디언트를 쓰지 않는다 (`DESIGN.md`).

- [ ] **Step 2: 타입 검사**

Run: `pnpm typecheck`
Expected: 오류 없음

- [ ] **Step 3: 커밋**

```bash
git add src/app/add-source/page.tsx
git commit -m "미리보기에 AI 추론 여부 표시 — 필드 메타의 출처를 사용자가 알 수 있게 함"
```

---

### Task 11: 전체 검증과 문서 갱신

**Files:**
- Modify: `docs/시스템설계서.md` (§4 수집 아키텍처)
- Modify: `docs/개발자가이드.md` (환경변수 절)
- Create or Modify: `.vscode/launch.json`

**Interfaces:**
- Consumes: 완성된 구현 전체
- Produces: 없음

- [ ] **Step 1: 전체 테스트**

Run: `pnpm test`
Expected: 전부 PASS. 실패 시 원인을 분석해 수정한다 (CLAUDE.md §25).

- [ ] **Step 2: lint**

Run: `pnpm lint`
Expected: 오류 없음

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 오류 없음

- [ ] **Step 4: `시스템설계서.md` 갱신**

§4 "수집 아키텍처"의 `collectSource` 흐름 아래에 **LLM 필드 추론** 단락을 추가한다: 호출 지점 3곳, 셀렉터만 반환한다는 점, 검증 임계치(30%/80%), 미설정 시 기존 동작 유지, 일별 상한. §5 데이터 모델 목록에 `llm_calls` 한 줄을 추가한다.

- [ ] **Step 5: `개발자가이드.md` 갱신**

환경변수 절에 `LLM_API_BASE`/`LLM_API_KEY`/`LLM_MODEL`/`LLM_DAILY_LIMIT`/`LLM_DAILY_LIMIT_SYSTEM` 5개를 설명한다. 키 없이도 서비스가 완전히 동작한다는 점과 OpenAI 키 발급 위치를 적는다.

- [ ] **Step 6: `launch.json` 확인**

`.vscode/launch.json`이 없으면 Next.js 서버 사이드 디버깅 구성을 만든다 (`pnpm dev`를 port 3001로 실행하고 `src/server` 중단점이 걸리는 구성). 이미 있으면 그대로 둔다 (CLAUDE.md §25.7).

- [ ] **Step 7: 커밋**

```bash
git add docs/시스템설계서.md docs/개발자가이드.md .vscode/launch.json
git commit -m "LLM 필드 추론 설계와 환경변수를 문서에 반영"
```
