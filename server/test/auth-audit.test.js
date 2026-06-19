import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signAppUserToken,
  verifyAppUserToken,
  withAuditFieldsForInsert,
  withAuditFieldsForUpdate,
  resolveAuditActorId
} from '../src/index.js';

test('signAppUserToken + verifyAppUserToken round trip', () => {
  const token = signAppUserToken({
    userId: 'google_123',
    email: 'user@example.com',
    name: 'Sample User',
    googleSub: '123'
  });
  const claims = verifyAppUserToken(token);
  assert.equal(claims.userId, 'google_123');
  assert.equal(claims.email, 'user@example.com');
  assert.equal(claims.googleSub, '123');
});

test('withAuditFieldsForInsert sets defaults without overwriting explicit values', () => {
  const withDefaults = withAuditFieldsForInsert({ name: 'Acme' }, 'google_1');
  assert.equal(withDefaults.createdBy, 'google_1');
  assert.equal(withDefaults.updatedBy, 'google_1');

  const prefilled = withAuditFieldsForInsert({ name: 'Acme', createdBy: 'seed', updatedBy: 'seed' }, 'google_2');
  assert.equal(prefilled.createdBy, 'seed');
  assert.equal(prefilled.updatedBy, 'seed');
});

test('withAuditFieldsForUpdate stamps updatedBy for operator, replacement, and pipeline updates', () => {
  const opStyle = withAuditFieldsForUpdate({ $set: { name: 'Next' } }, 'google_actor');
  assert.equal(opStyle.$set.updatedBy, 'google_actor');

  const replacement = withAuditFieldsForUpdate({ name: 'Next' }, 'google_actor');
  assert.equal(replacement.updatedBy, 'google_actor');

  const pipeline = withAuditFieldsForUpdate([{ $set: { name: 'Next' } }], 'google_actor');
  assert.equal(Array.isArray(pipeline), true);
  assert.deepEqual(pipeline[pipeline.length - 1], { $set: { updatedBy: 'google_actor' } });
});

test('resolveAuditActorId prioritizes initiatedBy then userId then system', () => {
  assert.equal(resolveAuditActorId({ initiatedByUserId: 'user_a', userId: 'user_b' }), 'user_a');
  assert.equal(resolveAuditActorId({ userId: 'user_b' }), 'user_b');
  assert.equal(resolveAuditActorId({}), 'system');
});
