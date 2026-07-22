import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addShareUserId,
  isSelfShare,
  mapSharedWithUsers,
  normalizeShareEmail,
  removeShareUserId,
  resolveShareTargetUserId
} from '../src/crm-share.js';

test('normalizeShareEmail lowercases valid emails and rejects invalid values', () => {
  assert.equal(normalizeShareEmail('  USER@Example.COM  '), 'user@example.com');
  assert.equal(normalizeShareEmail('not-an-email'), null);
  assert.equal(normalizeShareEmail(''), null);
});

test('addShareUserId adds once and avoids duplicates', () => {
  const first = addShareUserId(['google_a'], 'google_b');
  assert.equal(first.added, true);
  assert.deepEqual(first.nextShareUserIds, ['google_a', 'google_b']);

  const second = addShareUserId(first.nextShareUserIds, 'google_b');
  assert.equal(second.added, false);
  assert.deepEqual(second.nextShareUserIds, ['google_a', 'google_b']);
});

test('removeShareUserId removes existing target and reports misses', () => {
  const removed = removeShareUserId(['google_a', 'google_b'], 'google_b');
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.nextShareUserIds, ['google_a']);

  const missing = removeShareUserId(['google_a'], 'google_z');
  assert.equal(missing.removed, false);
  assert.deepEqual(missing.nextShareUserIds, ['google_a']);
});

test('mapSharedWithUsers resolves known users and preserves unknown user ids', () => {
  const rows = mapSharedWithUsers(
    ['google_a', 'google_unknown'],
    [{ userId: 'google_a', email: 'A@Example.com', name: 'Alice' }]
  );
  assert.deepEqual(rows, [
    { userId: 'google_a', email: 'a@example.com', name: 'Alice' },
    { userId: 'google_unknown', email: null, name: null }
  ]);
});


test('resolveShareTargetUserId handles unknown users and self-share checks', () => {
  assert.equal(resolveShareTargetUserId(null), null);
  assert.equal(resolveShareTargetUserId({ userId: '  google_owner  ' }), 'google_owner');
  assert.equal(isSelfShare('google_owner', 'google_owner'), true);
  assert.equal(isSelfShare('google_owner', 'google_other'), false);
});
