import { Hono } from "hono";
import {
  keywordPreviewSchema,
  upsertKeywordRuleSchema,
} from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import {
  createRule,
  deleteRule,
  listRules,
  previewRule,
  updateRule,
} from "../features/keywords/rules";

export const keywordRulesRoutes = new Hono()
  .get("/keyword-rules", async (c) => {
    return success(c, await listRules(getUserId(c)));
  })
  .post("/keyword-rules", async (c) => {
    const body = upsertKeywordRuleSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    const d = body.data;
    return success(
      c,
      await createRule(getUserId(c), {
        name: d.name,
        keywords: d.keywords,
        exclude: d.exclude,
        scope: d.scope,
        scopeId: d.scopeId,
        action: d.action,
      }),
      201,
    );
  })
  .patch("/keyword-rules/:id", async (c) => {
    const body = upsertKeywordRuleSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    const d = body.data;
    return success(
      c,
      await updateRule(getUserId(c), c.req.param("id"), {
        name: d.name,
        keywords: d.keywords,
        exclude: d.exclude,
        scope: d.scope,
        scopeId: d.scopeId,
        action: d.action,
      }),
    );
  })
  .delete("/keyword-rules/:id", async (c) => {
    await deleteRule(getUserId(c), c.req.param("id"));
    return success(c, { ok: true });
  })
  .post("/keyword-rules/preview", async (c) => {
    const body = keywordPreviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await previewRule(getUserId(c), body.data));
  });
