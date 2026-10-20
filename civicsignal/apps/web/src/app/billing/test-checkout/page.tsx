'use client';
import { Alert, PageHeader } from '@/components/ui';

/**
 * Landing page of the TEST billing adapter (BILLING_PROVIDER=test, refused in production). It never activates a plan:
 * a plan changes only when a signed `checkout.completed` event reaches the webhook endpoint (see BILLING_AND_SUBSCRIPTIONS.md).
 */
export default function TestCheckout() {
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  return (
    <div className="mx-auto max-w-xl p-6">
      <PageHeader title="Test checkout (simulator)" />
      <Alert tone="warning">This server uses the test billing adapter. No payment is collected and nothing is charged.</Alert>
      <div className="card mt-4 space-y-2 text-sm">
        <p>Session: <code>{q?.get('session') ?? '—'}</code> · plan <code>{q?.get('plan') ?? '—'}</code></p>
        <p>To simulate a completed payment, send a signed <code>checkout.completed</code> event for this session to <code>/api/v1/billing/webhooks/test</code> (see <code>scripts/billing-test-event.mjs</code>). Returning to the app without that event does not change the plan.</p>
        <button className="btn-secondary" onClick={() => history.back()}>Back</button>
      </div>
    </div>
  );
}
