import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSocial, connectorStatus, costText, quotaPercent, shareText, youtubeConfig, type SocialConnector } from './social';

const base = (o: Partial<SocialConnector> = {}): SocialConnector => ({
  id: 'c', connectorId: 'k', name: 'YT', provider: 'youtube', providerName: 'YouTube Data API v3', kind: 'youtube', enabled: true, authorizationStatus: 'authorized', authorizationBasis: 'x',
  config: {}, permittedFields: ['title', 'url'], refreshIntervalSeconds: 3600, retentionDays: 30,
  credentials: { required: true, label: 'YouTube Data API key', configured: true, hint: '…abcd', updatedAt: null }, connectionStatus: 'configured', connectionVerifiedAt: null,
  health: 'healthy', lastSuccessAt: '2026-10-20T00:00:00Z', lastAttemptAt: null, lastError: null, consecutiveFailures: 0, recordsCollected: 1, recordsStored: 1,
  schedule: { active: true, nextDueAt: null }, paused: null,
  quota: { provider: 'youtube', day: '2026-10-19', resetsAt: null, buckets: [], exhausted: false },
  rights: { derivedAnalysisAllowed: false, approval: null, attribution: null, redistribution: null }, lifecycle: { lastRun: null, refreshDue: 0, pastDeletionDeadline: 0 },
  notices: [], capabilities: [], ...o,
});

test('connector status shows the most important blocker first', () => {
  assert.equal(connectorStatus(base({ authorizationStatus: 'unverified' })).label, 'Not authorized');
  assert.equal(connectorStatus(base({ credentials: { ...base().credentials, configured: false } })).label, 'Unconfigured');
  assert.equal(connectorStatus(base({ paused: { until: '2999-01-01T00:00:00Z', reason: 'provider_quota' } })).label, 'Paused');
  assert.equal(connectorStatus(base({ paused: { until: '2000-01-01T00:00:00Z', reason: 'provider_quota' } })).label, 'Collecting');   // expired pause
  assert.equal(connectorStatus(base({ connectionStatus: 'failing' })).label, 'Connection failing');
  assert.equal(connectorStatus(base({ enabled: false })).label, 'Disabled');
  assert.equal(connectorStatus(base({ health: 'unknown' })).label, 'Not yet collected');
});

test('quota and shares never invent figures', () => {
  assert.equal(quotaPercent({ key: 's', label: 's', limit: 100, used: 25, remaining: 75, requests: 25 }), 25);
  assert.equal(quotaPercent({ key: 's', label: 's', limit: 100, used: 150, remaining: 0, requests: 150 }), 100);
  assert.equal(quotaPercent({ key: 's', label: 's', limit: null, used: 5, remaining: null, requests: 5 }), null);
  assert.equal(shareText(null), '—');
  assert.equal(shareText(12.5), '12.5%');
  assert.match(costText({ status: 'not_priced', amount: null, currency: null, basis: [], verifiedAt: null }), /^Not priced/);
  assert.match(costText({ status: 'incomplete', amount: null, currency: null, basis: [], verifiedAt: null }), /no total is shown/);
  assert.match(costText({ status: 'estimated', amount: 0.012, currency: 'USD', basis: [], verifiedAt: '2026-10-20' }), /0\.012 USD \(estimate; prices verified 2026-10-20\)/);
});

test('connector form builds only accepted settings', () => {
  assert.deepEqual(youtubeConfig({ mode: 'search', query: ' banjir jakarta ', channelIds: 'ignored', lookbackHours: 24, maxPages: 2, includeComments: false }),
    { mode: 'search', query: 'banjir jakarta', lookbackHours: 24, maxPages: 2, includeComments: false });
  assert.deepEqual(youtubeConfig({ mode: 'channel', query: 'ignored', channelIds: 'UCa, UCb\nUCc', lookbackHours: 48, maxPages: 1, includeComments: true }),
    { mode: 'channel', channelIds: ['UCa', 'UCb', 'UCc'], lookbackHours: 48, maxPages: 1, includeComments: true });
});

test('permissions mirror the API matrix', () => {
  assert.equal(canSocial.read('report_viewer'), false);
  assert.equal(canSocial.manage('analyst'), false);
  assert.equal(canSocial.manage('project_manager'), true);
  assert.equal(canSocial.approve('project_manager'), false);
  assert.equal(canSocial.approve('admin'), true);
});
