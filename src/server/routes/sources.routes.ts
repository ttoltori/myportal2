import { Hono } from "hono";
import { z } from "zod";
import {
  analyzeRequestSchema,
  createSourceRequestSchema,
} from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import { analyzeUrl } from "../features/crawl/analyze";
import { createSourceWithBaseline } from "../features/crawl/collector";
import { collectNow, getSourceDetail, rebuildSpec } from "../features/sources/sources";
import type { CrawlSpec, ExtractedRow } from "../features/crawl/extract";

// createSourceRequestSchema + 분석 단계에서 넘어온 스펙/미리보기 행
const createWithSpecSchema = createSourceRequestSchema.extend({
  spec: z.unknown().nullable().optional(),
  previewRows: z.array(z.record(z.unknown())).optional(),
});

export const sourcesRoutes = new Hono()
  .post("/sources/analyze", async (c) => {
    const body = analyzeRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효한 URL을 입력해주세요.", body.error.issues);
    return success(c, await analyzeUrl(body.data.url));
  })
  .post("/sources", async (c) => {
    const parsed = createWithSpecSchema.safeParse(await c.req.json().catch(() => ({})));
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
        previewRows: (d.previewRows as ExtractedRow[] | undefined) ?? [],
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
  .post("/sources/:id/rebuild-spec", async (c) => {
    return success(c, await rebuildSpec(getUserId(c), c.req.param("id")));
  });
