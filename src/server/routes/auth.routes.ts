import { Hono } from "hono";
import { requestMagicLinkSchema } from "@myportal/api-contracts";
import { z } from "zod";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import {
  getUserId,
  handleConfirm,
  handleLogout,
  handleSessionFromSupabase,
  issueMagicLink,
} from "../features/auth/auth";
import { getMe } from "../features/auth/me";

const sessionSchema = z.object({ accessToken: z.string().min(10) });

export const authRoutes = new Hono()
  .post("/auth/magic-link", async (c) => {
    const body = requestMagicLinkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효한 이메일을 입력해주세요.", body.error.issues);
    const result = await issueMagicLink(body.data.email);
    return success(c, result);
  })
  .get("/auth/confirm", (c) => handleConfirm(c))
  .post("/auth/session", async (c) => {
    const body = sessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("accessToken이 필요합니다.", body.error.issues);
    await handleSessionFromSupabase(c, body.data.accessToken);
    return success(c, { ok: true });
  })
  .post("/auth/logout", async (c) => {
    await handleLogout(c);
    return success(c, { ok: true });
  })
  .get("/me", async (c) => {
    return success(c, await getMe(getUserId(c)));
  });
