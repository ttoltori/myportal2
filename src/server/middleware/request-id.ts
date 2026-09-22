// request id 미들웨어는 @ttoltori/hono-api-kit으로 공통화했다. 기존 import 경로
// (./middleware/request-id)를 유지하기 위한 재노출(re-export)이다.
export { requestIdMiddleware, getRequestId } from "@ttoltori/hono-api-kit";
