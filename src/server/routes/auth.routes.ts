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
  isMasterKey,
  issueMagicLink,
  sessionForMasterKey,
  setSessionCookie,
} from "../features/auth/auth";
import { getMe } from "../features/auth/me";

const sessionSchema = z.object({ accessToken: z.string().min(10) });

export const authRoutes = new Hono()
  .post("/auth/magic-link", async (c) => {
    const body = requestMagicLinkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("이메일 또는 로그인 키를 입력해주세요.", body.error.issues);
    // 비밀 문구가 맞으면 매직링크 없이 바로 세션을 발급한다.
    // 쿠키 설정에 Context가 필요해 feature가 아니라 여기서 처리한다.
    if (isMasterKey(body.data.email)) {
      const { sessionToken } = await sessionForMasterKey();
      setSessionCookie(c, sessionToken);
      return success(c, { sent: true, loggedIn: true });
    }
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
