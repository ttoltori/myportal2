import { Hono } from "hono";
import { success } from "../utils/response";
import { getUserId } from "../features/auth/auth";
import { getDeskPayload, heartbeat } from "../features/desk/desk";

export const deskRoutes = new Hono()
  .get("/desk", async (c) => {
    return success(c, await getDeskPayload(getUserId(c)));
  })
  .post("/desk/heartbeat", async (c) => {
    const lastVisitAt = await heartbeat(getUserId(c));
    return success(c, { lastVisitAt });
  });
