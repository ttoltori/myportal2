import { app } from "@/server/app";

// Hono 앱에 요청을 넘기는 얇은 어댑터다 (CLAUDE.md §18).
// 비즈니스 로직은 src/server/ 에만 둔다.
// /api/v1/* → /v1/* 로 변환해 Hono 라우트와 맞춘다.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 소스 분석(/v1/sources/analyze)의 LLM 앞단 최악 소요는 fetchPage 15초 + 브라우저 기동 + 렌더링
// (render.ts: goto 30 + networkidle 6 + SPA 대기 1 + networkidle 6 + 안정화 8 ≈ 51초)이고,
// LLM 호출은 호출 하나가 최대 80초(chatJson이 스키마 불일치 시 시도당 40초로 2회 시도)다.
// 첫 호출 하나만 최악이어도 15 + 51 + 80 = 146초로 120초를 넘고, 호출은 중간에 중단할 수 없다.
// 플랫폼이 중간에 끊으면 폴백도 못 타고 응답 자체가 없으므로, 고정 마감으로 조이지 않고
// 호출 직전의 남은 시간으로 시도 timeout을 줄인다 (run-analysis.ts의 attemptTimeoutMs):
//   시도 timeout = clamp((120 − 경과 − 10) ÷ 2, 15, 40)초, 15초 미만이면 LLM을 건너뛰고 폴백.
// 첫 호출과 보수 호출 모두 이 계산을 거치므로 "시도 timeout × 2 ≤ 남은 예산"이 구조적으로 성립하고,
// 호출 뒤의 합성·검증·프로파일 계산 몫으로 10초가 남는다. 숫자를 손으로 맞추는 것이 아니다.
// 이 값을 바꾸면 run-analysis.ts의 PLATFORM_MAX_DURATION_MS도 같이 바꿔야 예산이 따라 바뀐다.
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
