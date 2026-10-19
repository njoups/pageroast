# Notifications: configuration and behaviour

Issue events (detected, severity increased, escalated, reopened, resolved) produce notifications. Each one is a
`notification_deliveries` row, created in the same transaction as the issue change (outbox pattern). The worker then
delivers it.

Recipients are a rule's `recipientUserIds` (or the rule owner when the list is empty) plus escalation contacts. Only members
who can currently see the project's issues are included; report viewers never are.

## Channel status
`GET /organizations/:org/notifications/deliveries` (Administration → Alert notifications) shows each channel as configured or
not. An unconfigured channel never pretends to send: its rows are stored with status `unconfigured` and the reason.

| Channel | Needs | Status 2026-10-19 |
|---|---|---|
| In-app | nothing | ✔ verified (inbox, read/unread, bell) |
| Email (SMTP) | `SMTP_URL`, `EMAIL_FROM` | ✔ verified end to end against a **local SMTP server** (tests and a dev mail sink); no third-party provider tested |
| WhatsApp | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` | **not configured**; adapter tested against mocked HTTP only |
| Webhooks | `CREDENTIALS_KEY` (stores signing secrets) | ✔ verified against a local receiver |

## Email
- **Settings:**
  - `SMTP_URL`: `smtp://user:pass@host:587` or `smtps://user:pass@host:465`. Any SMTP-capable provider works (SES, Postmark,
    Mailgun, an internal relay).
  - `EMAIL_FROM`: e.g. `CivicSignal <alerts@your-domain>`; one line.
- **Message:** multipart HTML and text. It contains the severity, the rationale (thresholds exceeded, severity factors and
  adjustments), up to five source links, and a link to the issue (`APP_BASE_URL`). It also carries `Auto-Submitted` headers.
- **Header injection:** recipients must be one plain address; CR/LF in subjects is removed; titles from coverage are
  HTML-escaped. Test: `config-channels.spec.ts`.
- **Failures:** SMTP 5xx is permanent (no retry, status `failed`). 4xx and connection errors are retried with exponential
  backoff and jitter (`ALERTS_DELIVERY_ATTEMPTS`, `ALERTS_BACKOFF_BASE_MS`). The final failure is marked `dead` and
  copied to the `alerts-dlq` queue. Administrators can retry failed or dead deliveries from the delivery log.
- **Rate limits:** `ALERTS_EMAIL_PER_MINUTE` per organization. Excess deliveries wait for the next minute and do not use an attempt.

## In-app
- **Inbox:** `GET /organizations/:org/notifications` returns only the caller's own rows. Mark one read or unread with
  `PATCH /notifications/:id`, or all with `POST /notifications/read-all`. The header bell shows the unread count.
- **Preferences:** set per user and channel (enabled, minimum severity) with `GET/PUT /notifications/preferences`.
  Defaults: in-app on for every severity; email on for medium and above; WhatsApp off.

## Quiet hours, cooldown, quota
- **Quiet hours:** set per rule. Email and WhatsApp are deferred to the end of the window (status `deferred`, `not_before`);
  in-app is not. Critical issues bypass quiet hours when `allowCritical` is set.
- **Cooldown and escalation:** see ALERT_RULES.md.
- **Daily quota:** `ALERTS_NOTIFICATIONS_PER_DAY` per organization across channels. Beyond it, rows are stored as
  `suppressed` with the reason, so nothing is silently dropped.

## WhatsApp (official WhatsApp Business Platform only)
- **How it works:** the adapter calls the Cloud API messages endpoint with an approved **template** message. It uses no
  unofficial gateways and sends no free-form bulk messages.
- **Opt-in:** each user enters their own E.164 number in their preferences. Numbers are never imported in bulk.
- **Setup:**
  1. Create a Meta Business account and a WhatsApp Business app.
  2. Add and verify the sending phone number.
  3. Create a message template, e.g. `civicsignal_issue` with three body parameters (severity, title, link), and get it
     approved.
  4. Set `WHATSAPP_ACCESS_TOKEN` (system-user token), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` and
     `WHATSAPP_TEMPLATE_LANGUAGE` (default `id`).
- **Not live-verified.** No WhatsApp credentials were available while this was built. Only the request shape and error
  classification are tested, against mocked HTTP.

## Webhooks
- **Creation:** `POST /organizations/:org/webhooks` with `{ name, url, minSeverity }`. The response contains the signing
  secret **once**; it is stored encrypted (AES-256-GCM, `CREDENTIALS_KEY`) and never returned again.
- **URL policy:** HTTPS only, no credentials in the URL, and the same SSRF policy as connectors. Private, loopback,
  link-local and metadata addresses are refused, and DNS is checked at connect time. Redirects are not followed, so a
  receiver cannot bounce a signed payload elsewhere.
- **Verification (required before any alert payload is sent):** `POST /webhooks/:id/verify` sends
  `{"type":"webhook.verification","challenge":"…"}`. The receiver must answer 2xx with `{"challenge":"<same value>"}`.
- **Signature:** header `X-CivicSignal-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Reject requests whose
  `t` is more than 5 minutes old. The header `X-CivicSignal-Delivery` is the delivery id; use it to de-duplicate retries.
  Reference verifier: `verifyWebhookSignature` in `apps/api/src/alerts/channels/webhook.ts`.
- **Secret rotation:** `POST /webhooks/:id/rotate-secret { graceHours }`. During the grace period each delivery carries two
  `v1` values (new and old secret).
- **Payload:** issue id, title, severity, status, signal, scope, timestamps, rationale, method, app link, counts and up to
  10 source links. It never includes investigation notes, user data or credentials.
- **Retries:** timeouts, 408, 429 and 5xx are retried with backoff. Other 4xx and redirects are permanent. After all
  attempts the delivery is `dead` and goes to the DLQ; an administrator can retry it. After 20 consecutive dead deliveries
  the endpoint is disabled. The delivery log is at `GET /webhooks/:id/deliveries`.
- **Rate limit:** `ALERTS_WEBHOOK_PER_MINUTE` per organization.
