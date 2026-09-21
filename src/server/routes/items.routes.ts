import { Hono } from "hono";
import { z } from "zod";
import {
  markReadScopeSchema,
  restoreItemStatesSchema,
  updateItemStateSchema,
} from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import {
  markScopeRead,
  restoreItemStates,
  searchItems,
  updateItemState,
} from "../features/items/items";

export const itemsRoutes = new Hono()
  .patch("/items/:id", async (c) => {
    const body = updateItemStateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await updateItemState(getUserId(c), c.req.param("id"), body.data));
  })
  .post("/items/read-all", async (c) => {
    const body = markReadScopeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 범위입니다.", body.error.issues);
    return success(c, await markScopeRead(getUserId(c), body.data.scope));
  })
  .post("/items/state", async (c) => {
    const body = restoreItemStatesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await restoreItemStates(getUserId(c), body.data.itemIds, body.data.read));
  })
  .get("/items/search", async (c) => {
    const q = z.string().min(1).max(200).safeParse(c.req.query("q"));
    if (!q.success) throw validationError("검색어를 입력해주세요.");
    return success(c, await searchItems(getUserId(c), q.data));
  });
