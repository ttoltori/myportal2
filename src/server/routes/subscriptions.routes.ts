import { Hono } from "hono";
import {
  bulkSubscriptionSchema,
  updateSubscriptionSchema,
} from "@myportal/api-contracts";
import { success } from "../utils/response";
import { validationError } from "../errors/error-codes";
import { getUserId } from "../features/auth/auth";
import {
  bulkSubscriptions,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from "../features/subscriptions/subscriptions";

export const subscriptionsRoutes = new Hono()
  .get("/subscriptions", async (c) => {
    return success(c, await listSubscriptions(getUserId(c)));
  })
  .patch("/subscriptions/:id", async (c) => {
    const body = updateSubscriptionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await updateSubscription(getUserId(c), c.req.param("id"), body.data));
  })
  .delete("/subscriptions/:id", async (c) => {
    await deleteSubscription(getUserId(c), c.req.param("id"));
    return success(c, { ok: true });
  })
  .post("/subscriptions/bulk", async (c) => {
    const body = bulkSubscriptionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw validationError("유효하지 않은 요청입니다.", body.error.issues);
    return success(c, await bulkSubscriptions(getUserId(c), body.data));
  });
