import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { conflict } from '../common/errors';
import { IdentityProvider, IdentityUser, SessionInfo, SessionMeta, SessionSummary } from './identity.provider';
import { hashPassword, verifyPassword } from './password';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

type UserRow = { id: string; email: string; display_name: string; is_platform_admin: boolean; password_hash: string };
const toUser = (r: UserRow): IdentityUser => ({ id: r.id, email: r.email, displayName: r.display_name, isPlatformAdmin: r.is_platform_admin });
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** last_seen_at is written at most once per minute per session, so busy sessions do not create a write per request. */
const TOUCH_INTERVAL_S = 60;

@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  readonly name = 'local';
  readonly capabilities: { mfa: boolean; passwordRecovery: boolean };
  private dummyHash: Promise<string>;

  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig) {
    // Used to equalise timing when the email does not exist.
    this.dummyHash = hashPassword(randomBytes(16).toString('hex'), config.scryptN);
    // MFA is not offered by this adapter (it requires a managed IdP); recovery needs an email channel to deliver tokens.
    this.capabilities = { mfa: false, passwordRecovery: !!(config.email.smtpUrl && config.email.from) };
  }

  async register(input: { email: string; password: string; displayName: string }): Promise<IdentityUser> {
    const passwordHash = await hashPassword(input.password, this.config.scryptN);
    return this.db.withSystem(async (c) => {
      const r = await c.query<UserRow>(
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING RETURNING *`, [input.email, input.displayName, passwordHash]);
      if (!r.rows[0]) throw conflict('email_taken', 'An account with this email already exists');
      return toUser(r.rows[0]);
    });
  }

  async verifyCredentials(email: string, password: string): Promise<IdentityUser | null> {
    const row = await this.db.withSystem(async (c) =>
      (await c.query<UserRow>('SELECT * FROM users WHERE email = $1 AND disabled_at IS NULL', [email])).rows[0]);
    const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash));
    return row && ok ? toUser(row) : null;
  }

  async createSession(userId: string, meta: SessionMeta) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
    const sessionId = await this.db.withSystem(async (c) =>
      (await c.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [userId, hashToken(token), expiresAt, meta.ip, meta.userAgent?.slice(0, 400) ?? null])).rows[0]!.id);
    return { token, sessionId, expiresAt };
  }

  /** Valid only if not revoked, not past the absolute expiry, not idle longer than SESSION_IDLE_SECONDS, user active. */
  async resolveSession(token: string): Promise<SessionInfo | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.withSystem(async (c) => {
      const row = (await c.query<UserRow & { session_id: string; expires_at: Date; idle_s: number }>(
        `SELECT u.*, s.id AS session_id, s.expires_at, extract(epoch FROM now() - s.last_seen_at)::int AS idle_s
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
           AND s.last_seen_at > now() - make_interval(secs => $2)`,
        [hashToken(token), this.config.sessionIdleSeconds])).rows[0];
      if (!row) return null;
      if (row.idle_s >= TOUCH_INTERVAL_S) await c.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
      return { sessionId: row.session_id, expiresAt: row.expires_at, user: toUser(row) };
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.withSystem((c) => c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]));
  }

  async listSessions(userId: string): Promise<SessionSummary[]> {
    return this.db.withUser(userId, async (c) => (await c.query(
      `SELECT id, created_at, last_seen_at, expires_at, host(ip) AS ip, user_agent FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(secs => $2)
       ORDER BY last_seen_at DESC LIMIT 50`, [userId, this.config.sessionIdleSeconds])).rows.map((r) => ({
      id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent?.slice(0, 200) ?? null })));
  }

  async revokeUserSession(userId: string, sessionId: string): Promise<boolean> {
    return this.db.withUser(userId, async (c) =>
      ((await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [sessionId, userId])).rowCount ?? 0) > 0);
  }

  async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    return this.db.withUser(userId, async (c) =>
      (await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [userId, keepSessionId])).rowCount ?? 0);
  }

  async changePassword(userId: string, current: string, next: string, keepSessionId: string): Promise<boolean> {
    const row = await this.db.withUser(userId, async (c) =>
      (await c.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId])).rows[0]);
    if (!row || !(await verifyPassword(current, row.password_hash))) return false;
    const hash = await hashPassword(next, this.config.scryptN);
    await this.db.withUser(userId, async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [userId, keepSessionId]);
    });
    return true;
  }

  async createPasswordReset(email: string) {
    return this.db.withSystem(async (c) => {
      const user = (await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL', [email])).rows[0];
      if (!user) return null;
      // At most 3 outstanding requests per account per hour; earlier unused tokens are invalidated.
      const recent = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user.id])).rows[0]!.n;
      if (recent >= 3) return null;
      await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + this.config.passwordResetTtlMinutes * 60_000);
      await c.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [user.id, hashToken(token), expiresAt]);
      return { userId: user.id, token, expiresAt };
    });
  }

  async completePasswordReset(token: string, newPassword: string): Promise<string | null> {
    if (!TOKEN.test(token)) return null;
    const hash = await hashPassword(newPassword, this.config.scryptN);
    const userId = await this.db.withSystem(async (c) => (await c.query<{ user_id: string }>(
      `UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [hashToken(token)])).rows[0]?.user_id ?? null);
    if (!userId) return null;
    await this.db.withUser(userId, async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1 AND disabled_at IS NULL', [userId, hash]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    });
    return userId;
  }
}
