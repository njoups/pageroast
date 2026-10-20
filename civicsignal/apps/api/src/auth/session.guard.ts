import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { unauthorized } from '../common/errors';
import type { AppRequest } from '../common/request';
import { IDENTITY_PROVIDER, IdentityProvider } from '../identity/identity.provider';

export const SESSION_COOKIE = 'cs_session';
/** With Secure cookies the __Host- prefix binds the cookie to this exact host, HTTPS only, path / (no Domain attribute). */
export const SECURE_SESSION_COOKIE = '__Host-cs_session';
export const sessionCookieName = (secure: boolean) => (secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const jar = req.cookies as Record<string, string> | undefined;
    const token = jar?.[SECURE_SESSION_COOKIE] ?? jar?.[SESSION_COOKIE];
    if (!token) throw unauthorized();
    const s = await this.identity.resolveSession(token);
    if (!s) throw unauthorized('Session expired or invalid');
    req.auth = { userId: s.user.id, sessionId: s.sessionId, email: s.user.email, displayName: s.user.displayName, isPlatformAdmin: s.user.isPlatformAdmin };
    return true;
  }
}
