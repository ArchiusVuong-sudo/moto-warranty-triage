import { randomBytes } from 'node:crypto';

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');
/** W3C trace context header for calls that belong to a claim's trace. */
export const traceparent = (traceId: string, spanId = newSpanId()) => `00-${traceId}-${spanId}-01`;
