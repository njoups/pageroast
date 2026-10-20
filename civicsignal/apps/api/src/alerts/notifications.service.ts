import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';
import { Database } from '../database/database.service';
import { loadEntitlements } from '../commercial/quota';
import { REDIS } from '../ingestion/ingestion-core.module';
import { logEvent } from '../ingestion/log';
import { KEY_PREFIX, type Redis } from '../ingestion/queue';
import { SafeHttpClient } from '../ingestion/safe-http';
import { CredentialCipher } from '../ingestion/secrets';
import { hasPermission, seesAllProjects, type Role } from '../authz/permissions';
import { CLOCK, type Clock } from './clock';
import { DeliveryError } from './channels/errors';
import { EmailChannel, safeHeader } from './channels/email';
import { WebhookSender } from './channels/webhook';
import { WhatsAppChannel } from './channels/whatsapp';
import { atLeast, type Severity } from './levels';
import type { RuleConfig } from './rule-config';

const SYS = '00000000-0000-0000-0000-000000000000';
export type NotificationKind = 'detected' | 'severity_changed' | 'escalated' | 'reopened' | 'resolved' | 'test';
type Channel = 'in_app' | 'email' | 'whatsapp';

export interface IssueForNotification {
  id: string; tenant_id: string; project_id: string; title: string; severity: Severity; status: string; signal: string; scope: string;
  severity_breakdown: { factors?: Array<{ factor: string; value: unknown; points: number }>; caps?: string[] };
  detection: { method?: string; exceeded?: string[]; observed?: Record<string, unknown>; baseline?: Record<string, unknown> };
  first_detected_at: Date; occurrence_count: number;
}

/** Default preferences when a user has not set any. */
const DEFAULT_PREFS: Record<Channel, { enabled: boolean; min: Severity }> = {
  in_app: { enabled: true, min: 'informational' }, email: { enabled: true, min: 'medium' }, whatsapp: { enabled: false, min: 'high' },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const KIND_TEXT: Record<NotificationKind, string> = {
  detected: 'New issue detected', severity_changed: 'Issue severity increased', escalated: 'Unacknowledged issue escalated',
  reopened: 'Issue reopened with new evidence', resolved: 'Issue resolved', test: 'Test notification',
};

/** Local wall-clock minutes in a time zone. */
function localMinutes(d: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return Number(p.find((x) => x.type === 'hour')!.value) * 60 + Number(p.find((x) => x.type === 'minute')!.value);
}
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export function inQuietHours(d: Date, q: NonNullable<RuleConfig['quietHours']>): boolean {
  const m = localMinutes(d, q.timezone); const s = toMin(q.start); const e = toMin(q.end);
  return s <= e ? m >= s && m < e : m >= s || m < e;   // window may wrap past midnight
}
/** First minute at or after `d` that is outside quiet hours (5-minute resolution). */
export function quietHoursEnd(d: Date, q: NonNullable<RuleConfig['quietHours']>): Date {
  let t = d.getTime();
  for (let i = 0; i < 24 * 12 && inQuietHours(new Date(t), q); i++) t += 5 * 60_000;
  return new Date(t);
}

@Injectable()
export class NotificationService {
  readonly email: EmailChannel;
  readonly whatsapp: WhatsAppChannel;
  readonly webhooks: WebhookSender;
  readonly cipher: CredentialCipher | null;

  constructor(private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig, @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis | null) {
    this.email = new EmailChannel(config.email);
    this.whatsapp = new WhatsAppChannel(config.whatsapp);
    this.webhooks = new WebhookSender(new SafeHttpClient({ userAgent: 'CivicSignal-Webhooks/1', allowPrivateHosts: config.ingestion.allowPrivateHosts,
      timeoutMs: config.alerts.webhookTimeoutMs, maxBytes: 64 * 1024, maxRedirects: 0 }));
    this.cipher = CredentialCipher.fromBase64(config.credentialsKey ?? undefined);
  }

  /** Test seam: replace channel transports (e.g. a local SMTP server or a failing stub). */
  override(channels: { email?: EmailChannel; whatsapp?: WhatsAppChannel }) {
    Object.assign(this as unknown as Record<string, unknown>, channels);
  }

  channelStatus() {
    return {
      in_app: { configured: true },
      email: { configured: this.email.configured, note: this.email.configured ? null : 'Set SMTP_URL and EMAIL_FROM (docs/NOTIFICATIONS.md).' },
      whatsapp: { configured: this.whatsapp.configured, note: this.whatsapp.configured ? null : 'WhatsApp Business Cloud API credentials and an approved template are not configured.' },
      webhook: { configured: !!this.cipher, note: this.cipher ? null : 'CREDENTIALS_KEY is required to store webhook signing secrets.' },
    };
  }

  /** Users who may receive notifications about an issue in this project right now. */
  private async eligible(c: PoolClient, projectId: string, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const r = await c.query<{ user_id: string; role: Role; assigned: boolean }>(
      `SELECT m.user_id, m.role, EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $1 AND pm.user_id = m.user_id) AS assigned
       FROM memberships m WHERE m.user_id = ANY($2::uuid[])`, [projectId, userIds]);
    return r.rows.filter((x) => hasPermission(x.role, 'alerts:read') && (seesAllProjects(x.role) || x.assigned)).map((x) => x.user_id);
  }

  payload(issue: IssueForNotification, kind: NotificationKind, sources: Array<{ url: string; title: string; publisher: string }>, extra: Record<string, unknown> = {}) {
    const exceeded = issue.detection.exceeded ?? [];
    const top = (issue.severity_breakdown.factors ?? []).filter((f) => f.points > 0).map((f) => `${f.factor.replace(/_/g, ' ')} (+${f.points})`);
    return {
      kind, title: safeHeader(issue.title, 300), severity: issue.severity, status: issue.status, signal: issue.signal, scope: issue.scope,
      heading: KIND_TEXT[kind],
      rationale: `Thresholds exceeded: ${exceeded.join(', ') || 'none recorded'}. Severity factors: ${top.join(', ') || 'none'}.${(issue.severity_breakdown.caps ?? []).length ? ` Adjustments: ${issue.severity_breakdown.caps!.join('; ')}.` : ''}`,
      method: issue.detection.method ?? null, link: `${this.config.appBaseUrl}/o/${issue.tenant_id}/alerts/${issue.id}`,
      sources: sources.slice(0, 5), ...extra,
    };
  }

  /**
   * Plans deliveries for an issue event inside the caller's transaction (outbox): in-app rows are delivered at once;
   * email/WhatsApp rows are queued, deferred for quiet hours, or recorded as unconfigured/suppressed. Idempotent: the
   * key ties a row to (issue, event marker, user, channel).
   */
  async plan(c: PoolClient, issue: IssueForNotification, kind: NotificationKind, marker: string, cfg: RuleConfig, recipients: string[], extra: Record<string, unknown> = {}) {
    const now = this.clock.now();
    const sources = (await c.query<{ url: string; title: string; publisher: string }>(
      `SELECT m.url, m.title, coalesce(m.publisher, m.publisher_domain) AS publisher FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id
       WHERE e.issue_id = $1 ORDER BY e.is_syndicated, coalesce(m.published_at, m.discovered_at) DESC LIMIT 5`, [issue.id])).rows;
    const payload = this.payload(issue, kind, sources, extra);
    const users = await this.eligible(c, issue.project_id, recipients);
    const prefs = (await c.query<{ user_id: string; channel: Channel; enabled: boolean; min_severity: Severity; destination: string | null }>(
      'SELECT user_id, channel, enabled, min_severity, destination FROM notification_preferences WHERE user_id = ANY($1::uuid[])', [users])).rows;
    const today = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_deliveries WHERE created_at >= date_trunc('day', $1::timestamptz)`, [now])).rows[0]!.n;
    let budget = this.config.alerts.notificationsPerDay - today;
    const created: string[] = [];
    const channels: Channel[] = [...new Set<Channel>(['in_app', ...cfg.notify.channels])];
    const quiet = cfg.quietHours && inQuietHours(now, cfg.quietHours) && !(issue.severity === 'critical' && cfg.quietHours.allowCritical);
    const whatsappInPlan = channels.includes('whatsapp') ? (await loadEntitlements(c, issue.tenant_id)).features.whatsapp : true;
    for (const userId of users) {
      for (const ch of channels) {
        const p = prefs.find((x) => x.user_id === userId && x.channel === ch);
        const enabled = p ? p.enabled : DEFAULT_PREFS[ch].enabled;
        const min = p ? p.min_severity : DEFAULT_PREFS[ch].min;
        if (!enabled || (!atLeast(issue.severity, min) && kind !== 'resolved')) continue;
        let status = ch === 'in_app' ? 'delivered' : 'pending'; let error: string | null = null; let notBefore: Date | null = null;
        if (budget <= 0) { status = 'suppressed'; error = 'Organization daily notification limit reached'; }
        else if (ch === 'email' && !this.email.configured) { status = 'unconfigured'; error = 'Email is not configured on this server'; }
        else if (ch === 'whatsapp' && !whatsappInPlan) { status = 'suppressed'; error = 'WhatsApp notifications are not included in the plan'; }
        else if (ch === 'whatsapp' && !this.whatsapp.configured) { status = 'unconfigured'; error = 'WhatsApp is not configured on this server'; }
        else if (ch === 'whatsapp' && !p?.destination) { status = 'suppressed'; error = 'No opted-in WhatsApp number for this user'; }
        else if (ch !== 'in_app' && quiet) { status = 'deferred'; notBefore = quietHoursEnd(now, cfg.quietHours!); }
        const r = await c.query<{ id: string }>(
          `INSERT INTO notification_deliveries (tenant_id, issue_id, user_id, channel, kind, idempotency_key, status, payload, last_error, not_before, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $7 = 'delivered' THEN $11::timestamptz END)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
          [issue.tenant_id, issue.id, userId, ch, kind, `${issue.id}:${kind}:${marker}:${userId}:${ch}`, status, JSON.stringify({ ...payload, destination: ch === 'whatsapp' ? p?.destination : undefined }), error, notBefore, now]);
        if (r.rows[0]) { created.push(r.rows[0].id); budget--; }
      }
    }
    const webhookIds: string[] = [];
    if (cfg.notify.webhookEndpointIds.length) {
      const eps = (await c.query<{ id: string; min_severity: Severity }>(
        `SELECT id, min_severity FROM webhook_endpoints WHERE id = ANY($1::uuid[]) AND is_active AND verified_at IS NOT NULL`, [cfg.notify.webhookEndpointIds])).rows;
      for (const ep of eps) {
        if (!atLeast(issue.severity, ep.min_severity) && kind !== 'resolved') continue;
        const r = await c.query<{ id: string }>(
          `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, issue_id, event, idempotency_key) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`, [issue.tenant_id, ep.id, issue.id, `issue.${kind}`, `${issue.id}:${kind}:${marker}:${ep.id}`]);
        if (r.rows[0]) webhookIds.push(r.rows[0].id);
      }
    }
    if (created.length || webhookIds.length) {
      await c.query(`UPDATE detected_issues SET last_notified_at = $2, last_notified_severity = severity WHERE id = $1`, [issue.id, now]);
      await c.query(`INSERT INTO alert_events (tenant_id, issue_id, event, details) VALUES ($1,$2,'notified',$3)`,
        [issue.tenant_id, issue.id, JSON.stringify({ kind, deliveries: created.length, webhooks: webhookIds.length })]);
    }
    return { deliveryIds: created, webhookDeliveryIds: webhookIds };
  }

  private async rateGate(key: string, perMinute: number): Promise<number> {
    if (!this.redis) return 0;
    const now = this.clock.now().getTime();
    const k = `${KEY_PREFIX}:alerts:rl:${key}:${Math.floor(now / 60_000)}`;
    const n = await this.redis.incr(k); if (n === 1) await this.redis.expire(k, 120);
    return n > perMinute ? 60_000 - (now % 60_000) + 250 : 0;
  }

  /**
   * Sends one email/WhatsApp delivery. Returns 'delay' with milliseconds when it must wait (quiet hours, channel rate
   * limit); throws DeliveryError (retryable or not) on failure after recording it.
   */
  async deliver(tenantId: string, id: string, attempt: number, final: boolean): Promise<{ outcome: 'delivered' | 'skipped' } | { outcome: 'delay'; ms: number }> {
    const now = this.clock.now();
    const d = await this.db.withTenant(tenantId, SYS, async (c) => (await c.query<{ id: string; channel: Channel; status: string; payload: Record<string, unknown> & { title: string; heading: string; link: string; rationale: string; severity: string; sources: Array<{ url: string; title: string; publisher: string }>; destination?: string };
      not_before: Date | null; email: string | null }>(
      `SELECT d.id, d.channel, d.status, d.payload, d.not_before, u.email FROM notification_deliveries d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = $1`, [id])).rows[0]);
    if (!d || !['pending', 'deferred', 'failed', 'sending'].includes(d.status) || d.channel === 'in_app') return { outcome: 'skipped' };
    if (d.not_before && d.not_before > now) return { outcome: 'delay', ms: d.not_before.getTime() - now.getTime() };
    const wait = await this.rateGate(`${d.channel}:${tenantId}`, d.channel === 'email' ? this.config.alerts.emailPerMinute : 20);
    if (wait) return { outcome: 'delay', ms: wait };
    await this.db.withTenant(tenantId, SYS, (c) => c.query(`UPDATE notification_deliveries SET status = 'sending', attempts = $2 WHERE id = $1`, [id, attempt]));
    try {
      const p = d.payload;
      if (d.channel === 'email') {
        const lines = [`${p.heading}: ${p.title}`, `Severity: ${p.severity}`, p.rationale, '', 'Sources:', ...p.sources.map((s) => `- ${s.publisher}: ${s.title} <${s.url}>`), '', `Review: ${p.link}`,
          '', 'Automated detection from collected coverage. Severity follows documented rules; verify the sources before acting.'];
        const html = `<p><strong>${esc(p.heading)}</strong></p><h2 style="font-size:16px">${esc(p.title)}</h2><p>Severity: <strong>${esc(p.severity)}</strong></p>`
          + `<p>${esc(p.rationale)}</p><ul>${p.sources.map((s) => `<li>${esc(s.publisher)}: <a href="${esc(s.url)}">${esc(s.title)}</a></li>`).join('')}</ul>`
          + `<p><a href="${esc(p.link)}">Review the issue in CivicSignal</a></p><p style="color:#666;font-size:12px">Automated detection from collected coverage. Severity follows documented rules; verify the sources before acting.</p>`;
        if (!d.email) throw new DeliveryError(false, 'Recipient has no email address');
        await this.email.send({ to: d.email, subject: `[CivicSignal ${p.severity.toUpperCase()}] ${p.title}`, text: lines.join('\n'), html });
      } else {
        await this.whatsapp.send(String(p.destination ?? ''), [p.severity, p.title.slice(0, 200), p.link]);
      }
      await this.db.withTenant(tenantId, SYS, (c) => c.query(`UPDATE notification_deliveries SET status = 'delivered', sent_at = $2, last_error = NULL WHERE id = $1`, [id, this.clock.now()]));
      return { outcome: 'delivered' };
    } catch (e) {
      const err = e instanceof DeliveryError ? e : new DeliveryError(true, (e as Error).message);
      const status = !err.retryable || final ? (err.retryable ? 'dead' : 'failed') : 'failed';
      await this.db.withTenant(tenantId, SYS, (c) => c.query(`UPDATE notification_deliveries SET status = $2, last_error = $3 WHERE id = $1`, [id, status, err.message.slice(0, 500)]));
      logEvent('warn', 'alerts.delivery_failed', { tenantId, deliveryId: id, channel: d.channel, attempt, retryable: err.retryable, final });
      throw err;
    }
  }

  /** Sends one webhook delivery with the endpoint's current (and, during rotation, previous) secret. */
  async deliverWebhook(tenantId: string, id: string, attempt: number, final: boolean): Promise<{ outcome: 'delivered' | 'skipped' } | { outcome: 'delay'; ms: number }> {
    const now = this.clock.now();
    const row = await this.db.withTenant(tenantId, SYS, async (c) => (await c.query<{ id: string; status: string; event: string; endpoint_id: string; url: string; secret_ciphertext: string;
      previous_secret_ciphertext: string | null; previous_secret_expires_at: Date | null; is_active: boolean; verified_at: Date | null; issue_id: string | null }>(
      `SELECT d.id, d.status, d.event, d.endpoint_id, e.url, e.secret_ciphertext, e.previous_secret_ciphertext, e.previous_secret_expires_at, e.is_active, e.verified_at, d.issue_id
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = $1`, [id])).rows[0]);
    if (!row || !['pending', 'failed'].includes(row.status)) return { outcome: 'skipped' };
    if (!row.is_active || !row.verified_at || !this.cipher) {
      await this.db.withTenant(tenantId, SYS, (c) => c.query(`UPDATE webhook_deliveries SET status = 'skipped', error = $2 WHERE id = $1`, [id, !this.cipher ? 'CREDENTIALS_KEY not configured' : 'Endpoint disabled or unverified']));
      return { outcome: 'skipped' };
    }
    const wait = await this.rateGate(`webhook:${tenantId}`, this.config.alerts.webhookPerMinute);
    if (wait) return { outcome: 'delay', ms: wait };
    const body = await this.db.withTenant(tenantId, SYS, (c) => this.webhookBody(c, tenantId, row.issue_id, row.event, id));
    const secrets = [this.cipher.decrypt(row.secret_ciphertext, `webhook:${row.endpoint_id}`)];
    if (row.previous_secret_ciphertext && row.previous_secret_expires_at && row.previous_secret_expires_at > now) {
      secrets.push(this.cipher.decrypt(row.previous_secret_ciphertext, `webhook:${row.endpoint_id}`));
    }
    try {
      const res = await this.webhooks.send(row.url, body, secrets, { 'x-civicsignal-event': row.event, 'x-civicsignal-delivery': id }, Math.floor(now.getTime() / 1000));
      await this.db.withTenant(tenantId, SYS, async (c) => {
        await c.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, response_status = $3, duration_ms = $4, delivered_at = $5, error = NULL WHERE id = $1`,
          [id, attempt, res.status, res.durationMs, this.clock.now()]);
        await c.query('UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1', [row.endpoint_id]);
      });
      return { outcome: 'delivered' };
    } catch (e) {
      const err = e instanceof DeliveryError ? e : new DeliveryError(true, (e as Error).message);
      const status = err.retryable && !final ? 'failed' : 'dead';
      await this.db.withTenant(tenantId, SYS, async (c) => {
        await c.query(`UPDATE webhook_deliveries SET status = $2, attempts = $3, response_status = $4, error = $5 WHERE id = $1`, [id, status, attempt, err.status ?? null, err.message.slice(0, 500)]);
        // After 20 consecutive dead deliveries the endpoint is disabled (an admin re-verifies it).
        if (status === 'dead') await c.query(`UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1,
          is_active = CASE WHEN consecutive_failures + 1 >= 20 THEN false ELSE is_active END WHERE id = $1`, [row.endpoint_id]);
      });
      logEvent('warn', 'alerts.webhook_failed', { tenantId, deliveryId: id, attempt, retryable: err.retryable, final, status: err.status ?? null });
      throw err;
    }
  }

  /** Webhook payload: issue metadata, counts, rationale and source links. No notes, no user data, no secrets. */
  async webhookBody(c: PoolClient, tenantId: string, issueId: string | null, event: string, deliveryId: string): Promise<string> {
    if (!issueId) return JSON.stringify({ id: deliveryId, type: event, tenantId, createdAt: this.clock.now().toISOString() });
    const i = (await c.query<IssueForNotification & { last_detected_at: Date }>('SELECT * FROM detected_issues WHERE id = $1', [issueId])).rows[0]!;
    const counts = (await c.query<{ articles: number; publishers: number }>(
      `SELECT count(*)::int AS articles, count(DISTINCT m.publisher_domain)::int AS publishers FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id WHERE e.issue_id = $1`, [issueId])).rows[0]!;
    const sources = (await c.query<{ url: string; title: string; publisher: string }>(
      `SELECT m.url, m.title, coalesce(m.publisher, m.publisher_domain) AS publisher FROM alert_evidence e JOIN mentions m ON m.id = e.mention_id
       WHERE e.issue_id = $1 ORDER BY coalesce(m.published_at, m.discovered_at) DESC LIMIT 10`, [issueId])).rows;
    const p = this.payload(i, event.replace('issue.', '') as NotificationKind, sources);
    return JSON.stringify({ id: deliveryId, type: event, createdAt: this.clock.now().toISOString(), tenantId,
      issue: { id: i.id, projectId: i.project_id, title: p.title, severity: i.severity, status: i.status, signal: i.signal, scope: i.scope,
        firstDetectedAt: i.first_detected_at, lastDetectedAt: i.last_detected_at, rationale: p.rationale, method: p.method, url: p.link, counts, sources } });
  }
}
