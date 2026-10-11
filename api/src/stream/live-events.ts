import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export type LiveEvent =
  | { type: 'claim'; data: Record<string, unknown> }
  | { type: 'span'; data: Record<string, unknown> }
  | { type: 'health'; data: Record<string, unknown> };

/** In-process fan-out to SSE clients. Only committed state is published. */
@Injectable()
export class LiveEvents {
  private readonly subject = new Subject<LiveEvent>();

  publish(event: LiveEvent): void {
    this.subject.next(event);
  }

  stream(): Observable<LiveEvent> {
    return this.subject.asObservable();
  }
}
