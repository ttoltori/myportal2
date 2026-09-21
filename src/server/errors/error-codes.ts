import { errorCodes, type ErrorCode } from "@myportal/api-contracts";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

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
