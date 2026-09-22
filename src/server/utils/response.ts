// 응답 envelope(success/error/paginated)은 여러 서비스에서 반복되던 패턴이라
// @ttoltori/hono-api-kit으로 공통화했다. 이 파일은 기존 import 경로(../utils/response)를
// 유지하기 위한 재노출(re-export)이다.
export { success, error, paginated } from "@ttoltori/hono-api-kit";
