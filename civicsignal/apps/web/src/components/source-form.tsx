'use client';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui';
import type { Source } from '@/lib/api';

const FIELDS: Array<{ id: string; label: string; locked?: boolean }> = [
  { id: 'title', label: 'Headline', locked: true }, { id: 'url', label: 'Link', locked: true }, { id: 'published_at', label: 'Publication time' },
  { id: 'excerpt', label: 'Excerpt / feed summary' }, { id: 'author', label: 'Author' }, { id: 'categories', label: 'Categories' },
];

export interface SourcePayload { [k: string]: unknown }

/** Add/edit form. Licence fields are first-class: collection is only possible once an authorization basis is recorded. */
export function SourceForm({ initial, onSubmit, submitLabel, disabled }: {
  initial?: Source; onSubmit: (p: SourcePayload) => Promise<void>; submitLabel: string; disabled?: boolean;
}) {
  const [kind, setKind] = useState<'feed' | 'gdelt'>(initial?.connector.kind ?? 'feed');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cfg = initial?.connector.config ?? {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => { const v = String(f.get(k) ?? '').trim(); return v === '' ? null : Number(v); };
    const str = (k: string) => String(f.get(k) ?? '').trim();
    const payload: SourcePayload = {
      name: str('name'), category: str('category') || 'news', authorizationStatus: str('authorizationStatus'), authorizationBasis: str('authorizationBasis'),
      permittedFields: f.getAll('permittedFields').map(String), permitsFullText: f.get('permitsFullText') === 'on',
      refreshIntervalSeconds: num('refreshMinutes') !== null ? num('refreshMinutes')! * 60 : undefined,
      rateLimitPerMinute: num('rateLimitPerMinute'), quotaPerDay: num('quotaPerDay'), retentionDays: num('retentionDays'),
      licenseTerms: str('licenseTerms'), usageRestrictions: str('usageRestrictions'), redistributionRestrictions: str('redistributionRestrictions'),
      attributionRequirement: str('attributionRequirement'),
    };
    if (!initial) payload.kind = kind;
    if (kind === 'feed') { payload.feedUrl = str('feedUrl'); payload.format = str('format') || 'rss'; }
    else payload.connectorConfig = { query: str('gdeltQuery'), timespan: str('gdeltTimespan') || '1h', maxRecords: num('gdeltMax') ?? 75 };
    setBusy(true); setError(null);
    try { await onSubmit(payload); } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-6" aria-label={submitLabel}>
      {error && <Alert>{error}</Alert>}
      <fieldset disabled={disabled || busy} className="grid gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-800">Source</legend>
        <div><label className="label" htmlFor="name">Name</label><input id="name" name="name" required minLength={2} maxLength={120} defaultValue={initial?.name} className="input" /></div>
        <div><label className="label" htmlFor="kind">Connector</label>
          <select id="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as 'feed' | 'gdelt')} disabled={!!initial}>
            <option value="feed">RSS / Atom feed</option><option value="gdelt">GDELT DOC 2.0 (open data API)</option>
          </select></div>
        {kind === 'feed' ? (
          <>
            <div className="md:col-span-2"><label className="label" htmlFor="feedUrl">Feed URL</label>
              <input id="feedUrl" name="feedUrl" type="url" required defaultValue={initial?.feedUrl ?? ''} placeholder="https://publisher.example/rss" className="input" />
              <p className="mt-1 text-xs text-slate-500">Only public http(s) addresses on ports 80/443. Internal and cloud-metadata addresses are refused.</p></div>
            <div><label className="label" htmlFor="format">Format</label>
              <select id="format" name="format" className="input" defaultValue={initial?.collectionMethod === 'atom' ? 'atom' : 'rss'}><option value="rss">RSS</option><option value="atom">Atom</option></select></div>
          </>
        ) : (
          <>
            <div className="md:col-span-2"><label className="label" htmlFor="gdeltQuery">GDELT query</label>
              <input id="gdeltQuery" name="gdeltQuery" required minLength={3} maxLength={500} defaultValue={String(cfg.query ?? '')} placeholder='banjir sourcecountry:indonesia' className="input" />
              <p className="mt-1 text-xs text-slate-500">GDELT query syntax. Returns headline, link, domain and language. GDELT does not provide publication times.</p></div>
            <div><label className="label" htmlFor="gdeltTimespan">Look-back window</label><input id="gdeltTimespan" name="gdeltTimespan" defaultValue={String(cfg.timespan ?? '1h')} pattern="\d{1,3}(min|h|d)" className="input" /></div>
            <div><label className="label" htmlFor="gdeltMax">Max records per run (1–250)</label><input id="gdeltMax" name="gdeltMax" type="number" min={1} max={250} defaultValue={Number(cfg.maxRecords ?? 75)} className="input" /></div>
          </>
        )}
        <div><label className="label" htmlFor="category">Category</label><input id="category" name="category" defaultValue={initial?.category ?? 'news'} maxLength={60} className="input" /></div>
        <div><label className="label" htmlFor="refreshMinutes">Refresh every (minutes, ≥5)</label><input id="refreshMinutes" name="refreshMinutes" type="number" min={5} max={1440} defaultValue={(initial?.refreshIntervalSeconds ?? 3600) / 60} className="input" /></div>
        <div><label className="label" htmlFor="rateLimitPerMinute">Rate limit (requests/minute, optional)</label><input id="rateLimitPerMinute" name="rateLimitPerMinute" type="number" min={1} max={600} defaultValue={initial?.rateLimitPerMinute ?? ''} className="input" /></div>
        <div><label className="label" htmlFor="quotaPerDay">Daily quota (requests/day, optional)</label><input id="quotaPerDay" name="quotaPerDay" type="number" min={1} defaultValue={initial?.quotaPerDay ?? ''} className="input" /></div>
      </fieldset>

      <fieldset disabled={disabled || busy} className="grid gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-800">Authorization and licence</legend>
        <div><label className="label" htmlFor="authorizationStatus">Authorization status</label>
          <select id="authorizationStatus" name="authorizationStatus" className="input" defaultValue={initial?.authorizationStatus ?? 'unverified'}>
            <option value="unverified">Unverified (cannot collect)</option><option value="authorized">Authorized</option>
            <option value="restricted">Restricted (cannot collect)</option><option value="revoked">Revoked (cannot collect)</option>
          </select></div>
        <div><label className="label" htmlFor="retentionDays">Retention (days, from licence)</label><input id="retentionDays" name="retentionDays" type="number" min={1} max={3650} defaultValue={initial?.retentionDays ?? ''} className="input" /></div>
        <div className="md:col-span-2"><label className="label" htmlFor="authorizationBasis">Authorization basis (required to authorize)</label>
          <textarea id="authorizationBasis" name="authorizationBasis" rows={2} maxLength={2000} defaultValue={initial?.authorizationBasis ?? ''} className="input" placeholder="e.g. Written permission from publisher dated …, contract reference …, or published terms URL" /></div>
        <div className="md:col-span-2"><label className="label" htmlFor="licenseTerms">Licence terms</label><textarea id="licenseTerms" name="licenseTerms" rows={2} maxLength={4000} defaultValue={initial?.licenseTerms ?? ''} className="input" /></div>
        <div><label className="label" htmlFor="usageRestrictions">Usage restrictions</label><textarea id="usageRestrictions" name="usageRestrictions" rows={2} maxLength={2000} defaultValue={initial?.usageRestrictions ?? ''} className="input" /></div>
        <div><label className="label" htmlFor="redistributionRestrictions">Redistribution restrictions</label><textarea id="redistributionRestrictions" name="redistributionRestrictions" rows={2} maxLength={2000} defaultValue={initial?.redistributionRestrictions ?? ''} className="input" /></div>
        <div className="md:col-span-2"><label className="label" htmlFor="attributionRequirement">Attribution requirement</label><input id="attributionRequirement" name="attributionRequirement" maxLength={500} defaultValue={initial?.attributionRequirement ?? ''} className="input" /></div>
        <div className="md:col-span-2">
          <p className="label">Fields the licence permits us to store</p>
          <div className="flex flex-wrap gap-4">
            {FIELDS.map((fd) => (
              <label key={fd.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="permittedFields" value={fd.id} defaultChecked={fd.locked || (initial?.permittedFields ?? ['title', 'url', 'published_at']).includes(fd.id)}
                  onClick={fd.locked ? (e) => e.preventDefault() : undefined} aria-disabled={fd.locked} />
                {fd.label}{fd.locked && <span className="text-xs text-slate-500">(required)</span>}
              </label>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" name="permitsFullText" defaultChecked={initial?.permitsFullText ?? false} />
            Licence permits storing full article text (when the feed includes it)</label>
          <p className="mt-1 text-xs text-slate-500">Article pages are never fetched. A public feed does not by itself grant redistribution rights.</p>
        </div>
      </fieldset>
      {!disabled && <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>}
    </form>
  );
}
