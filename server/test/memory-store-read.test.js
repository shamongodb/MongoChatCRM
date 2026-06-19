import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getConversationMessagesDetailed,
  listConversationSessions
} from '../src/memory/store.js';

function matchesFilter(doc, filter = {}) {
  return Object.entries(filter).every(([key, value]) => {
    const docValue = doc[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Array.isArray(value.$in)) return value.$in.includes(docValue);
      return false;
    }
    return docValue === value;
  });
}

function makeCursor(input) {
  let rows = [...input];
  return {
    sort(sortSpec = {}) {
      const keys = Object.keys(sortSpec);
      rows.sort((a, b) => {
        for (const key of keys) {
          const dir = Number(sortSpec[key]) >= 0 ? 1 : -1;
          const av = a[key] == null ? '' : String(a[key]);
          const bv = b[key] == null ? '' : String(b[key]);
          if (av === bv) continue;
          return av > bv ? dir : -dir;
        }
        return 0;
      });
      return this;
    },
    limit(n) {
      rows = rows.slice(0, Math.max(0, Number(n) || 0));
      return this;
    },
    async toArray() {
      return rows.map((row) => ({ ...row }));
    },
    async next() {
      const list = await this.limit(1).toArray();
      return list[0] || null;
    }
  };
}

function createFakeDb(seed = {}) {
  const collections = new Map(Object.entries(seed));
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, []);
      const docs = collections.get(name);
      return {
        find(filter = {}) {
          return makeCursor(docs.filter((doc) => matchesFilter(doc, filter)));
        },
        aggregate(pipeline = []) {
          let rows = docs.map((row) => ({ ...row }));
          for (const stage of pipeline) {
            if (stage.$match) {
              rows = rows.filter((row) => matchesFilter(row, stage.$match));
            } else if (stage.$sort) {
              const keys = Object.keys(stage.$sort);
              rows.sort((a, b) => {
                for (const key of keys) {
                  const dir = Number(stage.$sort[key]) >= 0 ? 1 : -1;
                  const av = a[key] == null ? '' : String(a[key]);
                  const bv = b[key] == null ? '' : String(b[key]);
                  if (av === bv) continue;
                  return av > bv ? dir : -dir;
                }
                return 0;
              });
            } else if (stage.$group) {
              const grouped = new Map();
              for (const row of rows) {
                const key = row.conversationId;
                if (!grouped.has(key)) {
                  grouped.set(key, {
                    _id: key,
                    role: row.role,
                    content: row.content,
                    createdAt: row.createdAt
                  });
                }
              }
              rows = Array.from(grouped.values());
            }
          }
          return {
            async toArray() {
              if (rows && typeof rows.toArray === 'function') return rows.toArray();
              return Array.isArray(rows) ? rows : [];
            }
          };
        }
      };
    }
  };
}

const cfg = {
  conversationsCollection: 'conversations',
  messagesCollection: 'messages'
};

test('listConversationSessions returns latest message previews', async () => {
  const db = createFakeDb({
    conversations: [
      { conversationId: 'c1', userId: 'u1', title: 'Deal A', updatedAt: '2026-01-02T00:00:00.000Z' },
      { conversationId: 'c2', userId: 'u1', title: 'Deal B', updatedAt: '2026-01-03T00:00:00.000Z' }
    ],
    messages: [
      { conversationId: 'c1', role: 'assistant', content: 'Old c1', createdAt: '2026-01-01T00:00:00.000Z' },
      { conversationId: 'c2', role: 'assistant', content: 'Latest c2', createdAt: '2026-01-03T01:00:00.000Z' },
      { conversationId: 'c1', role: 'user', content: 'Latest c1', createdAt: '2026-01-02T01:00:00.000Z' }
    ]
  });

  const sessions = await listConversationSessions(db, cfg, { userId: 'u1', limit: 10 });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].conversationId, 'c2');
  assert.equal(sessions[0].latestMessage.content, 'Latest c2');
  assert.equal(sessions[1].conversationId, 'c1');
  assert.equal(sessions[1].latestMessage.content, 'Latest c1');
});

test('getConversationMessagesDetailed returns chronological chat messages', async () => {
  const db = createFakeDb({
    messages: [
      { conversationId: 'c1', role: 'assistant', content: 'Second', createdAt: '2026-01-02T00:00:00.000Z', _id: '2' },
      { conversationId: 'c1', role: 'user', content: 'First', createdAt: '2026-01-01T00:00:00.000Z', _id: '1' },
      { conversationId: 'c1', role: 'tool', content: 'Ignored', createdAt: '2026-01-03T00:00:00.000Z', _id: '3' }
    ]
  });

  const messages = await getConversationMessagesDetailed(db, cfg, 'c1', 100);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'First');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'Second');
});
