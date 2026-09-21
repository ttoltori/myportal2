import type { Context, Next } from "hono";
import { randomUUID } from "crypto";

export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  };
}

export function getRequestId(c: Context): string {
  return (c.get("requestId") as string) ?? "unknown";
}
