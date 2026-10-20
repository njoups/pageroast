import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AppError, conflict, notFound } from '../common/errors';
import { lockSubscription, transition, type Actor } from './lifecycle';

/**
 * Commercial invoices (manual / procurement workflow, and mirrors of provider invoices). These are payment requests
 * with a sequential number. They are NOT a Faktur Pajak (Indonesian VAT invoice issued through e-Faktur / Coretax):
 * tax metadata is stored for reference only and no tax-compliance claim is made.
 */
export const INVOICE_NOTICE = 'Commercial invoice for payment. This is not a Faktur Pajak (tax invoice); any tax invoice is issued separately.';

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'overdue' | 'void' | 'canceled';

export const InvoiceInput = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  // Money is entered in cents and computed in PostgreSQL numeric, never in floating point.
  lines: z.array(z.object({ description: z.string().min(1).max(500), quantity: z.number().positive().max(1e6).multipleOf(0.0001), unitAmount: z.number().nonnegative().max(1e9).multipleOf(0.01) }).strict()).min(1).max(100),
  taxAmount: z.number().nonnegative().max(1e11).multipleOf(0.01).default(0),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  contractId: z.string().uuid().optional(),
  poReference: z.string().max(200).optional(),
  taxMetadata: z.record(z.string().max(60), z.string().max(200)).refine((o) => Object.keys(o).length <= 20).default({}),
  billTo: z.object({ name: z.string().min(1).max(300), address: z.string().max(1000).optional(), email: z.string().email().max(320).optional(), taxId: z.string().max(60).optional() }).strict(),
  notes: z.string().max(4000).optional(),
  documentRefs: z.array(z.string().min(1).max(500)).max(20).default([]),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/).optional(),
}).strict();

export const PaymentInput = z.object({
  amount: z.number().positive().max(1e13).multipleOf(0.01),
  method: z.enum(['bank_transfer', 'government_treasury', 'other']),
  reference: z.string().min(1).max(200),
  receivedAt: z.string().datetime(),
  note: z.string().max(1000).optional(),
}).strict();


export async function createDraftInvoice(c: PoolClient, tenantId: string, input: z.infer<typeof InvoiceInput>, userId: string) {
  if (input.idempotencyKey) {
    const ex = (await c.query('SELECT id FROM invoices WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, input.idempotencyKey])).rows[0];
    if (ex) return { id: ex.id as string, created: false };
  }
  if (input.contractId && !(await c.query('SELECT 1 FROM contracts WHERE id = $1 AND tenant_id = $2', [input.contractId, tenantId])).rowCount) throw notFound('Contract');
  const sub = (await c.query<{ id: string }>('SELECT id FROM subscriptions WHERE tenant_id = $1 AND ended_at IS NULL', [tenantId])).rows[0];
  const inv = (await c.query<{ id: string }>(`INSERT INTO invoices (tenant_id, subscription_id, contract_id, source, status, currency, subtotal, tax_amount, total, period_start, period_end, po_reference,
      tax_metadata, bill_to, notes, document_refs, idempotency_key, created_by)
    VALUES ($1,$2,$3,'manual','draft',$4,0,$5::numeric,$5::numeric,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [tenantId, sub?.id ?? null, input.contractId ?? null, input.currency, String(input.taxAmount), input.periodStart ?? null, input.periodEnd ?? null,
      input.poReference ?? null, JSON.stringify(input.taxMetadata), JSON.stringify(input.billTo), input.notes ?? null, input.documentRefs, input.idempotencyKey ?? null, userId])).rows[0]!;
  let i = 0;
  for (const l of input.lines) {
    await c.query(`INSERT INTO invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount, amount, sort_order)
      VALUES ($1,$2,$3,$4::numeric,$5::numeric, round($4::numeric * $5::numeric, 2), $6)`, [tenantId, inv.id, l.description, String(l.quantity), String(l.unitAmount), i++]);
  }
  // Totals are the sum of the stored (rounded) line amounts, computed in numeric.
  await c.query(`UPDATE invoices SET subtotal = s.v, total = s.v + tax_amount FROM (SELECT coalesce(sum(amount), 0) AS v FROM invoice_lines WHERE invoice_id = $1) s WHERE id = $1`, [inv.id]);
  return { id: inv.id, created: true };
}

async function lockInvoice(c: PoolClient, tenantId: string, id: string) {
  const r = (await c.query('SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId])).rows[0];
  if (!r) throw notFound('Invoice');
  return r as { id: string; status: InvoiceStatus; source: string; total: string; amount_paid: string; currency: string; subscription_id: string | null; due_at: Date | null; number: string | null };
}

/** draft → issued: assigns the next number from a sequence (never reused, gaps possible if a transaction aborts). */
export async function issueInvoice(c: PoolClient, tenantId: string, id: string, input: { dueDays: number }, prefix: string, now = new Date()) {
  const inv = await lockInvoice(c, tenantId, id);
  if (inv.status !== 'draft') throw conflict('invalid_invoice_transition', `A ${inv.status} invoice cannot be issued`);
  if (Number(inv.total) <= 0) throw conflict('invalid_invoice', 'An invoice with a zero total cannot be issued');
  const seq = (await c.query<{ n: string }>(`SELECT nextval('invoice_number_seq') AS n`)).rows[0]!.n;
  const number = `${prefix}-${now.getUTCFullYear()}-${seq.padStart(6, '0')}`;
  return (await c.query(`UPDATE invoices SET status = 'issued', number = $2, issued_at = $3, due_at = $3::timestamptz + make_interval(days => $4) WHERE id = $1 RETURNING *`,
    [id, number, now, input.dueDays])).rows[0];
}

/**
 * Manual reconciliation of a received payment (bank transfer, government treasury / SP2D). The same remittance
 * reference cannot be recorded twice on an invoice. A fully paid invoice restores a past-due subscription.
 */
export async function recordPayment(c: PoolClient, tenantId: string, id: string, p: z.infer<typeof PaymentInput>, actor: Actor & { userId: string }) {
  const inv = await lockInvoice(c, tenantId, id);
  if (!['issued', 'partially_paid', 'overdue'].includes(inv.status)) throw conflict('invalid_invoice_transition', `A payment cannot be recorded on a ${inv.status} invoice`);
  const outstanding = (await c.query<{ o: string; over: boolean }>('SELECT total - amount_paid AS o, $2::numeric > total - amount_paid AS over FROM invoices WHERE id = $1', [id, String(p.amount)])).rows[0]!;
  if (outstanding.over) throw new AppError(400, 'overpayment', `The amount exceeds the outstanding balance (${outstanding.o} ${inv.currency})`);
  const ins = await c.query(`INSERT INTO payments (tenant_id, invoice_id, amount, currency, method, reference, received_at, source, note, recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9) ON CONFLICT (invoice_id, reference) DO NOTHING RETURNING id`,
    [tenantId, id, String(p.amount), inv.currency, p.method, p.reference, p.receivedAt, p.note ?? null, actor.userId]);
  if (!ins.rowCount) throw conflict('payment_duplicate', 'A payment with this reference is already recorded on this invoice');
  // Computed in numeric. A partial payment does not clear 'overdue' while the due date has passed (that would restart
  // the dunning clock on every small payment).
  const row = (await c.query(`UPDATE invoices SET amount_paid = amount_paid + $2::numeric,
      status = CASE WHEN amount_paid + $2::numeric >= total THEN 'paid' WHEN due_at < now() THEN 'overdue' ELSE 'partially_paid' END,
      paid_at = CASE WHEN amount_paid + $2::numeric >= total THEN $3::timestamptz ELSE paid_at END
    WHERE id = $1 RETURNING *`, [id, String(p.amount), p.receivedAt])).rows[0];
  const status = row.status as InvoiceStatus;
  if (status === 'paid') await recoverIfSettled(c, tenantId, actor);
  return { invoice: row, paymentId: ins.rows[0].id as string };
}

/** A past-due or payment-suspended subscription returns to active when no invoice is overdue any more. */
export async function recoverIfSettled(c: PoolClient, tenantId: string, actor: Actor) {
  const sub = await lockSubscription(c, tenantId);
  if (!sub || !(sub.status === 'past_due' || (sub.status === 'suspended' && sub.suspended_reason === 'past_due_grace_elapsed'))) return null;
  const open = (await c.query(`SELECT 1 FROM invoices WHERE tenant_id = $1 AND status IN ('issued','partially_paid','overdue') AND due_at < now()`, [tenantId])).rowCount;
  if (open) return null;
  return transition(c, sub, 'payment_recovered', actor);
}

export async function voidInvoice(c: PoolClient, tenantId: string, id: string, actor: Actor = { type: 'system' }) {
  const inv = await lockInvoice(c, tenantId, id);
  if (inv.status === 'draft') return (await c.query(`UPDATE invoices SET status = 'canceled' WHERE id = $1 RETURNING *`, [id])).rows[0];
  if (!['issued', 'overdue'].includes(inv.status) || Number(inv.amount_paid) > 0) throw conflict('invalid_invoice_transition', `A ${inv.status} invoice${Number(inv.amount_paid) > 0 ? ' with payments' : ''} cannot be voided`);
  const row = (await c.query(`UPDATE invoices SET status = 'void', voided_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0];
  // Voiding the last overdue invoice settles the account: a past-due subscription returns to active.
  if (inv.status === 'overdue') await recoverIfSettled(c, tenantId, actor);
  return row;
}

export async function invoiceDetail(c: PoolClient, tenantId: string, id: string) {
  const inv = (await c.query('SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
  if (!inv) throw notFound('Invoice');
  const lines = (await c.query('SELECT description, quantity, unit_amount, amount FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order', [id])).rows;
  const payments = (await c.query('SELECT id, amount, currency, method, reference, received_at, source, created_at FROM payments WHERE invoice_id = $1 ORDER BY received_at', [id])).rows;
  return { ...invoiceOut(inv), lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitAmount: Number(l.unit_amount), amount: Number(l.amount) })),
    payments: payments.map((p) => ({ id: p.id, amount: Number(p.amount), currency: p.currency, method: p.method, reference: p.reference, receivedAt: p.received_at, source: p.source })) };
}

export function invoiceOut(r: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any -- raw pg row
  return {
    id: r.id, number: r.number, status: r.status, source: r.source, provider: r.provider, currency: r.currency,
    subtotal: Number(r.subtotal), taxAmount: Number(r.tax_amount), total: Number(r.total), amountPaid: Number(r.amount_paid), balance: Math.round((Number(r.total) - Number(r.amount_paid)) * 100) / 100,
    periodStart: r.period_start, periodEnd: r.period_end, issuedAt: r.issued_at, dueAt: r.due_at, paidAt: r.paid_at, voidedAt: r.voided_at,
    poReference: r.po_reference, contractId: r.contract_id, billTo: r.bill_to, taxMetadata: r.tax_metadata, notes: r.notes, documentRefs: r.document_refs, createdAt: r.created_at,
    notice: INVOICE_NOTICE,
  };
}
