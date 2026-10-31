# LLM 선행 소스 분석 파이프라인 설계

작성일: 2026-10-31
대상: 소스 등록(`/add-source`)·재분석(`/sources/[id]`)·자가복구(`collectSource`)가 공유하는 분석 경로

## 1. 배경과 문제

현재 `analyzeListing`(`src/server/features/crawl/analyze.ts`)은 추출 전략을 순서대로 시도한다.

```text
robots → 정적 fetch
  → detectExtraction: 힌트 → RSS/Atom → 피드 자동탐지 → JSON-LD → DOM 휴리스틱(generateSpec)
  → (실패했거나 힌트 미스면) 헤드리스 렌더링 → detectExtraction 재시도
  → (그래도 실패면) LLM 구제 / (성공했으면) LLM 필드 보강
```

이 구조에 세 가지 문제가 있다.

### 1-1. 알고리즘이 "먼저 맞히는 쪽"이라 특수 케이스가 쌓인다

`generateSpec`은 DOM을 `li, article, tr, dd, div, p` 버킷으로 묶어 점수를 매겨 목록을 추측한다(`extract.ts` 685줄). 점수 함수에 들어간 지식은 전부 사이트별 관찰에서 나온 것이다.

```ts
// extract.ts
const ITEM_TAGS = "li, article, tr, dd, div, p";
const NOISE_TOKENS = new Set([...]);   // 메뉴·푸터로 보이는 class 토큰
const BADGE_TOKENS = new Set([...]);   // 상태 배지로 보이는 class 토큰
const TITLE_HINT_TOKENS = new Set([...]);
const CONTENT_ANCHOR_MIN = 5;
const CONTENT_ANCHOR_TEXT_MIN = 15;
```

새 사이트가 안 되면 토큰 집합이나 임계치를 늘리는 식으로 대응하게 되고, 그 변경이 이미 되던 사이트를 깨뜨릴 위험을 매번 안는다. **"어떤 DOM 패턴이 목록처럼 보이는가"를 코드가 맞히려는 한 범용성은 사이트 수에 반비례한다.**

### 1-2. LLM이 구제 담당이라 가장 어려운 입력만 받는다

LLM은 휴리스틱이 실패한 뒤에 호출되고, 그 시점의 입력은 `digestPage`로 20KB까지 절단한 DOM 조각이다. LLM은 난독화된 클래스명과 깊은 중첩 속에서 `itemSelector`를 직접 설계해야 한다. 틀렸을 때 **왜 틀렸는지 판정할 기준이 없다** — `rescueListIsValid`는 "제목 채움률 80%"라는 자기참조적 기준만 본다.

### 1-3. 렌더링 대기 전략이 전역 상수라 소스별로 조정할 수 없다

```ts
// render.ts
const GOTO_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 6_000;
const SPA_ROUTE_DELAY_MS = 1_000;
const STABLE_POLLS = 3;
const MAX_STABILIZE_MS = 8_000;
```

모든 소스가 같은 값을 쓴다. 빠른 사이트도 DOM 안정화 폴링에 최소 1.5초를 쓰고, 느린 SPA는 8초 안에 못 끝나면 미완성 DOM으로 추출한다. 어느 쪽도 측정값에 근거하지 않는다.

그리고 "렌더링이 필요한가"는 `spec.render` 하나로 `crawl_specs.spec` jsonb 안에 들어 있다. self-repair가 스펙을 새 버전으로 교체할 때 이 플래그가 사라져 렌더링 소스가 조용히 0건이 되는 사고가 이미 발생했고, 코드에 방어 주석이 남아 있다.

```ts
// collector.ts repairSpec
// 구제 모드 스펙에는 render/hint가 없으므로 이전 스펙 값을 다시 입힌다.
// 렌더링이 필요한 소스가 정적 HTML로 되돌아가 영구히 0건이 되는 것을 막는다.
if (prevSpec?.render) regenerated.spec.render = true;
```

## 2. 목표와 비목표

### 목표

1. 분석 경로를 **단일 경로**로 만든다: 렌더링으로 로딩 완료를 보장한 뒤, LLM이 페이지를 해석하고, 코드가 그 해석을 셀렉터로 번역·검증한다.
2. LLM은 **CSS 셀렉터를 설계하지 않는다.** 페이지를 읽고 "무엇이 목록 항목이고 각 항목의 어떤 값이 무슨 의미인지"만 보고한다.
3. 검증 기준을 사이트 구조가 아니라 **LLM이 읽은 내용**에 둔다. 그래서 판정이 사이트 종류와 무관해진다.
4. 다음 수집에 필요한 측정값(렌더링 필요 여부, 로딩 완료 판정 셀렉터, 측정된 대기 시간)을 소스 정보로 보관하고 수집 시 참조한다.
5. 정기 수집에서는 LLM을 호출하지 않는다(요건정의서 CRAWL-03). 셀렉터만 재실행한다.
6. 재분석(`reanalyzeSource`)과 자가복구(`repairSpec`)가 같은 새 경로를 쓴다.
7. 페이지 종류 판정(목록/상세)과 부모 목록 추천을 LLM이 담당한다.
8. 힌트 문자열 입력을 **보조 수단으로 유지**하되, 시간이 지나면 무의미해진다는 사실을 사용자에게 환기시킨다.

### 비목표

- 목록 페이지네이션(다음 페이지) 분석 — 수집기·중복 처리까지 손대야 하는 별도 과제.
- 분석 전용 상위 모델 분리(`LLM_ANALYZE_MODEL`) — 현재 단일 모델을 유지한다. 정확도 부족 증거가 나오면 별건으로 다룬다.
- 항목별 상세 페이지 방문.
- 정기 수집 시점의 LLM 호출.
- LLM이 생성한 코드 실행 — 반환값은 **번호 참조와 메타 문자열뿐**이다.

### 성공 기준

1. 등록 분석이 목록 사이트에서 `itemSelector` + 2개 이상의 추가 필드를 담은 스펙을 만든다.
2. 분석이 만든 스펙으로 `applySpec`을 실행한 결과가 LLM이 보고한 항목과 대조해 임계치를 넘는다(항목 수 일치, 제목 일치율 ≥ 0.8).
3. `LLM_API_KEY`가 비어 있거나 일별 한도를 초과하면 기존 휴리스틱 경로로 폴백해 분석이 **성공한다**(실패하지 않는다).
4. 저장된 `fetch_profile`로 수집했을 때, 렌더링 소스는 `waitForSelector`가 잡히는 순간 추출을 시작한다(고정 대기 제거).
5. self-repair가 스펙을 교체해도 `fetch_profile`은 보존된다.
6. 힌트가 저장된 소스를 재분석하면, 저장된 힌트의 입력 시점과 현재 페이지에서의 매칭 여부가 사용자에게 보인다.

## 3. 전체 흐름

```text
analyzeListing({ userId, url, hint, sourceId, purpose })
  1. robots.txt 확인                                      (변경 없음)
  2. 정적 fetch                                           (유지 — ETag·비교용)
  3. ★ 렌더링: renderPage(url, profileHint?)
       → { html, finalUrl, timings }  로딩 완료 판정·측정
  4. ★ 페이지 개요 생성: buildPageOutline(renderedHtml)
       → { outline: string, refs: Element[] }   stripNoise 적용 DOM 기준
  5. ★ LLM 해석: readPage(outline, hint?)
       → { pageKind, pageTitle, items[], listCandidates?, suggested }
  6. ★ 셀렉터 합성: synthesizeSpec(html, refs, llmResult)
       → CrawlSpec { strategy:"html", itemSelector, fields }
  7. ★ 검증: verifySpec(html, pageUrl, spec, llmResult)
       → { rows, score }   임계치 미달 → repair 1회 → 미달이면 폴백
  8. ★ 프로파일 확정: buildFetchProfile(staticHtml, renderedHtml, spec, timings)
       → FetchProfile { mode, waitForSelector, settleMs, ... }
  → ListingAnalysis { steps, outcome, profile, pageText, ... }
```

RSS/Atom은 3단계 앞에 남는다. URL 자체가 피드이거나(`looksLikeFeed`) 페이지에 피드 링크가 있고(`discoverFeedUrl`) 그 피드가 항목을 주면, 렌더링과 LLM 호출 없이 끝낸다. 피드는 이미 구조화된 데이터이고 LLM이 추가할 것이 없으므로 이 분기는 특수 케이스가 아니라 정당한 조기 종료다.

JSON-LD(`parseJsonLdList`)는 **조기 종료에서 빠진다.** JSON-LD가 있는 페이지도 렌더링·LLM 해석을 거치고, JSON-LD 파싱은 폴백 경로(§7)에만 남는다. 현재 `jsonLd.length >= 3`으로 조기 채택하는데, 사이트가 JSON-LD에 본문 목록이 아닌 빵부스러기나 사이트 메뉴를 넣은 경우를 구분할 방법이 없었다.

## 4. 모듈 구조

```text
src/server/features/crawl/
├─ fetcher.ts                  (변경 없음)
├─ robots.ts                   (변경 없음)
├─ render.ts                   (프로파일 입·출력으로 확장)
├─ extract.ts                  (피드·JSON-LD·applySpec·parseDate 유지,
│                               generateSpec은 폴백 전용으로 격하)
├─ dom-selector.ts             ★ 신규 — 셀렉터 생성 유틸 (extract.ts에서 추출)
├─ analyze.ts                  (오케스트레이터만 남음)
├─ analyze/
│  ├─ page-outline.ts          ★ 번호 붙은 페이지 개요 + ref 맵
│  ├─ llm-read.ts              ★ LLM 호출·응답 스키마
│  ├─ selector-synthesis.ts    ★ ref → itemSelector + 필드 셀렉터
│  ├─ verify.ts                ★ 실행 결과 ↔ LLM 보고 대조
│  └─ profile.ts               ★ 수집 프로파일 측정·조립
└─ llm/
   ├─ llm-client.ts            (변경 없음 — 전송 계층)
   ├─ usage.ts, usage.sql.ts   (변경 없음 — 쿼터·기록)
   ├─ html-digest.ts           (유지 — repair 호출의 항목 HTML 축약에 사용)
   ├─ enrich.ts                ✂ 삭제
   └─ field-inference.ts       ✂ 삭제
```

`enrich.ts`/`field-inference.ts`를 삭제하는 이유: 두 파일의 역할(휴리스틱 결과에 LLM 필드를 덧붙이기, LLM에게 셀렉터를 설계시키기)이 새 설계에서 사라진다. 폴백 경로는 LLM을 쓸 수 없는 상황이므로 LLM 필드 추론도 쓸 수 없다. 쿼터·기록·전송은 `usage.ts`/`llm-client.ts`에 이미 분리되어 있어 그대로 재사용한다.

## 5. 각 단계 설계

### 5-1. 렌더링과 로딩 완료 판정 (`render.ts`)

```ts
export interface RenderOptions {
  // 이 셀렉터가 나타나면 즉시 완료로 본다. 없으면 시간 기반 판정만 쓴다.
  waitForSelector?: string;
  // 시간 기반 판정의 상한. 프로파일에 측정값이 있으면 그 값 + 여유.
  settleMs?: number;
  // 지연 로딩 목록: 끝까지 스크롤한다.
  scrollToBottom?: boolean;
}

export interface RenderTimings {
  // goto 시작부터 로딩 완료 판정까지 경과 시간
  readyMs: number;
  // 완료를 무엇으로 판정했는가 — 프로파일 신뢰도 판단에 쓴다.
  readyBy: "selector" | "networkidle" | "stabilized" | "timeout";
  // 스크롤로 항목이 늘어났는가
  grewByScroll: boolean;
}

export async function renderPage(
  rawUrl: string,
  opts?: RenderOptions,
): Promise<{ finalUrl: string; html: string; timings: RenderTimings }>;
```

판정 순서:

1. `goto(waitUntil: "domcontentloaded")`
2. `waitForSelector`가 주어졌으면 그것을 기다린다. 잡히면 **즉시 완료**(`readyBy: "selector"`).
3. 아니면 `networkidle`을 기다리고, `scrollToBottom`이면 높이가 늘지 않을 때까지 최대 N회 스크롤한다.
4. DOM 안정화 폴링(기존 로직 유지).
5. 어느 단계에서 끝났는지와 경과 시간을 `timings`에 담는다.

분석 시점에는 `waitForSelector`를 모르므로 3~4단계를 타고 `readyMs`를 **측정**한다. 수집 시점에는 프로파일의 `waitForSelector`로 2단계에서 끝낸다. 전역 상수는 기본값으로만 남고 호출자가 덮어쓸 수 있다.

SPA hash 라우트 보존(`withHashRoute`)은 렌더 입력 URL 생성 유틸로 이동해 유지한다.

### 5-2. 페이지 개요와 ref 맵 (`page-outline.ts`)

LLM에게 DOM을 주면 셀렉터를 틀린다. 대신 **번호 붙은 텍스트 개요**를 준다.

```ts
export interface PageOutline {
  text: string;             // LLM 입력
  refs: (Element | null)[]; // 인덱스 → 노드. 0번은 사용하지 않는다.
  truncated: boolean;
}

export function buildPageOutline(html: string): PageOutline;
```

출력 형태 — 들여쓰기로 DOM 깊이를 보이고, 의미 있는 텍스트 노드와 링크에 `[n]`을 붙인다.

```text
    [11] "번호 제목 기관 접수기간 상태"
      [12] a→/notice/1234 "2026년 AI 바우처 지원사업 공고"
      [13] "정보통신산업진흥원"
      [14] "2026-01-05 ~ 2026-02-03"
      [15] "접수중"
      [16] a→/notice/1233 "데이터 활용 기업 모집"
      [17] "한국데이터산업진흥원"
```

**개요는 `stripNoise`를 적용한 문서에서 만든다.** `applySpec`이 추출 전에 `stripNoise(document)`로 `nav`/`header`/`footer`/`aside`/노이즈 클래스 컨테이너를 제거하기 때문이다. 원본 DOM에서 번호를 붙이면 LLM이 가리킨 노드가 추출 시점에는 존재하지 않아, 합성한 셀렉터가 0건을 뽑고 검증에서 폐기된다. **ref 공간과 `applySpec`이 보는 DOM이 같아야 한다**는 것이 이 단계의 불변식이다.

그러면 상세 페이지에서 목록으로 가는 링크(보통 `nav`에 있다)를 잃는다. 이것만 따로 챙긴다: 개요 끝에 **원본 문서**의 앵커를 최대 40개까지 `라벨 → URL` 텍스트로 덧붙인다. 이 구역에는 번호를 붙이지 않는다 — 셀렉터 합성에 쓰이지 않고 부모 목록 후보 URL을 고르는 데만 쓰이므로, 두 번째 ref 공간을 만들 이유가 없다.

```text
── 페이지 내 링크 (목록 후보 판단용) ──
사업공고 → /notice/list.it
알림마당 → /board/index.it
```

규칙:

- `stripNoise` 적용 후 `svg` 추가 제거(`stripNoise`는 `svg`를 지우지 않는다).
- 텍스트 노드는 공백 정규화 후 `TEXT_NODE_LIMIT`(120자)로 절단. 빈 노드는 번호를 받지 않는다.
- 앵커는 `a→경로 "텍스트"` 형태로 href를 함께 보인다(쿼리 포함, 길면 절단). LLM이 항목 링크와 메뉴 링크를 구분하는 핵심 단서다.
- `img`는 `img→src "alt"`로 표기(필드 role=image 후보).
- 들여쓰기는 DOM 깊이를 2칸 단위로 반영하되 최대 깊이에서 포화시킨다.
- 전체 크기 상한 `OUTLINE_MAX_BYTES`(48KB). 넘으면 절단하고 `truncated: true`. 절단은 뒤에서 자른다(목록은 보통 본문 중간~상단에 있고, 푸터가 먼저 잘려야 한다).

`refs`는 인덱스 → `Element`. 텍스트 노드에는 번호를 붙이지만 ref는 **그 텍스트 노드의 부모 요소**를 가리킨다. 셀렉터는 요소 단위로만 만들 수 있기 때문이다. 같은 요소에 텍스트가 여러 조각으로 나뉘어 있으면(`<td>접수기간: <span>2026-01-05</span></td>`) 각 조각이 각자의 가장 가까운 요소를 가리킨다.

### 5-3. LLM 해석 (`llm-read.ts`)

```ts
const pageReadResponseSchema = z.object({
  pageKind: z.enum(["list", "detail", "unknown"]),
  pageTitle: z.string().max(200),
  items: z.array(z.object({
    titleRef: z.number().int().positive(),
    titleText: z.string().max(500),        // ref 검증·폴백 매칭용
    linkRef: z.number().int().positive().optional(),
    fields: z.array(z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
      label: z.string().min(1).max(40),
      type: fieldTypeSchema,
      role: fieldRoleSchema,
      ref: z.number().int().positive(),
      text: z.string().max(500),           // ref 검증·폴백 매칭용
    })).max(12),
  })).max(12),
  listCandidates: z.array(z.object({
    label: z.string().max(60),
    url: z.string().max(2048),
  })).max(5).optional(),
  suggested: z.object({
    displayName: z.string().max(200),
    categoryPath: z.array(z.string().max(60)).max(3),
    tagNames: z.array(z.string().max(60)).max(8),
  }),
});
```

`titleText`/`text`를 함께 받는 이유는 **ref 검증**이다. ref가 가리키는 노드의 실제 텍스트와 LLM이 적은 값이 어긋나면(모델이 인덱스를 밀려 썼거나 값을 가공한 경우) 값으로 노드를 재탐색한다. 이 폴백이 번호 참조 방식의 유일한 약점을 막는다.

프롬프트 요지:

- 당신은 목록 페이지를 읽는다. 각 줄 앞의 `[n]`은 그 내용을 가리키는 번호다.
- 본문의 반복되는 게시글·공고 항목만 목록으로 본다. 메뉴·사이드바·푸터의 반복 링크는 목록이 아니다.
- 각 항목에서 제목·링크와, 그 목록에 **실제로 있는** 메타 정보만 보고한다. 없는 필드를 추측해 만들지 않는다.
- 값은 반드시 `[n]` 번호로 가리키고, 번호와 함께 그 번호의 텍스트를 그대로 적는다. 개요에 없는 번호는 쓰지 않는다.
- 접수기간처럼 시작·종료가 한 문자열이면 `type: "date_range"`, `role: "deadline"`.
- 목록이 보이지 않으면 `pageKind: "detail"` 또는 `"unknown"`으로 답하고, 개요 끝의 링크 구역에서 목록으로 이어질 것을 골라 `listCandidates`에 담는다.
- `suggested`에는 이 소스의 표시 이름과, 한국어 카테고리 경로·태그를 제안한다.

힌트가 있으면 프롬프트에 한 줄 덧붙이고, 개요에서 매칭된 줄에 표시를 남긴다.

```text
사용자가 지정한 목록 항목의 단서: "지원사업 공고"
이 문자열을 포함하는 항목이 목록에 포함되어야 합니다. 개요에서 ◀단서 로 표시된 줄을 보십시오.
단서가 개요에 없으면 무시하고 스스로 판단하십시오.
```

호출 수: 기본 1회. 검증 미달 시 보수 1회(§5-5). 총 최대 2회.

### 5-4. 셀렉터 합성 (`selector-synthesis.ts`)

순수 함수. 외부 호출 없음.

```ts
export interface SynthesisResult {
  spec: CrawlSpec;
  // 합성 과정에서 버린 것 — 분석 단계 detail과 테스트에 쓴다.
  dropped: { key: string; reason: string }[];
  // ref가 어긋나 값 매칭으로 복구한 횟수
  remapped: number;
}

export function synthesizeSpec(
  html: string,
  outline: PageOutline,
  read: PageReadResult,
  pageUrl: string,
): SynthesisResult | null;
```

단계:

1. **ref 해소.** 각 `titleRef`/`fields[].ref`를 `outline.refs`에서 요소로 바꾼다. 요소의 텍스트와 LLM이 적은 텍스트가 정규화 후 포함 관계가 아니면, 그 텍스트로 문서 전체를 재탐색해 가장 가까운 요소를 찾는다(`remapped` 증가). 둘 다 실패하면 그 필드를 버린다.
2. **항목 루트 결정.** 해소된 제목 요소가 2개 이상이어야 한다. 첫 두 제목 요소의 조상 체인을 올라가며 **서로 달라지는 최초의 조상 쌍**을 항목 루트로 잡는다. 제목이 3개 이상이면 셋째로 교차 검증한다.
3. **itemSelector 생성.** 항목 루트들의 공통 셀렉터를 만든다. 우선순위: ① 공통 class 조합이 있으면 `tag.class1.class2`, ② 없으면 `부모셀렉터 > tag`, ③ 그래도 모호하면 부모 셀렉터를 한 단계 더 올린다. 생성한 셀렉터를 `querySelectorAll`로 실행해 **해소된 모든 항목 루트를 포함하고** 결과 수가 항목 수의 3배를 넘지 않을 때 채택한다.
4. **필드 셀렉터 생성.** 각 필드 ref 요소에 대해, 소속 항목 루트 기준 상대 셀렉터를 만든다(`dom-selector.ts`의 `relativeSelector(root, el)`). 항목마다 뽑은 상대 셀렉터가 전부 같으면 그대로, 다르면 공통 접미(`.date`, `td:nth-child(4)` 등)로 일반화한다. 일반화도 실패하면 버린다.
5. **값 추출 방식 결정.** 요소가 앵커이고 필드 `type`이 `url`이면 `attr: "href"`, 이미지면 `attr: "src"`, `<time datetime>`이면 `attr: "datetime"`, 그 외는 텍스트.
6. **제목·링크·게시일 고정 역할 처리.** `title`/`link`/`published`는 `CrawlSpec.fields`에 넣지 않는다 — `applyDomSpec`이 이미 담당한다. 다만 제목 상대 셀렉터가 `applyDomSpec`의 앵커 추측과 어긋날 수 있으므로, `spec.titleSelector`/`spec.linkSelector`/`spec.publishedSelector`를 **새로 추가**해 명시적으로 지정한다. `applyDomSpec`은 이 값이 있으면 그것을 쓰고, 없으면 기존 추측을 유지한다(기존 소스 호환).
7. `key`가 `title`/`link`/`published`인 필드와 `role`이 그 셋인 필드는 버린다(고정 역할과 충돌).

반환값이 `null`이면 합성 실패 — 호출자가 폴백 경로를 탄다.

### 5-5. 검증과 보수 (`verify.ts`)

```ts
export interface VerifyScore {
  itemCount: number;         // applySpec 결과 행 수
  reportedCount: number;     // LLM이 보고한 항목 수
  titleMatchRate: number;    // 보고한 제목이 추출 결과에 있는 비율
  fieldRates: Record<string, { fill: number; match: number }>;
  ok: boolean;
}

export function verifySpec(
  html: string, pageUrl: string, spec: CrawlSpec, read: PageReadResult,
): { rows: ExtractedRow[]; score: VerifyScore };
```

임계치:

| 항목 | 기준 | 미달 시 |
|---|---|---|
| 추출 행 수 | ≥ 3 | 전체 폐기 |
| 추출 행 수 | ≥ 보고 항목 수 × 0.7 | 전체 폐기 |
| 제목 일치율 | ≥ 0.8 | 전체 폐기 |
| 필드 채움률 | ≥ 0.3 | 그 필드만 폐기 |
| 필드 값 일치율 | ≥ 0.5 | 그 필드만 폐기 |

**전체 폐기 시 보수 호출 1회.** 입력에 다음을 덧붙인다: 합성한 `itemSelector`, 그것으로 실제 추출된 상위 3개 항목의 제목, 그리고 "당신이 보고한 항목과 다릅니다. 개요에서 목록 항목을 다시 찾아 번호를 보고하십시오." 보수 응답으로 §5-4를 다시 돌린다. 그래도 미달이면 LLM 경로 포기.

필드만 폐기한 경우 보수하지 않는다 — 제목·링크가 맞으면 소스로서 쓸 수 있고, 추가 호출의 기대 이득이 비용보다 작다.

### 5-6. 수집 프로파일 (`profile.ts`)

```ts
export interface FetchProfile {
  mode: "feed" | "static" | "rendered";
  // 로딩 완료 판정 셀렉터. 보통 itemSelector.
  waitForSelector?: string;
  // 시간 기반 대기 상한 (측정값 × 여유계수, 하한·상한 적용)
  settleMs?: number;
  scrollToBottom?: boolean;
  // 측정 근거 — 운영 추적·재측정 판단에 쓴다.
  measuredReadyMs?: number;
  measuredReadyBy?: "selector" | "networkidle" | "stabilized" | "timeout";
  measuredAt: string;        // ISO 8601
}

export function buildFetchProfile(args: {
  staticHtml: string;
  renderedHtml: string;
  spec: CrawlSpec;
  timings: RenderTimings;
  strategy: "rss" | "structured" | "html";
  pageUrl: string;
}): FetchProfile;
```

`mode` 판정은 추측이 아니다. 같은 스펙을 **정적 HTML과 렌더 DOM 양쪽에 적용**해 비교한다.

- 전략이 `rss` → `feed`
- 정적 HTML에 적용한 결과 행 수가 렌더 결과의 80% 이상 → `static` (렌더링 불필요)
- 그 외 → `rendered`

`settleMs = clamp(measuredReadyMs × 1.5, 1500, 20000)`. 여유계수 1.5의 근거: 수집 시점의 네트워크·서버 지연이 분석 시점보다 느릴 수 있고, `waitForSelector`가 먼저 잡히면 이 값은 쓰이지 않으므로 넉넉해도 비용이 없다.

`scrollToBottom`은 렌더링 중 스크롤로 항목이 늘어났을 때(`timings.grewByScroll`) `true`.

**저장 위치: `myportal.sources.fetch_profile jsonb`** (새 마이그레이션 `004_fetch_profile.sql`).

`crawl_specs.spec`에 넣지 않는 이유는 §1-3의 사고다. 프로파일은 "어떻게 가져오는가", 스펙은 "가져온 것에서 무엇을 뽑는가"로 수명이 다르다. self-repair가 스펙을 교체할 때 프로파일은 건드리지 않아야 한다.

호환: `fetch_profile`이 `{}`인 기존 소스는 `spec.render`를 읽어 `mode`를 유도한다. 새 분석이 돌면 프로파일이 채워진다.

## 6. 힌트 — 보조 수단과 낡음 환기

### 6-1. 힌트의 성격

힌트는 **분석 시점에 목록에 보이던 제목의 일부 문자열**이다. 목록 내용은 시간이 지나면 바뀌므로, 저장된 힌트는 **반드시 낡는다.** 지금 코드는 이 사실을 전혀 반영하지 않고 `spec.hint`를 영구적 설정처럼 다룬다.

```ts
// collector.ts repairSpec — 낡은 힌트를 무조건 재사용한다
const heuristic = generateSpec(html, finalUrl, prevSpec?.hint);
```

낡은 힌트는 자가복구를 영구히 실패시킬 수 있다: 힌트 문자열이 더 이상 페이지에 없으므로 힌트 영역을 못 찾고, 그 실패가 매 수집마다 반복된다.

### 6-2. 변경

**저장 형태.** `spec.hint`에 입력 시점을 함께 남긴다.

```ts
export interface CrawlSpec {
  // ...
  hint?: string;
  hintSetAt?: string;   // ★ ISO 8601. 힌트를 입력한 시점.
}
```

**분석 시점.** 힌트는 §5-3의 프롬프트 한 줄과 개요의 `◀단서` 표시로만 작용한다. 목록 탐지를 힌트가 **결정하지 않는다** — LLM이 판단하고, 힌트는 그 판단의 단서다. 힌트 문자열이 개요에 없으면 단계에 `warn`을 남긴다("힌트 문자열이 현재 페이지에 없습니다 — 목록 내용이 바뀐 것 같습니다").

**자가복구(`repairSpec`).** 순서를 뒤집는다. **힌트 없이 먼저** 시도하고, 실패했을 때만 저장된 힌트로 재시도한다. 낡은 힌트가 복구를 막지 않게 하는 것이 목적이다.

**재분석 화면.** 저장된 힌트를 입력란에 채워 보여줄 때 입력 시점과 경과를 함께 보인다.

```text
저장된 힌트: "지원사업 공고"   (2026-01-12 입력, 292일 경과)
⚠ 이 문자열이 현재 페이지에 없습니다. 목록 내용이 바뀌었을 수 있습니다.
   비우고 다시 분석하면 자동 판단으로 진행합니다.           [힌트 없이 재분석]
```

경과 일수만으로 경고하지 않는다 — 날짜는 보이고, **경고는 "현재 페이지에서 매칭되지 않을 때"만** 띄운다. 임의의 기준일(30일 등)을 발명하지 않는 쪽이 정확하다.

`reanalyzeRequest`의 세 가지 의사 구분(생략=저장된 것 사용 / `""`=힌트 없이 / 값=덮어쓰기)은 이미 계약에 있으므로 그대로 쓴다.

**등록 화면.** 힌트 입력란에 상시 안내를 둔다.

```text
힌트 (선택) — 자동 분석이 엉뚱한 영역을 잡을 때만 쓰세요.
지금 목록에 보이는 제목의 일부를 넣습니다. 목록 내용은 바뀌므로 이 문자열은
시간이 지나면 의미가 없어집니다. 영구 설정이 아닙니다.
```

## 7. 폴백 경로

LLM을 쓸 수 없는 경우(`hasLlm()`이 false, 일별 한도 초과, LLM 오류·타임아웃, 응답 검증 실패, 합성·검증 실패)에는 현재의 휴리스틱 경로를 **렌더된 DOM에** 적용한다.

```text
generateSpec(renderedHtml, finalUrl, hint)
  → 성공: fieldSource = "heuristic", fields = {} (제목·링크·게시일만)
  → 실패: parseJsonLdList 시도
  → 실패: outcome = null → 상세 페이지 경로(부모 후보)
```

폴백에서는 LLM이 없으므로 부모 후보도 기존 URL 경로 자르기 + 링크 텍스트 패턴(`parentCandidates`)을 쓴다. 이 함수는 유지한다.

폴백은 **단계에 명시**된다. 사용자가 왜 필드가 없는지 알 수 있어야 한다.

| 상황 | 단계 라벨 | 상태 | detail |
|---|---|---|---|
| LLM 미설정 | AI 페이지 해석 | warn | AI 분석이 설정되지 않았습니다 — 패턴 추정으로 진행 |
| 한도 초과 | AI 페이지 해석 | warn | 일별 AI 분석 한도를 초과했습니다 — 패턴 추정으로 진행 |
| LLM 오류 | AI 페이지 해석 | warn | AI 분석 호출에 실패했습니다 — 패턴 추정으로 진행 |
| 합성 실패 | 셀렉터 합성 | warn | AI가 읽은 항목을 셀렉터로 옮길 수 없었습니다 — 패턴 추정으로 진행 |
| 검증 미달(보수 후) | 셀렉터 합성·검증 | warn | 추출 결과가 AI가 읽은 내용과 달랐습니다 — 패턴 추정으로 진행 |

프로바이더 원문 오류 메시지는 단계에 넣지 않는다(CLAUDE.md §15). 서버 로그에만 남긴다.

## 8. 분석 단계 표시

`AnalyzeStep` 계약은 바뀌지 않는다. 라벨만 새 흐름에 맞춘다.

```text
URL 검증                    ok
기존 소스 확인              ok   신규 소스
robots.txt 확인             ok
페이지 접근                 ok   HTTP 200
RSS/Atom 피드 확인          warn 피드 없음
브라우저 렌더링             ok   로딩 완료 2.4초 (DOM 안정화)
AI 페이지 해석              ok   목록 12건, 필드 5개
셀렉터 합성·검증            ok   항목 12건, 제목 일치율 100%, 필드 4개 채택
수집 프로파일               ok   렌더링 필요, 대기 3.6초, 항목 확인 셀렉터 저장
페이지 유형 판정            ok   목록 페이지
```

## 9. 계약 변경

`CrawlSpec`은 `extract.ts`의 내부 타입이고 `@myportal/api-contracts`에 없다(계약은 `spec: z.unknown()`으로 받는다). 따라서 §5-4의 `titleSelector`/`linkSelector`/`publishedSelector`와 §6-2의 `hintSetAt` 추가는 공개 계약 변경이 아니다. 공개 계약 변경은 다음 넷뿐이다.

```ts
// analyzeResultSchema.preview
preview: z.object({
  fields: z.array(sourceFieldSchema),
  rows: z.array(z.record(z.unknown())),
  fetchStrategy: fetchStrategySchema,
  spec: z.unknown().nullable(),
  profile: z.unknown().nullable(),     // ★ 추가
}).nullable(),

// reanalyzeResultSchema.preview — 같은 형태로 profile 추가
// reanalyzeResultSchema — ★ 추가
storedHint: z.object({
  value: z.string(),
  setAt: z.string().nullable(),
  matchesPage: z.boolean(),           // 현재 페이지에서 매칭되는가
}).nullable(),

// createSourceRequestSchema — ★ 추가
profile: z.unknown().nullable().optional(),

// applySpecRequestSchema — ★ 추가
profile: z.unknown().nullable().optional(),
```

`spec`과 같은 관례로 `unknown`으로 받고 서버에서 Zod로 재검증한다. 클라이언트가 보낸 프로파일을 신뢰하지 않는다.

`fetchStrategy` enum은 그대로 쓴다(`rendered`는 이미 있다). 다만 **`fetch_strategy`와 `fetch_profile.mode`를 이중 저장하지 않는다**: `fetch_strategy`는 추출 방식(`rss`/`structured`/`html`/`link`)만 담고, 렌더링 여부는 프로파일이 단독으로 담는다. 분석 결과가 `rendered`를 반환하던 자리는 `html` + `profile.mode = "rendered"`가 된다. 기존 데이터에 남은 `fetch_strategy = 'rendered'`는 `html`과 같게 처리한다(collector의 `extractRows` switch에 분기 추가).

## 10. 테스트 전략

### 본진: 순수 함수

| 모듈 | 테스트 |
|---|---|
| `selector-synthesis` | 픽스처 HTML 4종(테이블 게시판 / 카드 그리드 / `ul>li` / 중첩 div) × ref 맵 → 기대 itemSelector·필드 셀렉터. ref 어긋남 → 값 매칭 복구. 항목 루트가 갈라지지 않는 경우(모든 제목이 같은 부모) → null. 고정 역할 key 충돌 폐기. |
| `verify` | 임계치 경계값(제목 일치율 0.79/0.80, 행 수 비율 0.69/0.70). 필드만 폐기 vs 전체 폐기. 보수 트리거 조건. |
| `page-outline` | ref 인덱스와 노드 대응 일관성. 텍스트 절단. 크기 상한 초과 시 뒤에서 절단·`truncated` 플래그. 빈 HTML·`<html>` 없는 조각. |
| `profile` | `mode` 판정 3분기. `settleMs` clamp 하한·상한. `grewByScroll` → `scrollToBottom`. |
| `dom-selector` | `relativeSelector` 가 항목 루트 기준으로 유효한 셀렉터를 만드는지. `nth-child` 폴백. CSS 이스케이프. |

### LLM 경계

`llm-read`는 `chatJson`을 모킹한다(기존 `field-inference.test.ts`와 같은 방식). 테스트 대상: 응답 스키마 검증, 개요에 없는 ref 거부, `items`가 빈 배열일 때, `pageKind: "detail"` 경로, 타임아웃·HTTP 오류 → 폴백.

### 통합

`analyze.test.ts`를 개정한다. `fetchPage`/`renderPage`/`chatJson`을 모킹하고 실제 사이트 HTML 픽스처로 전 경로를 돌려 `AnalyzeResult`가 계약을 만족하는지 확인한다. 실제 네트워크·DB 호출 테스트는 만들지 않는다.

`collector.test.ts`에 프로파일 기반 fetch 분기와 self-repair의 힌트 순서 역전을 추가한다.

## 11. 마이그레이션과 호환

`004_fetch_profile.sql`:

```sql
alter table myportal.sources
    add column if not exists fetch_profile jsonb not null default '{}'::jsonb;
```

기존 소스는 다음 분석·재분석·자가복구 때 프로파일이 채워진다. 그때까지는 `spec.render`로 동작한다. 백필 스크립트를 만들지 않는다 — 전체 재분석은 LLM 비용이 소스 수만큼 들고, 수집은 기존 경로로 계속 동작하므로 긴급하지 않다.

## 12. 위험과 대응

| 위험 | 대응 |
|---|---|
| LLM이 `[n]` 인덱스를 어긋나게 쓴다 | `titleText`/`text`를 함께 받아 ref 노드의 실제 텍스트와 대조하고, 어긋나면 값으로 재탐색(§5-4 1단계). `remapped` 횟수를 로그에 남겨 모델 품질을 추적한다. |
| 개요 절단으로 목록이 잘린다 | 48KB 상한, 뒤에서 절단, `truncated` 플래그를 단계 detail에 표시. 목록이 잘려 항목이 3건 미만이면 검증에서 폐기되어 폴백한다. |
| 항상 렌더링해서 분석이 느려진다 | 정적 페이지도 +2~4초. 요건 목표(렌더링 필요 60초) 안. 반대로 정기 수집은 `waitForSelector` 조기 종료로 빨라진다. |
| Vercel에서 Chromium 실행 실패 | 기존 `resolveLaunch` 폴백 체인(시스템 Chrome → `@sparticuz/chromium` → playwright 번들) 유지. 렌더링 실패 시 정적 HTML로 LLM 해석을 진행한다(렌더링을 **보장**하지 못한 사실을 단계에 `warn`으로 남긴다). |
| LLM 비용 증가 | 분석 1건당 1~2회, 입력 10~20k 토큰. 기존 일별 한도(`LLM_DAILY_LIMIT` 50 / 시스템 200)와 `llm_calls` 기록 그대로. 정기 수집은 0회 유지. |
| 개요 ref와 `applySpec`이 보는 DOM이 어긋난다 | 개요를 `stripNoise` 적용 문서에서 만들어 불변식으로 고정(§5-2). `page-outline` 테스트가 `nav` 안의 노드에 번호가 붙지 않음을 확인한다. |
| `gpt-4o-mini`가 번호 참조를 못 따라온다 | 값 매칭 폴백으로 1차 방어. `remapped` 비율이 높게 나오면 모델 분리를 별건으로 다룬다(이 설계의 비목표). |

## 13. 요건정의서 반영

- **SRC-04** 수집 방식 시도 순서를 다시 쓴다: ① RSS/Atom 자동 탐지 → ② 렌더링 + LLM 해석 + 셀렉터 합성·검증 → ③ (LLM 불가 시) 패턴 추정 폴백.
- **ORG-08** 카테고리·태그 자동 제안이 이 설계로 구현된다(지금은 빈 배열).
- **NFR-P3** 분석 목표 시간은 유지하되, 정적 페이지도 렌더링하므로 "정적 30초" 기준을 "분석 60초"로 통합한다.
- **CRAWL-03**(정기 수집 LLM 호출 금지)은 그대로 지킨다.
