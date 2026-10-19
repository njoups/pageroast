import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, canAlerts, SEVERITIES, SEVERITY_STYLE } from './alerts';

test('every severity has an icon and label, so colour never carries meaning alone', () => {
  for (const s of SEVERITIES) { assert.ok(SEVERITY_STYLE[s].icon.length > 0); assert.ok(SEVERITY_STYLE[s].className.length > 0); }
});

test('time since detection', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(ago('2026-10-19T11:15:00Z', now), '45 min');
  assert.equal(ago('2026-10-19T02:30:00Z', now), '9 h 30 min');
  assert.equal(ago('2026-10-15T12:00:00Z', now), '4 days');
  assert.equal(ago(null, now), '—');
});

test('UI permission hints mirror the API matrix', () => {
  assert.equal(canAlerts.read('report_viewer'), false);
  assert.equal(canAlerts.act('analyst'), true);
  assert.equal(canAlerts.manage('analyst'), false);
  assert.equal(canAlerts.manage('project_manager'), true);
});
