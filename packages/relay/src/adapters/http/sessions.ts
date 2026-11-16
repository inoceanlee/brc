import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { SESSION_COOKIE, SessionPolicy, type SessionSigner } from '../../core/auth/sessions.js';

export class HmacSessionSigner implements SessionSigner {
  constructor(private readonly secret: string) {}

  sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  equals(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export class Sessions {
  constructor(private readonly policy: SessionPolicy, private readonly secure: boolean) {}

  issue(res: Response, userId: string): void {
    const { value, maxAge } = this.policy.issue(userId);
    res.cookie(SESSION_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: this.secure, maxAge, path: '/' });
  }

  clear(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  userId(req: Request): string | null {
    return this.policy.userId(req.cookies?.[SESSION_COOKIE] as string | undefined);
  }
}