import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { conflict } from '../common/errors';
import { IdentityProvider, IdentityUser, SessionInfo, SessionMeta } from './identity.provider';
import { hashPassword, verifyPassword } from './password';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

type UserRow = { id: string; email: string; display_name: string; is_platform_admin: boolean; password_hash: string };
const toUser = (r: UserRow): IdentityUser => ({ id: r.id, email: r.email, displayName: r.display_name, isPlatformAdmin: r.is_platform_admin });

@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  readonly name = 'local';
  readonly capabilities = { mfa: false, passwordRecovery: false };
  private dummyHash: Promise<string>;

  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig) {
    // Used to equalise timing when the email does not exist.
    this.dummyHash = hashPassword(randomBytes(16).toString('hex'), config.scryptN);
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

  async resolveSession(token: string): Promise<SessionInfo | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = await this.db.withSystem(async (c) =>
      (await c.query<UserRow & { session_id: string; expires_at: Date }>(
        `SELECT u.*, s.id AS session_id, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
        [hashToken(token)])).rows[0]);
    return row ? { sessionId: row.session_id, expiresAt: row.expires_at, user: toUser(row) } : null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.withSystem((c) => c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]));
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
}
