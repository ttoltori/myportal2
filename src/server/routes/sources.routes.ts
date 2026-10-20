import { Hono } from "hono";
import {
  analyzeRequestSchema,
  applySpecRequestSchema,
  createSourceRequestSchema,
  reanalyzeRequestSchema,
} from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import { analyzeUrl } from "../features/crawl/analyze";
import { createSourceWithBaseline } from "../features/crawl/collector";
import { collectNow, getSourceDetail } from "../features/sources/sources";
import { applySpecForSource, reanalyzeSource } from "../features/sources/reanalyze";
import type { CrawlSpec, ExtractedRow } from "../features/crawl/extract";

// 분석 미리보기 행({title, link, published, ...attrs})을 ExtractedRow 형태로 변환한다.
function toExtractedRow(r: Record<string, unknown>): ExtractedRow {
  const { title, link, published, ...attrs } = r;
  return {
    title: String(title ?? ""),
    link: typeof link === "string" ? link : null,
    publishedAt: typeof published === "string" ? published : null,
    attrs,
  };
}

export const sourcesRoutes = new Hono()
  .post("/sources/analyze", async (c) => {
    const body = analyzeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효한 URL을 입력해주세요.", body.error.issues);
    return success(c, await analyzeUrl(getUserId(c), body.data.url, body.data.hint));
  })
  .post("/sources", async (c) => {
    const parsed = createSourceRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError("유효하지 않은 요청입니다.", parsed.error.issues);
    const d = parsed.data;
    return success(
      c,
      await createSourceWithBaseline(getUserId(c), {
        url: d.url,
        displayName: d.displayName,
        categoryId: d.categoryId,
        tagNames: d.tagNames,
        fields: d.fields,
        fetchStrategy: d.fetchStrategy,
        linkOnly: d.linkOnly,
        spec: (d.spec as CrawlSpec | null) ?? null,
        previewRows: (d.previewRows ?? []).map(toExtractedRow),
      }),
      201,
    );
  })
  .get("/sources/:id", async (c) => {
    return success(c, await getSourceDetail(getUserId(c), c.req.param("id")));
  })
  .post("/sources/:id/collect", async (c) => {
    return success(c, await collectNow(getUserId(c), c.req.param("id")));
  })
  .post("/sources/:id/reanalyze", async (c) => {
    const body = reanalyzeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await reanalyzeSource(getUserId(c), c.req.param("id"), body.data.hint));
  })
  .post("/sources/:id/apply-spec", async (c) => {
    const body = applySpecRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await applySpecForSource(getUserId(c), c.req.param("id"), body.data));
  });
