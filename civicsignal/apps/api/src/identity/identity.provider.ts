/**
 * Port for identity. LocalIdentityProvider is the development/pilot adapter.
 * A managed adapter (Supabase Auth / OIDC with MFA and password recovery) implements the same contract.
 */
export interface IdentityUser { id: string; email: string; displayName: string; isPlatformAdmin: boolean }
export interface SessionInfo { sessionId: string; user: IdentityUser; expiresAt: Date }
export interface SessionSummary { id: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; ip: string | null; userAgent: string | null }
export interface SessionMeta { ip: string | null; userAgent: string | null }

export interface IdentityProvider {
  readonly name: string;
  readonly capabilities: { mfa: boolean; passwordRecovery: boolean };
  register(input: { email: string; password: string; displayName: string }): Promise<IdentityUser>;
  verifyCredentials(email: string, password: string): Promise<IdentityUser | null>;
  createSession(userId: string, meta: SessionMeta): Promise<{ token: string; sessionId: string; expiresAt: Date }>;
  resolveSession(token: string): Promise<SessionInfo | null>;
  revokeSession(sessionId: string): Promise<void>;
  changePassword(userId: string, current: string, next: string, keepSessionId: string): Promise<boolean>;
  listSessions(userId: string): Promise<SessionSummary[]>;
  /** Revokes one of the user's own sessions; false when it is not theirs or already ended. */
  revokeUserSession(userId: string, sessionId: string): Promise<boolean>;
  revokeOtherSessions(userId: string, keepSessionId: string): Promise<number>;
  /** Issues a single-use reset token for an active account, or null (callers must not reveal which). */
  createPasswordReset(email: string): Promise<{ userId: string; token: string; expiresAt: Date } | null>;
  /** Consumes a reset token, sets the password and revokes every session. Returns the user id, or null when invalid. */
  completePasswordReset(token: string, newPassword: string): Promise<string | null>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
