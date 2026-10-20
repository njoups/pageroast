import { createHash } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppConfig, CONFIG } from '../config';
import { AuditService } from '../audit/audit.service';
import { Database } from '../database/database.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { EmailChannel } from '../alerts/channels/email';
import { logEvent } from '../ingestion/log';
import { FailureThrottle, RateLimit, RateLimitGuard } from '../common/rate-limit';
import { Auth, AuthContext, Meta, RequestMeta } from '../common/request';
import { IDENTITY_PROVIDER, IdentityProvider } from '../identity/identity.provider';
import { ChangePasswordDto, LoginDto, PasswordResetConfirmDto, PasswordResetRequestDto, RegisterDto } from './dto';
import { sessionCookieName, SessionGuard } from './session.guard';

@ApiTags('auth')
@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly throttle: FailureThrottle,
  ) {}

  private setCookie(res: Response, token: string, expiresAt: Date) {
    res.cookie(sessionCookieName(this.config.cookieSecure), token, {
      httpOnly: true, secure: this.config.cookieSecure, sameSite: 'lax', path: '/', expires: expiresAt,
    });
  }

  private auditSystem(action: string, userId: string | null, meta: RequestMeta, metadata: Record<string, unknown> = {}, outcome: 'success' | 'failure' | 'denied' = 'success') {
    return this.db.withSystem((c) => this.audit.record(c, { tenantId: null, actorUserId: userId, action, targetType: 'user', targetId: userId ?? undefined, metadata, meta, outcome }));
  }
  private mailer: EmailChannel | null = null;
  /** Tests replace the SMTP transport. */
  overrideMailer(m: EmailChannel) { this.mailer = m; }

  @Post('register')
  @RateLimit({ limit: 5, windowSeconds: 600 })
  async register(@Body() dto: RegisterDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const user = await this.identity.register(dto);
    const s = await this.identity.createSession(user.id, meta);
    await this.auditSystem('auth.registered', user.id, meta);
    this.setCookie(res, s.token, s.expiresAt);
    return { user };
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 300 })
  async login(@Body() dto: LoginDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const key = `login:${hashEmail(dto.email)}`;
    await this.throttle.begin(key);
    const user = await this.identity.verifyCredentials(dto.email, dto.password);
    if (!user) {
      await this.auditSystem('auth.login_failed', null, meta, { emailHash: hashEmail(dto.email) }, 'failure');
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    await this.throttle.reset(key);
    const s = await this.identity.createSession(user.id, meta);
    await this.auditSystem('auth.login', user.id, meta);
    this.setCookie(res, s.token, s.expiresAt);
    return { user };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@Auth() auth: AuthContext, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    await this.identity.revokeSession(auth.sessionId);
    await this.auditSystem('auth.logout', auth.userId, meta);
    res.clearCookie(sessionCookieName(this.config.cookieSecure), { path: '/', secure: this.config.cookieSecure, httpOnly: true, sameSite: 'lax' });
  }

  @Post('change-password')
  @HttpCode(204)
  @RateLimit({ limit: 5, windowSeconds: 600 })
  @UseGuards(SessionGuard)
  async changePassword(@Auth() auth: AuthContext, @Body() dto: ChangePasswordDto, @Meta() meta: RequestMeta) {
    const key = `password:${auth.userId}`;
    await this.throttle.begin(key);
    const ok = await this.identity.changePassword(auth.userId, dto.currentPassword, dto.newPassword, auth.sessionId);
    if (!ok) {
      await this.auditSystem('auth.password_change_failed', auth.userId, meta, {}, 'failure');
      throw badRequest('invalid_current_password', 'Current password is incorrect');
    }
    await this.throttle.reset(key);
    await this.auditSystem('auth.password_changed', auth.userId, meta, { otherSessionsRevoked: true });
  }

  /**
   * Password recovery (local adapter). The response is identical whether or not the account exists, and the email is sent
   * after the response is prepared, so neither content nor timing reveals registered addresses. The link carries the token
   * in the URL fragment, so it never reaches server logs or Referer headers.
   */
  @Post('password-reset/request')
  @HttpCode(202)
  @RateLimit({ limit: 5, windowSeconds: 900 })
  async requestReset(@Body() dto: PasswordResetRequestDto, @Meta() meta: RequestMeta) {
    const mailer = this.mailer ?? new EmailChannel(this.config.email);
    if (!this.identity.capabilities.passwordRecovery || !mailer.configured) {
      throw new AppError(503, 'recovery_unavailable', 'Password recovery is not available: no email channel is configured. Ask an administrator.');
    }
    await this.throttle.begin(`reset:${hashEmail(dto.email)}`);
    const issued = await this.identity.createPasswordReset(dto.email);
    await this.auditSystem('auth.password_reset_requested', issued?.userId ?? null, meta, { emailHash: hashEmail(dto.email), issued: !!issued });
    if (issued) {
      const link = `${this.config.appBaseUrl}/reset-password#token=${issued.token}`;
      setImmediate(() => void mailer.send({ to: dto.email, subject: 'CivicSignal password reset',
        text: `A password reset was requested for this account.\n\nSet a new password (valid ${this.config.passwordResetTtlMinutes} minutes, single use):\n${link}\n\nIf you did not request this, ignore this email; your password is unchanged.`,
        html: `<p>A password reset was requested for this account.</p><p><a href="${link}">Set a new password</a> (valid ${this.config.passwordResetTtlMinutes} minutes, single use).</p><p>If you did not request this, ignore this email; your password is unchanged.</p>` })
        .catch((e: Error) => logEvent('warn', 'auth.reset_email_failed', { message: e.message.slice(0, 200) })));
    }
    return { status: 'accepted', message: 'If an active account exists for this address, a reset link has been sent.' };
  }

  @Post('password-reset/confirm')
  @HttpCode(204)
  @RateLimit({ limit: 10, windowSeconds: 900 })
  async confirmReset(@Body() dto: PasswordResetConfirmDto, @Meta() meta: RequestMeta) {
    const userId = await this.identity.completePasswordReset(dto.token, dto.newPassword);
    if (!userId) {
      await this.auditSystem('auth.password_reset_failed', null, meta, {}, 'failure');
      throw badRequest('invalid_reset_token', 'This reset link is invalid, expired or already used');
    }
    await this.auditSystem('auth.password_reset_completed', userId, meta, { allSessionsRevoked: true });
  }

  /** The caller's active sessions (devices). */
  @Get('sessions')
  @UseGuards(SessionGuard)
  async sessions(@Auth() auth: AuthContext) {
    return { sessions: (await this.identity.listSessions(auth.userId)).map((s) => ({ ...s, current: s.id === auth.sessionId })) };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async revokeSession(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    if (!(await this.identity.revokeUserSession(auth.userId, id))) throw notFound('Session');
    await this.auditSystem('auth.session_revoked', auth.userId, meta, { sessionId: id, current: id === auth.sessionId });
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async revokeOthers(@Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    const n = await this.identity.revokeOtherSessions(auth.userId, auth.sessionId);
    await this.auditSystem('auth.sessions_revoked', auth.userId, meta, { count: n });
    return { revoked: n };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@Auth() auth: AuthContext) {
    const organizations = await this.db.withUser(auth.userId, async (c) => (await c.query(
      `SELECT t.id, t.name, t.slug, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 AND t.archived_at IS NULL ORDER BY t.name`, [auth.userId])).rows);
    return {
      user: { id: auth.userId, email: auth.email, displayName: auth.displayName, isPlatformAdmin: auth.isPlatformAdmin },
      organizations,
      identityProvider: { name: this.identity.name, ...this.identity.capabilities },
    };
  }
}

function hashEmail(email: string): string {
  // Store only a hash so failed-login audit rows don't accumulate submitted (possibly mistyped) emails.
  return createHash('sha256').update(email).digest('hex').slice(0, 16);
}
