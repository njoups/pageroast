/**
 * Port for identity. LocalIdentityProvider is the development/pilot adapter.
 * A managed adapter (Supabase Auth / OIDC with MFA and password recovery) implements the same contract.
 */
export interface IdentityUser { id: string; email: string; displayName: string; isPlatformAdmin: boolean }
export interface SessionInfo { sessionId: string; user: IdentityUser; expiresAt: Date }
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
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
