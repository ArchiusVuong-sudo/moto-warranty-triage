import { HttpException } from '@nestjs/common';

/** RFC 9457 problem details. */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extra: string]: unknown;
}

export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly kind: string,
    readonly title: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super({ title, detail }, status);
  }
}

export const problemType = (kind: string) => `https://docs.warranty-triage.local/problems/${kind}`;
