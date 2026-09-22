import { Hono } from "hono";
import { cors } from "hono/cors";
import { attachErrorHandling, requestIdMiddleware } from "@ttoltori/hono-api-kit";
import { errorCodes } from "./errors/error-codes";
import { env } from "./config/env";
import { authRoutes } from "./routes/auth.routes";
import { deskRoutes } from "./routes/desk.routes";
import { itemsRoutes } from "./routes/items.routes";
import { categoriesRoutes } from "./routes/categories.routes";
import { tagsRoutes } from "./routes/tags.routes";
import { subscriptionsRoutes } from "./routes/subscriptions.routes";
import { sourcesRoutes } from "./routes/sources.routes";
import { keywordRulesRoutes } from "./routes/keyword-rules.routes";
import { digestRoutes } from "./routes/digest.routes";
import { internalRoutes } from "./routes/internal.routes";
import { requireAuth } from "./features/auth/auth";

// Next.js Route Handler 외부에서도 테스트 가능한 순수 Hono 앱 (CLAUDE.md §18).
export function createApp(): Hono {
  const app = new Hono();

  app.use("*", requestIdMiddleware());
  app.use(
    "*",
    cors({
      origin: env.appBaseUrl,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // notFound/onError 공통 처리 — 내부 오류는 코드/메시지를 숨기고 안정적인 코드만 반환한다 (§15).
  attachErrorHandling(app, {
    notFoundCode: errorCodes.NOT_FOUND,
    notFoundMessage: "엔드포인트를 찾을 수 없습니다.",
    internalErrorCode: errorCodes.INTERNAL_ERROR,
    internalErrorMessage: "서버 내부 오류가 발생했습니다.",
    onUnhandledError: (err) => console.error(`[myportal] unhandled error:`, err),
  });

  // 세션 인증은 여기서 한 번만 적용한다.
  // /v1/auth/*(로그인 관련)와 /v1/internal/*(시크릿 인증)은 제외.
  // 서브 라우터에 .use("/*")로 달면 병합 시 /internal/*까지 미들웨어가 새어 나간다.
  const SESSION_EXEMPT_PREFIXES = ["/v1/auth/", "/v1/internal/"];
  app.use("/v1/*", async (c, next) => {
    if (SESSION_EXEMPT_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      return next();
    }
    return requireAuth()(c, next);
  });

  const v1 = new Hono()
    .route("/", authRoutes)
    .route("/", deskRoutes)
    .route("/", itemsRoutes)
    .route("/", categoriesRoutes)
    .route("/", tagsRoutes)
    .route("/", subscriptionsRoutes)
    .route("/", sourcesRoutes)
    .route("/", keywordRulesRoutes)
    .route("/", digestRoutes)
    .route("/", internalRoutes);

  app.route("/v1", v1);

  app.get("/health", (c) => c.json({ ok: true }));

  return app;
}

export const app = createApp();
