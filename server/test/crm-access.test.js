import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDocumentAccessible,
  buildOwnerVisibilityFilter,
  getVisibleOwnerUserIds,
  mergeCrmFilter,
  resolveCrmActor,
  stampOwnerUserId
} from '../src/crm-access.js';

test('resolveCrmActor prioritizes initiatedByUserId then userId', () => {
  assert.equal(resolveCrmActor({ initiatedByUserId: 'user_a', userId: 'user_b' }), 'user_a');
  assert.equal(resolveCrmActor({ userId: 'user_b' }), 'user_b');
  assert.equal(resolveCrmActor({}), null);
});

test('buildOwnerVisibilityFilter and mergeCrmFilter compose query filters', () => {
  const visibility = buildOwnerVisibilityFilter(['u1', 'u2']);
  assert.deepEqual(visibility, { ownerUserId: { $in: ['u1', 'u2'] } });
  const merged = mergeCrmFilter({ accountId: 'acc_1' }, visibility);
  assert.deepEqual(merged, { $and: [{ accountId: 'acc_1' }, { ownerUserId: { $in: ['u1', 'u2'] } }] });
});

test('assertDocumentAccessible allows visible owner and blocks others', () => {
  const ok = assertDocumentAccessible({ ownerUserId: 'u1' }, ['u1', 'u2'], 'Contact');
  assert.equal(ok.ok, true);
  const denied = assertDocumentAccessible({ ownerUserId: 'u3' }, ['u1', 'u2'], 'Contact');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /not found or not accessible/i);
});

test('stampOwnerUserId sets owner on insert docs', () => {
  const stamped = stampOwnerUserId({ name: 'Acme' }, 'u1');
  assert.equal(stamped.ownerUserId, 'u1');
  const keepsExisting = stampOwnerUserId({ name: 'Acme', ownerUserId: 'u9' }, 'u1');
  assert.equal(keepsExisting.ownerUserId, 'u9');
});

test('getVisibleOwnerUserIds includes self and sharing owners', async () => {
  const mockRows = [
    { userId: 'owner_a' },
    { userId: 'owner_b' },
    { userId: 'owner_a' }
  ];
  const db = {
    collection() {
      return {
        find() {
          return {
            limit() {
              return {
                async toArray() {
                  return mockRows;
                }
              };
            }
          };
        }
      };
    }
  };
  const visible = await getVisibleOwnerUserIds(db, { userId: 'viewer_u', userProfilesCollection: 'user_profiles' });
  assert.deepEqual(visible.sort(), ['owner_a', 'owner_b', 'viewer_u'].sort());
});
