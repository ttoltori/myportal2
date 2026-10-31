# LLM 선행 소스 분석 파이프라인 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 소스 분석을 "알고리즘이 먼저 추측하고 실패하면 LLM이 구제"에서 "렌더링으로 로딩 완료를 보장한 뒤 LLM이 페이지를 읽고 코드가 셀렉터로 번역·검증"으로 바꾸고, 다음 수집에 필요한 측정값을 소스 정보로 보관한다.

**Architecture:** LLM은 CSS 셀렉터를 설계하지 않는다. `stripNoise`를 적용한 DOM에서 만든 번호 붙은 개요를 읽고 `[n]` 번호로 항목·필드를 가리키기만 한다. 셀렉터는 코드가 그 노드들의 조상 체인에서 역산하고, 검증은 LLM 자신이 보고한 값을 정답지로 쓴다. 그래서 정기 수집은 LLM 비용이 0이고 판정이 사이트 종류와 무관해진다. 렌더링 대기는 전역 상수 대신 분석 시점의 측정값을 `sources.fetch_profile`에 담아 참조한다.

**Tech Stack:** TypeScript, Next.js App Router, Hono, Zod, linkedom, playwright-core, pg, vitest. 신규 npm 의존성 **없음**.

**Spec:** [docs/superpowers/specs/2026-10-31-llm-first-source-analysis-design.md](../specs/2026-10-31-llm-first-source-analysis-design.md)

## Global Constraints

- 신규 npm 의존성을 추가하지 않는다 (CLAUDE.md §22).
- LLM은 번호 참조와 메타 문자열만 반환한다. 생성된 코드를 실행하지 않는다 (요건정의서 CRAWL-01).
- LLM 호출 지점은 분석(`analyze`) / 재분석(`rebuild`) / 자가복구(`self-repair`) 셋뿐이다. `collectSource`의 정기 수집 경로에 LLM 코드가 들어가지 않는다 (CRAWL-03).
- `LLM_API_KEY`가 비어 있거나 일별 한도를 초과하면 분석이 **실패하지 않고** 휴리스틱 폴백으로 성공한다.
- `LlmError`는 `llm/`·`analyze/` 디렉터리 밖으로 전파되지 않는다. 모든 LLM 실패는 `AnalyzeStep` warn으로 환원된다.
- 오류 메시지·API 응답에 프로바이더 원문·스택·API 키를 넣지 않는다 (CLAUDE.md §15).
- SQL은 전부 파라미터 바인딩. `select *` 금지. SQL 상수는 `*.sql.ts`에 둔다 (CLAUDE.md §11, §12).
- 적용된 마이그레이션(001~003)은 수정하지 않는다. 새 파일 `004_fetch_profile.sql`을 추가한다 (CLAUDE.md §19).
- `any` 금지. 외부 데이터는 `unknown`으로 받고 zod로 검증한다 (CLAUDE.md §16, §23).
- 테스트는 소스 옆 `*.test.ts`. 실제 네트워크·DB·브라우저 호출 테스트는 만들지 않는다.
- 커밋 메시지는 한글로, "왜"가 드러나게 쓴다 (CLAUDE.md §27).
- **ref 공간 불변식:** 개요의 ref는 `stripNoise`를 적용한 문서의 요소를 가리킨다. `applySpec`이 보는 DOM과 같아야 한다.
- 고정 상수: 개요 상한 `OUTLINE_MAX_BYTES = 48 * 1024`, 텍스트 노드 절단 `TEXT_NODE_LIMIT = 120`, 링크 구역 상한 40개, 보고 항목 상한 12, 필드 상한 12, `key` 정규식 `^[a-z][a-z0-9_]{0,31}$`.
- 검증 임계치: 추출 행 수 ≥ 3, 행 수 ≥ min(보고 수, 10) × 0.7, `rowYield` ≥ 0.6, 제목 일치율 ≥ 0.8, 필드 채움률 ≥ 0.3, 필드 값 일치율 ≥ 0.5.
- 프로파일: `settleMs = clamp(measuredReadyMs × 1.5, 1500, 20000)`, `mode = "static"`은 정적 행 수 ≥ 렌더 행 수 × 0.8일 때.
- LLM 호출 상한은 분석 1건당 2회(최초 + 보수 1회).

## Review Focus

설계가 함축하지만 어느 태스크의 테스트도 짚지 않는 입력들. 각 줄의 테스트를 해당 코드를 가진 태스크에 넣었다.

1. **`itemSelector`가 메뉴까지 과포함해도 검증을 통과한다** — 보고된 12개 제목이 500행 안에 전부 있으면 제목 일치율은 100%다. 사용자는 공고 목록을 등록했는데 메뉴 항목이 함께 수집된다. → Task 5에서 매칭 요소 대비 추출 행 `rowYield < 0.6`일 때 전체 폐기 테스트.
2. **개요가 절단되어 LLM이 범위 밖 번호를 가리킨다** — 스키마는 `positive int`만 보므로 `refs[999]`가 `undefined`로 통과하고, 합성 단계에서 `el.parentElement` 접근이 터진다. → Task 4에서 범위 밖 ref를 가진 필드·항목을 버리고 나머지로 합성하는 테스트.
3. **두 필드가 같은 ref를 가리킨다** — `fields`는 배열이라 key 중복은 스키마로 막히지 않고, 같은 노드를 두 key로 저장하면 같은 값이 두 번 나온다. → Task 4에서 같은 `(selector, attr)` 조합의 중복 필드 중 첫 번째만 채택하는 테스트.
4. **로딩 완료를 timeout으로 판정했을 때 그 측정값을 신뢰한다** — `readyBy: "timeout"`은 "DOM이 안정되지 않았다"는 뜻인데 `measuredReadyMs`를 그대로 쓰면 다음 수집이 부족한 시간만 기다린다. → Task 6에서 `readyBy: "timeout"`이면 `settleMs`를 상한(20000)으로 두는 테스트.
5. **제목 요소가 모두 같은 부모를 공유한다** — `<td>` 안에 제목들이 나란히 있는 레이아웃이면 조상 체인이 갈라지지 않아 항목 루트를 못 잡는다. → Task 4에서 항목 루트가 갈라지지 않을 때 `null`을 반환해 폴백으로 넘기는 테스트.

---

### Task 1: 셀렉터 생성 유틸 분리

`extract.ts`에 private으로 묻혀 있는 셀렉터 생성 함수를 꺼내고, 합성 단계가 필요한 `relativeSelector`를 추가한다.

**Files:**
- Create: `src/server/features/crawl/dom-selector.ts`
- Create: `src/server/features/crawl/dom-selector.test.ts`
- Modify: `src/server/features/crawl/extract.ts` — `selectorFor`/`parentSelector`/`cssEscape` 제거하고 새 모듈에서 import

**Interfaces:**
- Produces:
  - `cssEscape(s: string): string`
  - `selectorFor(el: Element): string` — `tag.firstClass` 또는 `tag`
  - `parentSelector(el: Element): string` — 식별 가능한 조상으로 한정한 셀렉터
  - `relativeSelector(root: Element, el: Element): string | null` — `root.querySelector()`로 `el`에 도달하는 상대 셀렉터. `el`이 `root`의 후손이 아니면 `null`
  - `commonSelector(els: Element[]): string | null` — 여러 요소를 모두 포함하는 공통 셀렉터

- [ ] **Step 1: 실패하는 테스트 작성** — `src/server/features/crawl/dom-selector.test.ts`

```ts
// relativeSelector
test("클래스가 있으면 클래스로 상대 셀렉터를 만든다", ...)
//   <li class="item"><span class="date">2026-01-05</span></li>
//   → "span.date", root.querySelector(result) === 그 span
test("클래스가 없으면 nth-child로 경로를 만든다", ...)
//   <li><div><span>값</span></div></li> → "div:nth-child(1) > span:nth-child(1)"
test("root 자신을 가리키면 null을 반환한다", ...)
test("root의 후손이 아니면 null을 반환한다", ...)
test("클래스에 CSS 특수문자가 있으면 이스케이프한다", ...)
//   class="w-1/2" → "div.w-1\\/2"
// commonSelector
test("공통 클래스가 있으면 모든 요소를 포함하는 셀렉터를 만든다", ...)
test("공통 클래스가 없으면 부모 기준 자식 셀렉터를 만든다", ...)
test("빈 배열이면 null을 반환한다", ...)
```

각 테스트는 `parseHTML`로 문서를 만들고, 반환된 셀렉터를 **실제로 실행해** 대상 요소에 도달하는지 확인한다. 문자열 비교만 하면 셀렉터가 유효한지 증명하지 못한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/dom-selector.test.ts`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: `dom-selector.ts` 구현**

`selectorFor`/`parentSelector`/`cssEscape`는 `extract.ts:482-513`에서 그대로 옮긴다(동작 변경 없음). `relativeSelector`는 `el`에서 `root`까지 조상을 올라가며 각 단계의 셀렉터 조각을 모아 `>`로 잇는다. 각 조각은 클래스가 있으면 `tag.class`, 없으면 `tag:nth-child(n)`.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/dom-selector.test.ts`
Expected: PASS

- [ ] **Step 5: `extract.ts`에서 중복 제거하고 전체 테스트 통과 확인**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS — 기존 `extract.test.ts` 463줄이 그대로 통과해야 한다

- [ ] **Step 6: 커밋**

```bash
git add src/server/features/crawl/dom-selector.ts src/server/features/crawl/dom-selector.test.ts src/server/features/crawl/extract.ts
git commit -m "셀렉터 생성 유틸을 extract.ts에서 분리"
```

---

### Task 2: 페이지 개요와 ref 맵

**Files:**
- Create: `src/server/features/crawl/analyze/page-outline.ts`
- Create: `src/server/features/crawl/analyze/page-outline.test.ts`
- Modify: `src/server/features/crawl/extract.ts` — `stripNoise`를 export

**Interfaces:**
- Consumes: 없음
- Produces:
  - `interface PageOutline { text: string; refs: (Element | null)[]; truncated: boolean; document: Document }`
  - `buildPageOutline(html: string): PageOutline`
  - `OUTLINE_MAX_BYTES`, `TEXT_NODE_LIMIT`, `LINK_SECTION_LIMIT` 상수 export

`document`를 함께 반환하는 이유: Task 4의 합성이 `refs`의 요소와 **같은 문서 인스턴스**에서 조상 체인을 타야 한다. 호출자가 html을 다시 파싱하면 다른 인스턴스가 되어 ref가 무의미해진다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
test("텍스트 노드와 링크에 1부터 번호를 붙인다", ...)
//   refs[0] === null, refs[1]은 첫 번째 번호가 붙은 노드의 요소
test("번호가 가리키는 요소는 그 텍스트의 가장 가까운 부모 요소다", ...)
//   <td>접수기간: <span>2026-01-05</span></td> → 두 조각이 각각 td와 span
test("앵커는 경로와 텍스트를 함께 표기한다", ...)
//   개요 줄에 "a→/notice/1234" 와 제목이 모두 포함
test("nav 안의 노드에는 번호를 붙이지 않는다", ...)
//   stripNoise가 제거하므로 refs에 그 요소가 없다 — ref 공간 불변식
test("개요 끝에 원본 문서의 링크 구역을 덧붙인다", ...)
//   nav의 링크가 '페이지 내 링크' 구역에 라벨→URL로 나타나고, 번호는 없다
test("링크 구역은 40개로 제한한다", ...)
test("텍스트 노드를 120자로 절단한다", ...)
test("48KB를 넘으면 뒤에서 절단하고 truncated를 true로 둔다", ...)
test("빈 HTML에서 빈 개요와 refs=[null]을 반환한다", ...)
test("html 태그 없는 조각도 처리한다", ...)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/page-outline.test.ts`
Expected: FAIL

- [ ] **Step 3: `buildPageOutline` 구현**

`parseHTML(html)` → `stripNoise(document)` → 추가로 `svg` 제거 → `document.body`(비어 있으면 `documentElement`)를 깊이 우선 순회. 링크 구역은 **별도로 파싱한 원본 문서**에서 `a[href]`를 모아 만든다(stripNoise 전). 절단은 번호 부여 순회를 중단하는 방식으로 하고, 링크 구역은 절단 후에도 붙인다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/page-outline.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/analyze/page-outline.ts src/server/features/crawl/analyze/page-outline.test.ts src/server/features/crawl/extract.ts
git commit -m "LLM이 번호로 노드를 가리킬 수 있도록 페이지 개요 생성"
```

---

### Task 3: LLM 해석 호출

**Files:**
- Create: `src/server/features/crawl/analyze/llm-read.ts`
- Create: `src/server/features/crawl/analyze/llm-read.test.ts`

**Interfaces:**
- Consumes: `chatJson`, `LlmError` (`../llm/llm-client`), `PageOutline` (Task 2), `fieldTypeSchema`/`fieldRoleSchema` (`@myportal/api-contracts`)
- Produces:
  - `type PageReadResult = z.infer<typeof pageReadResponseSchema>` — 설계서 §5-3의 스키마 그대로
  - `readPage(args: { outline: PageOutline; pageUrl: string; hint?: string; model: LlmModelConfig }): Promise<ChatJsonResult<PageReadResult>>`
  - `readPageRepair(args: { outline: PageOutline; pageUrl: string; hint?: string; model: LlmModelConfig; attempted: { itemSelector: string; extractedTitles: string[] } }): Promise<ChatJsonResult<PageReadResult>>`
  - `interface LlmModelConfig { baseUrl: string; apiKey: string; model: string }` — `field-inference.ts`에서 옮겨온다
  - `hintMatchesOutline(outline: PageOutline, hint: string): boolean`

- [ ] **Step 1: 실패하는 테스트 작성** — `chatJson`을 `vi.mock`으로 대체

```ts
test("응답을 스키마로 검증해 돌려준다", ...)
test("pageKind가 enum 밖이면 LlmError(schema)를 던진다", ...)
//   chatJson이 내부에서 재시도 후 던지는 동작을 그대로 확인
test("items가 빈 배열이어도 성공으로 받는다", ...)
//   목록 없음은 LLM의 유효한 판단이다
test("fields의 key가 정규식에 맞지 않으면 거부한다", ...)
test("힌트가 있으면 프롬프트에 단서 문장을 넣는다", ...)
//   chatJson 호출 인자의 user에 힌트 문자열이 포함
test("힌트가 개요에 없으면 hintMatchesOutline이 false다", ...)
test("보수 호출은 시도한 셀렉터와 추출된 제목을 프롬프트에 넣는다", ...)
test("timeout은 LlmError(timeout)으로 전파된다", ...)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/llm-read.test.ts`
Expected: FAIL

- [ ] **Step 3: `llm-read.ts` 구현**

프롬프트 문구는 설계서 §5-3의 요지를 그대로 쓴다. `maxTokens`는 항목 12 × 필드 12의 JSON을 담아야 하므로 `4000`, `temperature` 0, `timeoutMs` 40000(기본 20000은 48KB 입력에 부족하다).

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/llm-read.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/analyze/llm-read.ts src/server/features/crawl/analyze/llm-read.test.ts
git commit -m "LLM이 셀렉터 대신 번호 참조로 목록을 보고하게 함"
```

---

### Task 4: 셀렉터 합성

이 태스크가 설계의 핵심이다. 순수 함수이므로 테스트가 가장 두껍다.

**Files:**
- Create: `src/server/features/crawl/analyze/selector-synthesis.ts`
- Create: `src/server/features/crawl/analyze/selector-synthesis.test.ts`
- Create: `src/server/features/crawl/analyze/__fixtures__/table-board.html`
- Create: `src/server/features/crawl/analyze/__fixtures__/card-grid.html`
- Create: `src/server/features/crawl/analyze/__fixtures__/ul-list.html`
- Create: `src/server/features/crawl/analyze/__fixtures__/nested-div.html`

**Interfaces:**
- Consumes: `PageOutline` (Task 2), `PageReadResult` (Task 3), `relativeSelector`/`commonSelector` (Task 1), `CrawlSpec` (`../extract`)
- Produces:
  - `interface SynthesisResult { spec: CrawlSpec; dropped: { key: string; reason: string }[]; remapped: number }`
  - `synthesizeSpec(outline: PageOutline, read: PageReadResult, pageUrl: string): SynthesisResult | null`

- [ ] **Step 1: 실패하는 테스트 작성**

픽스처 4종은 실제 사이트 구조를 축약해 손으로 만든다(테이블 게시판 `table>tbody>tr`, 카드 그리드 `div.card`, `ul>li`, 클래스 없는 중첩 div). 각 픽스처에서 `buildPageOutline`을 돌려 ref를 얻고, 사람이 읽어 "LLM이 이렇게 답했을 것"인 `PageReadResult`를 손으로 쓴다.

```ts
// 정상 합성 — 픽스처 4종 각각
test.each(fixtures)("%s: itemSelector가 모든 항목 루트를 포함한다", ...)
test.each(fixtures)("%s: 필드 상대 셀렉터가 항목 기준으로 동작한다", ...)
//   합성 결과로 applySpec을 돌려 LLM이 보고한 값이 attrs에 들어오는지 확인
// Review Focus 2
test("범위 밖 ref를 가진 필드를 버리고 나머지로 합성한다", ...)
test("모든 항목의 titleRef가 범위 밖이면 null을 반환한다", ...)
// Review Focus 3
test("같은 ref를 가리키는 중복 필드는 첫 번째만 채택하고 사유를 남긴다", ...)
// Review Focus 5
test("제목 요소들이 같은 부모를 공유해 조상이 갈라지지 않으면 null을 반환한다", ...)
// ref 어긋남 복구
test("ref 노드 텍스트가 LLM이 적은 값과 다르면 값으로 재탐색하고 remapped를 센다", ...)
test("값으로도 못 찾으면 그 필드를 버린다", ...)
// 고정 역할
test("key가 title/link/published인 필드를 버린다", ...)
test("role이 title/link/published인 필드를 버린다", ...)
test("제목·링크·게시일은 titleSelector/linkSelector/publishedSelector로 분리한다", ...)
// 값 추출 방식
test("앵커이고 type=url이면 attr=href를 붙인다", ...)
test("img이면 attr=src를 붙인다", ...)
test("time[datetime]이면 attr=datetime을 붙인다", ...)
// 항목 수
test("해소된 제목이 1개뿐이면 null을 반환한다", ...)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/selector-synthesis.test.ts`
Expected: FAIL

- [ ] **Step 3: `synthesizeSpec` 구현**

설계서 §5-4의 7단계를 그대로 따른다. 항목 루트 결정은 다음 알고리즘으로 한다(시그니처와 테스트가 결정하지 않는 부분이므로 명시한다).

```text
resolveItemRoot(titleEls: Element[]): Element[] | null
  1. titleEls[0]의 조상 체인을 root까지 배열로 만든다 (자신 포함, 가까운 순)
  2. titleEls[1]의 조상 체인도 같이 만든다
  3. 두 체인에서 처음으로 나타나는 공통 조상 C를 찾는다
  4. 각 제목의 체인에서 C의 바로 직전 요소가 그 제목의 항목 루트다
  5. 어느 제목의 항목 루트가 C 자신이면(= 제목이 C의 직계) null
  6. titleEls가 3개 이상이면 3번째로 같은 계산을 해 루트가 서로 다른지 확인
```

텍스트 정규화는 `s.replace(/\s+/g, " ").trim()` 후 소문자 비교, 포함 관계(`includes`)로 일치 판정.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/selector-synthesis.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/analyze/selector-synthesis.ts src/server/features/crawl/analyze/selector-synthesis.test.ts src/server/features/crawl/analyze/__fixtures__/
git commit -m "LLM이 가리킨 노드에서 추출 셀렉터를 역산"
```

---

### Task 5: 검증

**Files:**
- Create: `src/server/features/crawl/analyze/verify.ts`
- Create: `src/server/features/crawl/analyze/verify.test.ts`

**Interfaces:**
- Consumes: `applySpec` (`../extract`), `PageReadResult` (Task 3), `CrawlSpec`
- Produces:
  - `interface VerifyScore { itemCount; matchedCount; reportedCount; rowYield; titleMatchRate; fieldRates: Record<string, { fill: number; match: number }>; ok: boolean }`
  - `verifySpec(html: string, pageUrl: string, spec: CrawlSpec, read: PageReadResult): { rows: ExtractedRow[]; score: VerifyScore }`
  - `pruneFailedFields(spec: CrawlSpec, score: VerifyScore): CrawlSpec` — 임계치 미달 필드를 제거한 스펙

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// Review Focus 1
test("매칭 요소 대비 추출 행 수율이 0.6 미만이면 ok=false", ...)
//   메뉴 li 20개 + 공고 li 5개를 함께 잡은 셀렉터 → rowYield 0.2
test("수율 경계 0.6은 통과하고 0.59는 실패한다", ...)
test("추출 행이 3건 미만이면 ok=false", ...)
test("행 수가 min(보고 수,10)의 0.7 미만이면 ok=false", ...)
test("보고 항목이 12건이어도 기준은 10건으로 계산한다", ...)
test("제목 일치율 경계 0.8은 통과하고 0.79는 실패한다", ...)
test("채움률 0.3 미만인 필드만 fieldRates에 낮게 기록하고 전체는 ok=true", ...)
test("값 일치율 0.5 미만인 필드는 pruneFailedFields가 제거한다", ...)
test("pruneFailedFields는 임계치를 넘는 필드를 보존한다", ...)
test("itemSelector 문법이 깨져 있으면 ok=false로 환원한다", ...)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/verify.test.ts`
Expected: FAIL

- [ ] **Step 3: `verifySpec`·`pruneFailedFields` 구현**

`matchedCount`는 `parseHTML(html)` + `stripNoise` 후 `querySelectorAll(itemSelector).length`를 100으로 상한. `applySpec`도 100으로 자르므로 같은 기준이어야 한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/verify.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/analyze/verify.ts src/server/features/crawl/analyze/verify.test.ts
git commit -m "LLM이 읽은 내용을 정답지로 삼아 합성 스펙을 검증"
```

---

### Task 6: 렌더링 측정과 수집 프로파일

**Files:**
- Modify: `src/server/features/crawl/render.ts`
- Create: `src/server/features/crawl/analyze/profile.ts`
- Create: `src/server/features/crawl/analyze/profile.test.ts`

**Interfaces:**
- Consumes: `applySpec`, `CrawlSpec`
- Produces:
  - `render.ts`: `interface RenderOptions { waitForSelector?: string; settleMs?: number; scrollToBottom?: boolean }`, `interface RenderTimings { readyMs: number; readyBy: "selector" | "networkidle" | "stabilized" | "timeout"; grewByScroll: boolean }`, `renderPage(rawUrl: string, opts?: RenderOptions): Promise<{ finalUrl: string; html: string; timings: RenderTimings }>`
  - `profile.ts`: `fetchProfileSchema` (zod), `type FetchProfile`, `buildFetchProfile(args)`, `settleBudget(timings: RenderTimings): number`, `profileFromLegacySpec(spec: CrawlSpec | null): FetchProfile` — `spec.render`로 `mode`를 유도하는 기존 소스 호환

`renderPage`의 반환 형태가 바뀌므로 기존 호출처 2곳(`analyze.ts`, `collector.ts`)이 깨진다. 이 태스크에서는 `const { html, finalUrl } = await renderPage(url)`로 구조 분해만 맞춰 두고, 프로파일 사용은 Task 9·12에서 연결한다.

- [ ] **Step 1: 실패하는 테스트 작성** — `profile.test.ts`만. `render.ts`는 playwright 실행이 필요해 단위 테스트를 만들지 않는다(기존 코드에도 `render.test.ts`가 없다). 측정 로직 중 순수한 부분(`settleBudget`)을 `profile.ts`로 빼서 테스트한다.

```ts
// settleBudget — Review Focus 4
test("측정값의 1.5배를 쓴다", ...)                        // 2000 → 3000
test("하한 1500을 적용한다", ...)                          // 200 → 1500
test("상한 20000을 적용한다", ...)                         // 30000 → 20000
test("readyBy가 timeout이면 측정값을 믿지 않고 상한을 쓴다", ...)
// buildFetchProfile
test("전략이 rss면 mode=feed이고 셀렉터를 담지 않는다", ...)
test("정적 행 수가 렌더 행 수의 0.8 이상이면 mode=static", ...)
test("정적 행 수가 모자라면 mode=rendered", ...)
test("렌더 행이 0이면 mode=rendered로 두고 셀렉터를 담지 않는다", ...)
test("mode=rendered면 itemSelector를 waitForSelector에 담는다", ...)
test("grewByScroll이면 scrollToBottom=true", ...)
test("measuredAt을 ISO 8601로 기록한다", ...)
// profileFromLegacySpec
test("spec.render가 true면 mode=rendered", ...)
test("spec이 null이면 mode=static", ...)
test("strategy가 rss인 spec이면 mode=feed", ...)
// 스키마
test("fetchProfileSchema가 알 수 없는 키를 걸러낸다", ...)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze/profile.test.ts`
Expected: FAIL

- [ ] **Step 3: `render.ts` 확장과 `profile.ts` 구현**

`render.ts`: 기존 상수를 기본값으로 남기고 `opts`로 덮어쓰게 한다. `waitForSelector`가 주어지면 `page.waitForSelector(sel, { timeout: settleMs })`를 먼저 시도해 성공 시 `readyBy: "selector"`로 즉시 반환. `scrollToBottom`이면 `document.body.scrollHeight`가 늘지 않을 때까지 최대 5회 스크롤하고 높이 변화를 `grewByScroll`에 기록. `readyMs`는 `goto` 직전부터 측정.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS — 기존 테스트도 통과해야 한다

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/render.ts src/server/features/crawl/analyze/profile.ts src/server/features/crawl/analyze/profile.test.ts
git commit -m "렌더링 대기를 상수에서 측정값으로 바꾸고 수집 프로파일로 보관"
```

---

### Task 7: 명시적 제목·링크·게시일 셀렉터

합성이 만든 제목 셀렉터를 `applyDomSpec`이 쓰게 한다. 지금은 `pickMainAnchor`가 항목 안에서 **가장 긴 앵커 텍스트**를 제목으로 추측하므로, LLM이 가리킨 제목과 다를 수 있다.

**Files:**
- Modify: `src/server/features/crawl/extract.ts` — `CrawlSpec`에 `titleSelector`/`linkSelector`/`publishedSelector`/`hintSetAt` 추가, `applyDomSpec`이 사용
- Modify: `src/server/features/crawl/extract.test.ts`

**Interfaces:**
- Produces: `CrawlSpec`에 선택 필드 4개 추가. 없으면 기존 동작 그대로(기존 소스 호환).

- [ ] **Step 1: 실패하는 테스트 작성** — `extract.test.ts`에 추가

```ts
test("titleSelector가 있으면 그 요소의 텍스트를 제목으로 쓴다", ...)
//   항목에 긴 앵커와 짧은 제목 앵커가 함께 있을 때 titleSelector가 이긴다
test("linkSelector가 있으면 그 요소의 href를 절대 URL로 링크에 쓴다", ...)
test("publishedSelector가 있으면 그 요소에서만 날짜를 찾는다", ...)
//   항목 전체 텍스트에 다른 날짜가 있어도 영향받지 않는다
test("titleSelector가 매칭되지 않는 항목은 기존 앵커 추측으로 폴백한다", ...)
test("세 셀렉터가 모두 없으면 기존 동작과 동일하다", ...)
test("titleSelector로도 제목을 못 찾으면 그 항목을 건너뛴다", ...)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/extract.test.ts`
Expected: FAIL

- [ ] **Step 3: `applyDomSpec` 수정**

`spec.titleSelector`가 있으면 `el.querySelector(titleSelector)`의 텍스트를 먼저 쓰고, 비면 기존 `pickMainAnchor`/`pickTitleText` 경로로 폴백. 링크·게시일도 같은 방식.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/crawl/extract.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/extract.ts src/server/features/crawl/extract.test.ts
git commit -m "제목·링크·게시일을 추측이 아니라 명시된 셀렉터로 추출"
```

---

### Task 8: 프로파일 영속화

**Files:**
- Create: `database/migrations/myportal/004_fetch_profile.sql`
- Modify: `src/server/features/sources/sources.sql.ts` — `findById`/`latestActiveSpec` 주변에 프로파일 컬럼 추가, `updateFetchProfile` 추가
- Modify: `src/server/features/sources/sources.ts`
- Create: `src/server/features/sources/fetch-profile.test.ts`

**Interfaces:**
- Consumes: `fetchProfileSchema`, `FetchProfile` (Task 6)
- Produces:
  - `saveFetchProfile(sourceId: string, profile: FetchProfile, tx?: DatabaseClient): Promise<void>`
  - `loadFetchProfile(row: { fetch_profile: unknown; }, spec: CrawlSpec | null): FetchProfile` — jsonb를 검증하고, 비었으면 `profileFromLegacySpec`으로 폴백

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
test("빈 jsonb면 spec.render로 mode를 유도한다", ...)
test("저장된 프로파일이 스키마에 맞으면 그대로 쓴다", ...)
test("저장된 프로파일이 스키마에 맞지 않으면 레거시 폴백으로 되돌린다", ...)
//   운영 DB에 손으로 넣은 값이나 구버전 형태가 수집을 깨뜨리면 안 된다
test("pg가 문자열로 돌려준 jsonb도 파싱한다", ...)
//   기존 코드가 typeof === "string" 분기를 쓰는 것과 같은 관례
```

`saveFetchProfile`은 DB 호출이므로 `getDb`를 모킹해 SQL과 파라미터만 확인한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/sources/fetch-profile.test.ts`
Expected: FAIL

- [ ] **Step 3: 마이그레이션과 함수 구현**

```sql
-- 004_fetch_profile.sql
alter table myportal.sources
    add column if not exists fetch_profile jsonb not null default '{}'::jsonb;
```

`sources.sql.ts`에 `updateFetchProfile: "update myportal.sources set fetch_profile = $2 where id = $1"`. `findById`의 컬럼 목록에 `fetch_profile` 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/server/features/sources/fetch-profile.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add database/migrations/myportal/004_fetch_profile.sql src/server/features/sources/
git commit -m "수집 프로파일을 스펙과 분리해 sources에 저장"
```

---

### Task 9: 분석 오케스트레이터 재작성

**Files:**
- Modify: `src/server/features/crawl/analyze.ts` — `detectExtraction` 제거, 새 흐름으로 교체
- Create: `src/server/features/crawl/analyze/run-analysis.ts` — LLM 경로 + 폴백을 담당
- Create: `src/server/features/crawl/analyze/run-analysis.test.ts`
- Modify: `src/server/features/crawl/analyze.test.ts`

**Interfaces:**
- Consumes: Task 2~7의 전부, `checkLlmQuota`/`recordLlmCall` (`../llm/usage`), `hasLlm`/`env` (`../../config/env`), `generateSpec`/`parseJsonLdList` (`../extract`)
- Produces:
  - `interface AnalysisOutcome { spec: CrawlSpec | null; rows: ExtractedRow[]; strategy: "rss" | "structured" | "html"; feedUrl: string | null; fieldSource: "llm" | "heuristic" | null; listCandidates: ParentCandidate[]; suggested: { displayName: string; categoryPath: string[]; tagNames: string[] }; pageKind: PageKind; steps: AnalyzeStep[] }`
  - `runAnalysis(args: { html: string; pageUrl: string; outline: PageOutline; hint?: string; userId: string | null; sourceId: string | null; purpose: LlmPurpose; allowRepair?: boolean }): Promise<AnalysisOutcome>` — `allowRepair`는 기본 `true`. 자가복구가 힌트 없이·힌트로 두 번 호출하므로(Task 11) 그 1회차에서 `false`를 넘겨 분석 1건당 LLM 호출 상한 2회를 지킨다.
  - `ListingAnalysis`에 `profile: FetchProfile | null`, `suggested`, `listCandidates`, `pageKind` 추가

- [ ] **Step 1: 실패하는 테스트 작성** — `run-analysis.test.ts`. `readPage`/`readPageRepair`/`checkLlmQuota`를 모킹.

```ts
test("LLM이 목록을 읽으면 합성·검증을 거쳐 llm fieldSource로 돌려준다", ...)
test("검증 미달이면 보수 호출을 1회 하고 그 결과를 쓴다", ...)
test("보수 후에도 미달이면 휴리스틱 폴백으로 넘어간다", ...)
test("LLM 호출은 분석 1건당 최대 2회다", ...)
test("hasLlm이 false면 LLM을 호출하지 않고 폴백 단계를 남긴다", ...)
test("한도 초과면 폴백하고 단계 detail에 한도 초과를 적는다", ...)
test("LlmError가 나도 예외를 던지지 않고 폴백한다", ...)
test("합성이 null이면 폴백하고 단계에 합성 실패를 적는다", ...)
test("단계 detail에 프로바이더 원문 오류 메시지를 넣지 않는다", ...)
test("pageKind=detail이면 listCandidates를 페이지 앵커로 검증해 돌려준다", ...)
test("listCandidates의 URL이 페이지에 없는 앵커면 버린다", ...)
//   LLM이 URL을 만들어내는 것을 막는다
test("힌트가 개요에 없으면 warn 단계를 남긴다", ...)
test("성공·실패와 무관하게 호출이 발생하면 llm_calls에 기록한다", ...)
test("기록 실패가 분석 결과를 바꾸지 않는다", ...)
test("LLM이 제안한 표시 이름·카테고리 경로·태그를 suggested로 돌려준다", ...)
//   지금 빈 배열로 나가는 요건 ORG-08이 채워지는지
test("allowRepair=false면 검증 미달에도 보수 호출을 하지 않는다", ...)
```

`analyze.test.ts`는 `fetchPage`/`renderPage`/`readPage`를 모킹하고 픽스처로 전 경로를 돌려 다음을 확인한다.

```ts
test("analyzeUrl의 모든 outcome이 analyzeResultSchema를 만족한다", ...)
//   list / detail / link-only / exists / error 다섯 지점
test("preview.profile이 분석 결과에 담긴다", ...)
test("렌더링이 실패해도 정적 HTML로 분석을 계속하고 warn을 남긴다", ...)
test("피드 URL은 렌더링과 LLM 호출 없이 끝낸다", ...)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/analyze`
Expected: FAIL

- [ ] **Step 3: `run-analysis.ts` 구현과 `analyze.ts` 교체**

`analyzeListing`의 새 흐름은 설계서 §3 그대로. 피드 조기 종료(`looksLikeFeed`/`discoverFeedUrl`)는 렌더링 **앞에** 남긴다. 렌더링 실패 시 정적 HTML로 개요를 만들어 LLM 해석을 진행한다(로딩 완료를 보장하지 못한 사실을 warn으로 남긴다). 단계 라벨은 설계서 §8의 표를 그대로 쓴다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/analyze.ts src/server/features/crawl/analyze.test.ts src/server/features/crawl/analyze/run-analysis.ts src/server/features/crawl/analyze/run-analysis.test.ts
git commit -m "분석 경로를 렌더링 선행 + LLM 해석 단일 경로로 교체"
```

---

### Task 10: 계약 변경과 등록 경로

**Files:**
- Modify: `packages/api-contracts/src/index.ts`
- Modify: `src/server/features/crawl/collector.ts` — `createSourceWithBaseline`이 프로파일을 저장
- Modify: `src/server/routes/sources.routes.ts`
- Modify: `src/server/features/crawl/collector.test.ts`

**Interfaces:**
- Consumes: `fetchProfileSchema` (Task 6), `saveFetchProfile` (Task 8)
- Produces: `analyzeResultSchema.preview.profile`, `reanalyzeResultSchema.preview.profile`, `reanalyzeResultSchema.storedHint`, `createSourceRequestSchema.profile`, `applySpecRequestSchema.profile`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
test("createSource가 전달된 프로파일을 검증해 저장한다", ...)
test("프로파일이 스키마에 맞지 않으면 무시하고 빈 프로파일로 등록한다", ...)
//   클라이언트가 보낸 값을 신뢰하지 않는다
test("프로파일이 없으면 fetch_profile을 건드리지 않는다", ...)
test("기존 소스를 재사용하는 등록은 프로파일을 덮어쓰지 않는다", ...)
//   다른 사용자가 이미 등록한 소스의 수집 설정을 신규 구독이 바꿔선 안 된다
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/collector.test.ts`
Expected: FAIL

- [ ] **Step 3: 계약과 등록 경로 수정**

`fetchStrategy`로 `rendered`를 반환하지 않는다 — `html` + `profile.mode = "rendered"`로 표현한다. enum은 호환을 위해 그대로 둔다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/api-contracts/src/index.ts src/server/features/crawl/collector.ts src/server/features/crawl/collector.test.ts src/server/routes/sources.routes.ts
git commit -m "분석이 측정한 수집 프로파일을 등록 시 함께 저장"
```

---

### Task 11: 재분석의 힌트 낡음 표시와 자가복구 순서 역전

**Files:**
- Modify: `src/server/features/sources/reanalyze.ts`
- Modify: `src/server/features/crawl/collector.ts` — `repairSpec`
- Modify: `src/server/features/sources/reanalyze.test.ts`
- Modify: `src/server/features/crawl/collector.test.ts`

**Interfaces:**
- Consumes: `hintMatchesOutline` (Task 3), `analyzeListing` (Task 9)
- Produces: `ReanalyzeResult.storedHint: { value: string; setAt: string | null; matchesPage: boolean } | null`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// reanalyze
test("저장된 힌트와 입력 시점을 storedHint로 돌려준다", ...)
test("저장된 힌트가 현재 페이지에 없으면 matchesPage=false다", ...)
test("hintSetAt이 없는 구버전 스펙이면 setAt=null이다", ...)
test("힌트를 빈 문자열로 넘기면 저장된 힌트를 쓰지 않고 storedHint도 null이다", ...)
test("새 힌트를 적용하면 hintSetAt이 현재 시각으로 저장된다", ...)   // apply-spec
// repairSpec — 순서 역전
test("힌트 없이 먼저 분석하고 성공하면 저장된 힌트를 쓰지 않는다", ...)
test("힌트 없이 실패하면 저장된 힌트로 한 번 더 시도한다", ...)
test("두 번 다 실패하면 null을 반환한다", ...)
test("스펙을 교체해도 fetch_profile을 덮어쓰지 않는다", ...)
//   §1-3의 사고가 재발하지 않는지
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/sources/reanalyze.test.ts src/server/features/crawl/collector.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

`repairSpec`은 `runAnalysis`를 힌트 없이 호출하고, 실패했을 때만 `prevSpec.hint`로 재호출한다. 두 번 호출하면 LLM 호출이 최대 4회가 되므로, 자가복구 경로의 1회차는 **힌트 없는 호출만** 하고 보수 호출은 2회차에서만 허용한다(`runAnalysis`에 `allowRepair: boolean` 인자 추가).

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/sources/reanalyze.ts src/server/features/sources/reanalyze.test.ts src/server/features/crawl/collector.ts src/server/features/crawl/collector.test.ts
git commit -m "낡은 힌트가 자가복구를 영구히 막지 않게 순서를 뒤집음"
```

---

### Task 12: 수집이 프로파일을 쓴다

**Files:**
- Modify: `src/server/features/crawl/collector.ts` — `collectSource`
- Modify: `src/server/features/crawl/collector.test.ts`

**Interfaces:**
- Consumes: `loadFetchProfile` (Task 8), `renderPage(url, opts)` (Task 6)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
test("mode=rendered면 프로파일의 waitForSelector와 settleMs로 렌더링한다", ...)
test("mode=static이면 ETag 조건부 요청으로 fetch한다", ...)
test("프로파일이 비어 있고 spec.render가 true면 렌더링한다", ...)
//   마이그레이션 직후 기존 소스
test("fetch_strategy가 rendered인 기존 소스를 html과 같이 처리한다", ...)
test("mode=feed면 피드를 fetch한다", ...)
test("scrollToBottom이 저장되어 있으면 렌더 옵션으로 넘긴다", ...)
test("정기 수집 경로에서 LLM을 호출하지 않는다", ...)
//   CRAWL-03 — readPage 모킹이 호출되지 않음을 확인
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/server/features/crawl/collector.test.ts`
Expected: FAIL

- [ ] **Step 3: `collectSource` 수정**

`extractRows`의 switch에 `case "rendered":`를 `case "html":`과 합친다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/features/crawl/collector.ts src/server/features/crawl/collector.test.ts
git commit -m "수집이 측정된 프로파일로 대기해 고정 대기를 없앰"
```

---

### Task 13: 프론트엔드 — 힌트 안내와 프로파일 전달

**Files:**
- Modify: `src/app/add-source/page.tsx` — 힌트 입력란 안내, `create`에 `profile` 전달
- Modify: `src/app/sources/[id]/page.tsx` — `storedHint` 표시·경고·`힌트 없이 재분석` 버튼, `apply-spec`에 `profile` 전달
- Modify: `packages/myportal-api-client/src/index.ts` — 변경된 요청 타입 반영

**Interfaces:**
- Consumes: Task 10의 계약

- [ ] **Step 1: 힌트 입력란 안내 문구 추가** — `add-source/page.tsx`

설계서 §6-2의 등록 화면 문구를 그대로 쓴다.

```text
힌트 (선택) — 자동 분석이 엉뚱한 영역을 잡을 때만 쓰세요.
지금 목록에 보이는 제목의 일부를 넣습니다. 목록 내용은 바뀌므로 이 문자열은
시간이 지나면 의미가 없어집니다. 영구 설정이 아닙니다.
```

- [ ] **Step 2: `create` 호출에 `profile: result.preview?.profile ?? null` 추가**

- [ ] **Step 3: 재분석 패널에 저장된 힌트 상태 표시** — `sources/[id]/page.tsx`

`storedHint`가 있으면 입력란 아래에 입력 시점과 경과 일수를 보인다. `matchesPage === false`일 때만 경고와 `힌트 없이 재분석` 버튼(빈 문자열로 재분석 호출)을 보인다. 경과 일수만으로 경고하지 않는다.

- [ ] **Step 4: `apply-spec` 호출에 `profile` 추가**

- [ ] **Step 5: 타입 검사와 빌드 확인**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/app/add-source/page.tsx src/app/sources/ packages/myportal-api-client/src/index.ts
git commit -m "힌트가 시간이 지나면 무의미해진다는 것을 화면에서 환기"
```

---

### Task 14: 레거시 제거와 문서 갱신

**Files:**
- Delete: `src/server/features/crawl/llm/enrich.ts`, `enrich.test.ts`, `field-inference.ts`, `field-inference.test.ts`
- Modify: `docs/요건정의서.md` — SRC-04, ORG-08, NFR-P3
- Modify: `docs/시스템설계서.md` — 분석 흐름, 모듈 구조
- Modify: `docs/개발자가이드.md` — 환경변수, 로컬에서 분석 디버깅하는 방법
- Modify: `.vscode/launch.json` (없으면 생성) — 분석 경로 디버깅 구성

- [ ] **Step 1: 삭제 대상에 남은 참조가 없는지 확인**

Run: `grep -rn "enrichWithLlm\|field-inference\|inferFields\|inferListAndFields\|validateInferredFields" src/ packages/`
Expected: 결과 없음

- [ ] **Step 2: 파일 삭제 후 전체 검증**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: 요건정의서 갱신**

- SRC-04: 수집 방식 시도 순서를 "① RSS/Atom 자동 탐지 → ② 렌더링 + LLM 해석 + 셀렉터 합성·검증 → ③ (LLM 불가 시) 패턴 추정 폴백"으로 고친다.
- ORG-08: 구현됨으로 표시한다.
- NFR-P3: "정적 30초 / 렌더링 60초"를 "분석 60초"로 통합한다.
- 수집 방식 표에서 `rendered`가 `fetch_strategy`가 아니라 프로파일의 `mode`임을 명시한다.

- [ ] **Step 4: 시스템설계서에 새 분석 흐름과 모듈 구조 반영**

설계서 §3·§4의 다이어그램과 모듈 표를 옮긴다.

- [ ] **Step 5: 개발자가이드에 분석 디버깅 절차 추가**

로컬에서 Chrome 없이 렌더링을 쓰는 방법(`pnpm playwright install chromium` 또는 `CHROMIUM_PATH`), `LLM_API_KEY`가 없을 때의 폴백 동작, 특정 URL 하나를 분석해 보는 방법.

- [ ] **Step 6: `launch.json` 작성**

Next.js 서버사이드 디버깅 구성과 `vitest` 단일 파일 디버깅 구성(CLAUDE.md §25-7).

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "LLM 선행 구조로 바뀐 분석 흐름을 문서에 반영하고 대체된 모듈 제거"
```

---

## 완료 조건 (CLAUDE.md §25)

- [ ] `pnpm vitest run` 전체 통과
- [ ] `pnpm lint` 통과
- [ ] `pnpm typecheck` 통과
- [ ] `pnpm build` 통과
- [ ] `.vscode/launch.json`으로 IDE에서 직접 실행·디버깅 가능
- [ ] 개발자가이드에 실행·환경변수·디버깅·배포 절차 반영
