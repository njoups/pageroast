# Data Governance

> This document describes engineering controls. It is **not legal advice** and asserts no regulatory compliance.
> Indonesian personal-data protection (UU PDP No. 27/2022), government procurement rules, data-residency requirements,
> and customer contracts must be assessed by qualified counsel before production use with government customers.

## Principles
1. **Licence first.** Each source records authorization status, permitted fields, retention, and attribution. The pipeline
   (M2) stores only fields permitted by the source's licence; a full article body is stored only when `permits_full_text = true`.
2. **No circumvention.** No paywall, CAPTCHA, auth, quota, or platform-restriction bypass.
3. **Provenance.** Every mention keeps source, collection method, discovery time (separate from publication time), and licence reference.
4. **Minimisation.** Collect keyword-matched records for a project; no bulk profiling of individuals.
5. **No individual scoring.** The product must not compute citizen, loyalty, or other scores about individuals, nor feed automated decisions affecting individual rights.
6. **Tenant ownership.** Customer configuration and derived data belong to the tenant; export and deletion are supported (workflows in M6).

## Data classes
| Class | Examples | Handling |
|---|---|---|
| Account | email, name, password hash | scrypt hashes; never logged |
| Tenant config | projects, queries, alert rules | RLS-isolated; audit on change |
| Source content | headlines, excerpts, permitted bodies | licence-driven retention |
| Derived | sentiment, entities, summaries | stored with model/prompt versions and evidence |
| Audit | audit_events | append-only, retained ≥ 12 months (configurable per tenant, not below the floor) |

## Retention
`retention_policies` stores per-tenant, per-data-class retention. Defaults are conservative; enforcement jobs arrive in M6.
Retention may be shortened by a source licence but never lengthened beyond it.

## Source licence registry
Table `sources` (+ `connectors`) is the registry. No source is seeded as authorized; operators must enter the authorization basis.

## Open items for legal review
UU PDP applicability to public-figure mentions · hosting location · cross-border transfer of LLM prompts · publisher terms for RSS reuse and excerpts.
