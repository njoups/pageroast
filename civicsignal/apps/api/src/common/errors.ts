import { HttpException } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(status: number, readonly code: string, message: string, readonly details?: unknown) {
    super({ code, message, details }, status);
  }
}
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') => new AppError(403, 'forbidden', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthenticated', message);
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
