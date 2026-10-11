import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemException, problemType, type ProblemBody } from './problem.js';

const KIND_BY_STATUS: Record<number, string> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  412: 'precondition-failed',
  413: 'payload-too-large',
  422: 'unprocessable',
  428: 'precondition-required',
  429: 'rate-limited',
};

/** Every error leaves as application/problem+json with the request's trace id. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    let body: ProblemBody;
    if (exception instanceof ProblemException) {
      body = { type: problemType(exception.kind), title: exception.title, status: exception.getStatus(), detail: exception.detail, ...exception.extra };
      for (const [k, v] of Object.entries(exception.headers)) res.setHeader(k, v);
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse();
      const message = typeof r === 'object' && r !== null && 'message' in r ? (r as { message: unknown }).message : exception.message;
      const errors = Array.isArray(message) ? message : undefined;
      body = {
        type: problemType(KIND_BY_STATUS[status] ?? 'http-error'),
        title: HttpStatus[status]?.toString().replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) ?? 'Error',
        status,
        detail: errors ? errors.join('; ') : String(message),
        ...(errors ? { errors } : {}),
      };
    } else {
      this.log.error(exception instanceof Error ? exception.stack : String(exception));
      body = { type: problemType('internal'), title: 'Internal error', status: 500, detail: 'Unexpected error. See the server log with the trace id.' };
    }
    body.instance = req.originalUrl;
    const traceId = res.getHeader('x-trace-id');
    if (traceId) body.trace_id = traceId;
    res.status(body.status).type('application/problem+json').send(JSON.stringify(body));
  }
}
