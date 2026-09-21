import { createMyportalClient } from "@myportal/myportal-api-client";
import { ApiError } from "@ttoltori/api-client-core";

const baseUrl =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

// 세션은 httpOnly 쿠키로 전달되므로 별도 토큰 getter는 필요 없다.
// 같은 출처 요청에서는 브라우저가 자동으로 쿠키를 실어 보낸다.
export const api = createMyportalClient({ baseUrl });

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "UNAUTHORIZED";
}

export { ApiError };
