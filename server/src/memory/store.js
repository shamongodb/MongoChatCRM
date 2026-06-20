import { ObjectId } from 'mongodb';

function toObjectId(value) {
  try {
    return value ? new ObjectId(value) : null;
  } catch (_err) {
    return null;
  }
}

function normalizeStoredMessage(row) {
  const out = {
    role: row.role,
    content: row.content == null ? '' : String(row.content)
  };
  if (Array.isArray(row.toolCalls) && row.toolCalls.length) out.tool_calls = row.toolCalls;
  if (row.toolCallId) out.tool_call_id = row.toolCallId;
  if (row.name) out.name = row.name;
  return out;
}

function toStoredMessage(doc) {
  const now = new Date().toISOString();
  const role = String(doc.role || '').trim();
  return {
    role,
    content: doc.content == null ? '' : (typeof doc.content === 'string' ? doc.content : String(doc.content)),
    toolCalls: Array.isArray(doc.tool_calls) ? doc.tool_calls : [],
    toolCallId: doc.tool_call_id ? String(doc.tool_call_id) : null,
    name: doc.name ? String(doc.name) : null,
    tokenEstimate: typeof doc.content === 'string' ? Math.ceil(doc.content.length / 4) : 0,
    createdAt: now
  };
}

export async function ensureMemoryCollections(db, cfg) {
  await Promise.all([
    db.collection(cfg.conversationsCollection).createIndex({ conversationId: 1 }, { unique: true }),
    db.collection(cfg.conversationsCollection).createIndex({ userId: 1, updatedAt: -1 }),
    db.collection(cfg.messagesCollection).createIndex({ conversationId: 1, createdAt: 1 }),
    db.collection(cfg.messagesCollection).createIndex({ role: 1, createdAt: -1 }),
    db.collection(cfg.summariesCollection).createIndex({ conversationId: 1 }, { unique: true }),
    db.collection(cfg.summariesCollection).createIndex({ updatedAt: -1 }),
    db.collection(cfg.jobsCollection).createIndex({ status: 1, updatedAt: -1 }),
    db.collection(cfg.userProfilesCollection).createIndex({ userId: 1 }, { unique: true }),
    db.collection(cfg.userProfilesCollection).createIndex({ updatedAt: -1 })
  ]);
}

function sanitizeProfileDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const crmShareAllWith = Array.isArray(doc.crmShareAllWith)
    ? Array.from(new Set(doc.crmShareAllWith.map((item) => String(item || '').trim()).filter(Boolean)))
    : [];
  return {
    userId: doc.userId ? String(doc.userId) : null,
    displayName: doc.displayName == null ? null : String(doc.displayName),
    timezone: doc.timezone == null ? null : String(doc.timezone),
    role: doc.role == null ? null : String(doc.role),
    organization: doc.organization == null ? null : String(doc.organization),
    preferences: doc.preferences && typeof doc.preferences === 'object' && !Array.isArray(doc.preferences) ? doc.preferences : {},
    aliases: doc.aliases && typeof doc.aliases === 'object' && !Array.isArray(doc.aliases) ? doc.aliases : {},
    constraints: Array.isArray(doc.constraints) ? doc.constraints.map((item) => String(item)).filter(Boolean) : [],
    crmShareAllWith,
    source: doc.source == null ? null : String(doc.source),
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  };
}

export function mergeUserProfilePatch(existingDoc, patch, source) {
  const existing = sanitizeProfileDoc(existingDoc) || {};
  const now = new Date().toISOString();
  const incoming = patch && typeof patch === 'object' ? patch : {};

  const next = {
    userId: existing.userId || null,
    displayName: existing.displayName || null,
    timezone: existing.timezone || null,
    role: existing.role || null,
    organization: existing.organization || null,
    preferences: existing.preferences || {},
    aliases: existing.aliases || {},
    constraints: existing.constraints || [],
    crmShareAllWith: existing.crmShareAllWith || [],
    source: source ? String(source) : (existing.source || null),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };

  if (incoming.displayName !== undefined) next.displayName = incoming.displayName == null ? null : String(incoming.displayName);
  if (incoming.timezone !== undefined) next.timezone = incoming.timezone == null ? null : String(incoming.timezone);
  if (incoming.role !== undefined) next.role = incoming.role == null ? null : String(incoming.role);
  if (incoming.organization !== undefined) next.organization = incoming.organization == null ? null : String(incoming.organization);

  if (incoming.preferences !== undefined) {
    const input = incoming.preferences && typeof incoming.preferences === 'object' && !Array.isArray(incoming.preferences)
      ? incoming.preferences
      : {};
    next.preferences = { ...(existing.preferences || {}), ...input };
  }
  if (incoming.aliases !== undefined) {
    const input = incoming.aliases && typeof incoming.aliases === 'object' && !Array.isArray(incoming.aliases)
      ? incoming.aliases
      : {};
    next.aliases = { ...(existing.aliases || {}), ...input };
  }
  if (incoming.constraints !== undefined) {
    const values = Array.isArray(incoming.constraints) ? incoming.constraints : [];
    next.constraints = values.map((item) => String(item)).filter(Boolean);
  }
  if (incoming.crmShareAllWith !== undefined) {
    const values = Array.isArray(incoming.crmShareAllWith) ? incoming.crmShareAllWith : [];
    next.crmShareAllWith = Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)));
  }

  return next;
}

export async function loadConversationMemory(db, cfg, conversationId, recentLimit) {
  const summaries = db.collection(cfg.summariesCollection);
  const messages = db.collection(cfg.messagesCollection);
  const summaryDoc = await summaries.findOne({ conversationId });
  const rows = await messages
    .find({ conversationId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.max(1, recentLimit))
    .toArray();
  rows.reverse();
  return {
    summaryText: summaryDoc?.summaryText || '',
    coveredUntilMessageId: summaryDoc?.coveredUntilMessageId || null,
    recentMessages: rows.map(normalizeStoredMessage)
  };
}

export async function appendConversationMessages(db, cfg, { conversationId, userId, messages, title }) {
  const convs = db.collection(cfg.conversationsCollection);
  const messageRows = db.collection(cfg.messagesCollection);
  const now = new Date().toISOString();
  const filtered = (messages || [])
    .filter((m) => m && m.role && m.role !== 'system')
    .map(toStoredMessage);
  if (!filtered.length) {
    await convs.updateOne(
      { conversationId },
      {
        $setOnInsert: {
          conversationId,
          userId: userId || null,
          title: title || null,
          createdAt: now
        },
        $set: {
          updatedAt: now
        }
      },
      { upsert: true }
    );
    return { insertedCount: 0 };
  }

  const docs = filtered.map((row, index) => ({
    conversationId,
    userId: userId || null,
    turnId: new ObjectId().toString(),
    ...row,
    createdAt: filtered[index].createdAt || now
  }));
  const insertResult = await messageRows.insertMany(docs);
  await convs.updateOne(
    { conversationId },
    {
      $setOnInsert: {
        conversationId,
        title: title || null,
        createdAt: now
      },
      $set: {
        userId: userId || null,
        updatedAt: now,
        lastMessageAt: now
      }
    },
    { upsert: true }
  );
  const insertedIds = Object.values(insertResult.insertedIds).map((id) => String(id));
  return { insertedCount: insertedIds.length, insertedIds };
}

export async function upsertConversationSessionMeta(db, cfg, {
  conversationId,
  userId,
  title,
  sessionLabel,
  sessionDescription
}) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) return;
  const now = new Date().toISOString();
  const set = { updatedAt: now };
  if (userId !== undefined) set.userId = userId ? String(userId) : null;
  if (title !== undefined) set.title = title == null ? null : String(title);
  if (sessionLabel !== undefined) set.sessionLabel = sessionLabel == null ? null : String(sessionLabel);
  if (sessionDescription !== undefined) set.sessionDescription = sessionDescription == null ? null : String(sessionDescription);
  await db.collection(cfg.conversationsCollection).updateOne(
    { conversationId: normalizedConversationId },
    {
      $set: set,
      $setOnInsert: {
        conversationId: normalizedConversationId,
        createdAt: now
      }
    },
    { upsert: true }
  );
}

export async function getSummaryState(db, cfg, conversationId) {
  return db.collection(cfg.summariesCollection).findOne({ conversationId });
}

export async function getUnsummarizedMessages(db, cfg, conversationId, coveredUntilMessageId, limit) {
  const filter = { conversationId };
  const asObjectId = toObjectId(coveredUntilMessageId);
  if (asObjectId) filter._id = { $gt: asObjectId };
  const rows = await db.collection(cfg.messagesCollection)
    .find(filter)
    .sort({ _id: 1 })
    .limit(Math.max(1, limit))
    .toArray();
  return rows;
}

export async function saveConversationSummary(db, cfg, conversationId, summaryText, coveredUntilMessageId) {
  const now = new Date().toISOString();
  await db.collection(cfg.summariesCollection).updateOne(
    { conversationId },
    {
      $set: {
        conversationId,
        summaryText,
        coveredUntilMessageId,
        updatedAt: now
      },
      $setOnInsert: {
        createdAt: now
      }
    },
    { upsert: true }
  );
}

export async function createMemoryJob(db, cfg, doc) {
  const now = new Date().toISOString();
  const row = {
    ...doc,
    status: 'queued',
    processedConversations: 0,
    processedMessages: 0,
    error: null,
    createdAt: now,
    updatedAt: now
  };
  const result = await db.collection(cfg.jobsCollection).insertOne(row);
  return String(result.insertedId);
}

export async function updateMemoryJob(db, cfg, jobId, setFields) {
  const _id = toObjectId(jobId);
  if (!_id) return;
  await db.collection(cfg.jobsCollection).updateOne(
    { _id },
    {
      $set: {
        ...setFields,
        updatedAt: new Date().toISOString()
      }
    }
  );
}

export async function listConversationIds(db, cfg, conversationId) {
  if (conversationId) return [conversationId];
  const rows = await db.collection(cfg.conversationsCollection)
    .find({}, { projection: { conversationId: 1 } })
    .toArray();
  return rows.map((row) => row.conversationId).filter(Boolean);
}

export async function getLatestConversation(db, cfg, userId) {
  const filter = userId ? { userId } : {};
  return db.collection(cfg.conversationsCollection)
    .find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(1)
    .next();
}

export async function listConversationSessions(db, cfg, { userId, limit = 25 } = {}) {
  const normalizedUserId = userId ? String(userId).trim() : '';
  const filter = normalizedUserId ? { userId: normalizedUserId } : {};
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const conversations = await db.collection(cfg.conversationsCollection)
    .find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(safeLimit)
    .toArray();
  const conversationIds = conversations
    .map((row) => (row?.conversationId ? String(row.conversationId) : ''))
    .filter(Boolean);
  const latestByConversationId = new Map();
  if (conversationIds.length) {
    const latestRows = await db.collection(cfg.messagesCollection).aggregate([
      {
        $match: {
          conversationId: { $in: conversationIds },
          role: { $in: ['user', 'assistant'] }
        }
      },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$conversationId',
          role: { $first: '$role' },
          content: { $first: '$content' },
          createdAt: { $first: '$createdAt' }
        }
      }
    ]).toArray();
    for (const row of latestRows) {
      latestByConversationId.set(String(row._id), {
        role: row.role,
        content: row.content == null ? '' : String(row.content),
        createdAt: row.createdAt || null
      });
    }
  }
  return conversations.map((row) => {
    const conversationId = row?.conversationId ? String(row.conversationId) : null;
    const latestMessage = conversationId ? latestByConversationId.get(conversationId) : null;
    return {
      conversationId,
      userId: row?.userId ? String(row.userId) : null,
      title: row?.title ? String(row.title) : null,
      sessionLabel: row?.sessionLabel ? String(row.sessionLabel) : null,
      sessionDescription: row?.sessionDescription ? String(row.sessionDescription) : null,
      updatedAt: row?.updatedAt || null,
      lastMessageAt: row?.lastMessageAt || null,
      latestMessage: latestMessage || null
    };
  });
}

export async function getConversationMessages(db, cfg, conversationId, limit = 200) {
  const rows = await db.collection(cfg.messagesCollection)
    .find({ conversationId })
    .sort({ _id: -1 })
    .limit(Math.max(1, Math.min(500, Number(limit) || 200)))
    .toArray();
  rows.reverse();
  return rows.map((row) => ({
    role: row.role,
    content: row.content == null ? '' : String(row.content)
  }));
}

export async function getConversationMessagesDetailed(db, cfg, conversationId, limit = 200) {
  const rows = await db.collection(cfg.messagesCollection)
    .find({ conversationId })
    .sort({ _id: -1 })
    .limit(Math.max(1, Math.min(500, Number(limit) || 200)))
    .toArray();
  rows.reverse();
  return rows
    .filter((row) => row && (row.role === 'user' || row.role === 'assistant'))
    .map((row) => ({
      role: row.role,
      content: row.content == null ? '' : String(row.content),
      createdAt: row.createdAt || null
    }));
}

export async function getUserProfile(db, cfg, userId) {
  const normalizedUserId = userId ? String(userId).trim() : '';
  if (!normalizedUserId) return null;
  const doc = await db.collection(cfg.userProfilesCollection).findOne({ userId: normalizedUserId });
  return sanitizeProfileDoc(doc);
}

export async function upsertUserProfile(db, cfg, { userId, patch, source = 'user_input' }) {
  const normalizedUserId = userId ? String(userId).trim() : '';
  if (!normalizedUserId) {
    throw new Error('userId is required');
  }
  const profiles = db.collection(cfg.userProfilesCollection);
  const current = await profiles.findOne({ userId: normalizedUserId });
  const merged = mergeUserProfilePatch({ ...(current || {}), userId: normalizedUserId }, patch, source);
  const { createdAt, ...setFields } = merged;
  await profiles.updateOne(
    { userId: normalizedUserId },
    {
      $set: setFields,
      $setOnInsert: { createdAt }
    },
    { upsert: true }
  );
  const saved = await profiles.findOne({ userId: normalizedUserId });
  return sanitizeProfileDoc(saved);
}
