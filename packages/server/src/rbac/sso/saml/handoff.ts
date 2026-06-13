/**
 * In-memory, single-instance stores for the SAML flow:
 *  - one-time token-handoff codes (ACS → SPA exchange)
 *  - assertion-ID replay cache
 * Multi-instance deployments need shared storage (see design "Known limitations").
 */
import { randomUUID } from 'crypto';
import type { UserResponse } from '../../schema';
import type { TokenPair } from '../../services/jwt';

export interface HandoffPayload {
  user: UserResponse;
  tokens: TokenPair;
  redirect: string;
}

const codes = new Map<string, { payload: HandoffPayload; expiresAt: number }>();
const seen = new Map<string, number>(); // assertionId -> expiry ms

function sweep(now: number): void {
  for (const [k, v] of codes) if (v.expiresAt <= now) codes.delete(k);
  for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
}

export function stashTokens(
  payload: HandoffPayload,
  ttlMs: number,
  nowDate: Date = new Date()
): string {
  const now = nowDate.getTime();
  sweep(now);
  const code = randomUUID();
  codes.set(code, { payload, expiresAt: now + ttlMs });
  return code;
}

export function claimTokens(code: string, nowDate: Date = new Date()): HandoffPayload | null {
  const now = nowDate.getTime();
  const hit = codes.get(code);
  codes.delete(code); // single-use regardless of expiry
  if (!hit || hit.expiresAt <= now) return null;
  return hit.payload;
}

/** True if the assertion id is fresh (and records it); false if already seen (replay). */
export function markAssertionSeen(
  id: string,
  notOnOrAfter: Date,
  nowDate: Date = new Date()
): boolean {
  const now = nowDate.getTime();
  sweep(now);
  if (seen.has(id)) return false;
  seen.set(id, notOnOrAfter.getTime());
  return true;
}
