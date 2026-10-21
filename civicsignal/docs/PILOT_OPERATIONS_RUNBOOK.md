# Pilot Operations Runbook

How to onboard and run the **first pilot customer**. A pilot can start only when the prerequisites in section 1 are complete; as of 2026-10-21 they are not (PILOT_DEPLOYMENT_AUDIT.md § 8).

Promise nothing that has not been measured. This system has **no measured** service availability, alert latency or data coverage on real infrastructure. The pilot exists to measure them.

## 1. Prerequisites (all required before a real customer's data enters the system)

| # | Prerequisite | Evidence |
|---|---|---|
| 1 | Production environment deployed by the approved pipeline from the protected release branch. Smoke test passing | Deploy run link, smoke output |
| 2 | Staging deployed with the same SHA, and the manual staging checklist done (DEPLOYMENT.md § Smoke-test checklist) | Checklist record |
| 3 | Domain, TLS, HSTS and headers verified by `scripts/smoke.mjs` | Smoke output |
| 4 | Backups running (PITR + nightly encrypted dump off-host), first restore drill on staging recorded | DISASTER_RECOVERY_RUNBOOK.md verification record |
| 5 | Monitoring and paging live (`infra/monitoring/alerts.yml`); on-call rota and contacts filled in | INCIDENT_RESPONSE_RUNBOOK.md contacts |
| 6 | Real SMTP relay with SPF, DKIM and DMARC; a password reset email received | Test record |
| 7 | Customer-visible accuracy P2s fixed (AR-04, AR-06, AR-08, IN-04) or explicitly accepted by the customer as known limitations | QA report update or signed acceptance |
| 8 | Data processing agreement or pilot agreement signed: data residency, retention, sub-processors (hosting, SMTP, and the AI provider if used), incident notification, exit | Signed document (legal review is outside this repository) |
| 9 | Source licensing: every feed or social source has an authorization basis recorded | Source registry |
| 10 | Repository private; production access limited to named operators | Settings screenshot, access list |

## 2. Pilot scope (realistic for the current implementation)
- **1 organization**, up to **10 users**, **2–3 projects**.
- **News sources:** RSS/Atom feeds with an authorization basis (licensed, public with terms reviewed, or the customer's own). Target 10–50 feeds.
- **Social:** optional, YouTube only, with the customer's own API key and budget. No other platforms exist.
- **AI:**
  - Start with the rule-based baseline.
  - Enable the LLM only after the evaluation set run (AI_EVALUATION.md) and with a per-tenant monthly token limit agreed in writing.
- **Alerts:** email (and webhook if the customer has a receiver). WhatsApp only with an approved template.
- **Reports:** the built-in templates (REPORT_TEMPLATES.md), weekly and on demand.
- **Billing:** contract and manual invoice. No card payments: no payment provider exists.
- **Out of scope:**
  - SSO/MFA (an external IdP is needed);
  - API access for customers;
  - platforms other than news feeds and YouTube;
  - real-time (sub-minute) alerting promises.

## 3. Onboarding procedure

| Step | Who | How | Done when |
|---|---|---|---|
| 1. Tenant provisioning | Platform operator | The customer administrator registers and creates the organization (or the operator asks them to). Platform console → Organizations → confirm it exists and starts on the trial plan | Organization visible in `/platform` |
| 2. Contract and entitlements | Platform operator | Console → Manage → **Contract** (reference, PO, plan, term, value, contact). Activation `pending_activation` until the PO is confirmed, then `active`. Adjust quotas with overrides if the pilot needs different limits (COMMERCIAL_OPERATIONS_RUNBOOK.md) | Billing page shows the plan, period and limits |
| 3. Customer administrator | Customer | Owner sets the organization name, time zone (Admin → Organization) and brand colour. The **time zone drives calendar days in analytics and reports**: set it before data arrives | Settings saved |
| 4. User invitations | Customer owner/admin | Team → Invite, with the role per user (owner, admin, project manager, analyst, report viewer). Use the least-privileged role; report viewers cannot export CSV | Invitees accepted |
| 5. Authorized data sources | Customer admin with the operator | Sources → Add source: feed URL, **authorization basis** and licence note (CONNECTORS.md). Test fetch; enable. Sources whose host changes return to `unverified` and must be re-authorized | Collection runs succeed (Sources page, `ingestion_runs` metric) |
| 6. Keywords and topics | Customer project managers | Projects → queries (Boolean, max 20 prefix terms), categories and monitored entities. Check matches on the last 7 days before enabling alerts | Mentions appear in the project |
| 7. Alert configuration | Customer project managers | Alert rules (ALERT_RULES.md): start with keyword and volume-spike rules, **test send** to the customer's own address, set quiet hours and recipients. Daily notification cap per tenant applies | Test alert received |
| 8. Report templates | Customer | Reports → definition (template, project, schedule, recipients). Generate one on demand and review the evidence links | First report reviewed by the customer |
| 9. Data retention | Customer **owner** | Data governance → retention policies per data class (enabling or shortening requires the owner). Legal hold if required by the customer | Policy recorded |
| 10. Usage and cost monitoring | Platform operator | See section 4 | Thresholds agreed |
| 11. Acceptance tests | Customer + operator | Section 5 | Signed checklist |

## 4. Usage and cost monitoring
- **Customer's view:** Billing & usage page (usage per metric, limits, threshold notices at 70/85/95/100 %).
- **Operator's view:**
  - platform console → Costs and margin (AI cost per tenant from recorded token usage × configured prices);
  - Organizations → usage ledger.
- **Alerts:**
  - `CivicSignalAiQuotaExhausted` (AI monthly token limit reached; analysis falls back to the baseline);
  - `CivicSignalSocialQuotaPaused` (YouTube budget or provider quota);
  - notification failure alerts.
- **Weekly check during the pilot:**
  - collection success rate;
  - records per day;
  - AI tokens and cost against the agreed limit;
  - alerts sent and suppressed (and why);
  - reports generated and failed;
  - support tickets.

## 5. Customer acceptance tests
Run with the customer administrator in production during week 1. Record pass/fail and evidence for each.
1. All invited users can sign in; a report viewer cannot export CSV or change settings.
2. Each authorized source has collected at least once; a source the customer did not authorize is absent.
3. A known recent article for each project's main keyword is found by search.
4. A test alert reaches the intended recipient by email, and not anyone else.
5. A weekly report is generated, every claim in it links to source records, and the period matches the organization's time zone.
6. Usage on the billing page matches the actions taken (reports generated, records analysed).
7. The customer's data is not visible from the operator's internal test organization, and the reverse (tenant isolation spot check).
8. Data retention policy is shown as configured; legal hold, if requested, is on.
9. Password reset email works for a customer user.

## 6. Support process
- **Contact:** one named support address and an escalation phone for SEV-1, given to the customer administrator. Fill in the contacts in INCIDENT_RESPONSE_RUNBOOK.md.
- **Hours:** state the actual staffed hours. Do not promise 24/7 unless an on-call rota exists.
- **Ticket fields:** organization, user, time (with time zone), page or report, `requestId` from the error message if shown, screenshots without other people's data.
- **First response targets:** proposed SEV-1 1 h, SEV-2 4 business hours, SEV-3 next business day. These are targets to agree, not guarantees.
- **Customer data access by operators:** only to resolve a ticket, logged in the incident or ticket record. Platform administrators have no implicit access to customer content in the application.

## 7. Known limitations (tell the customer before the pilot starts)
- No measured uptime or alert latency on real infrastructure yet; the pilot will measure them.
- Single-host deployment (if chosen) has no high availability: host or disk loss means an outage. With nightly dumps only, up to 24 h of data loss.
- AI analysis is either the rule-based baseline or an LLM never verified live before the pilot. Summaries are grounded to source text, but users must check the evidence links before relying on them.
- Coverage is limited to the authorized feeds and YouTube. There is no coverage of other platforms, and no coverage guarantee for any source (publishers change or block feeds).
- Open known defects: QA report § 11 (for example syndicated copies counted in some metrics, until AR-04 is fixed).
- No SSO or MFA; local passwords only.
- Invoices are not tax invoices (no e-Faktur).
- No certification (ISO 27001, SOC 2, BSSN) is held or claimed.

## 8. Pilot success criteria (measured, agreed with the customer at kick-off)

| Area | Measure | Proposed target (agree before start) |
|---|---|---|
| Reliability | Monthly availability of `/readyz` (blackbox probe) | ≥ 99 % during business hours (measure first; do not promise before) |
| Reliability | SEV-1 incidents | 0 caused by data exposure; outages resolved within the agreed RTO |
| Data quality | Share of collection runs succeeding | ≥ 95 % per week |
| Data quality | Customer spot-check of 50 mentions: relevant to the query | ≥ 80 % (baseline to be measured in week 1) |
| Alert usefulness | Alerts marked useful (acknowledged/investigated) vs dismissed as noise | Trend improves week over week; noisy rules tuned within 2 business days |
| Report usefulness | Weekly reports used by the customer without manual rework | ≥ 3 of 4 in the last month |
| Workflow completion | Users completing the core workflow weekly (search → issue → report) | ≥ 60 % of invited users |
| Support burden | Tickets per week, and time to resolve | Falling trend; no ticket open > 5 business days |
| Cost | AI and infrastructure cost per month vs the agreed budget | Within budget, with no quota surprises |

## 9. Pilot exit criteria
- **Success → contract:** the success criteria are met for the last 4 weeks, there are no open SEV-1/SEV-2 issues, the customer signs off, and the production design is moved to option B (managed database, 2 replicas) if the pilot ran on a single host.
- **Extend:** criteria partly met with a clear fix list; agree a new end date.
- **Stop:** a confirmed data exposure, repeated SEV-1s, or the customer withdraws. Then:
  1. Export the customer's data on request (reports, CSV).
  2. Apply the agreed deletion: deletion workflow plus backup expiry (DISASTER_RECOVERY_RUNBOOK.md § 7).
  3. Revoke users, connectors and credentials.
  4. Confirm in writing what was deleted and when backup copies expire.
