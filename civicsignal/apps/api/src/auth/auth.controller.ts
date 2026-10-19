import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppConfig, CONFIG } from '../config';
import { AuditService } from '../audit/audit.service';
import { Database } from '../database/database.service';
import { AppError, badRequest } from '../common/errors';
import { FailureThrottle, RateLimit, RateLimitGuard } from '../common/rate-limit';
import { Auth, AuthContext, Meta, RequestMeta } from '../common/request';
import { IDENTITY_PROVIDER, IdentityProvider } from '../identity/identity.provider';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto';
import { SESSION_COOKIE, SessionGuard } from './session.guard';

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
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, secure: this.config.cookieSecure, sameSite: 'lax', path: '/', expires: expiresAt,
    });
  }

  private auditSystem(action: string, userId: string | null, meta: RequestMeta, metadata: Record<string, unknown> = {}) {
    return this.db.withSystem((c) => this.audit.record(c, { tenantId: null, actorUserId: userId, action, targetType: 'user', targetId: userId ?? undefined, metadata, meta }));
  }

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
    this.throttle.begin(key);
    const user = await this.identity.verifyCredentials(dto.email, dto.password);
    if (!user) {
      await this.auditSystem('auth.login_failed', null, meta, { emailHash: hashEmail(dto.email) });
      throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    this.throttle.reset(key);
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
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Post('change-password')
  @HttpCode(204)
  @RateLimit({ limit: 5, windowSeconds: 600 })
  @UseGuards(SessionGuard)
  async changePassword(@Auth() auth: AuthContext, @Body() dto: ChangePasswordDto, @Meta() meta: RequestMeta) {
    const key = `password:${auth.userId}`;
    this.throttle.begin(key);
    const ok = await this.identity.changePassword(auth.userId, dto.currentPassword, dto.newPassword, auth.sessionId);
    if (!ok) {
      throw badRequest('invalid_current_password', 'Current password is incorrect');
    }
    this.throttle.reset(key);
    await this.auditSystem('auth.password_changed', auth.userId, meta, { otherSessionsRevoked: true });
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
