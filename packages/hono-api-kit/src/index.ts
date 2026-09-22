import { randomUUID } from "crypto";
import type { Context, Hono, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// ── request id ──
// 모든 요청에 request id를 부여해 로그와 응답(meta.requestId)을 연결한다.

export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  };
}

export function getRequestId(c: Context): string {
  return (c.get("requestId") as string | undefined) ?? "unknown";
}

// ── error ──
// 서비스별 오류 코드 Union(예: ErrorCode)을 TCode로 지정해 서브클래싱하면
// code 필드의 타입 안전성을 유지하면서 응답/핸들링 로직은 공유할 수 있다.

export class AppError<TCode extends string = string> extends Error {
  constructor(
    public readonly code: TCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ── response envelope ──
// 성공/실패 응답을 { success, data|error, meta.requestId } 형태로 통일한다.

export function success<T>(
  c: Context,
  data: T,
  status: ContentfulStatusCode = 200,
) {
  return c.json(
    {
      success: true as const,
      data,
      meta: { requestId: getRequestId(c) },
    },
    status,
  );
}

export function error(c: Context, err: AppError) {
  return c.json(
    {
      success: false as const,
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
      },
      meta: { requestId: getRequestId(c) },
    },
    err.statusCode as ContentfulStatusCode,
  );
}

export function paginated<T>(
  c: Context,
  items: T[],
  total: number,
  page: number,
  pageSize: number,
) {
  return success(c, { items, total, page, pageSize });
}

// ── app wiring ──
// requestId 미들웨어 + 표준 notFound/onError 핸들러를 한 번에 붙인다.
// 서비스별 AppError 서브클래스와 내부 오류 코드/메시지를 주입받는다.

export function attachErrorHandling(
  app: Hono,
  options: {
    notFoundCode: string;
    notFoundMessage: string;
    internalErrorCode: string;
    internalErrorMessage: string;
    onUnhandledError?: (err: unknown) => void;
  },
): void {
  app.notFound((c) =>
    error(
      c,
      new AppError(options.notFoundCode, options.notFoundMessage, 404),
    ),
  );

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return error(c, err);
    }
    options.onUnhandledError?.(err);
    return error(
      c,
      new AppError(options.internalErrorCode, options.internalErrorMessage, 500),
    );
  });
}
