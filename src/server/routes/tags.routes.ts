import { Hono } from "hono";
import { createTagSchema, updateTagSchema } from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import { createTag, deleteTag, listTags, updateTag } from "../features/tags/tags";

export const tagsRoutes = new Hono()
  .get("/tags", async (c) => {
    return success(c, await listTags(getUserId(c)));
  })
  .post("/tags", async (c) => {
    const body = createTagSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("태그 이름이 필요합니다.", body.error.issues);
    return success(c, await createTag(getUserId(c), body.data.name), 201);
  })
  .patch("/tags/:id", async (c) => {
    const body = updateTagSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("태그 이름이 필요합니다.", body.error.issues);
    return success(c, await updateTag(getUserId(c), c.req.param("id"), body.data.name));
  })
  .delete("/tags/:id", async (c) => {
    await deleteTag(getUserId(c), c.req.param("id"));
    return success(c, { ok: true });
  });
