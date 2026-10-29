import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Central error shape: { error: { code, message, details? } }. Never leaks stack traces or SQL. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as any;
      const code = body?.code ?? defaultCode(status);
      const message = typeof body === 'string' ? body : (body?.message ?? exception.message);
      res.status(status).json({
        error: {
          code,
          message: Array.isArray(message) ? message.join('; ') : message,
          details: body?.details,
        },
      });
      return;
    }
    const err = exception as any;
    // body-parser errors (payload too large, malformed JSON)
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
      return;
    }
    this.logger.error(JSON.stringify({ msg: 'unhandled_exception', name: err?.name, message: err?.message }));
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  }
}

function defaultCode(status: number): string {
  const map: Record<number, string> = {
    400: 'bad_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    429: 'rate_limited',
  };
  return map[status] ?? 'error';
}
