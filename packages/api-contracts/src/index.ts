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
  errorCode: z.string().nullable(),
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
});
export type CreateSourceRequest = z.infer<typeof createSourceRequestSchema>;

export const createSourceResponseSchema = z.object({
  subscriptionId: z.string(),
  sourceId: z.string(),
  baselineCount: z.number(),
  reusedExisting: z.boolean(),
});
export type CreateSourceResponse = z.infer<typeof createSourceResponseSchema>;

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
