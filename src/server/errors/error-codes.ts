import { AppError as BaseAppError } from "@ttoltori/hono-api-kit";
import { errorCodes, type ErrorCode } from "@myportal/api-contracts";

// 공통 AppError(코드/응답 처리 로직)는 @ttoltori/hono-api-kit이 담당하고,
// 여기서는 myportal의 ErrorCode Union으로 타입만 좁힌다.
export class AppError extends BaseAppError<ErrorCode> {}

export function notFound(code: ErrorCode, message: string): AppError {
  return new AppError(code, message, 404);
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError(errorCodes.VALIDATION_ERROR, message, 400, details);
}

export function internalError(
  message = "서버 내부 오류가 발생했습니다.",
): AppError {
  return new AppError(errorCodes.INTERNAL_ERROR, message, 500);
}

export { errorCodes };
export type { ErrorCode };
