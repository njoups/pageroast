import type { AppConfig } from '../../config';
import { DeliveryError } from './errors';

/**
 * WhatsApp Business Platform (Cloud API, official). Sends an operator-approved *template* message to a user who opted in
 * with their own number; no unofficial gateways, no free-form bulk messaging. Unconfigured without an access token,
 * phone-number id and approved template name.
 */
export class WhatsAppChannel {
  constructor(private readonly cfg: AppConfig['whatsapp'], private readonly fetchFn: typeof fetch = fetch) {}
  get configured(): boolean { return !!(this.cfg.accessToken && this.cfg.phoneNumberId && this.cfg.templateName); }

  async send(toE164: string, params: string[]): Promise<{ messageId: string }> {
    if (!this.configured) throw new DeliveryError(false, 'WhatsApp is not configured');
    if (!/^\+[1-9]\d{7,14}$/.test(toE164)) throw new DeliveryError(false, 'Destination is not an E.164 phone number');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiBaseUrl}/${encodeURIComponent(this.cfg.phoneNumberId!)}/messages`, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: toE164.slice(1), type: 'template',
          template: { name: this.cfg.templateName, language: { code: this.cfg.templateLanguage },
            components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p.slice(0, 500) })) }] } }),
      });
    } catch (e) { throw new DeliveryError(true, `WhatsApp request failed: ${(e as Error).message}`); }
    const body = await res.json().catch(() => ({})) as { messages?: Array<{ id: string }>; error?: { message?: string } };
    if (!res.ok) throw new DeliveryError(res.status === 429 || res.status >= 500, `WhatsApp HTTP ${res.status}: ${body.error?.message ?? ''}`.slice(0, 300), res.status);
    return { messageId: body.messages?.[0]?.id ?? '' };
  }
}
