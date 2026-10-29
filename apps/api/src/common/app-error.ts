import { HttpException } from '@nestjs/common';

/** Domain/HTTP error with a stable machine-readable code. */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You are not allowed to perform this action') =>
  new AppError(403, 'forbidden', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
