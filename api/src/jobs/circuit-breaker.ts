export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerChange {
  from: BreakerState;
  to: BreakerState;
  reason: string;
}

/**
 * Consecutive-failure breaker. While open, the dispatcher leases nothing, so no
 * job spends an attempt on a service that is down. Half-open is a health probe,
 * not a job attempt.
 */
export class CircuitBreaker {
  private _state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly listeners: ((c: BreakerChange) => void)[] = [];

  constructor(
    private readonly opts: { failureThreshold: number; openMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    return this._state;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  onChange(fn: (c: BreakerChange) => void): void {
    this.listeners.push(fn);
  }

  allowsRequests(): boolean {
    return this._state === 'closed';
  }

  readyToProbe(): boolean {
    return this._state === 'open' && this.now() - this.openedAt >= this.opts.openMs;
  }

  beginProbe(): void {
    if (this._state === 'open') this.move('half_open', 'probing the service health');
  }

  recordSuccess(reason = 'call succeeded'): void {
    this.failures = 0;
    if (this._state !== 'closed') this.move('closed', reason);
  }

  recordFailure(reason: string): void {
    if (this._state === 'half_open') {
      this.openedAt = this.now();
      this.move('open', reason);
      return;
    }
    this.failures++;
    if (this._state === 'closed' && this.failures >= this.opts.failureThreshold) {
      this.openedAt = this.now();
      this.move('open', `${this.failures} failures in a row: ${reason}`);
    }
  }

  private move(to: BreakerState, reason: string): void {
    const from = this._state;
    this._state = to;
    for (const l of this.listeners) l({ from, to, reason });
  }
}
