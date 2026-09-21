import { app } from "@/server/app";

// Hono 앱에 요청을 넘기는 얇은 어댑터다 (CLAUDE.md §18).
// 비즈니스 로직은 src/server/ 에만 둔다.
// /api/v1/* → /v1/* 로 변환해 Hono 라우트와 맞춘다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = (req: Request) => {
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(/^\/api/, "") || "/";
  return app.fetch(new Request(url, req));
};

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
  handler as HEAD,
};
