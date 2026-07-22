import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureMemoryCollections,
  getUserProfile,
  mergeUserProfilePatch,
  upsertUserProfile
} from '../src/memory/store.js';

function createFakeDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) {
        const state = {
          docs: [],
          indexes: []
        };
        collections.set(name, {
          async createIndex(index, options = {}) {
            state.indexes.push({ index, options });
          },
          async findOne(filter) {
            return state.docs.find((doc) => (
              Object.entries(filter || {}).every(([key, value]) => doc[key] === value)
            )) || null;
          },
          async updateOne(filter, update, options = {}) {
            const existingIndex = state.docs.findIndex((doc) => (
              Object.entries(filter || {}).every(([key, value]) => doc[key] === value)
            ));
            if (existingIndex === -1) {
              if (!options.upsert) return { matchedCount: 0 };
              const next = { ...(filter || {}), ...(update.$setOnInsert || {}), ...(update.$set || {}) };
              state.docs.push(next);
              return { matchedCount: 0, upsertedCount: 1 };
            }
            state.docs[existingIndex] = {
              ...state.docs[existingIndex],
              ...(update.$set || {})
            };
            return { matchedCount: 1, upsertedCount: 0 };
          },
          _state: state
        });
      }
      return collections.get(name);
    }
  };
}

const cfg = {
  conversationsCollection: 'conversations',
  messagesCollection: 'messages',
  summariesCollection: 'memory_summaries',
  jobsCollection: 'memory_jobs',
  userProfilesCollection: 'user_profiles'
};

test('mergeUserProfilePatch merges object fields and replaces constraints', () => {
  const merged = mergeUserProfilePatch(
    {
      userId: 'u1',
      preferences: { style: 'detailed' },
      aliases: { myTeam: 'Team A' },
      constraints: ['Constraint A']
    },
    {
      preferences: { style: 'concise', locale: 'en-US' },
      aliases: { myManager: 'Sam' },
      constraints: ['Constraint B']
    },
    'user_input'
  );

  assert.equal(merged.userId, 'u1');
  assert.deepEqual(merged.preferences, { style: 'concise', locale: 'en-US' });
  assert.deepEqual(merged.aliases, { myTeam: 'Team A', myManager: 'Sam' });
  assert.deepEqual(merged.constraints, ['Constraint B']);
  assert.equal(merged.source, 'user_input');
});

test('upsertUserProfile persists and getUserProfile reads normalized result', async () => {
  const db = createFakeDb();
  await upsertUserProfile(db, cfg, {
    userId: 'user-123',
    patch: {
      displayName: 'Shaun',
      timezone: 'America/New_York',
      aliases: { myTeam: 'Enterprise Sales' }
    },
    source: 'admin'
  });

  const profile = await getUserProfile(db, cfg, 'user-123');
  assert.equal(profile.userId, 'user-123');
  assert.equal(profile.displayName, 'Shaun');
  assert.equal(profile.timezone, 'America/New_York');
  assert.deepEqual(profile.aliases, { myTeam: 'Enterprise Sales' });
  assert.equal(profile.source, 'admin');
});

test('ensureMemoryCollections creates user profile indexes', async () => {
  const db = createFakeDb();
  await ensureMemoryCollections(db, cfg);
  const profileIndexes = db.collection(cfg.userProfilesCollection)._state.indexes;
  assert.equal(profileIndexes.length, 3);
  assert.deepEqual(profileIndexes[0].index, { userId: 1 });
  assert.deepEqual(profileIndexes[1].index, { crmShareAllWith: 1 });
  assert.deepEqual(profileIndexes[2].index, { updatedAt: -1 });
});
