import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from './errors';
import type { AppRequest } from './request';

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    let status = 500;
    let code = 'internal_error';
    let message = 'Unexpected server error';
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.getStatus(); code = exception.code; message = exception.message; details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'http_error';
      message = exception.message;
    } else {
      const pg = exception as { code?: string };
      if (pg?.code === '23505') { status = 409; code = 'conflict'; message = 'A record with these values already exists'; }
      else if (pg?.code === '23503') { status = 409; code = 'conflict'; message = 'Referenced record does not exist or is still in use'; }
      else if (pg?.code === '22007' || pg?.code === '22008') { status = 400; code = 'validation_failed'; message = 'Invalid date or time value'; }
      else if (pg?.code === '23514') { status = 400; code = 'validation_failed'; message = 'Value violates a data constraint'; }
      else if (pg?.code === '22P02') { status = 400; code = 'invalid_identifier'; message = 'Malformed identifier'; }
      else this.log.error(`requestId=${req.requestId} ${(exception as Error)?.stack ?? String(exception)}`);
    }
    res.status(status).json({ error: { code, message, details, requestId: req.requestId } });
  }
}
