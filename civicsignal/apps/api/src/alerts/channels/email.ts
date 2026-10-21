import { createTransport, type Transporter } from 'nodemailer';
import type { AppConfig } from '../../config';
import { DeliveryError } from './errors';

export interface EmailMessage { to: string; subject: string; text: string; html: string }

/** One address, no display name, no CR/LF: recipient strings can never smuggle extra headers or recipients. */
const ADDRESS = /^[^\s@<>,;"'\\]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
export const safeHeader = (s: string, max = 200) => s.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

/** `null` = unrestricted. Entries are domains (example.go.id) or full addresses (ops@example.go.id). */
export function recipientAllowed(address: string, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  const a = address.toLowerCase(); const domain = a.slice(a.lastIndexOf('@') + 1);
  return allowed.includes(a) || allowed.includes(domain);
}

/**
 * SMTP email (any provider with SMTP: SES, Postmark, Mailgun, an internal relay). Unconfigured without SMTP_URL and
 * EMAIL_FROM; deliveries are then recorded as `unconfigured`, never as sent.
 */
export class EmailChannel {
  private transport: Transporter | null;
  constructor(private readonly cfg: AppConfig['email'], transport?: Transporter) {
    this.transport = transport ?? (cfg.smtpUrl ? createTransport(cfg.smtpUrl) : null);
  }
  get configured(): boolean { return !!this.transport && !!this.cfg.from; }

  async send(m: EmailMessage): Promise<{ messageId: string }> {
    if (!this.configured) throw new DeliveryError(false, 'Email is not configured (SMTP_URL / EMAIL_FROM)');
    if (!ADDRESS.test(m.to)) throw new DeliveryError(false, 'Recipient address is not a single plain email address');
    if (!recipientAllowed(m.to, this.cfg.allowedDomains ?? null)) throw new DeliveryError(false, 'Recipient is not on this environment\'s allow-list (NOTIFY_ALLOWED_EMAIL_DOMAINS)');
    try {
      const info = await this.transport!.sendMail({ from: this.cfg.from!, to: m.to, subject: safeHeader(m.subject), text: m.text, html: m.html,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } });
      return { messageId: String(info.messageId ?? '') };
    } catch (e) {
      const err = e as { responseCode?: number; code?: string; message?: string };
      // 5xx = permanent rejection (bad mailbox, policy); 4xx and connection errors are temporary.
      const permanent = typeof err.responseCode === 'number' && err.responseCode >= 500;
      throw new DeliveryError(!permanent, `SMTP ${err.responseCode ?? err.code ?? 'error'}: ${(err.message ?? '').slice(0, 200)}`, err.responseCode);
    }
  }
}
