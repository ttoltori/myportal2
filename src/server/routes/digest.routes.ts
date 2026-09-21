import { Hono } from "hono";
import { digestSettingsSchema } from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import {
  digestPreview,
  getDigest,
  sendDigestNow,
  updateDigest,
} from "../features/digest/digest";

export const digestRoutes = new Hono()
  .get("/digest", async (c) => {
    return success(c, await getDigest(getUserId(c)));
  })
  .put("/digest", async (c) => {
    const body = digestSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 설정입니다.", body.error.issues);
    return success(c, await updateDigest(getUserId(c), body.data));
  })
  .get("/digest/preview", async (c) => {
    return success(c, await digestPreview(getUserId(c)));
  })
  .post("/digest/send-now", async (c) => {
    return success(c, await sendDigestNow(getUserId(c)));
  });
