import { z } from "zod";

// ── Common ──────────────────────────────────────────────

export const successResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    success: z.literal(true),
    data,
    meta: z.object({ requestId: z.string() }).optional(),
  });

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().nullable(),
  }),
  meta: z.object({ requestId: z.string() }).optional(),
});

// ── Enum ────────────────────────────────────────────────

export const sourceStatusSchema = z.enum(["ok", "warn", "fail", "pause", "link"]);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const fetchStrategySchema = z.enum([
  "rss",
  "structured",
  "html",
  "rendered",
  "link",
]);
export type FetchStrategy = z.infer<typeof fetchStrategySchema>;

export const fieldTypeSchema = z.enum([
  "text",
  "url",
  "date",
  "datetime",
  "date_range",
  "number",
  "image",
  "tag_list",
]);
export type FieldType = z.infer<typeof fieldTypeSchema>;

// 필드 역할: 고정 컬럼(title/link/published/excerpt) 대응 또는 deadline/summary 같은 파생 용도
export const fieldRoleSchema = z.enum([
  "title",
  "link",
  "published",
  "deadline",
  "summary",
  "none",
]);
export type FieldRole = z.infer<typeof fieldRoleSchema>;

export const ruleActionSchema = z.enum(["emphasize", "alert", "mute"]);
export type RuleAction = z.infer<typeof ruleActionSchema>;

export const ruleScopeTypeSchema = z.enum(["all", "category", "tag"]);
export type RuleScopeType = z.infer<typeof ruleScopeTypeSchema>;

export const pageKindSchema = z.enum(["list", "detail", "unknown"]);
export type PageKind = z.infer<typeof pageKindSchema>;

export const digestFrequencySchema = z.enum(["daily", "weekly"]);
export type DigestFrequency = z.infer<typeof digestFrequencySchema>;

export const digestRunResultSchema = z.enum(["ok", "fail", "skipped", "queued"]);
export type DigestRunResult = z.infer<typeof digestRunResultSchema>;

// ── 공통 객체 ───────────────────────────────────────────

export const sourceFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  type: fieldTypeSchema,
  role: fieldRoleSchema.default("none"),
  visible: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type SourceField = z.infer<typeof sourceFieldSchema>;

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  sortOrder: z.number(),
});
export type Category = z.infer<typeof categorySchema>;

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type Tag = z.infer<typeof tagSchema>;

export const subscriptionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  displayName: z.string(),
  url: z.string(),
  categoryId: z.string().nullable(),
  tagIds: z.array(z.string()),
  fetchStrategy: fetchStrategySchema,
  status: sourceStatusSchema,
  lastSuccessAt: z.string().nullable(),
  new7d: z.number(),
  intervalMinutes: z.number(),
  paused: z.boolean(),
  fields: z.array(sourceFieldSchema),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

// ── 항목(Item) ──────────────────────────────────────────

export const ruleMatchSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  action: ruleActionSchema,
});
export type RuleMatch = z.infer<typeof ruleMatchSchema>;

export const itemSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
  collectedAt: z.string(),
  excerpt: z.string().nullable(),
  attrs: z.record(z.unknown()),
  read: z.boolean(),
  starred: z.boolean(),
  isBaseline: z.boolean(),
  clusterId: z.string().nullable(),
  ruleMatch: ruleMatchSchema.nullable(),
  deadlineAt: z.string().nullable(),
});
export type Item = z.infer<typeof itemSchema>;

// ── Desk (메인 데스크 부트스트랩) ──────────────────────

export const deskPayloadSchema = z.object({
  now: z.string(),
  lastVisitAt: z.string().nullable(),
  categories: z.array(categorySchema),
  tags: z.array(tagSchema),
  subscriptions: z.array(subscriptionSchema),
  keywordRules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      keywords: z.array(z.string()),
      exclude: z.array(z.string()),
      scope: ruleScopeTypeSchema,
      scopeId: z.string().nullable(),
      action: ruleActionSchema,
    }),
  ),
  items: z.array(itemSchema),
  clusters: z.array(
    z.object({
      id: z.string(),
      representativeItemId: z.string(),
    }),
  ),
  meta: z.object({
    lastCollectAt: z.string().nullable(),
    sourceCount: z.number(),
    warnCount: z.number(),
    userEmail: z.string(),
  }),
});
export type DeskPayload = z.infer<typeof deskPayloadSchema>;

// ── Auth ────────────────────────────────────────────────

export const requestMagicLinkSchema = z.object({
  email: z.string().email(),
});
export type RequestMagicLink = z.infer<typeof requestMagicLinkSchema>;

export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  settings: z.object({
    timezone: z.string(),
    digestEnabled: z.boolean(),
    digestFrequency: digestFrequencySchema,
    digestTime: z.string(),
    digestWeekday: z.number().int().min(0).max(6),
    digestCategories: z.array(z.string()),
    digestLimit: z.number().int(),
    lastVisitAt: z.string().nullable(),
  }),
});
export type Me = z.infer<typeof meSchema>;

// ── 소스 분석/등록 ──────────────────────────────────────

export const analyzeStepSchema = z.object({
  label: z.string(),
  status: z.enum(["ok", "warn", "fail", "pause", "running"]),
  detail: z.string().nullable(),
});
export type AnalyzeStep = z.infer<typeof analyzeStepSchema>;

export const analyzeRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  // 목록에 포함되어야 하는 항목의 텍스트 일부.
  // 자동 추정이 엉뚱한 영역(메뉴 등)을 잡을 때 사용자가 직접 지정한다.
  hint: z.string().trim().min(2).max(500).optional(),
});
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

export const parentCandidateSchema = z.object({
  label: z.string(),
  url: z.string(),
});
export type ParentCandidate = z.infer<typeof parentCandidateSchema>;

export const analyzeResultSchema = z.object({
  steps: z.array(analyzeStepSchema),
  outcome: z.enum(["list", "detail", "link-only", "exists", "error"]),
  normalizedUrl: z.string().nullable(),
  pageTitle: z.string().nullable(),
  candidates: z.array(parentCandidateSchema),
  existingSourceId: z.string().nullable(),
  preview: z
    .object({
      fields: z.array(sourceFieldSchema),
      rows: z.array(z.record(z.unknown())),
      fetchStrategy: fetchStrategySchema,
      spec: z.unknown().nullable(),
    })
    .nullable(),
  suggested: z.object({
    displayName: z.string(),
    categoryPath: z.array(z.string()),
    tagNames: z.array(z.string()),
  }),
  // 힌트 영역을 찾지 못했을 때 사용자가 직접 힌트 문자열을 고를 수 있도록
  // 마지막으로 분석한 페이지의 텍스트 스냅샷(블록 단위 줄바꿈).
  pageText: z.string().nullable(),
  errorCode: z.string().nullable(),
  // 미리보기 필드 메타의 출처. "llm"이면 등록 화면에 'AI 추론' 배지를 표시한다.
  // 목록 분석에 성공하지 못한 응답은 null.
  fieldSource: z.enum(["llm", "heuristic"]).nullable(),
});
export type AnalyzeResult = z.infer<typeof analyzeResultSchema>;

export const createSourceRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  displayName: z.string().min(1).max(200),
  categoryId: z.string().nullable(),
  tagNames: z.array(z.string().min(1).max(60)).max(20),
  fields: z.array(sourceFieldSchema),
  fetchStrategy: fetchStrategySchema,
  linkOnly: z.boolean().default(false),
  // 분석 단계에서 확정된 스펙/미리보기를 그대로 전달한다.
  // 없으면 서버가 등록 시점에 다시 추출한다(분석 화면과 다른 결과가 나올 수 있음).
  spec: z.unknown().nullable().optional(),
  previewRows: z.array(z.record(z.unknown())).optional(),
});
export type CreateSourceRequest = z.infer<typeof createSourceRequestSchema>;

export const createSourceResponseSchema = z.object({
  subscriptionId: z.string(),
  sourceId: z.string(),
  baselineCount: z.number(),
  reusedExisting: z.boolean(),
});
export type CreateSourceResponse = z.infer<typeof createSourceResponseSchema>;

// ── 소스 재분석/적용 ────────────────────────────────────
// 등록된 소스를 다시 분석(reanalyze)해 미리보기를 확인한 뒤 적용(apply-spec)하는 2단계 흐름.

export const reanalyzeRequestSchema = z.object({
  // 세 가지 의사를 구분한다.
  //   생략  → 저장된 spec.hint를 그대로 쓴다 (호출처가 힌트를 다루지 않는 경우)
  //   ""    → 힌트 없이 자동 추정한다 (저장된 힌트가 낡았을 때 버리는 수단)
  //   값    → 그 값으로 덮는다
  // 재분석 화면은 저장된 힌트를 입력박스에 채워 보여주므로, 사용자가 지운 것을
  // "저장된 힌트 재사용"으로 해석하면 의도와 정반대가 된다.
  hint: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || v.length >= 2, "힌트는 2자 이상이어야 합니다.")
    .optional(),
});
export type ReanalyzeRequest = z.infer<typeof reanalyzeRequestSchema>;

// reanalyze는 아무것도 저장하지 않는다(LLM 호출 이력 제외).
// 미리보기 단계에서 사용자가 이탈해도 되돌릴 것이 없다.
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
export type ReanalyzeResult = z.infer<typeof reanalyzeResultSchema>;

// 서버는 spec을 신뢰하지 않고 추출을 재실행해 검증한다. 그래서 형태를 느슨하게(unknown) 받는다.
export const applySpecRequestSchema = z.object({
  spec: z.unknown(),
  fields: z.array(sourceFieldSchema).max(30),
  fetchStrategy: fetchStrategySchema,
  hint: z.string().trim().min(2).max(500).optional(),
});
export type ApplySpecRequest = z.infer<typeof applySpecRequestSchema>;

export const applySpecResponseSchema = z.object({
  version: z.number(), // 새 스펙 버전
  fieldsSaved: z.number(),
  backfilled: z.number(), // attrs가 갱신된 기존 항목 수
  inserted: z.number(), // 새로 삽입된 항목 수
  // 페이지 조회 실패로 백필만 건너뜀(스펙·필드는 저장됨)
  backfillFailed: z.boolean(),
});
export type ApplySpecResponse = z.infer<typeof applySpecResponseSchema>;

// ── 구독/소스 관리 ──────────────────────────────────────

export const updateSubscriptionSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  categoryId: z.string().nullable().optional(),
  paused: z.boolean().optional(),
  tagIds: z.array(z.string()).optional(),
});
export type UpdateSubscription = z.infer<typeof updateSubscriptionSchema>;

export const bulkSubscriptionSchema = z.object({
  subscriptionIds: z.array(z.string()).min(1).max(200),
  action: z.enum(["move", "tag", "pause", "unsubscribe"]),
  categoryId: z.string().optional(),
  tagName: z.string().optional(),
});
export type BulkSubscription = z.infer<typeof bulkSubscriptionSchema>;

export const specVersionSchema = z.object({
  version: z.number(),
  createdBy: z.string(),
  createdAt: z.string(),
  active: z.boolean(),
  spec: z.unknown(),
});
export type SpecVersion = z.infer<typeof specVersionSchema>;

export const crawlRunSchema = z.object({
  id: z.string(),
  ranAt: z.string(),
  strategy: fetchStrategySchema,
  durationMs: z.number(),
  newCount: z.number(),
  result: z.string(),
});
export type CrawlRun = z.infer<typeof crawlRunSchema>;

export const sourceDetailSchema = z.object({
  subscription: subscriptionSchema,
  fields: z.array(sourceFieldSchema),
  versions: z.array(specVersionSchema),
  runs: z.array(crawlRunSchema),
  recentItems: z.array(itemSchema),
});
export type SourceDetail = z.infer<typeof sourceDetailSchema>;

// ── 카테고리/태그 ───────────────────────────────────────

export const createCategorySchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().nullable().default(null),
});
export const updateCategorySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: z.string().nullable().optional(),
});
export const mergeCategorySchema = z.object({
  targetId: z.string(),
});

export const createTagSchema = z.object({
  name: z.string().min(1).max(60),
});
export const updateTagSchema = z.object({
  name: z.string().min(1).max(60),
});

// ── 항목 상태 ───────────────────────────────────────────

export const updateItemStateSchema = z.object({
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
});

export const markReadScopeSchema = z.object({
  scope: z.object({
    type: z.enum(["all", "special", "category", "tag", "source"]),
    id: z.string().nullable(),
  }),
});
export const restoreItemStatesSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(5000),
  read: z.boolean(),
});

// ── 키워드 규칙 ─────────────────────────────────────────

export const keywordRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  keywords: z.array(z.string()),
  exclude: z.array(z.string()),
  scope: ruleScopeTypeSchema,
  scopeId: z.string().nullable(),
  action: ruleActionSchema,
});
export type KeywordRule = z.infer<typeof keywordRuleSchema>;

export const upsertKeywordRuleSchema = z.object({
  name: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1).max(120)).min(1).max(50),
  exclude: z.array(z.string().min(1).max(120)).max(50).default([]),
  scope: ruleScopeTypeSchema.default("all"),
  scopeId: z.string().nullable().default(null),
  action: ruleActionSchema,
});
export type UpsertKeywordRule = z.infer<typeof upsertKeywordRuleSchema>;

export const keywordPreviewSchema = z.object({
  keywords: z.array(z.string()).max(50).default([]),
  exclude: z.array(z.string()).max(50).default([]),
  scope: ruleScopeTypeSchema.default("all"),
  scopeId: z.string().nullable().default(null),
});

// ── 다이제스트 ──────────────────────────────────────────

export const digestSettingsSchema = z.object({
  enabled: z.boolean(),
  frequency: digestFrequencySchema,
  time: z.string().regex(/^\d{2}:\d{2}$/),
  weekday: z.number().int().min(0).max(6),
  categories: z.array(z.string()),
  limit: z.number().int().min(1).max(50),
  timezone: z.string(),
});
export type DigestSettings = z.infer<typeof digestSettingsSchema>;

export const digestRunSchema = z.object({
  id: z.string(),
  ranAt: z.string(),
  itemCount: z.number(),
  result: digestRunResultSchema,
});
export type DigestRun = z.infer<typeof digestRunSchema>;

export const digestPreviewSchema = z.object({
  generatedAt: z.string(),
  alertItems: z.array(itemSchema),
  deadlineItems: z.array(itemSchema),
  categorySections: z.array(
    z.object({
      categoryId: z.string(),
      name: z.string(),
      count: z.number(),
      topItems: z.array(itemSchema),
    }),
  ),
  warnSources: z.array(
    z.object({
      subscriptionId: z.string(),
      name: z.string(),
      status: sourceStatusSchema,
    }),
  ),
});
export type DigestPreview = z.infer<typeof digestPreviewSchema>;

// ── Error Codes (요건정의서 §9) ─────────────────────────

export const errorCodes = {
  INVALID_URL: "INVALID_URL",
  URL_UNREACHABLE: "URL_UNREACHABLE",
  ROBOTS_DISALLOWED: "ROBOTS_DISALLOWED",
  PAGE_TYPE_UNKNOWN: "PAGE_TYPE_UNKNOWN",
  PARENT_NOT_FOUND: "PARENT_NOT_FOUND",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
  ALREADY_SUBSCRIBED: "ALREADY_SUBSCRIBED",
  SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
  CATEGORY_NOT_FOUND: "CATEGORY_NOT_FOUND",
  CATEGORY_DEPTH_EXCEEDED: "CATEGORY_DEPTH_EXCEEDED",
  CATEGORY_CYCLE: "CATEGORY_CYCLE",
  RATE_LIMITED: "RATE_LIMITED",
  LLM_QUOTA_EXCEEDED: "LLM_QUOTA_EXCEEDED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_TOKEN: "INVALID_TOKEN",
  EMAIL_SEND_FAILED: "EMAIL_SEND_FAILED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];
