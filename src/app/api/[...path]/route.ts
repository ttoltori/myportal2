import { app } from "@/server/app";

// Hono 앱에 요청을 넘기는 얇은 어댑터다 (CLAUDE.md §18).
// 비즈니스 로직은 src/server/ 에만 둔다.
// /api/v1/* → /v1/* 로 변환해 Hono 라우트와 맞춘다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 소스 분석(/v1/sources/analyze)은 한 요청 안에서 렌더링 최대 ~25초 + LLM 최초 호출 최대 80초
// (chatJson이 스키마 불일치 시 40초씩 2회 시도)를 쓴다. 첫 호출은 중단할 수 없고 보수 호출은
// 시작 45초 이후면 건너뛰므로, 합계 ~105초에 여유를 더한 값으로 플랫폼 기본 한도를 넘겨 잡는다.
// 실행 시간 한도는 플랫폼 설정이라 비즈니스 로직(src/server/)이 아니라 이 어댑터에 둔다.
export const maxDuration = 120;

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
