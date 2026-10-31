import { app } from "@/server/app";

// Hono 앱에 요청을 넘기는 얇은 어댑터다 (CLAUDE.md §18).
// 비즈니스 로직은 src/server/ 에만 둔다.
// /api/v1/* → /v1/* 로 변환해 Hono 라우트와 맞춘다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 소스 분석(/v1/sources/analyze)은 한 요청 안에서 렌더링 최대 ~25초 + LLM 첫 호출 최대 80초를 쓴다
// (chatJson이 스키마 불일치 시 시도당 40초로 2회 시도). 첫 호출은 중단할 수 없다.
// 보수 호출도 최악 80초라, 시작 시점을 막지 않으면 첫 호출이 빨리 끝난 요청이 44초에 보수를 시작해
// 124초까지 갈 수 있고, 플랫폼이 중간에 끊으면 폴백도 못 타고 응답 자체가 없다.
// 그래서 보수는 "경과 ≤ 120 − 80 − 10(프로파일·응답 여유) = 30초"일 때만 시작한다
// (run-analysis.ts의 REPAIR_DEADLINE_MS). 보수를 포함한 최악은 30 + 80 = 110초, 보수 없이 첫 호출만
// 최악이면 25 + 80 = 105초이고 둘 다 120초 안이다.
// 이 값을 바꾸면 run-analysis.ts의 PLATFORM_MAX_DURATION_MS도 같이 바꿔야 마감이 따라 바뀐다.
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
