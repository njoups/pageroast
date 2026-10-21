import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { alertsBackoff } from '../../../src/alerts/alerts-queue';
import { EmailChannel, recipientAllowed, safeHeader } from '../../../src/alerts/channels/email';
import { assertWebhookUrl, signWebhook, verifyWebhookSignature, WebhookSender } from '../../../src/alerts/channels/webhook';
import { WhatsAppChannel } from '../../../src/alerts/channels/whatsapp';
import { canTransition } from '../../../src/alerts/levels';
import { inQuietHours, quietHoursEnd } from '../../../src/alerts/notifications.service';
import { RuleConfigError, validateRuleConfig } from '../../../src/alerts/rule-config';
import { SafeHttpClient } from '../../../src/ingestion/safe-http';

const problems = (type: Parameters<typeof validateRuleConfig>[0], cfg: unknown) => {
  try { validateRuleConfig(type, cfg); return []; } catch (e) { return (e as RuleConfigError).problems.map((p) => p.field); }
};

describe('rule configuration validation', () => {
  it('rejects malformed keyword expressions and unknown keys, never executing them', () => {
    expect(problems('keyword', { filters: { keywords: '(banjir OR' } })).toEqual(['filters.keywords']);
    expect(problems('keyword', { filters: { keywords: 'a'.repeat(501) } })).toEqual(['filters.keywords']);
    expect(problems('keyword', { filters: { keywords: 'x', sql: 'DROP TABLE' } })).toEqual(['filters']);
    expect(problems('keyword', {})).toEqual(['filters.keywords']);
  });
  it('bounds windows, thresholds and look-back', () => {
    expect(problems('volume_spike', { window: { minutes: 5 } })).toEqual(['window.minutes']);
    expect(problems('volume_spike', { window: { minutes: 10_080, comparison: 'previous_windows', baselineWindows: 60 } })).toEqual(['window.baselineWindows']);
    expect(problems('volume_spike', { window: { minutes: 2880 } })).toEqual(['window.comparison']);
    expect(problems('volume_spike', { thresholds: { minMentions: 0 } })).toEqual(['thresholds.minMentions']);
  });
  it('requires recipients for email, valid time zones and increasing escalation steps', () => {
    expect(problems('volume_spike', { notify: { channels: ['email'] } })).toEqual(['notify.recipientUserIds']);
    expect(problems('volume_spike', { quietHours: { start: '22:00', end: '06:00', timezone: 'Mars/Olympus' } })).toEqual(['quietHours.timezone']);
    const u = '00000000-0000-4000-8000-000000000001';
    expect(problems('volume_spike', { escalation: { steps: [{ afterMinutes: 60, notifyUserIds: [u] }, { afterMinutes: 30, notifyUserIds: [u] }] } })).toEqual(['escalation.steps']);
  });
});

describe('lifecycle transitions', () => {
  it('follows Detected → Pending review → Acknowledged → Investigating → Resolved → Closed, with reopening', () => {
    expect(canTransition('pending_review', 'acknowledged')).toBe(true);
    expect(canTransition('acknowledged', 'investigating')).toBe(true);
    expect(canTransition('investigating', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'closed')).toBe(true);
    expect(canTransition('resolved', 'pending_review')).toBe(true);
    expect(canTransition('closed', 'acknowledged')).toBe(false);
    expect(canTransition('investigating', 'acknowledged')).toBe(false);
  });
});

describe('quiet hours', () => {
  const q = { start: '22:00', end: '06:00', timezone: 'Asia/Jakarta', allowCritical: true };
  it('handles windows that wrap past midnight in the configured time zone', () => {
    expect(inQuietHours(new Date('2026-10-19T16:00:00Z'), q)).toBe(true);   // 23:00 WIB
    expect(inQuietHours(new Date('2026-10-19T02:00:00Z'), q)).toBe(false);  // 09:00 WIB
    expect(quietHoursEnd(new Date('2026-10-19T16:00:00Z'), q).toISOString()).toBe('2026-10-19T23:00:00.000Z'); // 06:00 WIB
  });
});

describe('notification delivery backoff', () => {
  it('is exponential with jitter and capped', () => {
    expect(alertsBackoff(1, 30_000, undefined, () => 0.5)).toBe(30_000);
    expect(alertsBackoff(3, 30_000, undefined, () => 0.5)).toBe(120_000);
    expect(alertsBackoff(20, 30_000, undefined, () => 0.5)).toBe(3_600_000);
    expect(alertsBackoff(1, 30_000, undefined, () => 0)).toBe(21_000);
  });
});

describe('email safety', () => {
  it('strips header-injection characters from subjects', () => {
    expect(safeHeader('Banjir\r\nBcc: victim@example.com')).toBe('Banjir Bcc: victim@example.com');
  });
  it('rejects multi-address or header-smuggling recipients and reports unconfigured honestly', async () => {
    const sent: unknown[] = [];
    const ch = new EmailChannel({ smtpUrl: 'smtp://unused', from: 'alerts@example.org' }, { sendMail: async (m: unknown) => { sent.push(m); return { messageId: 'x' }; } } as never);
    await expect(ch.send({ to: 'a@example.com, b@example.com', subject: 's', text: 't', html: 'h' })).rejects.toMatchObject({ retryable: false });
    await expect(ch.send({ to: 'a@example.com\r\nBcc: x@example.com', subject: 's', text: 't', html: 'h' })).rejects.toMatchObject({ retryable: false });
    await ch.send({ to: 'a@example.com', subject: 'Hi\nBcc: x@y.z', text: 't', html: 'h' });
    expect(sent[0]).toMatchObject({ to: 'a@example.com', subject: 'Hi Bcc: x@y.z' });
    await expect(new EmailChannel({ smtpUrl: null, from: null }).send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/not configured/);
  });
  it('classifies SMTP 5xx as permanent and 4xx/connection errors as retryable', async () => {
    const fail = (e: object) => new EmailChannel({ smtpUrl: 'smtp://x', from: 'a@b.co' }, { sendMail: async () => { throw e; } } as never);
    await expect(fail({ responseCode: 550, message: 'no mailbox' }).send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toMatchObject({ retryable: false });
    await expect(fail({ responseCode: 421, message: 'try later' }).send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toMatchObject({ retryable: true });
    await expect(fail({ code: 'ECONNREFUSED', message: 'refused' }).send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toMatchObject({ retryable: true });
  });
});

describe('staging recipient allow-lists (P10)', () => {
  const msg = (to: string) => ({ to, subject: 's', text: 't', html: 'h' });
  it('email: only listed domains or addresses are sent; the rest fail permanently without contacting SMTP', async () => {
    const sent: unknown[] = [];
    const ch = new EmailChannel({ smtpUrl: 'smtp://unused', from: 'a@example.go.id', allowedDomains: ['example.go.id', 'tester@gmail.example'] },
      { sendMail: async (m: unknown) => { sent.push(m); return { messageId: 'x' }; } } as never);
    await ch.send(msg('ops@EXAMPLE.go.id'));
    await ch.send(msg('tester@gmail.example'));
    await expect(ch.send(msg('customer@agency.go.id'))).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/allow-list/) });
    await expect(new EmailChannel({ smtpUrl: 'smtp://unused', from: 'a@b.co', allowedDomains: [] }, { sendMail: async () => ({}) } as never).send(msg('x@b.co'))).rejects.toThrow(/allow-list/);
    expect(sent).toHaveLength(2);
    expect(recipientAllowed('a@x.org', null)).toBe(true);
  });
  it('WhatsApp and webhooks: an empty list denies everything before any network call', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await expect(new WhatsAppChannel({ accessToken: 't', phoneNumberId: '1', templateName: 'x', templateLanguage: 'id', apiBaseUrl: 'https://g', allowedNumbers: [] }, f)
      .send('+6281234567890', [])).rejects.toThrow(/allow-list/);
    const http = { post: async () => { calls++; return { status: 200, body: Buffer.from('') }; } } as never;
    await expect(new WebhookSender(http, ['hooks.example.go.id']).send('https://evil.example/x', '{}', ['s'], {}, 1)).rejects.toThrow(/allow-list/);
    await new WebhookSender(http, ['hooks.example.go.id']).send('https://hooks.example.go.id/x', '{}', ['s'], {}, 1);
    expect(calls).toBe(1);
  });
});

describe('WhatsApp (official Cloud API adapter, mocked HTTP)', () => {
  it('is unconfigured without credentials and an approved template', async () => {
    const w = new WhatsAppChannel({ accessToken: null, phoneNumberId: null, templateName: null, templateLanguage: 'id', apiBaseUrl: 'https://graph.example' });
    expect(w.configured).toBe(false);
    await expect(w.send('+6281234567890', ['x'])).rejects.toMatchObject({ retryable: false });
  });
  it('sends a template message to an E.164 number and classifies errors', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const ok = (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body) }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }); }) as unknown as typeof fetch;
    const w = new WhatsAppChannel({ accessToken: 't', phoneNumberId: '123', templateName: 'issue_alert', templateLanguage: 'id', apiBaseUrl: 'https://graph.example' }, ok);
    expect(await w.send('+6281234567890', ['high', 'Banjir', 'https://app/x'])).toEqual({ messageId: 'wamid.1' });
    expect(calls[0]!.url).toBe('https://graph.example/123/messages');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ to: '6281234567890', type: 'template', template: { name: 'issue_alert' } });
    await expect(w.send('081234', ['x'])).rejects.toMatchObject({ retryable: false });
    const rate = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    await expect(new WhatsAppChannel({ accessToken: 't', phoneNumberId: '1', templateName: 'x', templateLanguage: 'id', apiBaseUrl: 'https://g' }, rate).send('+6281234567890', [])).rejects.toMatchObject({ retryable: true });
  });
});

describe('webhooks', () => {
  it('signatures verify, reject tampering and stale timestamps, and support rotation', () => {
    const body = '{"a":1}'; const t = 1_800_000_000;
    const h = signWebhook(body, ['new', 'old'], t);
    expect(verifyWebhookSignature(h, body, 'new', t)).toBe(true);
    expect(verifyWebhookSignature(h, body, 'old', t)).toBe(true);
    expect(verifyWebhookSignature(h, '{"a":2}', 'new', t)).toBe(false);
    expect(verifyWebhookSignature(h, body, 'new', t + 3600)).toBe(false);
    expect(verifyWebhookSignature(h, body, 'other', t)).toBe(false);
  });
  it('URL policy: https only, no credentials, no private or metadata addresses', () => {
    const opts = { allowHttp: false, allowPrivateHosts: false };
    expect(() => assertWebhookUrl('http://hooks.example.com/x', opts)).toThrow(/https/);
    expect(() => assertWebhookUrl('https://user:pw@hooks.example.com/x', opts)).toThrow();
    expect(() => assertWebhookUrl('https://169.254.169.254/latest', opts)).toThrow();
    expect(() => assertWebhookUrl('https://127.0.0.1/x', opts)).toThrow();
    expect(() => assertWebhookUrl('https://10.0.0.5/x', opts)).toThrow();
    expect(assertWebhookUrl('https://hooks.example.com/civicsignal', opts).host).toBe('hooks.example.com');
  });
  it('does not follow redirects and classifies receiver errors', async () => {
    let status = 302;
    const srv = createServer((req, res) => { req.resume(); res.statusCode = status; if (status === 302) res.setHeader('location', 'http://169.254.169.254/'); res.end('{}'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
    const sender = new WebhookSender(new SafeHttpClient({ userAgent: 't', allowPrivateHosts: true, allowAnyPort: true, timeoutMs: 2000, maxBytes: 1024, maxRedirects: 0 }));
    try {
      await expect(sender.send(url, '{}', ['s'], {}, 1)).rejects.toMatchObject({ retryable: false, status: 302 });
      status = 503; await expect(sender.send(url, '{}', ['s'], {}, 1)).rejects.toMatchObject({ retryable: true });
      status = 400; await expect(sender.send(url, '{}', ['s'], {}, 1)).rejects.toMatchObject({ retryable: false });
      status = 204; await expect(sender.send(url, '{}', ['s'], {}, 1)).resolves.toMatchObject({ status: 204 });
    } finally { srv.close(); }
  });
});
