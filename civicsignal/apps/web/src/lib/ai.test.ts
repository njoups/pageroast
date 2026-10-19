import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canAi, METHOD_LABEL, pct, topicLabel } from './ai';

test('pct renders fractions and missing values honestly', () => {
  assert.equal(pct('0.734'), '73%');
  assert.equal(pct(null), '—');
  assert.equal(pct(undefined), '—');
});

test('topic labels: taxonomy keys, custom categories, unknown keys', () => {
  assert.equal(topicLabel('public_safety'), 'Public safety');
  assert.equal(topicLabel('custom:bantuan_sosial'), 'bantuan sosial');
  assert.equal(topicLabel('something_else'), 'something_else');
});

test('test-fixture output is never labelled as AI analysis', () => {
  assert.match(METHOD_LABEL.test!, /not real analysis/);
  assert.notEqual(METHOD_LABEL.baseline, METHOD_LABEL.llm);
});

test('UI permission hints mirror the API matrix', () => {
  assert.equal(canAi.reprocess('analyst'), false);
  assert.equal(canAi.reprocess('project_manager'), true);
  assert.equal(canAi.settings('project_manager'), false);
});
