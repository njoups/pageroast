import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeNextPath } from './api';

const O = 'https://app.civicsignal.example';

test('allows same-origin paths, keeping query and hash', () => {
  assert.equal(safeNextPath('/o/123/projects?status=archived#x', O), '/o/123/projects?status=archived#x');
});

test('rejects protocol-relative, backslash and absolute redirects', () => {
  for (const bad of ['//evil.example', '/\\evil.example', '/\\/evil.example', 'https://evil.example', 'javascript:alert(1)', '/.//evil.example', '/%2e//evil.example', '/a/..//evil.example', '', null]) {
    assert.equal(safeNextPath(bad, O), '/', String(bad));
  }
});
