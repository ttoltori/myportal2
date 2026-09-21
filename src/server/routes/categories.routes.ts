import { Hono } from "hono";
import {
  createCategorySchema,
  mergeCategorySchema,
  updateCategorySchema,
} from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import {
  createCategory,
  deleteCategory,
  listCategories,
  mergeCategory,
  updateCategory,
} from "../features/categories/categories";

export const categoriesRoutes = new Hono()
  .get("/categories", async (c) => {
    return success(c, await listCategories(getUserId(c)));
  })
  .post("/categories", async (c) => {
    const body = createCategorySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await createCategory(getUserId(c), body.data.name, body.data.parentId), 201);
  })
  .patch("/categories/:id", async (c) => {
    const body = updateCategorySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await updateCategory(getUserId(c), c.req.param("id"), body.data));
  })
  .delete("/categories/:id", async (c) => {
    await deleteCategory(getUserId(c), c.req.param("id"));
    return success(c, { ok: true });
  })
  .post("/categories/:id/merge", async (c) => {
    const body = mergeCategorySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("targetId가 필요합니다.", body.error.issues);
    await mergeCategory(getUserId(c), c.req.param("id"), body.data.targetId);
    return success(c, { ok: true });
  });
