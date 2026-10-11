import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface CursorPosition {
  filedAt: string;
  id: string;
}

export class CursorError extends Error {}

/** Filters a cursor was minted for; a cursor only works with the same filters. */
export function filterHash(filters: Record<string, string | number | undefined>): string {
  const canonical = Object.keys(filters)
    .sort()
    .filter((k) => filters[k] !== undefined && filters[k] !== '')
    .map((k) => `${k}=${filters[k]}`)
    .join('&');
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

/**
 * Opaque keyset cursor: base64url(JSON position + filter hash) + "." + HMAC.
 * Clients cannot forge a position or reuse a cursor across filters.
 */
export class CursorCodec {
  constructor(private readonly secret: string) {}

  encode(pos: CursorPosition, filters: string): string {
    const payload = Buffer.from(JSON.stringify({ f: pos.filedAt, i: pos.id, h: filters })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  decode(cursor: string, filters: string): CursorPosition {
    const [payload, sig, ...rest] = cursor.split('.');
    if (!payload || !sig || rest.length) throw new CursorError('malformed cursor');
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new CursorError('cursor signature does not match');
    let data: { f?: unknown; i?: unknown; h?: unknown };
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof data;
    } catch {
      throw new CursorError('malformed cursor');
    }
    if (typeof data.f !== 'string' || typeof data.i !== 'string' || Number.isNaN(Date.parse(data.f))) throw new CursorError('malformed cursor');
    if (data.h !== filters) throw new CursorError('cursor was issued for different filters');
    return { filedAt: data.f, id: data.i };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url').slice(0, 22);
  }
}
