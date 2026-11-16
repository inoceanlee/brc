export const SESSION_COOKIE = 'brc_session';
export const SESSION_TTL_MS = 12 * 3_600_000;

export interface SessionSigner {
  sign(payload: string): string;
  equals(left: string, right: string): boolean;
}

export class SessionPolicy {
  constructor(private readonly signer: SessionSigner) {}

  issue(userId: string, now = Date.now()): { value: string; maxAge: number } {
    const payload = `${userId}.${now + SESSION_TTL_MS}`;
    return { value: `${payload}.${this.signer.sign(payload)}`, maxAge: SESSION_TTL_MS };
  }

  userId(raw: string | undefined, now = Date.now()): string | null {
    if (!raw) return null;
    const [userId, exp, sig, extra] = raw.split('.');
    if (!userId || !exp || !sig || extra !== undefined) return null;
    const expires = Number(exp);
    if (!Number.isSafeInteger(expires) || expires < now) return null;
    const expected = this.signer.sign(`${userId}.${exp}`);
    return this.signer.equals(sig, expected) ? userId : null;
  }
}