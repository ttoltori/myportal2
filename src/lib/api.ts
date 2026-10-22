import { createMyportalClient } from "@myportal/myportal-api-client";
import { ApiError } from "@ttoltori/api-client-core";

// 프론트와 API가 같은 출처이므로 브라우저에서는 현재 도메인에서 유도한다.
// NEXT_PUBLIC_*은 빌드 시점에 번들에 박히는 값이라, 설정을 빠뜨리거나 도메인이
// 바뀌면 운영 번들이 localhost를 호출해 모든 요청이 실패한다(값을 고쳐도 재배포
// 전까지 반영되지 않는다). 도메인에서 유도하면 그 사고가 구조적으로 사라지고
// preview 배포에서도 자동으로 맞는다.
//
// 상대 경로("/api")를 쓸 수는 없다 — api-client-core가 인자 하나짜리 new URL()로
// 요청 주소를 만들기 때문에 절대 URL이어야 한다.
//
// 값을 설정하면 그것이 우선한다. 프론트와 API를 다른 도메인에 두는 구성을 위해
// 남겨둔다. 서버 렌더링 중에는 window가 없으므로 로컬 기본값으로 떨어진다
// (현재 모든 호출은 "use client" 컴포넌트의 useEffect·핸들러에서만 일어난다).
// 빈 문자열도 '미설정'으로 본다. ??는 ""를 통과시켜 baseUrl이 ""가 되고
// 모든 요청이 Invalid URL로 죽는다 — 서버 쪽 env.ts가 쓰는 관례와 같다.
const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

const baseUrl =
  configuredApiUrl ||
  (typeof window !== "undefined"
    ? `${window.location.origin}/api`
    : "http://localhost:3001/api");

// 세션은 httpOnly 쿠키로 전달되므로 별도 토큰 getter는 필요 없다.
// 같은 출처 요청에서는 브라우저가 자동으로 쿠키를 실어 보낸다.
export const api = createMyportalClient({ baseUrl });

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "UNAUTHORIZED";
}

export { ApiError };
