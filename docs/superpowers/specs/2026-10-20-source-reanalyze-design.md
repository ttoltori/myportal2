# 등록된 소스 재분석·재적용 설계

작성일: 2026-10-20
대상: 소스 상세 화면(`/sources/[id]`)의 명세 재생성 흐름

## 1. 배경과 문제

LLM 필드 추론([2026-10-20-llm-field-inference-design.md](2026-10-20-llm-field-inference-design.md))을 붙인 결과, **그 이전에 등록된 소스는 혜택을 받지 못한다.** 저장된 `crawl_specs.spec`의 `fields`가 비어 있고 `source_fields`에는 title/link/published 세 행만 있다.

기존 '명세 다시 만들기'(`rebuildSpec`)가 절반을 해결한다 — LLM 연결 작업으로 이미 필드 추론까지 돌아간다. 하지만 두 가지가 빠져 있다.

1. **`source_fields`를 갱신하지 않는다.** `rebuildSpec`은 `crawl_specs`에만 새 버전을 쓴다. 데스크는 필드 메타를 `source_fields`에서 읽으므로, 새 `attrs` 키가 들어와도 라벨도 역할도 붙지 않는다. `role=deadline`이 연결되지 않아 '마감 임박' 뷰에도 나타나지 않는다.
2. **사용자가 결과를 보고 고칠 수 없다.** `rebuildSpec`은 확인 없이 즉시 저장한다. 등록 화면이 제공하는 라벨·타입·역할·표시여부 편집(SRC-07)이 등록 이후에는 아예 불가능하다 — `source_fields`를 갱신하는 엔드포인트가 없다.

### 삭제하고 재등록하면 되지 않는가

안 된다. 두 군데서 막힌다.

- **구독 해제는 소스를 지우지 않는다.** 코드 전체에 `delete from myportal.sources`가 없다. `unsubscribe`는 `subscriptions` 행만 지우고 `sources`·`crawl_specs`·`source_fields`·`items`는 남는다 (요건정의서 SRC-11: 구독자 0명이면 *수집을 중지*한다).
- **같은 URL을 다시 넣으면 분석을 하지 않는다.** `analyzeUrl`이 `normalized_url` 중복을 발견하면 `outcome: "exists"`로 조기 반환해 robots·fetch·추출·LLM을 전부 건너뛴다 (SRC-02). 낡은 스펙과 낡은 `source_fields`를 그대로 물려받는다.

DB에서 직접 지우는 것은 CLAUDE.md §23이 금지하며, `items`가 `on delete cascade`라 **같은 소스를 구독한 다른 사용자의 항목·읽음·별표까지 함께 사라진다.** 재분석은 그 전부를 보존하면서 스펙만 교체한다.

## 2. 목표와 비목표

### 목표

- 등록된 소스를 다시 분석해 새 스펙과 발견된 필드를 **미리보기로 보여주고**, 사용자가 라벨·타입·역할·표시여부를 고친 뒤 확정하면 저장한다.
- 확정 시 `crawl_specs` 새 버전과 `source_fields`를 함께 갱신한다.
- 이미 수집된 항목에 새 필드 값을 **백필**한다.
- 읽음·별표·표시이름·카테고리·태그·수집이력을 보존한다.

### 비목표

- 소스 삭제 기능 (다른 구독자의 데이터까지 cascade로 날아간다).
- 소스 URL 변경 (그것은 새 소스다).
- 구독자별 필드 메타 오버라이드 — `source_fields`는 소스 단위 공유를 유지한다(§7).
- 필드 삭제 — 사용자가 보낸 목록에 없는 기존 필드는 그대로 둔다(§5).
- 목록에서 내려간 오래된 항목의 상세 페이지 재방문 백필 (소스당 수백~수천 요청).

### 성공 기준

1. 재분석 미리보기 단계에서는 DB가 전혀 변하지 않는다 — '취소'가 아무것도 되돌릴 필요가 없다.
2. 적용 후 데스크에서 새 필드가 한글 라벨과 함께 보이고, `role=deadline` 필드는 '마감 임박' 뷰에 나타난다.
3. 제목 추출이 바뀐 소스를 적용해도 **기존 항목이 중복 삽입되지 않는다.**
4. 적용 직후 데스크의 "지난 방문 이후 신규" 건수가 재분석 때문에 늘지 않는다.
5. 읽음·별표·표시이름·카테고리·태그가 적용 전후로 동일하다.

## 3. 아키텍처 — `analyze` 코어 분리

`analyzeUrl`은 중복 확인에서 조기 반환하므로 재분석이 그대로 호출할 수 없다. 공통 코어를 뽑는다.

```text
analyzeListing(args)
  robots → fetchPage → detectExtraction → 렌더링 재시도 → enrichWithLlm
  반환: ListingAnalysis

analyzeUrl(userId, rawUrl, hint)
  URL 검증·정규화 → 중복 확인 → analyzeListing → AnalyzeResult 조립
                                                  (list/detail/link-only/exists/error)

reanalyzeSource(userId, sourceId, hint)
  소스 조회·구독 권한 → analyzeListing → ReanalyzeResult 조립
                                          (list/detail/link-only/error)
```

```ts
// src/server/features/crawl/analyze.ts
interface ListingAnalysis {
  steps: AnalyzeStep[];
  pageTitle: string | null;
  outcome: AnalyzeOutcome | null;              // null = 목록 패턴 없음
  fieldSource: "llm" | "heuristic" | null;
  pageText: string | null;                     // 힌트 미스 시 텍스트 스냅샷
  staticHtml: string;                           // parentCandidates용 (정적 HTML)
  finalUrl: string;
  blocked: { code: ErrorCode; detail: string } | null;  // robots 금지 / fetch 실패
}

async function analyzeListing(args: {
  userId: string;
  url: string;                                  // 정규화된 URL
  hint?: string;
  sourceId: string | null;                      // llm_calls 기록용
  purpose: LlmPurpose;                          // analyze-* 또는 rebuild
}): Promise<ListingAnalysis>;
```

`analyzeListing`은 예외를 던지지 않고 robots 금지·fetch 실패를 `blocked`로 돌려준다. 두 호출처가 각자의 응답 형태로 조립한다 — `analyzeUrl`은 `link-only`/`error`로, `reanalyzeSource`는 같은 코드로.

`analyze.ts`가 500줄을 넘겼으므로 이 분리는 이 작업에 필요한 범위의 정리다. 기존 `analyzeUrl`의 외부 동작은 바뀌지 않는다 — `analyze.test.ts` 11건이 그대로 통과해야 한다.

### `rebuild-spec` 제거

`POST /v1/sources/:id/rebuild-spec`과 `rebuildSpec()`을 제거하고 `reanalyze` + `apply-spec`으로 대체한다. '명세 다시 만들기' 버튼이 '다시 분석'으로 교체되면 그 엔드포인트는 호출처가 없어진다.

`collector.ts`의 `repairSpec`(수집 자가복구)은 **별개 함수이므로 그대로 둔다.** LLM purpose `"rebuild"`는 `reanalyzeSource`가 이어받아 의미를 유지한다.

`myportal-api-client`의 `rebuildSpec` 함수도 제거한다.

## 4. API 계약

```ts
// ── POST /v1/sources/:id/reanalyze ──────────────────────
export const reanalyzeRequestSchema = z.object({
  // 저장된 spec.hint가 기본값으로 쓰이고, 값을 주면 그것으로 덮는다.
  hint: z.string().trim().min(2).max(500).optional(),
});

export const reanalyzeResultSchema = z.object({
  steps: z.array(analyzeStepSchema),
  // "exists"가 없다 — 이미 등록된 소스를 다시 보는 것이 전제다.
  outcome: z.enum(["list", "detail", "link-only", "error"]),
  pageTitle: z.string().nullable(),
  preview: z
    .object({
      fields: z.array(sourceFieldSchema),
      rows: z.array(z.record(z.unknown())),
      fetchStrategy: fetchStrategySchema,
      spec: z.unknown().nullable(),
    })
    .nullable(),
  // 지금 저장된 필드. 패널이 '무엇이 바뀌는지'를 보여주고,
  // 이번 분석에서 발견되지 않은 기존 필드 수를 세는 데 쓴다.
  currentFields: z.array(sourceFieldSchema),
  pageText: z.string().nullable(),
  fieldSource: z.enum(["llm", "heuristic"]).nullable(),
  errorCode: z.string().nullable(),
});

// ── POST /v1/sources/:id/apply-spec ─────────────────────
export const applySpecRequestSchema = z.object({
  spec: z.unknown(),
  fields: z.array(sourceFieldSchema).max(30),
  fetchStrategy: fetchStrategySchema,
  hint: z.string().trim().min(2).max(500).optional(),
});

export const applySpecResponseSchema = z.object({
  version: z.number(),            // 새 스펙 버전
  fieldsSaved: z.number(),
  backfilled: z.number(),         // attrs가 갱신된 기존 항목 수
  inserted: z.number(),           // 새로 삽입된 항목 수
  backfillFailed: z.boolean(),    // 페이지 조회 실패로 백필만 건너뜀(스펙·필드는 저장됨)
});
```

`reanalyze`는 **아무것도 저장하지 않는다**(LLM 호출 이력 `llm_calls` 제외 — 비용이 발생했으므로 기록한다). 미리보기 단계에서 사용자가 이탈해도 되돌릴 것이 없다.

`apply-spec`은 클라이언트가 보낸 `spec`을 신뢰하지 않고 `applySpec`으로 재실행해 검증한다(§5 2단계).

## 5. 적용 절차

외부 I/O를 트랜잭션 밖에 둔다.

```text
1. 소스 조회 + 구독 권한 확인 (findSubscribedSource)
2. 페이지 획득(spec.render면 renderPage, 아니면 fetchPage)
   → 전략별 추출로 검증                                   [트랜잭션 밖]
   추출 0건 → AppError(EXTRACTION_FAILED, 422). 클라이언트 스펙을 신뢰하지 않는 지점.
   fetch/render 실패 → 백필을 건너뛰고 backfillFailed=true로 3단계 진행
3. 트랜잭션:
   a. deactivateSpecs(sourceId)
   b. insertSpec(sourceId, maxVersion+1, spec, 'manual')
   c. fields마다 insertField  (이미 on conflict (source_id,key) do update 업서트)
   d. 백필: 기존 항목 update / 신규 항목 insert / 적용자에게 읽음 마킹
   e. sources.fetch_strategy = 요청값, status='ok', consecutive_failures=0
   f. insertManualAction(userId, sourceId, 'apply-spec')
4. 응답
```

페이지 획득과 추출은 **항상** 수행한다. 이것이 클라이언트가 보낸 스펙을 검증하는 유일한 수단이므로 건너뛸 수 있는 선택지로 두지 않는다.

### 전략별 추출

요청 `fetchStrategy`에 따라 추출 경로가 다르다 — 재분석이 RSS 피드를 발견했다면 `applySpec`이 아니라 `parseFeed`를 써야 한다. `collector.ts`의 `extractRows`가 이미 같은 분기를 갖고 있으므로 그 함수를 재사용한다(소스 행 대신 `{fetch_strategy, feed_url}` 형태의 최소 인자를 받도록 시그니처를 넓힌다).

| `fetchStrategy` | 추출 |
|---|---|
| `rss` | `spec.feedUrl ?? finalUrl`을 조회해 `parseFeed` |
| `structured` | `parseJsonLdList` |
| `html` | `applySpec(html, spec, finalUrl)` |
| `link` | 재분석 자체를 허용하지 않는다(§8) |

`hint`가 주어지면 저장되는 `spec.hint`에 넣는다 — `repairSpec`이 이후 자가복구에서 재사용한다.

### 사라진 필드는 지우지 않는다

사용자가 보낸 `fields` 목록에 없는 기존 `source_fields` 행은 **건드리지 않는다.** 기존 `items.attrs`에 그 키가 남아 있어 데스크가 라벨을 필요로 한다. 패널에 "이번 분석에서 발견되지 않은 기존 필드 N개는 유지됩니다"를 표시해 사용자가 상황을 알게 한다. 필드 삭제는 비목표다.

## 6. 백필 — 두 가지 함정

### 6.1 `dedupe_hash`가 제목을 포함한다

`dedupeHash(sourceUrl, title)`는 `sha256(normalizedUrl::title)`이다(`url.ts:127`). 재분석으로 제목 추출이 달라지면 해시가 바뀌고, `insertItem`의 `on conflict (source_id, dedupe_hash) do nothing`이 막아주지 못해 **같은 항목이 중복 삽입된다.**

매칭 키 순서를 바꾼다.

1. 추출 행에 `normalized_url`이 있으면 **그 값으로** 기존 항목을 찾는다. 제목 변화에 영향받지 않는다.
2. URL 복원이 안 된 행(앵커 없는 목록 등)만 `dedupe_hash`로 찾는다.

매칭된 기존 항목은 `attrs`뿐 아니라 **`title`·`published_at`·`excerpt`·`dedupe_hash`를 함께 갱신한다.** 해시를 그대로 두면 다음 정기 수집이 새 제목으로 계산한 해시를 못 찾아 또 중복을 만든다 — 백필이 다음 수집과 일관되어야 한다.

`unique (source_id, dedupe_hash)` 충돌 처리: 한 새 해시에 여러 기존 항목이 매핑되면(과거에 제목이 달라 중복 삽입됐던 경우) **`collected_at`이 가장 오래된 항목만 갱신하고 나머지는 건너뛴다.** 건너뛴 수는 응답 집계에서 제외한다. 삭제하지 않는다 — 사용자의 읽음·별표가 붙어 있을 수 있다.

### 6.2 신규 삽입분이 데스크를 오염시킨다

재분석으로 처음 추출된 항목(앵커 없던 항목 등)은 내용은 오래됐지만 `items`에는 신규다. 그대로 두면 "지난 방문 이후 N건"에 수십 건이 쏟아진다.

`runBaseline`과 같은 방식으로 **적용을 실행한 사용자의 `item_states`에만 읽음 마킹**한다.

```sql
insert into myportal.item_states (user_id, item_id, read, read_at)
values ($1, $2, true, now())
on conflict (user_id, item_id) do nothing
```

다른 구독자에게는 신규로 보이는 것이 맞다 — 그들에게는 실제로 처음 보이는 항목이고, 그들의 읽음 상태를 다른 사용자의 조작으로 바꾸면 안 된다.

`is_baseline`은 `false`로 삽입한다. 기준선은 '최초 등록 시점의 과거분'을 뜻하므로 의미를 섞지 않는다.

## 7. 공유 소스 — 수용하되 기록한다

`crawl_specs`와 `source_fields`는 소스 단위이므로 사용자 A가 적용하면 사용자 B의 데스크 라벨도 바뀐다.

이것은 **기존 설계와 일관된다** — 최초 등록자가 모든 구독자를 위해 필드 메타를 정한다(`createSourceWithBaseline`). 구독자별 오버라이드를 도입하면 `source_fields`에 `user_id` 차원이 생기고 데스크 조회·다이제스트·마감 계산이 모두 바뀐다. 현재 서비스 규모(`ALLOWED_EMAILS`로 제한된 사용자)에서는 과잉이다.

수용하는 대신 `manual_actions`에 `action='apply-spec'`으로 누가 언제 적용했는지 남긴다. 분쟁이 생기면 추적할 수 있다.

## 8. 오류 처리

| 상황 | 동작 |
|---|---|
| 소스 없음 / 구독 안 함 | `SOURCE_NOT_FOUND` 404 (기존 `findSubscribedSource` 그대로) |
| robots 금지 | `reanalyze` → `outcome: "link-only"`, `errorCode: ROBOTS_DISALLOWED`. 적용 버튼 비활성 |
| 페이지 조회 실패 | `reanalyze` → `outcome: "error"`, `blocked.code` 전달 |
| 목록 패턴 없음 | `reanalyze` → `outcome: "detail"`, `preview: null`. 힌트 재입력을 안내 |
| 힌트 미스 | `pageText`로 텍스트 스냅샷 제공 (등록 화면과 동일) |
| `apply-spec`의 스펙이 0건 추출 | `EXTRACTION_FAILED` 422, 아무것도 저장하지 않음 |
| 백필 fetch/render 실패 | 스펙·필드는 저장, `backfillFailed: true`. 스펙은 유효하므로 다음 정기 수집이 처리 |
| `fetch_strategy='link'` 소스 | 재분석 불가 — 버튼 비활성 (기존 '지금 수집'과 동일 규칙) |

LLM 실패는 이 설계에서 별도로 다루지 않는다 — `enrichWithLlm`이 이미 모든 실패를 분석 단계 `warn`으로 환원하고 휴리스틱 결과를 유지한다.

## 9. 프론트엔드

### 9.1 공통 컴포넌트 추출

`src/app/add-source/page.tsx`의 필드 편집 표(약 130줄 JSX: 라벨 input, 타입 select, 역할 select, 표시 체크박스, 샘플 행 렌더)를 `src/components/field-preview-table.tsx`로 뽑아 등록 화면과 재분석 패널이 공유한다 (CLAUDE.md §25.9).

```ts
interface FieldPreviewTableProps {
  fields: SourceField[];
  rows: Record<string, unknown>[];
  onFieldsChange: (next: SourceField[]) => void;
}
```

`TYPE_OPTIONS`/`ROLE_OPTIONS` 상수도 함께 옮긴다. 추출 후 `add-source/page.tsx`의 동작은 바뀌지 않는다.

### 9.2 소스 상세 화면

`/sources/[id]`의 '명세 다시 만들기' 버튼을 **'다시 분석'으로 교체**한다. 누르면 그 자리에 패널이 펼쳐진다:

```text
[다시 분석]  ← 클릭
┌─ 재분석 ──────────────────────────────────────────┐
│ 분석 단계 목록 (steps — 기존 등록 화면과 같은 렌더) │
│ 목록 항목 힌트 [저장된 hint가 기본값]               │
│ 추출 미리보기 (FieldPreviewTable, 편집 가능)        │
│ 이번 분석에서 발견되지 않은 기존 필드 N개는 유지됩니다 │
│ [적용]  [취소]                                     │
└───────────────────────────────────────────────────┘
```

- 맥락을 유지한다 — 사용자는 수집 이력과 스펙 버전을 보면서 재분석할지 판단한다. 그래서 별도 화면으로 이동하지 않는다.
- '취소'는 패널만 닫는다. 미리보기 단계에서 DB가 바뀌지 않았으므로 되돌릴 것이 없다.
- '적용' 성공 시 패널을 닫고 상세를 다시 불러오며, 기존 `actionLog`에 `버전 N 적용 · 백필 N건 · 신규 N건`을 남긴다.
- 힌트를 바꿔 '다시 분석'을 재실행할 수 있다 — LLM 상한에 걸리면 분석 단계에 경고가 뜬다.

디자인은 `DESIGN.md`/`디자인컨셉.md`의 신문·전보 톤을 따른다 — 1px 테두리, 라운드·그림자·그래디언트 금지.

## 10. 테스트

핵심은 백필 매칭이다 — 조용히 데이터를 망가뜨릴 수 있는 유일한 지점이다.

### `applySpecForSource`

- **제목이 바뀐 항목이 `normalized_url`로 매칭되어 중복 삽입되지 않는다** (가장 중요)
- 매칭된 항목의 `dedupe_hash`가 새 제목 기준으로 갱신된다 — 다음 수집에서 중복이 생기지 않는다
- `title`·`published_at`·`excerpt`·`attrs`가 함께 갱신된다
- URL이 없는 행은 `dedupe_hash`로 매칭된다
- 한 새 해시에 기존 항목 2건이 매핑되면 `collected_at`이 오래된 것만 갱신하고 나머지는 건너뛴다
- 매칭되지 않은 행은 신규 삽입되고 `is_baseline=false`다
- 신규 삽입분이 적용자의 `item_states`에 읽음으로 마킹된다
- 다른 사용자의 `item_states`는 생성되지 않는다
- 사용자가 보낸 목록에 없는 기존 `source_fields` 행이 유지된다
- `fetch_strategy`가 요청값으로 저장된다
- 추출 0건이면 `EXTRACTION_FAILED`이고 스펙이 저장되지 않는다
- fetch 실패 시 스펙·필드는 저장되고 `backfillFailed: true`, `backfilled: 0`
- `manual_actions`에 `apply-spec`이 기록된다
- `spec.hint`에 요청 hint가 저장된다
- `fetchStrategy='rss'`면 `applySpec`이 아니라 `parseFeed` 경로로 추출한다
- `fetchStrategy='structured'`면 `parseJsonLdList` 경로로 추출한다

### `reanalyzeSource`

- 구독하지 않은 소스는 `SOURCE_NOT_FOUND`
- `outcome`별 응답 형태가 `reanalyzeResultSchema`를 통과한다 (list/detail/link-only/error 4가지)
- `currentFields`에 현재 `source_fields`가 담긴다
- 저장된 `spec.hint`가 기본 힌트로 쓰이고, 요청 hint가 그것을 덮는다
- 아무것도 저장하지 않는다 — `crawl_specs`·`source_fields`에 쓰기가 일어나지 않는다

### `analyzeListing` 코어 분리 회귀

- 기존 `analyze.test.ts` 11건이 그대로 통과한다 (외부 동작 불변)

### 하지 않는 테스트

- 실제 네트워크·DB 접속 (전부 `vi.mock`)
- `FieldPreviewTable`의 렌더 스냅샷 — 추출만 하고 동작은 바뀌지 않는다

## 11. 구현 순서

1. `analyze.ts`에서 `analyzeListing` 코어 분리 — 기존 테스트 11건 통과 확인.
2. `api-contracts`에 `reanalyzeRequestSchema`/`reanalyzeResultSchema`/`applySpecRequestSchema`/`applySpecResponseSchema` 추가.
3. `reanalyzeSource` 구현 + 테스트.
4. `collector.ts`의 `extractRows` 시그니처를 소스 행 대신 `{fetch_strategy, feed_url}` 최소 인자로 넓혀 재사용 가능하게 한다 — 기존 호출부 동작 불변.
5. 백필 SQL을 `sources.sql.ts`에 추가 (`findItemByNormalizedUrl`, `findItemByHash`, `updateItemFromRow`).
6. `applySpecForSource` 구현 + 테스트 (백필 매칭이 핵심).
7. 라우트 2개 추가, `rebuild-spec` 라우트와 `rebuildSpec()` 제거.
8. `myportal-api-client`에 `reanalyze`/`applySpec` 추가, `rebuildSpec` 제거.
9. `FieldPreviewTable` 컴포넌트 추출 — `add-source` 동작 불변 확인.
10. `/sources/[id]`에 재분석 패널 구현.
11. `pnpm test` → `pnpm lint` → `pnpm typecheck` → `pnpm build` 전부 통과.
12. `docs/시스템설계서.md`·`docs/개발자가이드.md` 갱신.

## 12. 설계 판단 기록

**왜 두 엔드포인트인가**: 미리보기 단계에서 DB를 건드리지 않으므로 '취소'가 공짜다. 단일 엔드포인트에 `dryRun` 플래그를 두면 한 핸들러가 두 책임을 갖고, 미리보기 응답과 저장 요청의 스키마가 완전히 달라 한 계약에 담기 어색하다.

**왜 적용 시 서버가 재분석하지 않는가**: LLM을 두 번 호출해 비용이 2배가 되고, 두 분석 결과가 달라 사용자가 본 것과 저장되는 것이 어긋날 수 있다. 클라이언트가 보낸 스펙은 `applySpec`으로 재실행해 검증하므로 신뢰 문제는 해소된다.

**왜 `normalized_url`을 1차 매칭 키로 쓰는가**: `dedupe_hash`에 제목이 섞여 있어, 재분석이 제목 추출을 개선하면 해시가 전부 바뀐다. 해시로만 매칭하면 백필이 아니라 전량 중복 삽입이 된다.

**왜 `dedupe_hash`까지 갱신하는가**: 백필이 새 제목을 저장하면서 해시를 그대로 두면, 다음 정기 수집이 새 제목으로 계산한 해시를 찾지 못해 같은 항목을 또 삽입한다. 백필과 이후 수집이 같은 키를 봐야 한다.

**왜 신규 삽입분을 읽음 마킹하는가**: 내용은 과거의 것인데 `items`에만 없던 항목이다. 마킹하지 않으면 재분석이 "지난 방문 이후 신규"를 수십 건 부풀려 데스크의 핵심 기능을 망친다.

**왜 사라진 필드를 지우지 않는가**: 기존 `items.attrs`에 그 키의 값이 남아 있고, `source_fields` 행이 없으면 데스크가 라벨 없이 렌더한다. 지우는 것이 손실이다.

**왜 `rebuild-spec`을 제거하는가**: '다시 분석'으로 버튼을 교체하면 호출처가 없어진다. 확인 없이 즉시 저장하는 경로를 남기면 사용자가 두 버튼의 차이를 알 수 없고, 자동 복구는 `repairSpec`이 이미 담당한다.

## 13. 범위 밖 후속 과제

- 소스 완전 삭제 (구독자 0명일 때만 허용하는 등의 안전장치와 함께).
- 구독자별 필드 메타 오버라이드.
- 재분석 결과를 현재 필드와 나란히 보여주는 diff 뷰 (`currentFields`를 이미 내려주므로 UI만 추가하면 된다).
- 여러 소스 일괄 재분석.
