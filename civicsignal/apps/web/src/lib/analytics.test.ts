import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyticsQuery, EMPTY_FILTERS, fmtChange, zonedMidnight } from './analytics';

test('converts local midnight in the tenant time zone to UTC', () => {
  assert.equal(zonedMidnight('2026-10-12', 'Asia/Jakarta').toISOString(), '2026-10-11T17:00:00.000Z');
  assert.equal(zonedMidnight('2026-10-12', 'Asia/Jayapura').toISOString(), '2026-10-11T15:00:00.000Z');
  assert.equal(zonedMidnight('2026-03-29', 'Europe/Berlin').toISOString(), '2026-03-28T23:00:00.000Z');
});

test('builds an inclusive custom range and passes filters', () => {
  const q = new URLSearchParams(analyticsQuery({ ...EMPTY_FILTERS, range: 'custom', from: '2026-10-12', to: '2026-10-18', projectId: 'p', entityIds: ['a', 'b'] }, 'Asia/Jakarta'));
  assert.equal(q.get('from'), '2026-10-11T17:00:00.000Z');
  assert.equal(q.get('to'), '2026-10-18T17:00:00.000Z');
  assert.equal(q.get('projectId'), 'p');
  assert.equal(q.get('entityIds'), 'a,b');
  assert.equal(q.get('days'), null);
  assert.equal(new URLSearchParams(analyticsQuery(EMPTY_FILTERS, 'UTC')).get('days'), '30');
});

test('formats changes without inventing growth from zero', () => {
  assert.equal(fmtChange({ delta: 4, pct: 400 }), '+4 (+400%)');
  assert.equal(fmtChange({ delta: 3, pct: null }), '+3 (new)');
  assert.equal(fmtChange({ delta: -2, pct: -50 }), '−2 (−50%)');
  assert.equal(fmtChange({ delta: 0, pct: 0 }), '±0 (0%)');
});
