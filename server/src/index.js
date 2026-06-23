import '../../scripts/load-env.js';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { File } from 'node:buffer';
import { MongoClient, ObjectId } from 'mongodb';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { pathToFileURL } from 'url';
import {
  appendConversationMessages,
  createMemoryJob,
  getConversationMessagesDetailed,
  ensureMemoryCollections,
  getConversationMessages,
  getLatestConversation,
  getUserProfile,
  listConversationSessions,
  listConversationIds,
  loadConversationMemory,
  upsertConversationSessionMeta,
  upsertUserProfile,
  updateMemoryJob
} from './memory/store.js';
import {
  buildShortTermContext,
  buildUserProfileContext,
  extractLatestUserTurn
} from './memory/context.js';
import {
  maybeRefreshConversationSummary,
  rebuildConversationSummary
} from './memory/summarize.js';
import {
  buildAccountCreateGuardResult,
  buildContactCreateGuardResult,
  buildWorkloadCreateGuardResult,
  mapAccountCandidateRows,
  mapContactCandidateRows,
  mapWorkloadCandidateRows
} from './workload-guards.js';
import {
  DEFAULT_WORKLOAD_STAGE,
  formatWorkloadStageChoices,
  parseWorkloadStage
} from './workload-stage.js';
import {
  mergeDocumentLinks,
  normalizeDocumentLinksInput
} from './document-links.js';
import { createLegacyAgentRunner } from './agent/orchestrator.js';
import { createLangGraphAgentRunner } from './agent/graph/index.js';
import { embedSingleText } from './voyage-embed.js';
import {
  assertDocumentAccessible,
  buildOwnerVisibilityFilter,
  getVisibleOwnerUserIds,
  mergeCrmFilter,
  resolveCrmActor,
  stampOwnerUserId
} from './crm-access.js';
import { buildLlmConfig, createCallModel } from './llm/index.js';
import { handleMcpHttpRequest } from './mcp/http-handler.js';
import { mintXaiRealtimeClientSecret, resolveMcpPublicUrl } from './mcp/session-config.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  PORT = '8787',
  NODE_API_KEY = '',
  AZURE_API_KEY = '',
  AZURE_ENDPOINT = '',
  GAS_WEB_APP_URL = '',
  NODE_TO_GAS_SECRET = '',
  MONGO_URI = '',
  MONGO_DB_NAME = 'sales_data',
  MONGO_TASK_LISTS_COLLECTION = 'taskLists',
  MONGO_TASKS_COLLECTION = 'tasks',
  MONGO_CONTACTS_COLLECTION = 'contacts',
  MONGO_ACCOUNTS_COLLECTION = 'accounts',
  MONGO_WORKLOADS_COLLECTION = 'Workloads',
  MONGO_MILESTONES_COLLECTION = 'milestones',
  MONGO_INITIATIVES_COLLECTION = 'initiatives',
  MONGO_INITIATIVES_VECTOR_INDEX = 'initiatives_vector',
  MONGO_VOYAGE_EMBED_DIMENSIONS = '',
  MONGO_ATLAS_SEARCH_INDEX = 'default',
  MONGO_USE_ATLAS_SEARCH = 'true',
  MONGO_CONVERSATIONS_COLLECTION = 'conversations',
  MONGO_MESSAGES_COLLECTION = 'messages',
  MONGO_MEMORY_SUMMARIES_COLLECTION = 'memory_summaries',
  MONGO_MEMORY_JOBS_COLLECTION = 'memory_jobs',
  MONGO_USER_PROFILES_COLLECTION = 'user_profiles',
  MEMORY_RECENT_MESSAGES = '12',
  MEMORY_SUMMARY_THRESHOLD_MESSAGES = '10',
  MEMORY_SUMMARY_BATCH_SIZE = '50',
  MEMORY_SUMMARY_RETRIES = '2',
  AZURE_OPENAI_ENDPOINT = '',
  AZURE_OPENAI_DEPLOYMENT = '',
  AZURE_OPENAI_API_VERSION = '2024-02-01',
  LLM_PROVIDER = 'azure',
  XAI_API_KEY = '',
  XAI_MODEL = 'grok-4.3',
  XAI_REASONING_EFFORT = 'low',
  CORS_ALLOWED_ORIGINS = '',
  REQUIRE_NODE_API_KEY = '',
  ELEVENLABS_API_KEY = '',
  ELEVENLABS_VOICE_ID = '',
  ELEVENLABS_STT_MODEL_ID = '',
  ELEVENLABS_TTS_MODEL_ID = '',
  AGENT_ORCHESTRATOR_MODE = 'legacy',
  AGENT_WORKFLOW_MODE = '',
  AGENT_CHAT_MODE = '',
  AGENT_ENABLE_CHAT_LANGGRAPH = 'false',
  AGENT_INCLUDE_TRACE_IN_RESPONSE = 'false',
  AGENT_TRACE_LOGS = 'false',
  GOOGLE_CLIENT_ID = '',
  JWT_SIGNING_SECRET = '',
  JWT_ISSUER = 'mcp-node-api',
  JWT_AUDIENCE = 'mongiecrm-app',
  JWT_EXPIRY_SECONDS = '3600',
  MONGO_AUTH_USERS_COLLECTION = 'auth_users'
} = process.env;

function parseAllowedOrigins(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '*') return '*';
  const out = raw
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return out.length ? out : '*';
}

const allowedCorsOrigins = parseAllowedOrigins(CORS_ALLOWED_ORIGINS);
app.use(
  cors({
    origin(origin, cb) {
      if (allowedCorsOrigins === '*') return cb(null, true);
      if (!origin) return cb(null, true);
      return cb(null, allowedCorsOrigins.includes(origin));
    }
  })
);

const shouldRequireNodeApiKey =
  String(REQUIRE_NODE_API_KEY || '').trim() !== ''
    ? String(REQUIRE_NODE_API_KEY).trim().toLowerCase() !== 'false'
    : String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

if (shouldRequireNodeApiKey && !String(NODE_API_KEY || '').trim()) {
  throw new Error('NODE_API_KEY is required when REQUIRE_NODE_API_KEY is enabled (or in production).');
}

const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
if (isProduction && !String(JWT_SIGNING_SECRET || '').trim()) {
  throw new Error('JWT_SIGNING_SECRET is required for end-user auth token signing in production.');
}

const jwtExpirySeconds = Math.max(300, Number(JWT_EXPIRY_SECONDS || 3600) || 3600);
const googleClientId = String(GOOGLE_CLIENT_ID || '').trim();
const jwtIssuer = String(JWT_ISSUER || 'mcp-node-api').trim() || 'mcp-node-api';
const jwtAudience = String(JWT_AUDIENCE || 'mongiecrm-app').trim() || 'mongiecrm-app';
const jwtSigningSecret = String(JWT_SIGNING_SECRET || '').trim() || 'dev-insecure-jwt-secret-change-me';
const googleAuthClient = googleClientId ? new OAuth2Client(googleClientId) : null;

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const MAIN_SYSTEM_PROMPT =
  "You are a Google Workspace orchestrator. You can create workload decks, manage notes in Drive, and manage MongoDB task lists, accounts, workloads, contacts, milestones, and initiatives. CRM records are visibility-scoped by the authenticated user and optional teammate sharing; never assume records from other owners are accessible. For task lists use Mongo tools only: createTaskList, updateTaskList, addTaskToList, updateTaskInList, listTaskLists, getTaskList, deleteTaskList. Use updateTaskList to change only the list name or list owner; pass owner as an empty string to clear ownership (unowned list). Task-level ownership is separate and should be updated on the task via addTaskToList/updateTaskInList owner. listTaskLists owner matches either the owner field or the list name (case-insensitive), so a person-named list with no owner still resolves. For accounts use Mongo tools only: addAccount, updateAccount, listAccounts, getAccount. For workloads use Mongo tools only: addWorkload, updateWorkload, listWorkloads, getWorkload. For milestones use Mongo tools only: addMilestone, updateMilestone, listMilestones, getMilestone. For initiatives use Mongo tools only: addInitiative, updateInitiative, listInitiatives, getInitiative, searchInitiatives. Initiatives require initiativeName and at least one accountId; contactIds and workloadIds must belong to one of the initiative accounts. Use searchInitiatives for semantic search over initiative names when the user asks conceptually; use listInitiatives with q for fuzzy text. For contacts use Mongo tools only: addContact, updateContact, listContacts, getContact, deleteContact, standardizeContactFields. Contact canonical fields include name, linkedIn, imageUrl, notes, title, email, phone, mobile, department, location, and relationship tracking fields. Never use legacy Google Doc team to-do tools. For deleting task lists, always ask for explicit user confirmation first and only call deleteTaskList when confirm is true. For deleting contacts, always ask for explicit user confirmation first and only call deleteContact when confirm is true. For account creation safety: always call listAccounts first using fuzzy q (not exact name filtering) to check for existing accounts. If there is any exact or close match, ask whether to use the existing account or create a new one. Only call addAccount when the user explicitly confirms creating a new account, and pass confirm=true. For workload creation or assignment safety: always call listWorkloads first using accountId and fuzzy q to check for existing workloads; if user mentions account-prefixed naming (for example, \"Lumen - X\" vs \"X\"), retry with both variants before concluding not found. Only call addWorkload when the user explicitly confirms creating a new workload, and pass confirm=true. Workload stage is separate from description/notes, defaults to Research when omitted on create, and must be one of: Research, Discovery, Scope, Technical Validation, Closed. For contact creation or assignment safety: always call listContacts first using accountId plus fuzzy q/email to check for existing contacts; if no exact hit and user says the contact exists, retry with close spelling variants before concluding not found. Only call addContact when the user explicitly confirms creating a new contact, and pass confirm=true. Accounts, workloads, contacts, and milestones support notes/doc links according to their schema. If a user provides only a bare link without a document name, ask what to call it before saving. For adding tasks, taskListId and task are required; task owner is optional via owner and is independent from list owner; status defaults to open when omitted, dueDate/person are optional, and optional priority must be one of: Priority 1, Priority 2, Priority 3, Priority 4. For updating tasks, taskId can be used without taskListId, while taskText resolution requires taskListId. Keep notes behavior unchanged: ask before appendNotesToDoc unless the user already granted permission, and use getNotesRootFolderId + resolveNotesLocation flows for account/opp/workload notes. If profile memory is missing and onboarding instructions are present, ask brief setup questions first and save profile answers with updateUserProfileMemory.";
const RESPONSE_MODE_CHAT_DEFAULT = 'chat_default';
const RESPONSE_MODE_VOICE_CONVERSATIONAL = 'voice_conversational';
const RESPONSE_MODE_VOICE_WHIMSICAL = 'voice_whimsical';
const VOICE_CONVERSATIONAL_SYSTEM_PROMPT = [
  'The user requested spoken delivery style.',
  'Respond conversationally, not rigidly.',
  'Use short natural sentences and smooth transitions.',
  'Avoid markdown tables, dense bullets, and code blocks unless explicitly asked.',
  'Do not ask follow-up questions.',
  'If input is missing, state only what is needed to proceed in a direct statement (for example: "Need: account name and due date.").',
  'End with a brief recap in one sentence.'
].join(' ');
const VOICE_WHIMSICAL_SYSTEM_PROMPT = [
  'The user requested spoken delivery style with a whimsical, funny tone.',
  'Keep the tone playful and light while still being clear and helpful.',
  'Use short natural sentences and smooth transitions.',
  'Use gentle humor only; avoid sarcasm, rude jokes, or anything that obscures required actions.',
  'Avoid markdown tables, dense bullets, and code blocks unless explicitly asked.',
  'Do not ask follow-up questions.',
  'If input is missing, state only what is needed to proceed in a direct statement (for example: "Need: account name and due date.").',
  'End with a brief recap in one sentence.'
].join(' ');
const VOICE_SPEECH_REWRITE_SYSTEM_PROMPT = [
  'You rewrite assistant text for spoken delivery while preserving meaning.',
  'Return plain text only.',
  'Keep it concise, conversational, and easy to say out loud.',
  'Use short sentences, remove markdown, and keep key facts.',
  'Do not add follow-up questions.',
  'When something is required from the user, state it as a direct requirement sentence instead of a question.'
].join(' ');
const VOICE_WHIMSICAL_SPEECH_REWRITE_SYSTEM_PROMPT = [
  'You rewrite assistant text for spoken delivery while preserving meaning.',
  'Return plain text only.',
  'Keep it concise, whimsical, and lightly funny while remaining clear.',
  'Use short sentences, remove markdown, and keep key facts.',
  'Do not add follow-up questions.',
  'When something is required from the user, state it as a direct requirement sentence instead of a question.'
].join(' ');

let mongoClient = null;
let mongoClientConnectPromise = null;
let googleToolDefsCache = null;
let googleToolDefsCacheTs = 0;
let memoryCollectionsReady = false;
let crmCollectionsReady = false;

const llmConfig = buildLlmConfig(process.env);
const callModel = createCallModel(llmConfig);

const memoryConfig = {
  conversationsCollection: MONGO_CONVERSATIONS_COLLECTION,
  messagesCollection: MONGO_MESSAGES_COLLECTION,
  summariesCollection: MONGO_MEMORY_SUMMARIES_COLLECTION,
  jobsCollection: MONGO_MEMORY_JOBS_COLLECTION,
  userProfilesCollection: MONGO_USER_PROFILES_COLLECTION,
  recentMessages: Math.max(1, Number(MEMORY_RECENT_MESSAGES || 12)),
  summaryThresholdMessages: Math.max(1, Number(MEMORY_SUMMARY_THRESHOLD_MESSAGES || 10)),
  summaryBatchSize: Math.max(1, Number(MEMORY_SUMMARY_BATCH_SIZE || 50)),
  summaryRetries: Math.max(0, Number(MEMORY_SUMMARY_RETRIES || 2)),
  ...llmConfig
};

const PROFILE_ALLOWED_PATCH_KEYS = new Set([
  'displayName',
  'timezone',
  'role',
  'organization',
  'preferences',
  'aliases',
  'constraints',
  'crmShareAllWith'
]);
const PROFILE_ALLOWED_SOURCE_VALUES = new Set(['user_input', 'admin', 'system']);
const REQUIRED_PROFILE_FIELDS = ['displayName'];
const OPTIONAL_PROFILE_FIELDS = ['role', 'organization', 'timezone'];

const CONTACT_STANDARD_FIELD_ALIASES = {
  name: ['Name'],
  preferredName: ['PreferredName'],
  pronouns: ['Pronouns'],
  title: ['Title'],
  department: ['Department'],
  email: ['Email'],
  phone: ['Phone'],
  mobile: ['Mobile'],
  location: ['Location'],
  timeZone: ['TimeZone', 'timezone'],
  linkedIn: ['LinkedIn', 'linkedin', 'linkedInUrl', 'linkedinUrl', 'linkedinURL', 'LinkedInURL'],
  imageUrl: ['ImageURL', 'imageURL', 'profileImageUrl', 'linkedinImageUrl', 'linkedInImageUrl'],
  website: ['Website'],
  relationshipStatus: ['RelationshipStatus'],
  lastContactDate: ['LastContactDate'],
  nextFollowUpDate: ['NextFollowUpDate'],
  owner: ['Owner'],
  tags: ['Tags'],
  source: ['Source'],
  notes: ['Notes'],
  freeText: ['FreeText'],
  workloadIds: ['WorkloadIds', 'workloadId', 'WorkloadId']
};
const CONTACT_LEGACY_FIELD_KEYS = Array.from(
  new Set(
    Object.entries(CONTACT_STANDARD_FIELD_ALIASES)
      .flatMap(([canonical, aliases]) => aliases.filter((alias) => alias !== canonical))
  )
);

function sanitizeProfileString(value, maxLen = 160) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, Math.max(1, maxLen));
}

function sanitizeProfileObject(value, maxKeys = 20, maxValLen = 200) {
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  const keys = Object.keys(value).slice(0, Math.max(1, maxKeys));
  for (const key of keys) {
    const nextKey = sanitizeProfileString(key, 80);
    const nextValue = sanitizeProfileString(value[key], maxValLen);
    if (nextKey && nextValue) out[nextKey] = nextValue;
  }
  return out;
}

function sanitizeProfileConstraints(value, maxItems = 20, maxItemLen = 180) {
  if (value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    const clean = sanitizeProfileString(item, maxItemLen);
    if (clean) out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeProfileUserIdList(value, maxItems = 200, maxItemLen = 200) {
  if (value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const clean = sanitizeProfileString(item, maxItemLen);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeUserProfilePatch(rawPatch) {
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    return { patch: null, invalidKeys: [] };
  }
  const patch = {};
  const invalidKeys = [];
  for (const key of Object.keys(rawPatch)) {
    if (!PROFILE_ALLOWED_PATCH_KEYS.has(key)) {
      invalidKeys.push(key);
      continue;
    }
    if (key === 'displayName' || key === 'timezone' || key === 'role' || key === 'organization') {
      const next = sanitizeProfileString(rawPatch[key], 160);
      if (next !== undefined) patch[key] = next;
      continue;
    }
    if (key === 'preferences' || key === 'aliases') {
      const next = sanitizeProfileObject(rawPatch[key], 20, 200);
      if (next !== undefined) patch[key] = next;
      continue;
    }
    if (key === 'constraints') {
      const next = sanitizeProfileConstraints(rawPatch[key], 20, 180);
      if (next !== undefined) patch[key] = next;
      continue;
    }
    if (key === 'crmShareAllWith') {
      const next = sanitizeProfileUserIdList(rawPatch[key], 200, 200);
      if (next !== undefined) patch[key] = next;
    }
  }
  return { patch, invalidKeys };
}

function getMissingUserProfileFields(userProfile, fields) {
  const profile = userProfile && typeof userProfile === 'object' ? userProfile : {};
  return fields.filter((field) => {
    const value = profile[field];
    if (value == null) return true;
    if (typeof value !== 'string') return false;
    return !String(value).trim();
  });
}

function buildProfileGateReply(missingRequired, missingOptional) {
  if (!Array.isArray(missingRequired) || !missingRequired.length) return null;
  const requiredText = missingRequired
    .map((field) => (field === 'displayName' ? 'preferred display name' : field))
    .join(', ');
  const optionalText = Array.isArray(missingOptional) && missingOptional.length
    ? ` Optional fields you can add now or later: ${missingOptional.join(', ')}.`
    : '';
  return `Before we continue, please share: ${requiredText}.${optionalText}`;
}

function jsonOk(res, data, status = 200) {
  return res.status(status).json({ ok: true, ...data });
}

function jsonErr(res, error, status = 400, details) {
  const body = { ok: false, error: String(error || 'Unknown error') };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

function extractBearerToken(req) {
  const auth = req?.headers?.authorization || '';
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice(7).trim();
}

function hasValidNodeApiKey(req) {
  const apiKey = String(NODE_API_KEY || '').trim();
  if (!apiKey) return false;
  const token = extractBearerToken(req);
  if (token && token === apiKey) return true;
  const bodyKey = (req.body && req.body.apiKey) ? String(req.body.apiKey).trim() : '';
  if (bodyKey && bodyKey === apiKey) return true;
  return false;
}

function signAppUserToken(user) {
  const userId = String(user?.userId || '').trim();
  if (!userId) throw new Error('userId is required for token signing');
  return jwt.sign(
    {
      sub: userId,
      typ: 'end_user',
      email: user?.email ? String(user.email).trim() : undefined,
      name: user?.name ? String(user.name).trim() : undefined,
      picture: user?.picture ? String(user.picture).trim() : undefined,
      googleSub: user?.googleSub ? String(user.googleSub).trim() : undefined
    },
    jwtSigningSecret,
    {
      algorithm: 'HS256',
      expiresIn: jwtExpirySeconds,
      issuer: jwtIssuer,
      audience: jwtAudience
    }
  );
}

function verifyAppUserToken(token) {
  const payload = jwt.verify(String(token || '').trim(), jwtSigningSecret, {
    algorithms: ['HS256'],
    issuer: jwtIssuer,
    audience: jwtAudience
  });
  const userId = String(payload?.sub || '').trim();
  if (!userId) throw new Error('Token missing user subject');
  return {
    userId,
    email: payload?.email ? String(payload.email).trim() : null,
    name: payload?.name ? String(payload.name).trim() : null,
    picture: payload?.picture ? String(payload.picture).trim() : null,
    googleSub: payload?.googleSub ? String(payload.googleSub).trim() : null
  };
}

function resolveEffectiveUserId(req, explicitUserId = null) {
  const claimed = explicitUserId == null ? '' : String(explicitUserId).trim();
  if (req?.auth?.type === 'user' && req?.auth?.userId) return String(req.auth.userId).trim();
  if (req?.auth?.type === 'machine') return claimed || null;
  return null;
}

function resolveAuditActorId(toolContext = {}) {
  const initiatedBy = toolContext?.initiatedByUserId ? String(toolContext.initiatedByUserId).trim() : '';
  if (initiatedBy) return initiatedBy;
  const userId = toolContext?.userId ? String(toolContext.userId).trim() : '';
  if (userId) return userId;
  return 'system';
}

async function resolveCrmVisibilityForRequest(req, db) {
  const userId = resolveEffectiveUserId(req, req?.query?.userId ?? req?.body?.userId);
  if (!userId) return { error: 'userId is required', status: 400 };
  const visibleOwnerUserIds = await getVisibleOwnerUserIds(db, {
    userId,
    userProfilesCollection: memoryConfig.userProfilesCollection
  });
  if (!visibleOwnerUserIds.length) return { error: 'userId is required', status: 400 };
  return { userId, visibleOwnerUserIds };
}

function withOwnerVisibilityFilter(baseFilter, visibleOwnerUserIds) {
  return mergeCrmFilter(baseFilter, buildOwnerVisibilityFilter(visibleOwnerUserIds));
}

function withAuditFieldsForInsert(doc, actorId) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const next = stampOwnerUserId(doc, actorId);
  if (!next.createdBy) next.createdBy = actorId;
  if (!next.updatedBy) next.updatedBy = actorId;
  return next;
}

function withAuditFieldsForUpdate(updateDoc, actorId) {
  if (!updateDoc || typeof updateDoc !== 'object') return updateDoc;
  if (Array.isArray(updateDoc)) {
    return [
      ...updateDoc,
      { $set: { updatedBy: actorId } }
    ];
  }
  const keys = Object.keys(updateDoc);
  if (!keys.length) return updateDoc;
  const usesOperators = keys.some((key) => key.startsWith('$'));
  if (!usesOperators) {
    return { ...updateDoc, updatedBy: actorId };
  }
  const next = { ...updateDoc };
  const existingSet = (next.$set && typeof next.$set === 'object' && !Array.isArray(next.$set)) ? next.$set : {};
  next.$set = { ...existingSet, updatedBy: actorId };
  return next;
}

function withAuditedCollection(collection, actorId) {
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (prop === 'insertOne') {
        return (doc, ...rest) => target.insertOne(withAuditFieldsForInsert(doc, actorId), ...rest);
      }
      if (prop === 'insertMany') {
        return (docs, ...rest) => {
          const list = Array.isArray(docs) ? docs.map((doc) => withAuditFieldsForInsert(doc, actorId)) : docs;
          return target.insertMany(list, ...rest);
        };
      }
      if (prop === 'updateOne') {
        return (filter, updateDoc, ...rest) => target.updateOne(filter, withAuditFieldsForUpdate(updateDoc, actorId), ...rest);
      }
      if (prop === 'updateMany') {
        return (filter, updateDoc, ...rest) => target.updateMany(filter, withAuditFieldsForUpdate(updateDoc, actorId), ...rest);
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    }
  });
}

function withVisibleCollection(collection, visibleOwnerUserIds) {
  const visibilityFilter = buildOwnerVisibilityFilter(visibleOwnerUserIds);
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (prop === 'find') {
        return (filter = {}, ...rest) => target.find(withOwnerVisibilityFilter(filter, visibleOwnerUserIds), ...rest);
      }
      if (prop === 'findOne') {
        return (filter = {}, ...rest) => target.findOne(withOwnerVisibilityFilter(filter, visibleOwnerUserIds), ...rest);
      }
      if (prop === 'updateOne') {
        return (filter = {}, updateDoc, ...rest) => target.updateOne(withOwnerVisibilityFilter(filter, visibleOwnerUserIds), updateDoc, ...rest);
      }
      if (prop === 'updateMany') {
        return (filter = {}, updateDoc, ...rest) => target.updateMany(withOwnerVisibilityFilter(filter, visibleOwnerUserIds), updateDoc, ...rest);
      }
      if (prop === 'deleteOne') {
        return (filter = {}, ...rest) => target.deleteOne(withOwnerVisibilityFilter(filter, visibleOwnerUserIds), ...rest);
      }
      if (prop === 'deleteMany') {
        return (filter = {}, ...rest) => target.deleteMany(withOwnerVisibilityFilter(filter, visibleOwnerUserIds), ...rest);
      }
      if (prop === 'countDocuments') {
        return (filter = {}, ...rest) => target.countDocuments(withOwnerVisibilityFilter(filter, visibleOwnerUserIds), ...rest);
      }
      if (prop === 'aggregate') {
        return (pipeline = [], ...rest) => {
          const steps = Array.isArray(pipeline) ? [...pipeline] : [];
          const firstStage = steps[0] || {};
          const startsWithSearch = !!(firstStage.$search || firstStage.$vectorSearch);
          if (startsWithSearch) {
            steps.splice(1, 0, { $match: visibilityFilter });
          } else {
            steps.unshift({ $match: visibilityFilter });
          }
          return target.aggregate(steps, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    }
  });
}

function requireApiAuth(req, res, next) {
  const bearerToken = extractBearerToken(req);
  if (hasValidNodeApiKey(req)) {
    req.auth = { type: 'machine' };
    return next();
  }
  if (!bearerToken) {
    return jsonErr(res, 'Unauthorized', 401);
  }
  try {
    const user = verifyAppUserToken(bearerToken);
    req.auth = { type: 'user', ...user };
    return next();
  } catch (err) {
    return jsonErr(res, 'Unauthorized', 401, { message: err?.message || String(err) });
  }
}

function requireEndUserAuth(req, res, next) {
  return requireApiAuth(req, res, () => {
    if (req?.auth?.type !== 'user' || !req?.auth?.userId) {
      return jsonErr(res, 'End-user authentication required', 401);
    }
    return next();
  });
}

function requireNodeApiKey(req, res, next) {
  if (!shouldRequireNodeApiKey) return next();
  if (hasValidNodeApiKey(req)) {
    req.auth = { type: 'machine' };
    return next();
  }
  return jsonErr(res, 'Unauthorized', 401);
}

async function getMongoDb() {
  if (!MONGO_URI) throw new Error('MONGO_URI is required');
  if (!mongoClient) {
    if (!mongoClientConnectPromise) {
      const candidateClient = new MongoClient(MONGO_URI);
      mongoClientConnectPromise = candidateClient.connect()
        .then(() => {
          mongoClient = candidateClient;
          return mongoClient;
        })
        .catch(async (err) => {
          try {
            await candidateClient.close();
          } catch (_closeErr) {
            // Ignore close failures from a partially initialized client.
          }
          throw err;
        })
        .finally(() => {
          mongoClientConnectPromise = null;
        });
    }
    await mongoClientConnectPromise;
  }
  return mongoClient.db(MONGO_DB_NAME);
}

async function closeMongoClientConnection() {
  if (!mongoClient) return;
  const client = mongoClient;
  mongoClient = null;
  mongoClientConnectPromise = null;
  try {
    await client.close();
  } catch (_err) {
    // Ignore close errors during shutdown/cleanup.
  }
}

function buildInternalUserIdFromGoogleSub(googleSub) {
  return `google_${String(googleSub || '').trim()}`;
}

async function upsertGoogleAuthUser(googleClaims) {
  const sub = String(googleClaims?.sub || '').trim();
  if (!sub) throw new Error('Google token is missing subject');
  const nowIso = new Date().toISOString();
  const userId = buildInternalUserIdFromGoogleSub(sub);
  const users = (await getMongoDb()).collection(MONGO_AUTH_USERS_COLLECTION);
  const email = googleClaims?.email ? String(googleClaims.email).trim().toLowerCase() : null;
  const name = googleClaims?.name ? String(googleClaims.name).trim() : null;
  const picture = googleClaims?.picture ? String(googleClaims.picture).trim() : null;
  await users.updateOne(
    { googleSub: sub },
    {
      $set: {
        userId,
        googleSub: sub,
        email,
        name,
        picture,
        emailVerified: googleClaims?.email_verified === true,
        updatedAt: nowIso
      },
      $setOnInsert: {
        createdAt: nowIso
      }
    },
    { upsert: true }
  );
  return {
    userId,
    googleSub: sub,
    email,
    name,
    picture
  };
}

function isTransactionUnsupportedError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('transaction numbers are only allowed on a replica set member or mongos')
    || msg.includes('transactions are not supported')
    || msg.includes('operation is not supported in transactions')
    || msg.includes('this mongodb deployment does not support retryable writes')
  );
}

async function runWithOptionalTransaction(work) {
  if (!mongoClient || typeof mongoClient.startSession !== 'function') {
    return work({ session: null, inTransaction: false });
  }
  const session = mongoClient.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await work({ session, inTransaction: true });
    });
    return out;
  } catch (err) {
    if (!isTransactionUnsupportedError(err)) throw err;
    console.warn('[mongo] transaction unavailable, running without transaction:', err?.message || String(err));
    return work({ session: null, inTransaction: false });
  } finally {
    try {
      await session.endSession();
    } catch (_err) {
      // Ignore endSession failures.
    }
  }
}

async function ensureMemorySetup() {
  if (memoryCollectionsReady) return;
  const db = await getMongoDb();
  await ensureMemoryCollections(db, memoryConfig);
  memoryCollectionsReady = true;
}

function isAtlasSearchEnabled() {
  return String(MONGO_USE_ATLAS_SEARCH || 'true').trim().toLowerCase() !== 'false';
}

function normalizeSearchText(value, maxLen = 200) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  return text.slice(0, Math.max(1, maxLen));
}

function parseLooseCurrencyValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const normalized = text
    .replace(/[$,\s]/g, '')
    .replace(/usd/ig, '')
    .toLowerCase();
  const suffixMatch = normalized.match(/^(-?\d+(?:\.\d+)?)([km])$/i);
  if (suffixMatch) {
    const base = Number(suffixMatch[1]);
    if (!Number.isFinite(base)) return null;
    const mult = suffixMatch[2].toLowerCase() === 'm' ? 1000000 : 1000;
    return base * mult;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeWorkloadArr(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = parseLooseCurrencyValue(value);
  if (parsed == null || parsed < 0) return null;
  return Math.round(parsed);
}

function normalizeWorkloadUrl(value, maxLen = 2000) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().slice(0, Math.max(1, maxLen));
  } catch (_err) {
    return null;
  }
}

const MILESTONE_STATUS_VALUES = ['On Target', 'Delayed', 'Completed'];
const DEFAULT_MILESTONE_STATUS = 'On Target';

function normalizeMilestoneDate(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const monthOnly = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (monthOnly) {
    const year = Number(monthOnly[1]);
    const month = Number(monthOnly[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
    const lastDay = new Date(Date.UTC(year, month, 0));
    return `${lastDay.getUTCFullYear()}-${String(lastDay.getUTCMonth() + 1).padStart(2, '0')}-${String(lastDay.getUTCDate()).padStart(2, '0')}`;
  }
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      return null;
    }
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  }
  const monthDayOnly = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (monthDayOnly) {
    const month = Number(monthDayOnly[1]);
    const day = Number(monthDayOnly[2]);
    const candidate = new Date(Date.UTC(currentYear, month - 1, day));
    if (
      !Number.isInteger(month)
      || !Number.isInteger(day)
      || month < 1
      || month > 12
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      return null;
    }
    return `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const hasExplicitYear = /\b\d{4}\b/.test(text);
  const targetYear = hasExplicitYear ? parsed.getUTCFullYear() : currentYear;
  return `${targetYear}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
}

function normalizeMilestoneDateBoundary(value, boundary = 'exact') {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const monthOnly = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (monthOnly) {
    const year = Number(monthOnly[1]);
    const month = Number(monthOnly[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
    const day = boundary === 'from' ? 1 : new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return normalizeMilestoneDate(text);
}

function normalizeMilestoneStatus(value, { defaultWhenMissing = true } = {}) {
  if (value === undefined || value === null) return defaultWhenMissing ? DEFAULT_MILESTONE_STATUS : undefined;
  const text = String(value).trim();
  if (!text) return defaultWhenMissing ? DEFAULT_MILESTONE_STATUS : undefined;
  const hit = MILESTONE_STATUS_VALUES.find((status) => status.toLowerCase() === text.toLowerCase());
  return hit || null;
}

function buildMilestoneNote(rawNote, nowIso) {
  return buildContactNote(rawNote, nowIso);
}

function normalizeMilestoneNotesArray(rawNotes, nowIso = new Date().toISOString()) {
  if (rawNotes == null) return { notes: [] };
  const source = Array.isArray(rawNotes) ? rawNotes : [rawNotes];
  const notes = [];
  const seenIds = new Set();
  for (const entry of source) {
    const built = buildMilestoneNote(entry, nowIso);
    if (built.error) return { error: built.error };
    let note = built.note;
    while (seenIds.has(note.id)) {
      note = { ...note, id: new ObjectId().toString() };
    }
    seenIds.add(note.id);
    notes.push(note);
  }
  return { notes };
}

function normalizeStoredMilestoneNotes(rawNotes, fallbackAuthor = 'Imported') {
  return normalizeStoredContactNotes(rawNotes, fallbackAuthor);
}

function sumWorkloadArrFromRefs(workloadRefs) {
  const refs = Array.isArray(workloadRefs) ? workloadRefs : [];
  let total = 0;
  let hasAny = false;
  for (const ref of refs) {
    const arr = normalizeWorkloadArr(ref?.arr);
    if (typeof arr !== 'number') continue;
    hasAny = true;
    total += arr;
  }
  return hasAny ? total : null;
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter for "whose list is this?" — matches either `owner` or list `name` (case-insensitive),
 * so lists titled with a person name but `owner: null` still resolve.
 */
function buildTaskListOwnerOrNameFilter(ownerArg) {
  const trimmed = String(ownerArg || '').trim();
  if (!trimmed) return {};
  const escaped = escapeRegExp(trimmed);
  const rx = { $regex: `^${escaped}$`, $options: 'i' };
  return { $or: [{ owner: rx }, { name: rx }] };
}

const TASK_ALLOWED_STATUSES = new Set(['open', 'in_progress', 'blocked', 'done']);
const TASK_ALLOWED_PRIORITIES = new Set(['Priority 1', 'Priority 2', 'Priority 3', 'Priority 4']);

function normalizeTaskPerson(personInput, existingPerson = null) {
  if (!personInput || typeof personInput !== 'object' || Array.isArray(personInput)) return existingPerson || null;
  const next = {
    ...(existingPerson && typeof existingPerson === 'object' ? existingPerson : {})
  };
  if (personInput.name !== undefined) {
    const name = String(personInput.name || '').trim();
    if (name) next.name = name;
    else delete next.name;
  }
  if (personInput.title !== undefined) {
    const title = String(personInput.title || '').trim();
    if (title) next.title = title;
    else delete next.title;
  }
  if (personInput.role !== undefined) {
    const role = String(personInput.role || '').trim();
    if (role) next.role = role;
    else delete next.role;
  }
  return Object.keys(next).length ? next : null;
}

function buildTaskLookupFilter(taskIdValue) {
  const taskId = String(taskIdValue || '').trim();
  if (!taskId) return null;
  const objectId = toObjectId(taskId);
  if (!objectId) return { taskId };
  return {
    $or: [
      { _id: objectId },
      { taskId }
    ]
  };
}

function normalizeTaskForRead(rawTask) {
  if (!rawTask || typeof rawTask !== 'object') return rawTask;
  const out = normalizeDocumentForRead(rawTask);
  const normalizedTaskId = out.taskId ? String(out.taskId) : (out._id ? String(out._id) : null);
  const status = out.status ? String(out.status) : 'open';
  const owner = out.owner != null && String(out.owner).trim()
    ? String(out.owner).trim()
    : (out.person?.name ? String(out.person.name).trim() : null);
  return {
    ...out,
    taskId: normalizedTaskId,
    task: out.task != null ? String(out.task) : '',
    status: TASK_ALLOWED_STATUSES.has(status) ? status : 'open',
    owner,
    priority: out.priority ? String(out.priority) : null,
    dueDate: toIsoOrNull(out.dueDate),
    person: out.person && typeof out.person === 'object' && !Array.isArray(out.person) ? out.person : null,
    accountId: out.accountId ? String(out.accountId) : null,
    workloadId: out.workloadId ? String(out.workloadId) : null,
    taskListId: out.taskListId ? String(out.taskListId) : null,
    taskListName: out.taskListName ? String(out.taskListName) : null,
    createdAt: toIsoOrNull(out.createdAt),
    updatedAt: toIsoOrNull(out.updatedAt)
  };
}

async function loadTasksForTaskLists(tasksCollection, taskListIds) {
  const ids = Array.isArray(taskListIds) ? taskListIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
  if (!ids.length) return new Map();
  const rows = await tasksCollection
    .find({ taskListId: { $in: ids } })
    .sort({ updatedAt: -1 })
    .toArray();
  const byList = new Map(ids.map((id) => [id, []]));
  for (const row of rows) {
    const listId = String(row?.taskListId || '').trim();
    if (!listId) continue;
    if (!byList.has(listId)) byList.set(listId, []);
    byList.get(listId).push(normalizeTaskForRead(row));
  }
  return byList;
}

function attachTasksToTaskList(taskListDoc, taskRows = []) {
  const list = normalizeDocumentForRead(taskListDoc);
  const tasks = Array.isArray(taskRows) ? taskRows : [];
  return {
    ...list,
    tasks
  };
}

function tokenizeSearchText(value, maxTokens = 8) {
  const normalized = normalizeSearchText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return [];
  const parts = normalized.split(/\s+/).filter(Boolean);
  return parts.slice(0, Math.max(1, maxTokens));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function buildMongoRegexQuery(baseFilter, paths, query) {
  const escaped = escapeRegExp(query);
  const normalizedPaths = (Array.isArray(paths) ? paths : []).filter(Boolean);
  const fullPhraseFilter = { $or: normalizedPaths.map((path) => ({ [path]: { $regex: escaped, $options: 'i' } })) };
  const tokens = tokenizeSearchText(query);
  const tokenAndFilter = tokens.length > 1
    ? {
      $and: tokens.map((token) => ({
        $or: normalizedPaths.map((path) => ({ [path]: { $regex: escapeRegExp(token), $options: 'i' } }))
      }))
    }
    : null;

  const textFilter = tokenAndFilter
    ? { $or: [fullPhraseFilter, tokenAndFilter] }
    : fullPhraseFilter;
  if (!baseFilter || !Object.keys(baseFilter).length) return textFilter;
  return { $and: [baseFilter, textFilter] };
}

async function searchCollectionHybrid({
  collection,
  query,
  paths,
  filter = {},
  limit = 25
}) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedLimit = Math.max(1, Math.min(500, Number(limit || 25)));
  const baseFilter = filter && typeof filter === 'object' ? filter : {};
  if (!normalizedQuery) {
    return collection.find(baseFilter).sort({ updatedAt: -1 }).limit(normalizedLimit).toArray();
  }

  if (isAtlasSearchEnabled()) {
    try {
      const pipeline = [
        {
          $search: {
            index: String(MONGO_ATLAS_SEARCH_INDEX || 'default'),
            text: {
              query: normalizedQuery,
              path: paths,
              fuzzy: { maxEdits: 2, prefixLength: 1, maxExpansions: 64 }
            }
          }
        },
        { $addFields: { _searchScore: { $meta: 'searchScore' } } },
        ...(Object.keys(baseFilter).length ? [{ $match: baseFilter }] : []),
        { $sort: { _searchScore: -1, updatedAt: -1 } },
        { $limit: normalizedLimit }
      ];
      const atlasRows = await collection.aggregate(pipeline).toArray();
      if (atlasRows.length >= normalizedLimit) return atlasRows;

      // Backfill with regex hits so create guards still catch likely duplicates
      // when Atlas fuzzy misses punctuation/order variants.
      const regexFilter = buildMongoRegexQuery(baseFilter, paths, normalizedQuery);
      const regexRows = await collection.find(regexFilter).sort({ updatedAt: -1 }).limit(normalizedLimit).toArray();
      if (!atlasRows.length) return regexRows;

      const merged = [];
      const seenIds = new Set();
      const pushUnique = (row) => {
        const id = String(row?._id || '');
        if (!id || seenIds.has(id)) return;
        seenIds.add(id);
        merged.push(row);
      };
      atlasRows.forEach(pushUnique);
      regexRows.forEach(pushUnique);
      return merged.slice(0, normalizedLimit);
    } catch (err) {
      console.warn(`Atlas Search fallback for ${collection.collectionName}: ${err?.message || err}`);
    }
  }

  const regexFilter = buildMongoRegexQuery(baseFilter, paths, normalizedQuery);
  return collection.find(regexFilter).sort({ updatedAt: -1 }).limit(normalizedLimit).toArray();
}

async function ensureSearchIndex(collection, definition) {
  const indexName = String(MONGO_ATLAS_SEARCH_INDEX || 'default').trim() || 'default';
  try {
    const existing = await collection.listSearchIndexes(indexName).toArray();
    if (!existing.length) {
      await collection.createSearchIndex({ name: indexName, definition });
      return;
    }
    const currentDefinition = existing[0]?.latestDefinition || existing[0]?.definition || {};
    const current = JSON.stringify(canonicalize(currentDefinition));
    const next = JSON.stringify(canonicalize(definition));
    if (current !== next) {
      await collection.updateSearchIndex(indexName, definition);
    }
  } catch (err) {
    console.warn(`Search index ensure skipped for ${collection.collectionName}: ${err?.message || err}`);
  }
}

async function ensureSearchIndexNamed(collection, explicitIndexName, definition) {
  const indexName = String(explicitIndexName || '').trim() || 'default';
  try {
    const existing = await collection.listSearchIndexes(indexName).toArray();
    if (!existing.length) {
      await collection.createSearchIndex({ name: indexName, definition });
      return;
    }
    const currentDefinition = existing[0]?.latestDefinition || existing[0]?.definition || {};
    const current = JSON.stringify(canonicalize(currentDefinition));
    const next = JSON.stringify(canonicalize(definition));
    if (current !== next) {
      await collection.updateSearchIndex(indexName, definition);
    }
  } catch (err) {
    console.warn(
      `Search index ensure skipped for ${collection.collectionName} (${indexName}): ${err?.message || err}`
    );
  }
}

function initiativesVectorDimensions() {
  const n = Number(String(MONGO_VOYAGE_EMBED_DIMENSIONS || '').trim());
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 1024;
}

async function searchInitiativesByVector({ collection, queryText, filter, limit, vectorIndexName }) {
  const normalizedLimit = Math.max(1, Math.min(100, Number(limit || 25)));
  const q = normalizeSearchText(queryText);
  if (!q) return { rows: [], vectorError: 'empty_query' };
  const embedResult = await embedSingleText(q);
  if (embedResult.error || !embedResult.embedding) {
    return { rows: [], vectorError: embedResult.error || 'embed_failed' };
  }
  const queryVector = embedResult.embedding;
  const indexName = String(vectorIndexName || 'initiatives_vector').trim() || 'initiatives_vector';
  const baseFilter = filter && typeof filter === 'object' && Object.keys(filter).length ? filter : undefined;
  try {
    const vs = {
      index: indexName,
      path: 'initiativeNameEmbedding',
      queryVector,
      numCandidates: Math.min(400, normalizedLimit * 20),
      limit: normalizedLimit
    };
    if (baseFilter) vs.filter = baseFilter;
    const pipeline = [
      { $vectorSearch: vs },
      { $addFields: { _vectorScore: { $meta: 'vectorSearchScore' } } }
    ];
    return { rows: await collection.aggregate(pipeline).toArray(), vectorError: null };
  } catch (err) {
    return { rows: [], vectorError: err?.message || String(err) };
  }
}

async function ensureCrmCollections(db) {
  await Promise.all([
    db.collection(MONGO_TASK_LISTS_COLLECTION).createIndex({ owner: 1, updatedAt: -1 }),
    db.collection(MONGO_TASK_LISTS_COLLECTION).createIndex({ name: 1, updatedAt: -1 }),
    db.collection(MONGO_TASK_LISTS_COLLECTION).createIndex({ ownerUserId: 1, updatedAt: -1 }),
    db.collection(MONGO_TASKS_COLLECTION).createIndex({ taskListId: 1, updatedAt: -1 }),
    db.collection(MONGO_TASKS_COLLECTION).createIndex({ status: 1, updatedAt: -1 }),
    db.collection(MONGO_TASKS_COLLECTION).createIndex({ taskListId: 1, status: 1, updatedAt: -1 }),
    db.collection(MONGO_TASKS_COLLECTION).createIndex({ taskId: 1 }, { unique: true, sparse: true }),
    db.collection(MONGO_TASKS_COLLECTION).createIndex({ ownerUserId: 1, updatedAt: -1 }),
    db.collection(MONGO_ACCOUNTS_COLLECTION).createIndex({ name: 1, updatedAt: -1 }),
    db.collection(MONGO_ACCOUNTS_COLLECTION).createIndex({ parentAccountId: 1, updatedAt: -1 }),
    db.collection(MONGO_ACCOUNTS_COLLECTION).createIndex({ ownerUserId: 1, updatedAt: -1 }),
    db.collection(MONGO_WORKLOADS_COLLECTION).createIndex({ accountId: 1, updatedAt: -1 }),
    db.collection(MONGO_WORKLOADS_COLLECTION).createIndex({ name: 1, updatedAt: -1 }),
    db.collection(MONGO_WORKLOADS_COLLECTION).createIndex({ contactIds: 1, updatedAt: -1 }),
    db.collection(MONGO_WORKLOADS_COLLECTION).createIndex({ ownerUserId: 1, updatedAt: -1 }),
    db.collection(MONGO_MILESTONES_COLLECTION).createIndex({ milestoneDate: 1, status: 1 }),
    db.collection(MONGO_MILESTONES_COLLECTION).createIndex({ accountId: 1, milestoneDate: 1 }),
    db.collection(MONGO_MILESTONES_COLLECTION).createIndex({ 'workloadIds.workloadId': 1, milestoneDate: 1 }),
    db.collection(MONGO_MILESTONES_COLLECTION).createIndex({ updatedAt: -1 }),
    db.collection(MONGO_MILESTONES_COLLECTION).createIndex({ ownerUserId: 1, updatedAt: -1 }),
    db.collection(MONGO_CONTACTS_COLLECTION).createIndex({ accountId: 1, updatedAt: -1 }),
    db.collection(MONGO_CONTACTS_COLLECTION).createIndex({ email: 1, updatedAt: -1 }),
    db.collection(MONGO_CONTACTS_COLLECTION).createIndex({ name: 1, updatedAt: -1 }),
    db.collection(MONGO_CONTACTS_COLLECTION).createIndex({ ownerUserId: 1, updatedAt: -1 }),
    db.collection(MONGO_INITIATIVES_COLLECTION).createIndex({ updatedAt: -1 }),
    db.collection(MONGO_INITIATIVES_COLLECTION).createIndex({ 'accounts.accountId': 1, updatedAt: -1 }),
    db.collection(MONGO_INITIATIVES_COLLECTION).createIndex({ ownerUserId: 1, updatedAt: -1 })
  ]);

  if (!isAtlasSearchEnabled()) return;

  await Promise.all([
    ensureSearchIndex(db.collection(MONGO_TASK_LISTS_COLLECTION), {
      mappings: {
        dynamic: false,
        fields: {
          name: { type: 'string' },
          owner: { type: 'string' }
        }
      }
    }),
    ensureSearchIndex(db.collection(MONGO_TASKS_COLLECTION), {
      mappings: {
        dynamic: false,
        fields: {
          task: { type: 'string' },
          status: { type: 'string' },
          taskListId: { type: 'string' },
          taskListName: { type: 'string' },
          person: {
            type: 'document',
            fields: {
              name: { type: 'string' },
              title: { type: 'string' },
              role: { type: 'string' }
            }
          }
        }
      }
    }),
    ensureSearchIndex(db.collection(MONGO_WORKLOADS_COLLECTION), {
      mappings: {
        dynamic: false,
        fields: {
          name: { type: 'string' },
          description: { type: 'string' },
          notes: { type: 'string' },
          accountName: { type: 'string' },
          contacts: {
            type: 'document',
            fields: {
              name: { type: 'string' },
              email: { type: 'string' }
            }
          }
        }
      }
    }),
    ensureSearchIndex(db.collection(MONGO_MILESTONES_COLLECTION), {
      mappings: {
        dynamic: false,
        fields: {
          name: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string' },
          accountName: { type: 'string' },
          notes: {
            type: 'document',
            fields: {
              text: { type: 'string' },
              author: { type: 'string' }
            }
          },
          workloadIds: {
            type: 'document',
            fields: {
              workloadId: { type: 'string' },
              name: { type: 'string' }
            }
          }
        }
      }
    }),
    ensureSearchIndex(db.collection(MONGO_CONTACTS_COLLECTION), {
      mappings: {
        dynamic: false,
        fields: {
          name: { type: 'string' },
          preferredName: { type: 'string' },
          email: { type: 'string' },
          title: { type: 'string' },
          department: { type: 'string' },
          location: { type: 'string' },
          linkedIn: { type: 'string' },
          imageUrl: { type: 'string' },
          website: { type: 'string' },
          relationshipStatus: { type: 'string' },
          owner: { type: 'string' },
          source: { type: 'string' },
          tags: { type: 'string' },
          accountName: { type: 'string' },
          freeText: { type: 'string' },
          notes: {
            type: 'document',
            fields: {
              text: { type: 'string' },
              author: { type: 'string' }
            }
          }
        }
      }
    }),
    ensureSearchIndex(db.collection(MONGO_ACCOUNTS_COLLECTION), {
      mappings: {
        dynamic: false,
        fields: {
          name: { type: 'string' },
          parentAccountName: { type: 'string' },
          documentLinks: {
            type: 'document',
            fields: {
              name: { type: 'string' },
              url: { type: 'string' }
            }
          }
        }
      }
    }),
    ensureSearchIndex(db.collection(MONGO_INITIATIVES_COLLECTION), {
      mappings: {
        dynamic: false,
        fields: {
          initiativeName: { type: 'string' },
          initiativeDescription: { type: 'string' }
        }
      }
    }),
    ensureSearchIndexNamed(
      db.collection(MONGO_INITIATIVES_COLLECTION),
      String(MONGO_INITIATIVES_VECTOR_INDEX || 'initiatives_vector').trim() || 'initiatives_vector',
      {
        mappings: {
          dynamic: false,
          fields: {
            initiativeNameEmbedding: {
              type: 'knnVector',
              dimensions: initiativesVectorDimensions(),
              similarity: 'cosine'
            }
          }
        }
      }
    )
  ]);
}

async function ensureCrmSetup() {
  if (crmCollectionsReady) return;
  const db = await getMongoDb();
  await ensureCrmCollections(db);
  crmCollectionsReady = true;
}

async function loadMemoryAwareMessages(conversationId, userId, incomingMessages, userProfile) {
  await ensureMemorySetup();
  const db = await getMongoDb();
  const incomingTurn = extractLatestUserTurn(incomingMessages);
  await appendConversationMessages(db, memoryConfig, {
    conversationId,
    userId,
    messages: incomingTurn
  });
  const memory = await loadConversationMemory(db, memoryConfig, conversationId, memoryConfig.recentMessages);
  return buildShortTermContext({
    summaryText: memory.summaryText,
    recentMessages: memory.recentMessages,
    incomingMessages: incomingTurn,
    userProfile,
    maxRecentMessages: memoryConfig.recentMessages
  });
}

function getConversationMeta(body) {
  const userId = body?.userId ? String(body.userId).trim() : null;
  const rawConversationId = body?.conversationId;
  if (rawConversationId === undefined || rawConversationId === null || rawConversationId === '') {
    return { conversationId: null, userId: userId || null };
  }
  const conversationId = String(rawConversationId).trim();
  return { conversationId: conversationId || null, userId: userId || null };
}

async function loadUserProfileForUserId(userId) {
  const normalizedUserId = userId ? String(userId).trim() : '';
  if (!normalizedUserId) return null;
  await ensureMemorySetup();
  const db = await getMongoDb();
  return getUserProfile(db, memoryConfig, normalizedUserId);
}

async function triggerSummaryRefresh(conversationId) {
  const db = await getMongoDb();
  return maybeRefreshConversationSummary(db, memoryConfig, conversationId, false);
}

async function fetchGoogleToolDefinitions(force = false) {
  if (!GAS_WEB_APP_URL) throw new Error('GAS_WEB_APP_URL is required');
  if (!NODE_TO_GAS_SECRET) throw new Error('NODE_TO_GAS_SECRET is required');

  const now = Date.now();
  if (!force && googleToolDefsCache && now - googleToolDefsCacheTs < 60_000) {
    return googleToolDefsCache;
  }

  const res = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'getGoogleToolDefinitions',
      secret: NODE_TO_GAS_SECRET
    })
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    const location = res.headers.get('location') || '';
    const maybeLoginRedirect = location.includes('ServiceLogin') || raw.includes('<!DOCTYPE') || raw.includes('<HTML');
    const hint = maybeLoginRedirect
      ? 'GAS_WEB_APP_URL appears to require Google sign-in or points to a non-API page. Deploy Apps Script Web App as "Anyone" and use the public /exec URL.'
      : 'GAS web app returned non-JSON response.';
    throw new Error(`${hint} HTTP ${res.status}. Body starts with: ${raw.slice(0, 120)}`);
  }
  if (!res.ok || !data.ok || !Array.isArray(data.tools)) {
    throw new Error(`Failed to fetch Google tool definitions: ${data.error || res.status}`);
  }
  googleToolDefsCache = data.tools;
  googleToolDefsCacheTs = now;
  return data.tools;
}

async function executeGoogleTool(name, args, toolContext = {}) {
  const res = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'executeTool',
      tool: name,
      args: args || {},
      context: {
        userId: toolContext.userId || null,
        userProfile: toolContext.userProfile || null,
        initiatedByUserId: toolContext.initiatedByUserId || toolContext.userId || null,
        authType: toolContext.authType || null
      },
      secret: NODE_TO_GAS_SECRET
    })
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    return {
      error: 'Google tool bridge returned non-JSON response. Check GAS_WEB_APP_URL deployment access and /exec URL.',
      details: { status: res.status, preview: raw.slice(0, 200) }
    };
  }
  if (!res.ok || !data.ok) {
    return { error: data.error || `Google tool failed (${res.status})`, details: data.details };
  }
  return data.result;
}

function mongoToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'updateUserProfileMemory',
        description: 'Update the current user profile memory for "my" references (name, timezone, role, organization, aliases, preferences, constraints).',
        parameters: {
          type: 'object',
          properties: {
            patch: {
              type: 'object',
              properties: {
                displayName: { type: 'string' },
                timezone: { type: 'string' },
                role: { type: 'string' },
                organization: { type: 'string' },
                preferences: { type: 'object' },
                aliases: { type: 'object' },
                constraints: { type: 'array', items: { type: 'string' } }
              }
            },
            source: { type: 'string', description: 'Optional provenance: user_input, admin, or system.' }
          },
          required: ['patch']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'createTaskList',
        description: 'Create a MongoDB task list document. A list is the parent container for tasks.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Task list name.' },
            owner: { type: 'string', description: 'Optional owner for the list.' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'updateTaskList',
        description:
          'Update an existing MongoDB task list by ObjectId: change its name and/or owner. Pass owner as an empty string to clear ownership (no owner). Omitted fields stay unchanged.',
        parameters: {
          type: 'object',
          properties: {
            taskListId: { type: 'string', description: 'Task list ObjectId string.' },
            name: { type: 'string', description: 'New list name when changing the title.' },
            owner: {
              type: 'string',
              description:
                'New owner name when assigning ownership. Pass empty string to clear owner (unowned). Omit to leave owner unchanged.'
            }
          },
          required: ['taskListId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'addTaskToList',
        description: 'Add one task document linked to a task list by taskListId.',
        parameters: {
          type: 'object',
          properties: {
            taskListId: { type: 'string', description: 'Task list ObjectId string.' },
            task: { type: 'string', description: 'Task text.' },
            status: { type: 'string', description: 'Optional task status: open, in_progress, blocked, done. Defaults to open.' },
            owner: { type: 'string', description: 'Optional task owner/assignee. Independent from task list owner.' },
            priority: { type: 'string', description: 'Optional priority: Priority 1, Priority 2, Priority 3, Priority 4.' },
            dueDate: { type: 'string', description: 'Optional due date as ISO string.' },
            person: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                title: { type: 'string' },
                role: { type: 'string' }
              }
            },
            accountId: { type: 'string' },
            workloadId: { type: 'string' },
            documentLinks: {
              type: 'array',
              description: 'Optional array of task document links. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            }
          },
          required: ['taskListId', 'task']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'updateTaskInList',
        description: 'Update one task document by taskId (taskListId optional) or resolve by taskText scoped to taskListId with strict unique matching.',
        parameters: {
          type: 'object',
          properties: {
            taskListId: { type: 'string' },
            taskId: { type: 'string' },
            taskText: { type: 'string', description: 'Optional text used to resolve the target task when taskId is not provided.' },
            task: { type: 'string' },
            status: { type: 'string' },
            owner: { type: 'string', description: 'Optional task owner/assignee. Independent from task list owner.' },
            priority: { type: 'string' },
            dueDate: { type: 'string' },
            person: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                title: { type: 'string' },
                role: { type: 'string' }
              }
            },
            accountId: { type: 'string' },
            workloadId: { type: 'string' },
            documentLinks: {
              type: 'array',
              description: 'Replace task document links with this array. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            addDocumentLinks: {
              type: 'array',
              description: 'Append task document links to existing links. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listTaskLists',
        description:
          'List MongoDB task lists. When owner is set, matches documents where owner OR list name equals that string (case-insensitive), so lists named after a person with a null owner still match.',
        parameters: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Person or list label; matches owner field or list name (case-insensitive).' },
            q: { type: 'string', description: 'Optional fuzzy search text for list name/owner/task text.' },
            limit: { type: 'number' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getTaskList',
        description: 'Get one task list by ObjectId.',
        parameters: {
          type: 'object',
          properties: { taskListId: { type: 'string' } },
          required: ['taskListId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'deleteTaskList',
        description: 'Delete one MongoDB task list by ObjectId and remove linked task documents. Requires explicit confirm=true for safety.',
        parameters: {
          type: 'object',
          properties: {
            taskListId: { type: 'string' },
            confirm: { type: 'boolean', description: 'Must be true to confirm permanent deletion of the full task list.' }
          },
          required: ['taskListId', 'confirm']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'addAccount',
        description: 'Create an account document in MongoDB. Use parentAccountId for sub-accounts. Before calling addAccount, call listAccounts for the same name to check for existing accounts, then only call addAccount when the user explicitly confirms creating a new account.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parentAccountId: { type: 'string' },
            documentLinks: {
              type: 'array',
              description: 'Optional array of document links for this account. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            confirm: { type: 'boolean', description: 'Must be true after explicit user confirmation to create a new account record.' }
          },
          required: ['name', 'confirm']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'updateAccount',
        description: 'Update an existing account by ObjectId or unique accountName match.',
        parameters: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            accountName: { type: 'string', description: 'Optional name used to resolve accountId when accountId is omitted.' },
            name: { type: 'string' },
            parentAccountId: { type: 'string' },
            clearParentAccount: { type: 'boolean' },
            documentLinks: {
              type: 'array',
              description: 'Replace account document links with this array. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            addDocumentLinks: {
              type: 'array',
              description: 'Append account document links to existing links. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listAccounts',
        description: 'List account documents from MongoDB. Always use this before addAccount to check for existing or similar account names.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            q: { type: 'string', description: 'Optional fuzzy search text for account names.' },
            parentAccountId: { type: 'string' },
            limit: { type: 'number' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getAccount',
        description: 'Get one MongoDB account by ObjectId.',
        parameters: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'addWorkload',
        description: `Create a MongoDB workload document and attach it to an account with optional contacts. Before calling addWorkload, call listWorkloads for the same account/name to check for existing workloads, then only call addWorkload when the user explicitly confirms creating a new workload. stage is separate from description/notes, defaults to ${DEFAULT_WORKLOAD_STAGE} when omitted, and must be one of: ${formatWorkloadStageChoices()}.`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            accountId: { type: 'string', description: 'Required account ObjectId string.' },
            description: { type: 'string' },
            notes: { type: 'string' },
            stage: { type: 'string', description: `Optional workload stage. Allowed values: ${formatWorkloadStageChoices()}. Defaults to ${DEFAULT_WORKLOAD_STAGE} on create when omitted.` },
            arr: { type: 'number', description: 'Optional annual recurring revenue in USD dollars as a number.' },
            salesforceLink: { type: 'string', description: 'Optional Salesforce opportunity/workload URL.' },
            documentLinks: {
              type: 'array',
              description: 'Optional array of document links for this workload. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            contactIds: { type: 'array', items: { type: 'string' } },
            confirm: { type: 'boolean', description: 'Must be true after explicit user confirmation to create a new workload record.' }
          },
          required: ['name', 'accountId', 'confirm']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'updateWorkload',
        description: 'Update an existing MongoDB workload by ObjectId or unique workloadName match.',
        parameters: {
          type: 'object',
          properties: {
            workloadId: { type: 'string' },
            workloadName: { type: 'string', description: 'Optional name used to resolve workloadId when workloadId is omitted.' },
            name: { type: 'string' },
            accountId: { type: 'string' },
            description: { type: 'string' },
            notes: { type: 'string' },
            stage: { type: 'string', description: `Optional workload stage. Allowed values: ${formatWorkloadStageChoices()}.` },
            arr: { type: 'number', description: 'Optional annual recurring revenue in USD dollars as a number.' },
            salesforceLink: { type: 'string', description: 'Optional Salesforce opportunity/workload URL.' },
            documentLinks: {
              type: 'array',
              description: 'Replace workload document links with this array. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            addDocumentLinks: {
              type: 'array',
              description: 'Append workload document links to existing links. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            contactIds: { type: 'array', items: { type: 'string' } },
            clearContacts: { type: 'boolean' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listWorkloads',
        description: 'List workloads from MongoDB. Always use this before addWorkload to check for existing or similar workload names. Prefer q for fuzzy lookup; name is treated as a query fallback, not an exact-only filter.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional lookup text alias for q.' },
            q: { type: 'string', description: 'Optional fuzzy search text for workload name/notes/description.' },
            accountId: { type: 'string' },
            contactId: { type: 'string' },
            limit: { type: 'number' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getWorkload',
        description: 'Get one MongoDB workload by ObjectId.',
        parameters: {
          type: 'object',
          properties: { workloadId: { type: 'string' } },
          required: ['workloadId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'addMilestone',
        description: 'Create a milestone in MongoDB that can attach to one account and one-or-many workloads.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Milestone name (required).' },
            description: { type: 'string' },
            milestoneDate: { type: 'string', description: 'Milestone date. Accepts YYYY-MM-DD or month-only YYYY-MM (defaults to month-end).' },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  author: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                },
                required: ['text', 'author']
              }
            },
            accountId: { type: 'string' },
            workloadIds: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      workloadId: { type: 'string' },
                      id: { type: 'string' },
                      name: { type: 'string' }
                    }
                  }
                ]
              }
            },
            narr: { type: 'number', description: 'Optional Net Annual Recurring Revenue. Defaults from attached workloads when omitted.' },
            status: { type: 'string', description: 'Optional. One of: On Target, Delayed, Completed. Defaults to On Target.' }
          },
          required: ['name', 'milestoneDate']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'updateMilestone',
        description: 'Update an existing milestone by milestoneId or unique milestone name.',
        parameters: {
          type: 'object',
          properties: {
            milestoneId: { type: 'string' },
            milestoneName: { type: 'string', description: 'Optional name used to resolve milestoneId when milestoneId is omitted.' },
            name: { type: 'string' },
            description: { type: 'string' },
            milestoneDate: { type: 'string', description: 'Accepts YYYY-MM-DD or YYYY-MM (month-end default).' },
            notes: {
              type: 'array',
              description: 'Replace all notes with this full array.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  author: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                },
                required: ['text', 'author']
              }
            },
            addNote: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                author: { type: 'string' }
              },
              required: ['text']
            },
            editNote: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                author: { type: 'string' }
              },
              required: ['id']
            },
            removeNoteId: { type: 'string' },
            clearNotes: { type: 'boolean' },
            accountId: { type: 'string' },
            clearAccount: { type: 'boolean' },
            workloadIds: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      workloadId: { type: 'string' },
                      id: { type: 'string' },
                      name: { type: 'string' }
                    }
                  }
                ]
              }
            },
            clearWorkloads: { type: 'boolean' },
            narr: { type: 'number' },
            status: { type: 'string', description: 'One of: On Target, Delayed, Completed.' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listMilestones',
        description: 'List milestones from MongoDB for timeline views.',
        parameters: {
          type: 'object',
          properties: {
            milestoneName: { type: 'string', description: 'Optional lookup text alias for q.' },
            q: { type: 'string', description: 'Optional fuzzy search text across milestone fields.' },
            accountId: { type: 'string' },
            workloadId: { type: 'string' },
            status: { type: 'string' },
            from: { type: 'string', description: 'Date-only lower bound (inclusive).' },
            to: { type: 'string', description: 'Date-only upper bound (inclusive).' },
            limit: { type: 'number' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getMilestone',
        description: 'Get one MongoDB milestone by ObjectId.',
        parameters: {
          type: 'object',
          properties: { milestoneId: { type: 'string' } },
          required: ['milestoneId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'addInitiative',
        description:
          'Create a strategic initiative in MongoDB. Requires initiativeName and at least one accountId. Optional contactIds and workloadIds must belong to one of those accounts. Initiative name is embedded with Voyage for vector search when MONGO_VOYAGE_API_KEY is set.',
        parameters: {
          type: 'object',
          properties: {
            initiativeName: { type: 'string' },
            initiativeDescription: { type: 'string' },
            accountIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'One or more account ObjectId strings (required).'
            },
            contactIds: { type: 'array', items: { type: 'string' } },
            workloadIds: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      workloadId: { type: 'string' },
                      id: { type: 'string' },
                      name: { type: 'string' }
                    }
                  }
                ]
              }
            },
            targetedErr: { type: 'number', description: 'Optional expected revenue (USD number).' }
          },
          required: ['initiativeName', 'accountIds']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'updateInitiative',
        description: 'Update an initiative by initiativeId or initiativeName. Re-embeds name when initiativeName changes.',
        parameters: {
          type: 'object',
          properties: {
            initiativeId: { type: 'string' },
            initiativeNameLookup: { type: 'string', description: 'Used to resolve initiative when initiativeId omitted.' },
            initiativeName: { type: 'string' },
            initiativeDescription: { type: 'string' },
            accountIds: { type: 'array', items: { type: 'string' } },
            contactIds: { type: 'array', items: { type: 'string' } },
            clearContacts: { type: 'boolean' },
            workloadIds: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      workloadId: { type: 'string' },
                      id: { type: 'string' },
                      name: { type: 'string' }
                    }
                  }
                ]
              }
            },
            clearWorkloads: { type: 'boolean' },
            targetedErr: { type: 'number' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listInitiatives',
        description:
          'List initiatives. Use q for fuzzy text on name/description. Optional accountId filters to initiatives that include that account.',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            accountId: { type: 'string' },
            limit: { type: 'number' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getInitiative',
        description: 'Get one initiative by ObjectId.',
        parameters: {
          type: 'object',
          properties: { initiativeId: { type: 'string' } },
          required: ['initiativeId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'searchInitiatives',
        description:
          'Semantic search initiatives by natural-language query using Voyage embeddings and Atlas vector search. Falls back to fuzzy text when vector search is unavailable. Requires embeddings on documents for best results.',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            accountId: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['q']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'addContact',
        description: 'Create a contact document in MongoDB. Before calling addContact, call listContacts for the same account/name/email to check for existing contacts, then only call addContact when the user explicitly confirms creating a new contact.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            Name: { type: 'string', description: 'Legacy alias for name.' },
            preferredName: { type: 'string' },
            pronouns: { type: 'string' },
            email: { type: 'string' },
            Email: { type: 'string', description: 'Legacy alias for email.' },
            phone: { type: 'string' },
            mobile: { type: 'string' },
            title: { type: 'string' },
            Title: { type: 'string', description: 'Legacy alias for title.' },
            department: { type: 'string' },
            location: { type: 'string' },
            timeZone: { type: 'string' },
            linkedIn: { type: 'string', description: 'Canonical LinkedIn profile URL.' },
            LinkedIn: { type: 'string', description: 'Legacy alias for linkedIn.' },
            imageUrl: { type: 'string', description: 'Canonical profile image URL.' },
            ImageURL: { type: 'string', description: 'Legacy alias for imageUrl.' },
            website: { type: 'string' },
            relationshipStatus: { type: 'string' },
            lastContactDate: { type: 'string' },
            nextFollowUpDate: { type: 'string' },
            owner: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            source: { type: 'string' },
            reportsTo: {
              type: 'object',
              properties: {
                contactId: { type: 'string' },
                name: { type: 'string' }
              }
            },
            ReportsTo: {
              type: 'object',
              description: 'Legacy alias for reportsTo.',
              properties: {
                contactId: { type: 'string' },
                name: { type: 'string' }
              }
            },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  author: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                },
                required: ['text', 'author']
              }
            },
            Notes: {
              type: 'array',
              description: 'Legacy alias for notes.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  author: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                },
                required: ['text', 'author']
              }
            },
            freeText: { type: 'string' },
            accountId: { type: 'string', description: 'Required account ObjectId string.' },
            AccountId: { type: 'string', description: 'Legacy alias for accountId.' },
            workloadIds: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      workloadId: { type: 'string' },
                      id: { type: 'string' },
                      name: { type: 'string' }
                    }
                  }
                ]
              }
            },
            documentLinks: {
              type: 'array',
              description: 'Optional array of document links for this contact. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            confirm: { type: 'boolean', description: 'Must be true after explicit user confirmation to create a new contact record.' }
          },
          required: ['name', 'accountId', 'confirm']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'updateContact',
        description: 'Update a MongoDB contact by ObjectId or unique contactName match.',
        parameters: {
          type: 'object',
          properties: {
            contactId: { type: 'string' },
            contactName: { type: 'string', description: 'Optional name used to resolve contactId when contactId is omitted.' },
            name: { type: 'string' },
            Name: { type: 'string', description: 'Legacy alias for name.' },
            preferredName: { type: 'string' },
            pronouns: { type: 'string' },
            email: { type: 'string' },
            Email: { type: 'string', description: 'Legacy alias for email.' },
            phone: { type: 'string' },
            mobile: { type: 'string' },
            title: { type: 'string' },
            Title: { type: 'string', description: 'Legacy alias for title.' },
            department: { type: 'string' },
            location: { type: 'string' },
            timeZone: { type: 'string' },
            linkedIn: { type: 'string' },
            LinkedIn: { type: 'string', description: 'Legacy alias for linkedIn.' },
            imageUrl: { type: 'string' },
            ImageURL: { type: 'string', description: 'Legacy alias for imageUrl.' },
            website: { type: 'string' },
            relationshipStatus: { type: 'string' },
            lastContactDate: { type: 'string' },
            nextFollowUpDate: { type: 'string' },
            owner: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            source: { type: 'string' },
            reportsTo: {
              type: 'object',
              properties: {
                contactId: { type: 'string' },
                name: { type: 'string' }
              }
            },
            ReportsTo: {
              type: 'object',
              description: 'Legacy alias for reportsTo.',
              properties: {
                contactId: { type: 'string' },
                name: { type: 'string' }
              }
            },
            clearReportsTo: { type: 'boolean' },
            notes: {
              type: 'array',
              description: 'Replace all notes with this full array.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  author: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                },
                required: ['text', 'author']
              }
            },
            Notes: {
              type: 'array',
              description: 'Legacy alias for notes.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  author: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' }
                },
                required: ['text', 'author']
              }
            },
            addNote: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                author: { type: 'string' }
              },
              required: ['text', 'author']
            },
            editNote: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                author: { type: 'string' }
              },
              required: ['id']
            },
            removeNoteId: { type: 'string' },
            clearNotes: { type: 'boolean' },
            freeText: { type: 'string' },
            accountId: { type: 'string' },
            AccountId: { type: 'string', description: 'Legacy alias for accountId.' },
            workloadIds: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      workloadId: { type: 'string' },
                      id: { type: 'string' },
                      name: { type: 'string' }
                    }
                  }
                ]
              }
            },
            documentLinks: {
              type: 'array',
              description: 'Replace contact document links with this array. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            },
            addDocumentLinks: {
              type: 'array',
              description: 'Append contact document links to existing links. Each item must include both name and url.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' }
                },
                required: ['name', 'url']
              }
            }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listContacts',
        description: 'List contacts from MongoDB. Always use this before addContact to check for existing or similar contacts.',
        parameters: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            accountId: { type: 'string' },
            q: { type: 'string', description: 'Optional fuzzy search text for contact fields.' },
            limit: { type: 'number' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getContact',
        description: 'Get one MongoDB contact by ObjectId.',
        parameters: {
          type: 'object',
          properties: { contactId: { type: 'string' } },
          required: ['contactId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'deleteContact',
        description:
          'Permanently delete one MongoDB contact by ObjectId or unique contactName match (use listContacts with accountId/email when duplicates exist). Removes the contact from all workloads and clears reportsTo pointers from other contacts. Requires explicit confirm=true after the user confirms deletion.',
        parameters: {
          type: 'object',
          properties: {
            contactId: { type: 'string' },
            contactName: { type: 'string', description: 'Optional; used to resolve contactId when contactId is omitted.' },
            accountId: { type: 'string', description: 'Optional account ObjectId to scope name resolution (same as updateContact).' },
            AccountId: { type: 'string', description: 'Legacy alias for accountId.' },
            confirm: { type: 'boolean', description: 'Must be true to confirm permanent deletion.' }
          },
          required: ['confirm']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'standardizeContactFields',
        description: 'Backfill contacts to canonical contact-card fields and remove legacy aliases. Use dryRun=true first.',
        parameters: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', description: 'Defaults to true. When false, writes updates to MongoDB.' },
            limit: { type: 'number', description: 'Optional max contacts to scan (default 1000).' }
          },
          required: []
        }
      }
    }
  ];
}

function parseSessionSummaryJson(rawContent) {
  const text = String(rawContent || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const sessionLabel = parsed.sessionLabel == null ? '' : String(parsed.sessionLabel).trim();
    const sessionDescription = parsed.sessionDescription == null ? '' : String(parsed.sessionDescription).trim();
    if (!sessionLabel && !sessionDescription) return null;
    return { sessionLabel, sessionDescription };
  } catch (_err) {
    return null;
  }
}

function toThreeWords(value) {
  const words = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(Boolean);
  if (!words.length) return 'New Conversation Thread';
  const out = words.slice(0, 3);
  while (out.length < 3) out.push(words[words.length - 1] || 'Thread');
  return out.join(' ');
}

function fallbackConversationSessionMeta({ title, latestMessage }) {
  const source = String(title || latestMessage || '').trim();
  const sessionLabel = toThreeWords(source);
  const sessionDescription = summarizeText(source || 'Conversation in progress.', 140) || 'Conversation in progress.';
  return { sessionLabel, sessionDescription };
}

async function generateConversationSessionMeta({ title, latestMessage }) {
  const fallback = fallbackConversationSessionMeta({ title, latestMessage });
  const system = [
    'You create concise chat session metadata.',
    'Return only strict JSON with keys: sessionLabel, sessionDescription.',
    'sessionLabel must be exactly 3 words.',
    'sessionDescription should be one clear sentence, 12-22 words.'
  ].join(' ');
  const user = [
    `Title: ${String(title || '').trim() || 'None'}`,
    `Latest message: ${String(latestMessage || '').trim() || 'None'}`
  ].join('\n');
  try {
    const response = await callModel(
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      [],
      { temperature: 0.2, max_tokens: 120, response_format: { type: 'json_object' } }
    );
    const content = response?.choices?.[0]?.message?.content;
    const parsed = parseSessionSummaryJson(content);
    if (!parsed) return fallback;
    const sessionLabel = toThreeWords(parsed.sessionLabel || fallback.sessionLabel);
    const sessionDescription = summarizeText(parsed.sessionDescription || fallback.sessionDescription, 180) || fallback.sessionDescription;
    return { sessionLabel, sessionDescription };
  } catch (_err) {
    return fallback;
  }
}

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch (_err) {
    return null;
  }
}

function isValidIsoString(value) {
  if (!value) return false;
  const asString = String(value).trim();
  if (!asString) return false;
  return !Number.isNaN(Date.parse(asString));
}

function hasOwn(source, key) {
  return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function pickFirstDefined(source, keys) {
  for (const key of keys) {
    if (hasOwn(source, key)) return source[key];
  }
  return undefined;
}

function normalizeOptionalContactString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeContactArray(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  const source = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  const seen = new Set();
  for (const entry of source) {
    const text = String(entry || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeContactWorkloadRefs(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  const source = Array.isArray(value) ? value : [value];
  const refs = [];
  const seen = new Set();
  for (const entry of source) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      const workloadId = entry.trim();
      if (!workloadId || seen.has(workloadId)) continue;
      seen.add(workloadId);
      refs.push({ workloadId, name: null });
      continue;
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) continue;
    const workloadId = String(entry.workloadId || entry.id || '').trim();
    if (!workloadId || seen.has(workloadId)) continue;
    seen.add(workloadId);
    const name = entry.name != null ? String(entry.name).trim() : '';
    refs.push({ workloadId, name: name || null });
  }
  return refs;
}

function extractLinkedInUrlFromText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/https?:\/\/(?:[\w-]+\.)?linkedin\.com\/[^\s)]+/i);
  if (!match || !match[0]) return null;
  return normalizeContactUrl(match[0]);
}

function normalizeContactUrl(value) {
  const text = normalizeOptionalContactString(value);
  if (text === undefined || text === null) return text;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\.[A-Za-z]{2,}(\/|$)/.test(text)) return `https://${text}`;
  return text;
}

function escapeRegexLiteral(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContactFieldValue(field, value) {
  if (field === 'name' || field === 'title') {
    if (value === undefined) return undefined;
    return String(value ?? '').trim();
  }
  if (field === 'linkedIn' || field === 'imageUrl' || field === 'website') {
    return normalizeContactUrl(value);
  }
  if (field === 'tags') {
    return normalizeContactArray(value);
  }
  if (field === 'workloadIds') {
    return normalizeContactWorkloadRefs(value);
  }
  if (field === 'lastContactDate' || field === 'nextFollowUpDate') {
    if (value === undefined) return undefined;
    return toIsoOrNull(value);
  }
  return normalizeOptionalContactString(value);
}

function extractStandardContactFields(source) {
  const out = {};
  for (const [canonical, aliases] of Object.entries(CONTACT_STANDARD_FIELD_ALIASES)) {
    const value = pickFirstDefined(source, [canonical, ...aliases]);
    if (value === undefined) continue;
    out[canonical] = normalizeContactFieldValue(canonical, value);
  }
  return out;
}

function normalizeContactForRead(rawContact) {
  const out = normalizeDocumentForRead(rawContact);
  if (!out || typeof out !== 'object') return out;
  const standardized = extractStandardContactFields(out);
  const normalizedNotes = normalizeStoredContactNotes(pickFirstDefined(out, ['notes', 'Notes']));
  const merged = { ...out, ...standardized, notes: normalizedNotes };
  for (const legacyKey of CONTACT_LEGACY_FIELD_KEYS) {
    delete merged[legacyKey];
  }
  return merged;
}

function buildContactStandardizationPatch(rawContact, nowIso) {
  const current = rawContact && typeof rawContact === 'object' ? rawContact : {};
  const standardized = extractStandardContactFields(current);
  const patch = {};
  const legacyUnsets = {};

  for (const legacyKey of CONTACT_LEGACY_FIELD_KEYS) {
    if (hasOwn(current, legacyKey)) legacyUnsets[legacyKey] = '';
  }
  for (const [key, value] of Object.entries(standardized)) {
    if (value === undefined) continue;
    const currentValue = current[key];
    if (JSON.stringify(currentValue) !== JSON.stringify(value)) {
      patch[key] = value;
    }
  }

  if (pickFirstDefined(current, ['notes', 'Notes']) !== undefined) {
    const normalizedNotes = normalizeStoredContactNotes(pickFirstDefined(current, ['notes', 'Notes']));
    if (JSON.stringify(current.notes) !== JSON.stringify(normalizedNotes)) {
      patch.notes = normalizedNotes;
    }
  }

  const hasChanges = Object.keys(patch).length > 0 || Object.keys(legacyUnsets).length > 0;
  if (hasChanges) patch.updatedAt = nowIso;
  return { patch, legacyUnsets, hasChanges };
}

function buildContactNote(rawNote, nowIso) {
  if (rawNote == null) return { error: 'Note cannot be null' };
  if (typeof rawNote === 'string') {
    const text = rawNote.trim();
    if (!text) return { error: 'Note text cannot be empty' };
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return buildContactNote(parsed, nowIso);
        }
      } catch (_err) {
        // Keep legacy plain-string behavior when parsing fails.
      }
    }
    return {
      note: {
        id: new ObjectId().toString(),
        text,
        author: 'Unknown',
        createdAt: nowIso,
        updatedAt: nowIso
      }
    };
  }
  if (typeof rawNote !== 'object' || Array.isArray(rawNote)) {
    return { error: 'Each note must be a string or object' };
  }
  const text = rawNote.text == null ? '' : String(rawNote.text).trim();
  if (!text) return { error: 'Each note must include non-empty text' };
  const author = rawNote.author == null ? '' : String(rawNote.author).trim();
  if (!author) return { error: 'Each note must include a non-empty author' };
  const createdAt = isValidIsoString(rawNote.createdAt) ? String(rawNote.createdAt).trim() : nowIso;
  const updatedAt = isValidIsoString(rawNote.updatedAt) ? String(rawNote.updatedAt).trim() : createdAt;
  return {
    note: {
      id: rawNote.id ? String(rawNote.id).trim() || new ObjectId().toString() : new ObjectId().toString(),
      text,
      author,
      createdAt,
      updatedAt
    }
  };
}

function normalizeContactNotesArray(rawNotes, nowIso = new Date().toISOString()) {
  if (rawNotes == null) return { notes: [] };
  const source = Array.isArray(rawNotes) ? rawNotes : [rawNotes];
  const notes = [];
  const seenIds = new Set();
  for (const entry of source) {
    const built = buildContactNote(entry, nowIso);
    if (built.error) return { error: built.error };
    let note = built.note;
    while (seenIds.has(note.id)) {
      note = { ...note, id: new ObjectId().toString() };
    }
    seenIds.add(note.id);
    notes.push(note);
  }
  return { notes };
}

function normalizeStoredContactNotes(rawNotes, fallbackAuthor = 'Imported') {
  const nowIso = new Date().toISOString();
  if (rawNotes == null) return [];
  if (Array.isArray(rawNotes)) {
    const notes = [];
    const seenIds = new Set();
    for (const entry of rawNotes) {
      const built = buildContactNote(entry, nowIso);
      if (built.error) continue;
      let note = built.note;
      while (seenIds.has(note.id)) {
        note = { ...note, id: new ObjectId().toString() };
      }
      seenIds.add(note.id);
      notes.push(note);
    }
    return notes;
  }
  if (typeof rawNotes === 'string') {
    const text = rawNotes.trim();
    if (!text) return [];
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          const normalized = normalizeStoredContactNotes(parsed, fallbackAuthor);
          if (normalized.length) return normalized;
        } else if (parsed && typeof parsed === 'object') {
          const built = buildContactNote(parsed, nowIso);
          if (!built.error) return [built.note];
        }
      } catch (_err) {
        // Keep legacy plain-string behavior when parsing fails.
      }
    }
    return [{
      id: new ObjectId().toString(),
      text,
      author: fallbackAuthor,
      createdAt: nowIso,
      updatedAt: nowIso
    }];
  }
  return [];
}

function normalizeMilestoneForRead(rawMilestone) {
  const out = normalizeDocumentForRead(rawMilestone);
  if (!out || typeof out !== 'object') return out;
  const normalizedDate = normalizeMilestoneDate(out.milestoneDate);
  const normalizedStatus = normalizeMilestoneStatus(out.status, { defaultWhenMissing: true });
  const normalizedNotes = normalizeStoredMilestoneNotes(out.notes);
  const normalizedWorkloadRefs = normalizeContactWorkloadRefs(out.workloadIds) || [];
  return {
    ...out,
    milestoneDate: normalizedDate || String(out.milestoneDate || '').trim() || null,
    status: normalizedStatus || DEFAULT_MILESTONE_STATUS,
    notes: normalizedNotes,
    workloadIds: normalizedWorkloadRefs
  };
}

async function handleTaskMongoTool(name, args, context) {
  const { taskLists, tasks, sessionOptions } = context;

  if (name === 'createTaskList') {
    const doc = {
      name: String(args.name || '').trim(),
      owner: args.owner ? String(args.owner).trim() : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!doc.name) return { error: 'name is required' };
    const result = await taskLists.insertOne(doc);
    return { ok: true, taskListId: String(result.insertedId), taskList: { ...doc, _id: String(result.insertedId) } };
  }

  if (name === 'updateTaskList') {
    const _id = toObjectId(args.taskListId);
    if (!_id) return { error: 'Invalid taskListId' };
    const existing = await taskLists.findOne({ _id });
    if (!existing) return { error: 'Task list not found' };

    const hasName = Object.prototype.hasOwnProperty.call(args, 'name');
    const hasOwner = Object.prototype.hasOwnProperty.call(args, 'owner');
    if (!hasName && !hasOwner) return { error: 'Provide name and/or owner to update' };

    const $set = {};
    const nowIso = new Date().toISOString();

    if (hasName) {
      const nextName = String(args.name || '').trim();
      if (!nextName) return { error: 'name cannot be empty when provided' };
      $set.name = nextName;
    }
    if (hasOwner) {
      const o = args.owner;
      $set.owner = o == null || String(o).trim() === '' ? null : String(o).trim();
    }

    $set.updatedAt = nowIso;
    await taskLists.updateOne({ _id }, { $set });

    if (Object.prototype.hasOwnProperty.call($set, 'name')) {
      await tasks.updateMany(
        { taskListId: String(_id) },
        { $set: { taskListName: $set.name, updatedAt: nowIso } }
      );
    }

    const row = await taskLists.findOne({ _id });
    const listId = String(row._id);
    return {
      ok: true,
      taskListId: listId,
      taskList: {
        _id: listId,
        name: row.name ? String(row.name) : '',
        owner: row.owner != null && String(row.owner).trim() ? String(row.owner).trim() : null,
        createdAt: row.createdAt ? String(row.createdAt) : null,
        updatedAt: row.updatedAt ? String(row.updatedAt) : null
      }
    };
  }

  if (name === 'getTaskList') {
    const _id = toObjectId(args.taskListId);
    if (!_id) return { error: 'Invalid taskListId' };
    const row = await taskLists.findOne({ _id });
    if (!row) return { error: 'Task list not found' };
    const listId = String(row._id);
    const listTasks = await tasks.find({ taskListId: listId }).sort({ updatedAt: -1 }).toArray();
    return attachTasksToTaskList(row, listTasks.map(normalizeTaskForRead));
  }

  if (name === 'listTaskLists') {
    const ownerFilter = args.owner ? buildTaskListOwnerOrNameFilter(args.owner) : {};
    const q = normalizeSearchText(args.q);
    const limit = Math.max(1, Math.min(100, Number(args.limit || 25)));
    let rows = [];
    if (!q) {
      rows = await taskLists.find(ownerFilter).sort({ updatedAt: -1 }).limit(limit).toArray();
    } else {
      const ownerScopedRows = args.owner
        ? await taskLists.find(ownerFilter, { projection: { _id: 1 } }).limit(2000).toArray()
        : [];
      const ownerScopedIds = ownerScopedRows.map((row) => String(row._id));
      if (args.owner && !ownerScopedIds.length) return { taskLists: [] };

      const listRowsByNameOrOwner = await searchCollectionHybrid({
        collection: taskLists,
        query: q,
        paths: ['name', 'owner'],
        filter: ownerFilter,
        limit: Math.max(limit * 6, 150)
      });
      const taskRowsByText = await searchCollectionHybrid({
        collection: tasks,
        query: q,
        paths: ['task'],
        filter: args.owner ? { taskListId: { $in: ownerScopedIds } } : {},
        limit: Math.max(limit * 10, 200)
      });
      const matchedTaskListIds = new Set();
      for (const row of listRowsByNameOrOwner) matchedTaskListIds.add(String(row?._id || ''));
      for (const row of taskRowsByText) {
        const listId = String(row?.taskListId || '').trim();
        if (listId) matchedTaskListIds.add(listId);
      }
      const ids = Array.from(matchedTaskListIds).filter(Boolean);
      if (!ids.length) return { taskLists: [] };
      const objectIds = ids.map((id) => toObjectId(id)).filter(Boolean);
      if (!objectIds.length) return { taskLists: [] };
      rows = await taskLists
        .find({ _id: { $in: objectIds } })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();
    }
    const listIds = rows.map((row) => String(row._id));
    const tasksByList = await loadTasksForTaskLists(tasks, listIds);
    return {
      taskLists: rows.map((row) => attachTasksToTaskList(row, tasksByList.get(String(row._id)) || []))
    };
  }

  if (name === 'deleteTaskList') {
    const _id = toObjectId(args.taskListId);
    if (!_id) return { error: 'Invalid taskListId' };
    if (args.confirm !== true) {
      return { error: 'Confirmation required: re-run deleteTaskList with confirm=true after the user explicitly confirms permanent deletion.' };
    }
    return runWithOptionalTransaction(async ({ session }) => {
      const result = await taskLists.deleteOne({ _id }, sessionOptions(session));
      if (!result.deletedCount) return { error: 'Task list not found' };
      await tasks.deleteMany({ taskListId: String(_id) }, sessionOptions(session));
      return { ok: true, taskListId: String(_id), deleted: true };
    });
  }

  if (name === 'addTaskToList') {
    const _id = toObjectId(args.taskListId);
    if (!_id) return { error: 'Invalid taskListId' };
    const list = await taskLists.findOne({ _id });
    if (!list) return { error: 'Task list not found' };
    const task = String(args.task || '').trim();
    const rawStatus = String(args.status || '').trim();
    const status = rawStatus || 'open';
    if (!task) return { error: 'task is required' };
    if (!TASK_ALLOWED_STATUSES.has(status)) {
      return { error: 'status must be one of: open, in_progress, blocked, done' };
    }
    const priority = args.priority != null ? String(args.priority).trim() : '';
    if (priority && !TASK_ALLOWED_PRIORITIES.has(priority)) {
      return { error: 'priority must be one of: Priority 1, Priority 2, Priority 3, Priority 4' };
    }
    const owner = args.owner != null ? String(args.owner).trim() : '';
    const person = normalizeTaskPerson(args.person);
    const taskLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'task documentLinks');
    if (taskLinksResult.error) return { error: taskLinksResult.error };
    const nowIso = new Date().toISOString();
    const taskObjectId = new ObjectId();
    const taskRow = {
      _id: taskObjectId,
      taskId: String(taskObjectId),
      taskListId: String(_id),
      taskListName: list.name ? String(list.name) : null,
      task,
      status,
      owner: owner || null,
      dueDate: args.dueDate ? String(args.dueDate) : null,
      accountId: args.accountId ? String(args.accountId) : null,
      workloadId: args.workloadId ? String(args.workloadId) : null,
      documentLinks: taskLinksResult.links ?? [],
      createdAt: nowIso,
      updatedAt: nowIso
    };
    if (priority) taskRow.priority = priority;
    if (person) taskRow.person = person;
    await tasks.insertOne(taskRow);
    await taskLists.updateOne({ _id }, { $set: { updatedAt: nowIso } });
    return { ok: true, task: normalizeTaskForRead(taskRow) };
  }

  if (name === 'updateTaskInList') {
    const taskListIdArg = String(args.taskListId || '').trim();
    const hasTaskListArg = taskListIdArg.length > 0;
    const _id = hasTaskListArg ? toObjectId(taskListIdArg) : null;
    if (hasTaskListArg && !_id) return { error: 'Invalid taskListId' };
    const taskId = String(args.taskId || '').trim();
    const taskText = normalizeSearchText(args.taskText);
    if (!taskId && !taskText) return { error: 'taskId or taskText is required' };
    if (!taskId && !_id) return { error: 'taskListId is required when using taskText' };
    if (args.documentLinks !== undefined && args.addDocumentLinks !== undefined) {
      return { error: 'Provide either documentLinks or addDocumentLinks, not both' };
    }
    let targetTask = null;
    if (taskId) {
      const idFilter = buildTaskLookupFilter(taskId);
      const targetFilter = {
        ...(idFilter || {}),
        ...(_id ? { taskListId: String(_id) } : {})
      };
      targetTask = await tasks.findOne(targetFilter);
      if (!targetTask) return { error: 'Task not found' };
    } else {
      const lowered = taskText.toLowerCase();
      const matches = await tasks
        .find({
          taskListId: String(_id),
          task: { $regex: escapeRegExp(lowered), $options: 'i' }
        })
        .sort({ updatedAt: -1 })
        .limit(6)
        .toArray();
      if (!matches.length) return { error: `Task not found for "${taskText}"` };
      if (matches.length > 1) {
        return {
          error: `Multiple task matches found for "${taskText}". Please provide taskId.`,
          needsDisambiguation: true,
          candidates: matches.slice(0, 5).map((row) => ({
            taskId: String(row?.taskId || row?._id || ''),
            task: String(row?.task || '')
          }))
        };
      }
      [targetTask] = matches;
    }
    const resolvedTaskListId = String(targetTask.taskListId || (_id ? String(_id) : '')).trim();
    if (!resolvedTaskListId) return { error: 'Task missing taskListId' };
    const listObjectId = toObjectId(resolvedTaskListId);
    if (!listObjectId) return { error: 'Task has invalid taskListId' };
    const list = await taskLists.findOne({ _id: listObjectId }, { projection: { _id: 1, name: 1 } });
    if (!list) return { error: 'Task list not found' };

    const next = { ...targetTask };
    if (args.task !== undefined) next.task = String(args.task);
    if (args.status !== undefined) {
      const status = String(args.status).trim();
      if (!TASK_ALLOWED_STATUSES.has(status)) return { error: 'status must be one of: open, in_progress, blocked, done' };
      next.status = status;
    }
    if (args.owner !== undefined) {
      const owner = String(args.owner || '').trim();
      next.owner = owner || null;
    }
    if (args.priority !== undefined) {
      const priority = String(args.priority || '').trim();
      if (!priority) delete next.priority;
      else {
        if (!TASK_ALLOWED_PRIORITIES.has(priority)) return { error: 'priority must be one of: Priority 1, Priority 2, Priority 3, Priority 4' };
        next.priority = priority;
      }
    }
    if (args.dueDate !== undefined) next.dueDate = args.dueDate === '' ? null : String(args.dueDate);
    if (args.person !== undefined) next.person = normalizeTaskPerson(args.person, next.person);
    if (args.accountId !== undefined) next.accountId = args.accountId ? String(args.accountId) : null;
    if (args.workloadId !== undefined) next.workloadId = args.workloadId ? String(args.workloadId) : null;
    if (args.documentLinks !== undefined) {
      const replaceLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'task documentLinks');
      if (replaceLinksResult.error) return { error: replaceLinksResult.error };
      next.documentLinks = replaceLinksResult.links ?? [];
    }
    if (args.addDocumentLinks !== undefined) {
      const addLinksResult = normalizeDocumentLinksInput(args.addDocumentLinks, 'task addDocumentLinks');
      if (addLinksResult.error) return { error: addLinksResult.error };
      next.documentLinks = mergeDocumentLinks(next.documentLinks, addLinksResult.links);
    }
    next.taskListId = resolvedTaskListId;
    next.taskListName = list.name ? String(list.name) : null;
    next.taskId = next.taskId ? String(next.taskId) : String(next._id);
    const nowIso = new Date().toISOString();
    next.updatedAt = nowIso;

    await tasks.updateOne({ _id: targetTask._id }, { $set: next });
    await taskLists.updateOne({ _id: listObjectId }, { $set: { updatedAt: nowIso } });
    const updated = await tasks.findOne({ _id: targetTask._id });
    return { ok: true, task: normalizeTaskForRead(updated) };
  }

  return undefined;
}

async function handleAccountWorkloadMongoTool(name, args, context) {
  const {
    accounts,
    contacts,
    workloads,
    resolveAccountRef,
    resolveContactRefs,
    resolveUniqueDocumentTarget,
    hasInputItems,
    addWorkloadRefToContacts,
    removeWorkloadRefFromContacts,
    syncWorkloadNameOnContacts,
    sessionOptions
  } = context;

  if (name === 'addAccount') {
    const accountName = String(args.name || '').trim();
    if (!accountName) return { error: 'name is required' };
    const possibleMatches = await searchCollectionHybrid({
      collection: accounts,
      query: accountName,
      paths: ['name', 'parentAccountName', 'documentLinks.name'],
      filter: {},
      limit: 10
    });
    const guard = buildAccountCreateGuardResult({
      accountName,
      confirm: args.confirm,
      candidates: mapAccountCandidateRows(possibleMatches)
    });
    if (guard.block) return guard.response;
    const accountLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'account documentLinks');
    if (accountLinksResult.error) return { error: accountLinksResult.error };

    let parentAccountId = null;
    let parentAccountName = null;
    if (args.parentAccountId != null && String(args.parentAccountId).trim()) {
      const parentRef = await resolveAccountRef(args.parentAccountId);
      if (parentRef.error) return { error: parentRef.error };
      parentAccountId = parentRef.accountId;
      parentAccountName = parentRef.accountName;
    }

    const doc = {
      name: accountName,
      parentAccountId,
      parentAccountName,
      documentLinks: accountLinksResult.links ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const result = await accounts.insertOne(doc);
    return { ok: true, accountId: String(result.insertedId), account: { ...doc, _id: String(result.insertedId) } };
  }

  if (name === 'getAccount') {
    const _id = toObjectId(args.accountId);
    if (!_id) return { error: 'Invalid accountId' };
    const row = await accounts.findOne({ _id });
    if (!row) return { error: 'Account not found' };
    row._id = String(row._id);
    return row;
  }

  if (name === 'listAccounts') {
    const filter = {};
    if (args.name) filter.name = String(args.name).trim();
    const q = normalizeSearchText(args.q);
    if (args.parentAccountId !== undefined) {
      const parentId = String(args.parentAccountId || '').trim();
      if (parentId) {
        const parentObjId = toObjectId(parentId);
        if (!parentObjId) return { error: 'Invalid parentAccountId' };
        filter.parentAccountId = String(parentObjId);
      } else {
        filter.parentAccountId = null;
      }
    }
    const limit = Math.max(1, Math.min(200, Number(args.limit || 50)));
    const rows = await searchCollectionHybrid({
      collection: accounts,
      query: q,
      paths: ['name', 'parentAccountName', 'documentLinks.name'],
      filter,
      limit
    });
    rows.forEach((r) => { r._id = String(r._id); });
    return { accounts: rows };
  }

  if (name === 'updateAccount') {
    const accountTarget = await resolveUniqueDocumentTarget({
      collection: accounts,
      idValue: args.accountId,
      nameValue: args.accountName,
      label: 'Account',
      paths: ['name', 'parentAccountName', 'documentLinks.name']
    });
    if (accountTarget.error) {
      return accountTarget.needsDisambiguation
        ? { error: accountTarget.error, needsDisambiguation: true, candidates: accountTarget.candidates }
        : { error: accountTarget.error };
    }
    const _id = toObjectId(accountTarget.id);
    if (!_id) return { error: 'Invalid accountId' };
    if (args.clearParentAccount === true && args.parentAccountId !== undefined) {
      return { error: 'Provide either parentAccountId or clearParentAccount, not both' };
    }
    if (args.documentLinks !== undefined && args.addDocumentLinks !== undefined) {
      return { error: 'Provide either documentLinks or addDocumentLinks, not both' };
    }
    const existing = await accounts.findOne({ _id });
    if (!existing) return { error: 'Account not found' };

    const set = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) {
      const nextName = String(args.name).trim();
      if (!nextName) return { error: 'name cannot be empty' };
      set.name = nextName;
    }
    if (args.clearParentAccount === true) {
      set.parentAccountId = null;
      set.parentAccountName = null;
    } else if (args.parentAccountId !== undefined) {
      const parentId = String(args.parentAccountId || '').trim();
      if (!parentId) return { error: 'parentAccountId cannot be empty' };
      const parentRef = await resolveAccountRef(parentId);
      if (parentRef.error) return { error: parentRef.error };
      if (parentRef.accountId === String(_id)) return { error: 'An account cannot be its own parent' };
      set.parentAccountId = parentRef.accountId;
      set.parentAccountName = parentRef.accountName;
    }
    if (args.documentLinks !== undefined) {
      const replaceLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'account documentLinks');
      if (replaceLinksResult.error) return { error: replaceLinksResult.error };
      set.documentLinks = replaceLinksResult.links ?? [];
    } else if (args.addDocumentLinks !== undefined) {
      const addLinksResult = normalizeDocumentLinksInput(args.addDocumentLinks, 'account addDocumentLinks');
      if (addLinksResult.error) return { error: addLinksResult.error };
      set.documentLinks = mergeDocumentLinks(existing.documentLinks, addLinksResult.links);
    }

    const updatedAccount = await runWithOptionalTransaction(async ({ session }) => {
      const result = await accounts.updateOne({ _id }, { $set: set }, sessionOptions(session));
      if (!result.matchedCount) return null;
      const nextAccount = await accounts.findOne({ _id }, sessionOptions(session));
      if (!nextAccount) return null;
      await contacts.updateMany(
        { accountId: String(_id) },
        {
          $set: {
            accountName: nextAccount.name ? String(nextAccount.name).trim() : '',
            parentAccountId: nextAccount.parentAccountId ? String(nextAccount.parentAccountId) : null,
            parentAccountName: nextAccount.parentAccountName ? String(nextAccount.parentAccountName) : null,
            updatedAt: new Date().toISOString()
          }
        },
        sessionOptions(session)
      );
      return nextAccount;
    });
    if (!updatedAccount) return { error: 'Account not found' };
    updatedAccount._id = String(updatedAccount._id);
    return { ok: true, account: updatedAccount };
  }

  if (name === 'addWorkload') {
    const workloadName = String(args.name || '').trim();
    if (!workloadName) return { error: 'name is required' };
    const accountRef = await resolveAccountRef(args.accountId);
    if (accountRef.error) return { error: accountRef.error };
    const possibleMatches = await searchCollectionHybrid({
      collection: workloads,
      query: workloadName,
      paths: ['name', 'description', 'notes', 'accountName', 'stage', 'contacts.name', 'contacts.email'],
      filter: { accountId: accountRef.accountId },
      limit: 10
    });
    const guard = buildWorkloadCreateGuardResult({
      workloadName,
      accountName: accountRef.accountName,
      confirm: args.confirm,
      candidates: mapWorkloadCandidateRows(possibleMatches)
    });
    if (guard.block) return guard.response;
    const workloadLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'workload documentLinks');
    if (workloadLinksResult.error) return { error: workloadLinksResult.error };
    const contactRef = await resolveContactRefs(args.contactIds, accountRef.accountId);
    if (hasInputItems(args.contactIds) && contactRef.allFailed) {
      return { error: 'Unable to resolve any provided contactIds', warnings: contactRef.failures };
    }
    const stageCreateResult = parseWorkloadStage(args.stage, { defaultWhenMissing: true });
    if (!stageCreateResult.ok) return { error: stageCreateResult.error };
    const normalizedStage = stageCreateResult.stage;
    const normalizedArr = normalizeWorkloadArr(args.arr);
    if (
      args.arr !== undefined
      && normalizedArr == null
      && args.arr !== null
      && String(args.arr).trim()
    ) {
      return { error: 'arr must be a valid non-negative number (USD dollars)' };
    }
    const normalizedSalesforceLink = normalizeWorkloadUrl(args.salesforceLink);
    if (
      args.salesforceLink !== undefined
      && normalizedSalesforceLink == null
      && args.salesforceLink !== null
      && String(args.salesforceLink).trim()
    ) {
      return { error: 'salesforceLink must be a valid http(s) URL' };
    }

    const doc = {
      name: workloadName,
      description: args.description != null ? String(args.description) : null,
      notes: args.notes != null ? String(args.notes) : null,
      stage: normalizedStage,
      arr: normalizedArr,
      salesforceLink: normalizedSalesforceLink,
      documentLinks: workloadLinksResult.links ?? [],
      accountId: accountRef.accountId,
      accountName: accountRef.accountName,
      parentAccountId: accountRef.parentAccountId,
      parentAccountName: accountRef.parentAccountName,
      contactIds: contactRef.contactIds,
      contacts: contactRef.contacts,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    let workloadId = null;
    await runWithOptionalTransaction(async ({ session }) => {
      const result = await workloads.insertOne(doc, sessionOptions(session));
      workloadId = String(result.insertedId);
      if (doc.contactIds.length) {
        await addWorkloadRefToContacts(doc.contactIds, { workloadId, name: doc.name }, session);
      }
      return true;
    });
    return {
      ok: true,
      workloadId,
      workload: { ...doc, _id: workloadId },
      warnings: contactRef.failures && contactRef.failures.length ? contactRef.failures : undefined
    };
  }

  if (name === 'getWorkload') {
    const _id = toObjectId(args.workloadId);
    if (!_id) return { error: 'Invalid workloadId' };
    const row = await workloads.findOne({ _id });
    if (!row) return { error: 'Workload not found' };
    row._id = String(row._id);
    return row;
  }

  if (name === 'listWorkloads') {
    const filter = {};
    if (args.accountId) filter.accountId = String(args.accountId).trim();
    if (args.contactId) filter.contactIds = String(args.contactId).trim();
    const q = normalizeSearchText(args.q || args.name);
    const limit = Math.max(1, Math.min(500, Number(args.limit || 100)));
    const rows = await searchCollectionHybrid({
      collection: workloads,
      query: q,
      paths: ['name', 'description', 'notes', 'accountName', 'stage', 'contacts.name', 'contacts.email'],
      filter,
      limit
    });
    rows.forEach((r) => { r._id = String(r._id); });
    return { workloads: rows };
  }

  if (name === 'updateWorkload') {
    const updateAccountIdValue = args.accountId !== undefined ? String(args.accountId || '').trim() : '';
    const workloadTarget = await resolveUniqueDocumentTarget({
      collection: workloads,
      idValue: args.workloadId,
      nameValue: args.workloadName,
      label: 'Workload',
      paths: ['name', 'description', 'notes', 'accountName', 'stage'],
      exactMatchPaths: ['name'],
      filter: updateAccountIdValue ? { accountId: updateAccountIdValue } : {}
    });
    if (workloadTarget.error) {
      return workloadTarget.needsDisambiguation
        ? { error: workloadTarget.error, needsDisambiguation: true, candidates: workloadTarget.candidates }
        : { error: workloadTarget.error };
    }
    const _id = toObjectId(workloadTarget.id);
    if (!_id) return { error: 'Invalid workloadId' };
    if (args.clearContacts === true && args.contactIds !== undefined) {
      return { error: 'Provide either contactIds or clearContacts, not both' };
    }
    if (args.documentLinks !== undefined && args.addDocumentLinks !== undefined) {
      return { error: 'Provide either documentLinks or addDocumentLinks, not both' };
    }
    const existing = await workloads.findOne({ _id });
    if (!existing) return { error: 'Workload not found' };

    const set = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) {
      const nextName = String(args.name).trim();
      if (!nextName) return { error: 'name cannot be empty' };
      set.name = nextName;
    }
    if (args.description !== undefined) set.description = args.description == null ? null : String(args.description);
    if (args.notes !== undefined) set.notes = args.notes == null ? null : String(args.notes);
    if (args.stage !== undefined) {
      const stageUpdateResult = parseWorkloadStage(args.stage, { defaultWhenMissing: false });
      if (!stageUpdateResult.ok) return { error: stageUpdateResult.error };
      set.stage = stageUpdateResult.stage;
    }
    if (args.arr !== undefined) {
      const normalizedArr = normalizeWorkloadArr(args.arr);
      if (normalizedArr == null && args.arr !== null && String(args.arr).trim()) {
        return { error: 'arr must be a valid non-negative number (USD dollars)' };
      }
      set.arr = normalizedArr;
    }
    if (args.salesforceLink !== undefined) {
      const normalizedSalesforceLink = normalizeWorkloadUrl(args.salesforceLink);
      if (normalizedSalesforceLink == null && args.salesforceLink !== null && String(args.salesforceLink).trim()) {
        return { error: 'salesforceLink must be a valid http(s) URL' };
      }
      set.salesforceLink = normalizedSalesforceLink;
    }
    if (args.documentLinks !== undefined) {
      const replaceLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'workload documentLinks');
      if (replaceLinksResult.error) return { error: replaceLinksResult.error };
      set.documentLinks = replaceLinksResult.links ?? [];
    } else if (args.addDocumentLinks !== undefined) {
      const addLinksResult = normalizeDocumentLinksInput(args.addDocumentLinks, 'workload addDocumentLinks');
      if (addLinksResult.error) return { error: addLinksResult.error };
      set.documentLinks = mergeDocumentLinks(existing.documentLinks, addLinksResult.links);
    }

    let nextAccountRef = {
      accountId: String(existing.accountId || ''),
      accountName: existing.accountName ? String(existing.accountName) : '',
      parentAccountId: existing.parentAccountId ? String(existing.parentAccountId) : null,
      parentAccountName: existing.parentAccountName ? String(existing.parentAccountName) : null
    };
    if (args.accountId !== undefined) {
      const accountRef = await resolveAccountRef(args.accountId);
      if (accountRef.error) return { error: accountRef.error };
      nextAccountRef = accountRef;
      set.accountId = accountRef.accountId;
      set.accountName = accountRef.accountName;
      set.parentAccountId = accountRef.parentAccountId;
      set.parentAccountName = accountRef.parentAccountName;
    }

    let nextContactRef = null;
    const existingContactIds = Array.isArray(existing.contactIds) ? existing.contactIds.map((id) => String(id)) : [];
    if (args.clearContacts === true) {
      nextContactRef = { contactIds: [], contacts: [] };
    } else if (args.contactIds !== undefined) {
      nextContactRef = await resolveContactRefs(args.contactIds, nextAccountRef.accountId);
      if (hasInputItems(args.contactIds) && nextContactRef.allFailed) {
        return { error: 'Unable to resolve any provided contactIds', warnings: nextContactRef.failures };
      }
    }
    if (nextContactRef) {
      set.contactIds = nextContactRef.contactIds;
      set.contacts = nextContactRef.contacts;
    }

    const row = await runWithOptionalTransaction(async ({ session }) => {
      const result = await workloads.updateOne({ _id }, { $set: set }, sessionOptions(session));
      if (!result.matchedCount) return null;
      const nextRow = await workloads.findOne({ _id }, sessionOptions(session));
      if (!nextRow) return null;

      const nextContactIds = Array.isArray(nextRow.contactIds) ? nextRow.contactIds.map((id) => String(id)) : [];
      const previousSet = new Set(existingContactIds);
      const nextSet = new Set(nextContactIds);
      const removedIds = existingContactIds.filter((id) => !nextSet.has(id));
      const addedIds = nextContactIds.filter((id) => !previousSet.has(id));
      const workloadId = String(_id);
      if (removedIds.length) await removeWorkloadRefFromContacts(removedIds, workloadId, session);
      if (addedIds.length) {
        await addWorkloadRefToContacts(addedIds, { workloadId, name: String(nextRow?.name || '').trim() || null }, session);
      }
      if (set.name !== undefined) await syncWorkloadNameOnContacts(workloadId, String(set.name || '').trim() || null, session);
      return nextRow;
    });
    if (!row) return { error: 'Workload not found' };
    row._id = String(row._id);
    return {
      ok: true,
      workload: row,
      warnings: nextContactRef?.failures && nextContactRef.failures.length ? nextContactRef.failures : undefined
    };
  }

  return undefined;
}

async function handleUserProfileMongoTool(name, args, context) {
  const { db, toolContext } = context;
  if (name !== 'updateUserProfileMemory') return undefined;
  const toolUserId = toolContext?.userId ? String(toolContext.userId).trim() : '';
  if (!toolUserId) return { error: 'Cannot update user profile memory without userId context.' };
  const { patch, invalidKeys } = sanitizeUserProfilePatch(args?.patch);
  if (!patch || !Object.keys(patch).length) {
    return { error: 'patch must include at least one allowed profile field.', invalidKeys };
  }
  const sourceRaw = args?.source ? String(args.source).trim() : 'user_input';
  const source = PROFILE_ALLOWED_SOURCE_VALUES.has(sourceRaw) ? sourceRaw : 'user_input';
  const profile = await upsertUserProfile(db, memoryConfig, {
    userId: toolUserId,
    patch,
    source
  });
  return { ok: true, userId: toolUserId, profile, invalidKeys };
}

async function handleMilestoneMongoTool(name, args, context) {
  const {
    milestones,
    workloads,
    resolveAccountRef,
    resolveWorkloadRefs,
    resolveUniqueDocumentTarget,
    hasInputItems
  } = context;

  if (name === 'addMilestone') {
    const milestoneName = String(args.name || '').trim();
    if (!milestoneName) return { error: 'name is required' };
    const normalizedDate = normalizeMilestoneDate(args.milestoneDate);
    if (!normalizedDate) return { error: 'milestoneDate must be a valid date (YYYY-MM-DD) or month (YYYY-MM)' };
    const normalizedStatus = normalizeMilestoneStatus(args.status, { defaultWhenMissing: true });
    if (!normalizedStatus) return { error: `status must be one of: ${MILESTONE_STATUS_VALUES.join(', ')}` };
    const nowIso = new Date().toISOString();
    const accountIdValue = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    let accountRef = null;
    if (accountIdValue !== undefined) {
      accountRef = await resolveAccountRef(accountIdValue);
      if (accountRef.error) return { error: accountRef.error };
    }
    const workloadRefResult = await resolveWorkloadRefs(args.workloadIds, accountRef ? accountRef.accountId : null);
    if (hasInputItems(args.workloadIds) && workloadRefResult.allFailed) {
      return { error: 'Unable to resolve any provided workloadIds', warnings: workloadRefResult.failures };
    }
    const normalizedNotes = normalizeMilestoneNotesArray(args.notes, nowIso);
    if (normalizedNotes.error) return { error: normalizedNotes.error };
    let normalizedNarr;
    if (args.narr !== undefined) {
      normalizedNarr = normalizeWorkloadArr(args.narr);
      if (normalizedNarr == null && args.narr !== null && String(args.narr).trim()) {
        return { error: 'narr must be a valid non-negative number (USD dollars)' };
      }
    } else {
      const workloadRefs = Array.isArray(workloadRefResult.workloadRefs) ? workloadRefResult.workloadRefs : [];
      const workloadObjectIds = workloadRefs.map((ref) => toObjectId(ref.workloadId)).filter(Boolean);
      const workloadRows = workloadObjectIds.length ? await workloads.find({ _id: { $in: workloadObjectIds } }).toArray() : [];
      normalizedNarr = sumWorkloadArrFromRefs(workloadRows);
    }
    const doc = {
      name: milestoneName,
      description: args.description != null ? String(args.description) : null,
      milestoneDate: normalizedDate,
      notes: normalizedNotes.notes,
      workloadIds: workloadRefResult.workloadRefs ?? [],
      accountId: accountRef ? accountRef.accountId : null,
      accountName: accountRef ? accountRef.accountName : null,
      parentAccountId: accountRef ? accountRef.parentAccountId : null,
      parentAccountName: accountRef ? accountRef.parentAccountName : null,
      narr: normalizedNarr == null ? null : normalizedNarr,
      status: normalizedStatus,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    const result = await milestones.insertOne(doc);
    return {
      ok: true,
      milestoneId: String(result.insertedId),
      milestone: normalizeMilestoneForRead({ ...doc, _id: String(result.insertedId) }),
      warnings: workloadRefResult.failures && workloadRefResult.failures.length ? workloadRefResult.failures : undefined
    };
  }

  if (name === 'getMilestone') {
    const _id = toObjectId(args.milestoneId);
    if (!_id) return { error: 'Invalid milestoneId' };
    const row = await milestones.findOne({ _id });
    if (!row) return { error: 'Milestone not found' };
    return normalizeMilestoneForRead(row);
  }

  if (name === 'listMilestones') {
    const filter = {};
    const listAccountId = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    if (listAccountId) filter.accountId = String(listAccountId).trim();
    const workloadId = pickFirstDefined(args || {}, ['workloadId', 'WorkloadId']);
    if (workloadId) filter['workloadIds.workloadId'] = String(workloadId).trim();
    if (args.status !== undefined) {
      const parsedStatus = normalizeMilestoneStatus(args.status, { defaultWhenMissing: false });
      if (!parsedStatus) return { error: `status must be one of: ${MILESTONE_STATUS_VALUES.join(', ')}` };
      filter.status = parsedStatus;
    }
    const fromDateRaw = pickFirstDefined(args || {}, ['from', 'startDate']);
    const toDateRaw = pickFirstDefined(args || {}, ['to', 'endDate']);
    if (fromDateRaw !== undefined) {
      const fromDate = normalizeMilestoneDateBoundary(fromDateRaw, 'from');
      if (!fromDate) return { error: 'from must be a valid date (YYYY-MM-DD) or month (YYYY-MM)' };
      filter.milestoneDate = { ...(filter.milestoneDate || {}), $gte: fromDate };
    }
    if (toDateRaw !== undefined) {
      const toDate = normalizeMilestoneDateBoundary(toDateRaw, 'to');
      if (!toDate) return { error: 'to must be a valid date (YYYY-MM-DD) or month (YYYY-MM)' };
      filter.milestoneDate = { ...(filter.milestoneDate || {}), $lte: toDate };
    }
    const q = normalizeSearchText(args.q || args.milestoneName);
    const limit = Math.max(1, Math.min(500, Number(args.limit || 200)));
    const rows = await searchCollectionHybrid({
      collection: milestones,
      query: q,
      paths: ['name', 'description', 'status', 'accountName', 'workloadIds.name', 'notes.text'],
      filter,
      limit
    });
    rows.sort((a, b) => {
      const dateCmp = String(a?.milestoneDate || '').localeCompare(String(b?.milestoneDate || ''));
      if (dateCmp !== 0) return dateCmp;
      return String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''));
    });
    return { milestones: rows.map((row) => normalizeMilestoneForRead(row)) };
  }

  if (name === 'updateMilestone') {
    const milestoneTarget = await resolveUniqueDocumentTarget({
      collection: milestones,
      idValue: args.milestoneId,
      nameValue: args.milestoneName,
      label: 'Milestone',
      paths: ['name', 'description', 'status', 'accountName', 'workloadIds.name', 'notes.text'],
      exactMatchPaths: ['name'],
      candidateLabel: (row) => String(row?.name || '').trim()
    });
    if (milestoneTarget.error) {
      return milestoneTarget.needsDisambiguation
        ? { error: milestoneTarget.error, needsDisambiguation: true, candidates: milestoneTarget.candidates }
        : { error: milestoneTarget.error };
    }
    const _id = toObjectId(milestoneTarget.id);
    if (!_id) return { error: 'Invalid milestoneId' };
    const existing = await milestones.findOne({ _id });
    if (!existing) return { error: 'Milestone not found' };
    if (args.accountId !== undefined && args.clearAccount === true) {
      return { error: 'Provide either accountId or clearAccount, not both' };
    }
    if (args.workloadIds !== undefined && args.clearWorkloads === true) {
      return { error: 'Provide either workloadIds or clearWorkloads, not both' };
    }
    const nowIso = new Date().toISOString();
    const set = { updatedAt: nowIso };
    if (args.name !== undefined) {
      const nextName = String(args.name || '').trim();
      if (!nextName) return { error: 'name cannot be empty' };
      set.name = nextName;
    }
    if (args.description !== undefined) set.description = args.description == null ? null : String(args.description);
    if (args.milestoneDate !== undefined) {
      const nextDate = normalizeMilestoneDate(args.milestoneDate);
      if (!nextDate) return { error: 'milestoneDate must be a valid date (YYYY-MM-DD) or month (YYYY-MM)' };
      set.milestoneDate = nextDate;
    }
    if (args.status !== undefined) {
      const nextStatus = normalizeMilestoneStatus(args.status, { defaultWhenMissing: false });
      if (!nextStatus) return { error: `status must be one of: ${MILESTONE_STATUS_VALUES.join(', ')}` };
      set.status = nextStatus;
    }
    const hasReplaceNotes = args.notes !== undefined;
    const hasAddNote = args.addNote !== undefined;
    const hasEditNote = args.editNote !== undefined;
    const hasRemoveNote = args.removeNoteId !== undefined;
    const hasClearNotes = args.clearNotes === true;
    const noteOpsCount = [hasReplaceNotes, hasAddNote, hasEditNote, hasRemoveNote, hasClearNotes].filter(Boolean).length;
    if (hasReplaceNotes && noteOpsCount > 1) {
      return { error: 'notes replacement cannot be combined with addNote/editNote/removeNoteId/clearNotes' };
    }
    if (hasClearNotes && noteOpsCount > 1) {
      return { error: 'clearNotes cannot be combined with notes/addNote/editNote/removeNoteId' };
    }
    if (hasReplaceNotes) {
      const normalized = normalizeMilestoneNotesArray(args.notes, nowIso);
      if (normalized.error) return { error: normalized.error };
      set.notes = normalized.notes;
    } else if (hasClearNotes) {
      set.notes = [];
    } else if (hasAddNote || hasEditNote || hasRemoveNote) {
      const nextNotes = normalizeStoredMilestoneNotes(existing.notes);
      if (hasAddNote) {
        const built = buildMilestoneNote(args.addNote, nowIso);
        if (built.error) return { error: built.error };
        nextNotes.push(built.note);
      }
      if (hasEditNote) {
        if (!args.editNote || typeof args.editNote !== 'object' || Array.isArray(args.editNote)) {
          return { error: 'editNote must be an object containing id and optional text/author' };
        }
        const noteId = String(args.editNote.id || '').trim();
        if (!noteId) return { error: 'editNote.id is required' };
        const idx = nextNotes.findIndex((note) => String(note.id) === noteId);
        if (idx === -1) return { error: `Note not found: ${noteId}` };
        const current = nextNotes[idx];
        const hasText = args.editNote.text !== undefined;
        const hasAuthor = args.editNote.author !== undefined;
        if (!hasText && !hasAuthor) return { error: 'editNote must include text or author to update' };
        const nextText = hasText ? String(args.editNote.text || '').trim() : current.text;
        const nextAuthor = hasAuthor ? String(args.editNote.author || '').trim() : current.author;
        if (!nextText) return { error: 'editNote.text cannot be empty' };
        if (!nextAuthor) return { error: 'editNote.author cannot be empty' };
        nextNotes[idx] = { ...current, text: nextText, author: nextAuthor, updatedAt: nowIso };
      }
      if (hasRemoveNote) {
        const removeId = String(args.removeNoteId || '').trim();
        if (!removeId) return { error: 'removeNoteId cannot be empty' };
        const filtered = nextNotes.filter((note) => String(note.id) !== removeId);
        if (filtered.length === nextNotes.length) return { error: `Note not found: ${removeId}` };
        set.notes = filtered;
      } else {
        set.notes = nextNotes;
      }
    } else if (existing.notes !== undefined) {
      set.notes = normalizeStoredMilestoneNotes(existing.notes);
    }

    if (args.clearAccount === true) {
      set.accountId = null;
      set.accountName = null;
      set.parentAccountId = null;
      set.parentAccountName = null;
    } else if (args.accountId !== undefined) {
      const accountRef = await resolveAccountRef(args.accountId);
      if (accountRef.error) return { error: accountRef.error };
      set.accountId = accountRef.accountId;
      set.accountName = accountRef.accountName;
      set.parentAccountId = accountRef.parentAccountId;
      set.parentAccountName = accountRef.parentAccountName;
    }

    if (args.clearWorkloads === true) {
      set.workloadIds = [];
    } else if (args.workloadIds !== undefined) {
      const accountIdForWorkloadCheck = set.accountId !== undefined ? set.accountId : String(existing.accountId || '').trim() || null;
      const workloadRefResult = await resolveWorkloadRefs(args.workloadIds, accountIdForWorkloadCheck);
      if (hasInputItems(args.workloadIds) && workloadRefResult.allFailed) {
        return { error: 'Unable to resolve any provided workloadIds', warnings: workloadRefResult.failures };
      }
      set.workloadIds = workloadRefResult.workloadRefs ?? [];
    }

    if (args.narr !== undefined) {
      const normalizedNarr = normalizeWorkloadArr(args.narr);
      if (normalizedNarr == null && args.narr !== null && String(args.narr).trim()) {
        return { error: 'narr must be a valid non-negative number (USD dollars)' };
      }
      set.narr = normalizedNarr;
    }

    const result = await milestones.updateOne({ _id }, { $set: set });
    if (!result.matchedCount) return { error: 'Milestone not found' };
    const row = await milestones.findOne({ _id });
    return { ok: true, milestone: normalizeMilestoneForRead(row) };
  }

  return undefined;
}

async function handleInitiativeMongoTool(name, args, context) {
  const {
    initiatives,
    contacts,
    workloads,
    resolveInitiativeAccounts,
    resolveContactRefsForAccountSet,
    resolveWorkloadRefsForAccountSet,
    enrichInitiativeDoc,
    hasInputItems,
    resolveUniqueDocumentTarget
  } = context;

  if (name === 'addInitiative') {
    const iname = String(args.initiativeName || '').trim();
    if (!iname) return { error: 'initiativeName is required' };
    const ar = await resolveInitiativeAccounts(args.accountIds);
    if (ar.error) return { error: ar.error, failures: ar.failures };
    const allowedIds = Array.from(ar.accountIdSet);
    let contactRef = { contactIds: [], contacts: [], failures: [] };
    if (hasInputItems(args.contactIds)) {
      contactRef = await resolveContactRefsForAccountSet(args.contactIds, allowedIds);
      if (contactRef.allFailed) return { error: 'Unable to resolve any provided contactIds', warnings: contactRef.failures };
    }
    let workloadRef = { workloadRefs: [], failures: [] };
    if (hasInputItems(args.workloadIds)) {
      workloadRef = await resolveWorkloadRefsForAccountSet(args.workloadIds, allowedIds);
      if (workloadRef.allFailed) return { error: 'Unable to resolve any provided workloadIds', warnings: workloadRef.failures };
    }
    let normalizedTargetedErr = null;
    if (args.targetedErr !== undefined) {
      normalizedTargetedErr = normalizeWorkloadArr(args.targetedErr);
      if (normalizedTargetedErr == null && args.targetedErr !== null && String(args.targetedErr).trim()) {
        return { error: 'targetedErr must be a valid non-negative number (USD dollars)' };
      }
    }
    const nowIso = new Date().toISOString();
    let initiativeNameEmbedding = null;
    let embeddingModel = null;
    let embeddedAt = null;
    let embeddingWarning = null;
    const emb = await embedSingleText(iname);
    if (emb.error || !emb.embedding) {
      embeddingWarning = emb.error || 'embedding_unavailable';
    } else {
      initiativeNameEmbedding = emb.embedding;
      embeddingModel = emb.model || null;
      embeddedAt = nowIso;
    }
    const initiativeContacts = (contactRef.contacts || []).map((c) => ({
      contactId: c.contactId,
      name: c.name,
      title: c.title != null && String(c.title).trim() ? String(c.title).trim() : null,
      linkedIn: c.linkedIn != null && String(c.linkedIn).trim() ? String(c.linkedIn).trim() : null
    }));
    const doc = {
      initiativeName: iname,
      initiativeDescription: args.initiativeDescription != null ? String(args.initiativeDescription) : null,
      accounts: ar.accounts,
      initiativeContacts,
      initiativeWorkloads: workloadRef.workloadRefs || [],
      targetedErr: normalizedTargetedErr,
      initiativeNameEmbedding,
      embeddingModel,
      embeddedAt,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    const result = await initiatives.insertOne(doc);
    const row = await initiatives.findOne({ _id: result.insertedId });
    const enriched = await enrichInitiativeDoc(row);
    if (enriched) delete enriched.initiativeNameEmbedding;
    const warn = [].concat(ar.failures || []).concat(contactRef.failures || []).concat(workloadRef.failures || []);
    return {
      ok: true,
      initiativeId: String(result.insertedId),
      initiative: enriched,
      warnings: warn.length ? warn : undefined,
      embeddingWarning: embeddingWarning || undefined
    };
  }

  if (name === 'getInitiative') {
    const _id = toObjectId(args.initiativeId);
    if (!_id) return { error: 'Invalid initiativeId' };
    const row = await initiatives.findOne({ _id });
    if (!row) return { error: 'Initiative not found' };
    const enriched = await enrichInitiativeDoc(row);
    if (enriched) delete enriched.initiativeNameEmbedding;
    return enriched;
  }

  if (name === 'listInitiatives') {
    const filter = {};
    const aid = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    if (aid) filter['accounts.accountId'] = String(aid).trim();
    const q = normalizeSearchText(args.q);
    const limit = Math.max(1, Math.min(500, Number(args.limit || 100)));
    const rows = await searchCollectionHybrid({
      collection: initiatives,
      query: q,
      paths: ['initiativeName', 'initiativeDescription'],
      filter,
      limit
    });
    const enriched = await Promise.all(rows.map((r) => enrichInitiativeDoc(r)));
    for (const e of enriched) if (e) delete e.initiativeNameEmbedding;
    return { initiatives: enriched };
  }

  if (name === 'searchInitiatives') {
    const q = normalizeSearchText(args.q);
    if (!q) return { error: 'q is required' };
    const limit = Math.max(1, Math.min(100, Number(args.limit || 25)));
    const aid = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    const vsFilter = aid ? { accounts: { $elemMatch: { accountId: String(aid).trim() } } } : undefined;
    const vectorIndexName = String(MONGO_INITIATIVES_VECTOR_INDEX || 'initiatives_vector').trim() || 'initiatives_vector';
    let rows = [];
    let searchMode = 'text';
    let vectorError = null;
    if (isAtlasSearchEnabled()) {
      const vs = await searchInitiativesByVector({
        collection: initiatives,
        queryText: q,
        filter: vsFilter,
        limit,
        vectorIndexName
      });
      vectorError = vs.vectorError;
      rows = vs.rows || [];
      if (rows.length) searchMode = 'vector';
    }
    if (!rows.length) {
      searchMode = searchMode !== 'vector' ? 'text' : (vectorError ? 'text_fallback' : 'text');
      const filter = {};
      if (aid) filter['accounts.accountId'] = String(aid).trim();
      rows = await searchCollectionHybrid({
        collection: initiatives,
        query: q,
        paths: ['initiativeName', 'initiativeDescription'],
        filter,
        limit
      });
    }
    const enriched = await Promise.all(rows.map((r) => enrichInitiativeDoc(r)));
    for (const e of enriched) if (e) delete e.initiativeNameEmbedding;
    return { initiatives: enriched, searchMode, vectorError: vectorError || undefined };
  }

  if (name === 'updateInitiative') {
    const lookupName = pickFirstDefined(args || {}, ['initiativeNameLookup', 'initiativeLookupName']);
    const initiativeTarget = await resolveUniqueDocumentTarget({
      collection: initiatives,
      idValue: args.initiativeId,
      nameValue: lookupName || (args.initiativeId ? undefined : args.initiativeName),
      label: 'Initiative',
      paths: ['initiativeName', 'initiativeDescription'],
      exactMatchPaths: ['initiativeName'],
      candidateLabel: (row) => String(row?.initiativeName || '').trim()
    });
    if (initiativeTarget.error) {
      return initiativeTarget.needsDisambiguation
        ? { error: initiativeTarget.error, needsDisambiguation: true, candidates: initiativeTarget.candidates }
        : { error: initiativeTarget.error };
    }
    const _id = toObjectId(initiativeTarget.id);
    if (!_id) return { error: 'Invalid initiativeId' };
    const existing = await initiatives.findOne({ _id });
    if (!existing) return { error: 'Initiative not found' };
    if (args.contactIds !== undefined && args.clearContacts === true) return { error: 'Provide either contactIds or clearContacts, not both' };
    if (args.workloadIds !== undefined && args.clearWorkloads === true) return { error: 'Provide either workloadIds or clearWorkloads, not both' };

    const nowIso = new Date().toISOString();
    const set = { updatedAt: nowIso };
    const pruneWarnings = [];
    let nextAccounts = Array.isArray(existing.accounts) ? existing.accounts : [];
    let accountIdSet = new Set(nextAccounts.map((a) => String(a.accountId || '').trim()).filter(Boolean));

    if (args.accountIds !== undefined) {
      const ar = await resolveInitiativeAccounts(args.accountIds);
      if (ar.error) return { error: ar.error, failures: ar.failures };
      nextAccounts = ar.accounts;
      accountIdSet = ar.accountIdSet;
      set.accounts = nextAccounts;
    }

    const allowedIds = Array.from(accountIdSet);
    let nextContacts = Array.isArray(existing.initiativeContacts) ? [...existing.initiativeContacts] : [];
    if (args.clearContacts === true) {
      nextContacts = [];
      set.initiativeContacts = [];
    } else if (args.contactIds !== undefined) {
      const cr = await resolveContactRefsForAccountSet(args.contactIds, allowedIds);
      if (hasInputItems(args.contactIds) && cr.allFailed) return { error: 'Unable to resolve any provided contactIds', warnings: cr.failures };
      nextContacts = (cr.contacts || []).map((c) => ({
        contactId: c.contactId,
        name: c.name,
        title: c.title != null && String(c.title).trim() ? String(c.title).trim() : null,
        linkedIn: c.linkedIn != null && String(c.linkedIn).trim() ? String(c.linkedIn).trim() : null
      }));
      set.initiativeContacts = nextContacts;
    } else if (args.accountIds !== undefined && allowedIds.length) {
      const cids = nextContacts.map((c) => toObjectId(c.contactId)).filter(Boolean);
      const cRows = cids.length ? await contacts.find({ _id: { $in: cids } }).toArray() : [];
      const byC = new Map(cRows.map((r) => [String(r._id), r]));
      const filtered = [];
      for (const ref of nextContacts) {
        const row = byC.get(String(ref.contactId));
        if (row && accountIdSet.has(String(row.accountId || ''))) {
          filtered.push({
            contactId: String(ref.contactId),
            name: row.name ? String(row.name) : ref.name,
            title: row.title != null && String(row.title).trim() ? String(row.title).trim() : null,
            linkedIn: row.linkedIn != null && String(row.linkedIn).trim() ? String(row.linkedIn).trim() : null
          });
        } else {
          pruneWarnings.push({ contactId: String(ref.contactId), reason: 'account_mismatch' });
        }
      }
      nextContacts = filtered;
      set.initiativeContacts = nextContacts;
    }

    let nextWorkloads = Array.isArray(existing.initiativeWorkloads) ? [...existing.initiativeWorkloads] : [];
    if (args.clearWorkloads === true) {
      nextWorkloads = [];
      set.initiativeWorkloads = [];
    } else if (args.workloadIds !== undefined) {
      const wr = await resolveWorkloadRefsForAccountSet(args.workloadIds, allowedIds);
      if (hasInputItems(args.workloadIds) && wr.allFailed) return { error: 'Unable to resolve any provided workloadIds', warnings: wr.failures };
      nextWorkloads = wr.workloadRefs || [];
      set.initiativeWorkloads = nextWorkloads;
    } else if (args.accountIds !== undefined && allowedIds.length) {
      const wids = nextWorkloads.map((w) => toObjectId(w.workloadId)).filter(Boolean);
      const wRows = wids.length ? await workloads.find({ _id: { $in: wids } }).toArray() : [];
      const byW = new Map(wRows.map((r) => [String(r._id), r]));
      const filteredW = [];
      for (const ref of nextWorkloads) {
        const row = byW.get(String(ref.workloadId));
        if (row && accountIdSet.has(String(row.accountId || ''))) {
          filteredW.push({ workloadId: String(ref.workloadId), name: String(row.name || '').trim() || ref.name });
        } else {
          pruneWarnings.push({ workloadId: String(ref.workloadId), reason: 'account_mismatch' });
        }
      }
      nextWorkloads = filteredW;
      set.initiativeWorkloads = nextWorkloads;
    }

    if (args.initiativeName !== undefined) {
      const nn = String(args.initiativeName || '').trim();
      if (!nn) return { error: 'initiativeName cannot be empty' };
      set.initiativeName = nn;
    }
    if (args.initiativeDescription !== undefined) set.initiativeDescription = args.initiativeDescription == null ? null : String(args.initiativeDescription);
    if (args.targetedErr !== undefined) {
      const te = normalizeWorkloadArr(args.targetedErr);
      if (te == null && args.targetedErr !== null && String(args.targetedErr).trim()) {
        return { error: 'targetedErr must be a valid non-negative number (USD dollars)' };
      }
      set.targetedErr = te;
    }

    let embeddingWarning = null;
    const nameChanged = set.initiativeName !== undefined && String(set.initiativeName) !== String(existing.initiativeName || '');
    if (nameChanged) {
      const emb = await embedSingleText(String(set.initiativeName));
      if (emb.error || !emb.embedding) {
        set.embeddingModel = null;
        set.embeddedAt = null;
        set.initiativeNameEmbedding = null;
        embeddingWarning = emb.error || 'embedding_unavailable';
      } else {
        set.initiativeNameEmbedding = emb.embedding;
        set.embeddingModel = emb.model || null;
        set.embeddedAt = nowIso;
      }
    }

    const result = await initiatives.updateOne({ _id }, { $set: set });
    if (!result.matchedCount) return { error: 'Initiative not found' };
    const row = await initiatives.findOne({ _id });
    const enriched = await enrichInitiativeDoc(row);
    if (enriched) delete enriched.initiativeNameEmbedding;
    return {
      ok: true,
      initiative: enriched,
      warnings: pruneWarnings.length ? pruneWarnings : undefined,
      embeddingWarning: embeddingWarning || undefined
    };
  }

  return undefined;
}

async function runMongoTool(name, args, _toolContext = {}) {
  await ensureCrmSetup();
  const db = await getMongoDb();
  const crmActorUserId = resolveCrmActor(_toolContext);
  if (!crmActorUserId) return { error: 'Cannot use CRM tools without userId context.' };
  const visibleOwnerUserIds = await getVisibleOwnerUserIds(db, {
    userId: crmActorUserId,
    userProfilesCollection: memoryConfig.userProfilesCollection
  });
  if (!visibleOwnerUserIds.length) return { error: 'Cannot use CRM tools without user visibility scope.' };
  const auditActorId = resolveAuditActorId(_toolContext);
  const taskLists = withVisibleCollection(withAuditedCollection(db.collection(MONGO_TASK_LISTS_COLLECTION), auditActorId), visibleOwnerUserIds);
  const tasks = withVisibleCollection(withAuditedCollection(db.collection(MONGO_TASKS_COLLECTION), auditActorId), visibleOwnerUserIds);
  const contacts = withVisibleCollection(withAuditedCollection(db.collection(MONGO_CONTACTS_COLLECTION), auditActorId), visibleOwnerUserIds);
  const accounts = withVisibleCollection(withAuditedCollection(db.collection(MONGO_ACCOUNTS_COLLECTION), auditActorId), visibleOwnerUserIds);
  const workloads = withVisibleCollection(withAuditedCollection(db.collection(MONGO_WORKLOADS_COLLECTION), auditActorId), visibleOwnerUserIds);
  const milestones = withVisibleCollection(withAuditedCollection(db.collection(MONGO_MILESTONES_COLLECTION), auditActorId), visibleOwnerUserIds);
  const initiatives = withVisibleCollection(withAuditedCollection(db.collection(MONGO_INITIATIVES_COLLECTION), auditActorId), visibleOwnerUserIds);
  const sessionOptions = (session) => (session ? { session } : undefined);

  const taskToolResult = await handleTaskMongoTool(name, args, { taskLists, tasks, sessionOptions, visibleOwnerUserIds });
  if (taskToolResult !== undefined) return taskToolResult;

  const userProfileToolResult = await handleUserProfileMongoTool(name, args, { db, toolContext: _toolContext });
  if (userProfileToolResult !== undefined) return userProfileToolResult;

  const resolveAccountRef = async (accountId, session = null) => {
    const trimmedId = String(accountId || '').trim();
    if (!trimmedId) return { error: 'accountId is required' };
    const _id = toObjectId(trimmedId);
    if (!_id) return { error: 'Invalid accountId' };
    const account = await accounts.findOne({ _id }, sessionOptions(session));
    if (!account) return { error: 'Account not found' };
    const access = assertDocumentAccessible(account, visibleOwnerUserIds, 'Account');
    if (!access.ok) return { error: access.error };
    return {
      accountId: String(account._id),
      accountName: String(account.name || '').trim(),
      parentAccountId: account.parentAccountId ? String(account.parentAccountId) : null,
      parentAccountName: account.parentAccountName ? String(account.parentAccountName) : null
    };
  };

  const resolveContactRefs = async (contactIds, expectedAccountId, session = null) => {
    const ids = Array.isArray(contactIds) ? contactIds : [];
    const deduped = [];
    const seen = new Set();
    for (const id of ids) {
      const trimmed = String(id || '').trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      deduped.push(trimmed);
    }
    if (!deduped.length) return { contactIds: [], contacts: [], failures: [], allFailed: false };

    const objectIds = [];
    const validIds = [];
    const failures = [];
    for (const id of deduped) {
      const parsed = toObjectId(id);
      if (!parsed) {
        failures.push({ id, reason: 'invalid_id', message: `Invalid contactId: ${id}` });
        continue;
      }
      objectIds.push(parsed);
      validIds.push(id);
    }
    if (!validIds.length) return { contactIds: [], contacts: [], failures, allFailed: true };
    const rows = await contacts.find({ _id: { $in: objectIds } }, sessionOptions(session)).toArray();

    const byId = new Map(rows.map((row) => [String(row._id), row]));
    const refs = [];
    const resolvedIds = [];
    for (const contactId of validIds) {
      const row = byId.get(contactId);
      if (!row) {
        failures.push({ id: contactId, reason: 'not_found', message: `Contact not found: ${contactId}` });
        continue;
      }
      if (expectedAccountId && String(row.accountId || '') !== String(expectedAccountId)) {
        failures.push({
          id: contactId,
          reason: 'account_mismatch',
          message: `Contact ${contactId} does not belong to accountId ${expectedAccountId}`
        });
        continue;
      }
      refs.push({
        contactId,
        name: row.name ? String(row.name) : null,
        title: row.title ? String(row.title) : null,
        email: row.email ? String(row.email) : null
      });
      resolvedIds.push(contactId);
    }
    return { contactIds: resolvedIds, contacts: refs, failures, allFailed: resolvedIds.length === 0 && failures.length > 0 };
  };

  const normalizeStoredWorkloadRefs = (rawWorkloadIds) => {
    const refs = normalizeContactWorkloadRefs(rawWorkloadIds) || [];
    return refs.map((ref) => ({
      workloadId: String(ref.workloadId || '').trim(),
      name: ref.name == null ? null : String(ref.name).trim() || null
    })).filter((ref) => ref.workloadId);
  };

  const resolveWorkloadRefs = async (rawWorkloadIds, expectedAccountId, session = null) => {
    const parsedRefs = normalizeContactWorkloadRefs(rawWorkloadIds);
    if (parsedRefs === undefined) return { workloadRefs: undefined, failures: [], allFailed: false };
    if (!parsedRefs.length) return { workloadRefs: [], failures: [], allFailed: false };
    const dedupedIds = [];
    for (const ref of parsedRefs) {
      const workloadId = String(ref.workloadId || '').trim();
      if (workloadId) dedupedIds.push(workloadId);
    }
    const objectIds = [];
    const validIds = [];
    const failures = [];
    for (const id of dedupedIds) {
      const parsed = toObjectId(id);
      if (!parsed) {
        failures.push({ id, reason: 'invalid_id', message: `Invalid workloadId: ${id}` });
        continue;
      }
      objectIds.push(parsed);
      validIds.push(id);
    }
    if (!validIds.length) return { workloadRefs: [], failures, allFailed: true };
    const rows = await workloads.find({ _id: { $in: objectIds } }, sessionOptions(session)).toArray();
    const byId = new Map(rows.map((row) => [String(row._id), row]));
    const refs = [];
    for (const id of validIds) {
      const row = byId.get(id);
      if (!row) {
        failures.push({ id, reason: 'not_found', message: `Workload not found: ${id}` });
        continue;
      }
      if (expectedAccountId && String(row.accountId || '') !== String(expectedAccountId)) {
        failures.push({
          id,
          reason: 'account_mismatch',
          message: `Workload ${id} does not belong to accountId ${expectedAccountId}`
        });
        continue;
      }
      const name = String(row.name || '').trim() || null;
      refs.push({ workloadId: id, name });
    }
    return { workloadRefs: refs, failures, allFailed: refs.length === 0 && failures.length > 0 };
  };

  const resolveWorkloadRefsForAccountSet = async (rawWorkloadIds, allowedAccountIds) => {
    const allowedSet = new Set(
      (Array.isArray(allowedAccountIds) ? allowedAccountIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    );
    const parsedRefs = normalizeContactWorkloadRefs(rawWorkloadIds);
    if (parsedRefs === undefined) return { workloadRefs: undefined, failures: [], allFailed: false };
    if (!parsedRefs.length) return { workloadRefs: [], failures: [], allFailed: false };
    const dedupedIds = [];
    for (const ref of parsedRefs) {
      const workloadId = String(ref.workloadId || '').trim();
      if (workloadId) dedupedIds.push(workloadId);
    }
    const objectIds = [];
    const validIds = [];
    const failures = [];
    for (const id of dedupedIds) {
      const parsed = toObjectId(id);
      if (!parsed) {
        failures.push({ id, reason: 'invalid_id', message: `Invalid workloadId: ${id}` });
        continue;
      }
      objectIds.push(parsed);
      validIds.push(id);
    }
    if (!validIds.length) return { workloadRefs: [], failures, allFailed: true };
    const rows = await workloads.find({ _id: { $in: objectIds } }).toArray();
    const byId = new Map(rows.map((row) => [String(row._id), row]));
    const refs = [];
    for (const id of validIds) {
      const row = byId.get(id);
      if (!row) {
        failures.push({ id, reason: 'not_found', message: `Workload not found: ${id}` });
        continue;
      }
      if (allowedSet.size && !allowedSet.has(String(row.accountId || ''))) {
        failures.push({
          id,
          reason: 'account_mismatch',
          message: `Workload ${id} does not belong to any initiative account`
        });
        continue;
      }
      const wname = String(row.name || '').trim() || null;
      refs.push({ workloadId: id, name: wname });
    }
    return { workloadRefs: refs, failures, allFailed: refs.length === 0 && failures.length > 0 };
  };

  const resolveContactRefsForAccountSet = async (contactIds, allowedAccountIds) => {
    const allowedSet = new Set(
      (Array.isArray(allowedAccountIds) ? allowedAccountIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    );
    const ids = Array.isArray(contactIds) ? contactIds : [];
    const deduped = [];
    const seen = new Set();
    for (const id of ids) {
      const trimmed = String(id || '').trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      deduped.push(trimmed);
    }
    if (!deduped.length) return { contactIds: [], contacts: [], failures: [], allFailed: false };

    const objectIds = [];
    const validIds = [];
    const failures = [];
    for (const id of deduped) {
      const parsed = toObjectId(id);
      if (!parsed) {
        failures.push({ id, reason: 'invalid_id', message: `Invalid contactId: ${id}` });
        continue;
      }
      objectIds.push(parsed);
      validIds.push(id);
    }
    if (!validIds.length) return { contactIds: [], contacts: [], failures, allFailed: true };
    const rows = await contacts.find({ _id: { $in: objectIds } }).toArray();
    const byId = new Map(rows.map((row) => [String(row._id), row]));
    const refs = [];
    const resolvedIds = [];
    for (const contactId of validIds) {
      const row = byId.get(contactId);
      if (!row) {
        failures.push({ id: contactId, reason: 'not_found', message: `Contact not found: ${contactId}` });
        continue;
      }
      if (allowedSet.size && !allowedSet.has(String(row.accountId || ''))) {
        failures.push({
          id: contactId,
          reason: 'account_mismatch',
          message: `Contact ${contactId} does not belong to any initiative account`
        });
        continue;
      }
      refs.push({
        contactId,
        name: row.name ? String(row.name) : null,
        title: row.title ? String(row.title) : null,
        email: row.email ? String(row.email) : null,
        linkedIn: row.linkedIn != null && String(row.linkedIn).trim() ? String(row.linkedIn).trim() : null
      });
      resolvedIds.push(contactId);
    }
    return { contactIds: resolvedIds, contacts: refs, failures, allFailed: resolvedIds.length === 0 && failures.length > 0 };
  };

  const resolveInitiativeAccounts = async (rawAccountIds) => {
    const raw = Array.isArray(rawAccountIds) ? rawAccountIds : [];
    const ids = [];
    const seen = new Set();
    for (const entry of raw) {
      const id = typeof entry === 'object' && entry
        ? String(entry.accountId || entry.AccountId || '').trim()
        : String(entry || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (!ids.length) return { error: 'At least one accountId is required', accounts: [], accountIdSet: new Set() };
    const accountsOut = [];
    const failures = [];
    for (const accountId of ids) {
      const ref = await resolveAccountRef(accountId);
      if (ref.error) {
        failures.push({ id: accountId, reason: 'not_found', message: ref.error });
        continue;
      }
      accountsOut.push({
        accountId: ref.accountId,
        accountName: ref.accountName,
        parentAccountId: ref.parentAccountId,
        parentAccountName: ref.parentAccountName
      });
    }
    if (!accountsOut.length) {
      return { error: 'Unable to resolve any provided accountIds', accounts: [], accountIdSet: new Set(), failures };
    }
    const accountIdSet = new Set(accountsOut.map((a) => a.accountId));
    return { accounts: accountsOut, accountIdSet, failures: failures.length ? failures : undefined };
  };

  const enrichInitiativeDoc = async (doc) => {
    if (!doc) return null;
    const workloadRefs = Array.isArray(doc.initiativeWorkloads) ? doc.initiativeWorkloads : [];
    const oids = workloadRefs.map((w) => toObjectId(w.workloadId)).filter(Boolean);
    const workloadRows = oids.length ? await workloads.find({ _id: { $in: oids } }).toArray() : [];
    const errDiscovered = sumWorkloadArrFromRefs(workloadRows);
    const out = normalizeDocumentForRead(doc);
    const rawContacts = Array.isArray(doc.initiativeContacts) ? doc.initiativeContacts : [];
    const contactObjectIdsForInit = rawContacts.map((c) => toObjectId(c.contactId)).filter(Boolean);
    const contactRowsForInit = contactObjectIdsForInit.length
      ? await contacts.find({ _id: { $in: contactObjectIdsForInit } }).toArray()
      : [];
    const contactByIdForInit = new Map(contactRowsForInit.map((r) => [String(r._id), r]));
    const normalizeLiRef = (v) => {
      if (v == null) return null;
      const t = String(v).trim();
      return t || null;
    };
    out.initiativeContacts = rawContacts.map((ref) => {
      const id = String(ref.contactId || '').trim();
      const row = contactByIdForInit.get(id);
      const linkedIn = row && row.linkedIn != null
        ? normalizeLiRef(row.linkedIn)
        : normalizeLiRef(ref.linkedIn);
      const title = row && row.title != null && String(row.title).trim()
        ? String(row.title).trim()
        : (ref.title != null && String(ref.title).trim() ? String(ref.title).trim() : null);
      const name = row && row.name != null && String(row.name).trim()
        ? String(row.name).trim()
        : (ref.name != null && String(ref.name).trim() ? String(ref.name).trim() : id || null);
      return {
        contactId: id,
        name,
        title: title || null,
        linkedIn: linkedIn || null
      };
    });
    out.initiativeWorkloads = Array.isArray(doc.initiativeWorkloads) ? doc.initiativeWorkloads : [];
    out.accounts = Array.isArray(doc.accounts) ? doc.accounts : [];
    out.errDiscovered = errDiscovered;
    return out;
  };

  const hasInputItems = (value) => {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.some((entry) => entry != null && String(entry).trim());
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return !!String(value).trim();
  };

  const addWorkloadRefToContacts = async (contactIds, workloadRef, session = null) => {
    const ids = Array.isArray(contactIds) ? contactIds : [];
    const contactObjectIds = ids.map((id) => toObjectId(id)).filter(Boolean);
    if (!contactObjectIds.length) return;
    const rows = await contacts.find({ _id: { $in: contactObjectIds } }, sessionOptions(session)).toArray();
    for (const row of rows) {
      const refs = normalizeStoredWorkloadRefs(row.workloadIds);
      const exists = refs.some((ref) => String(ref.workloadId) === String(workloadRef.workloadId));
      if (!exists) refs.push({ workloadId: String(workloadRef.workloadId), name: workloadRef.name || null });
      await contacts.updateOne(
        { _id: row._id },
        { $set: { workloadIds: refs, updatedAt: new Date().toISOString() } },
        sessionOptions(session)
      );
    }
  };

  const removeWorkloadRefFromContacts = async (contactIds, workloadId, session = null) => {
    const ids = Array.isArray(contactIds) ? contactIds : [];
    const contactObjectIds = ids.map((id) => toObjectId(id)).filter(Boolean);
    if (!contactObjectIds.length) return;
    const rows = await contacts.find({ _id: { $in: contactObjectIds } }, sessionOptions(session)).toArray();
    for (const row of rows) {
      const refs = normalizeStoredWorkloadRefs(row.workloadIds);
      const filtered = refs.filter((ref) => String(ref.workloadId) !== String(workloadId));
      if (filtered.length === refs.length) continue;
      await contacts.updateOne(
        { _id: row._id },
        { $set: { workloadIds: filtered, updatedAt: new Date().toISOString() } },
        sessionOptions(session)
      );
    }
  };

  const syncWorkloadNameOnContacts = async (workloadId, workloadName, session = null) => {
    const rows = await contacts.find({ workloadIds: { $exists: true, $ne: [] } }, sessionOptions(session)).toArray();
    for (const row of rows) {
      const refs = normalizeStoredWorkloadRefs(row.workloadIds);
      let changed = false;
      const nextRefs = refs.map((ref) => {
        if (String(ref.workloadId) !== String(workloadId)) return ref;
        changed = true;
        return { workloadId: String(ref.workloadId), name: workloadName || null };
      });
      if (!changed) continue;
      await contacts.updateOne(
        { _id: row._id },
        { $set: { workloadIds: nextRefs, updatedAt: new Date().toISOString() } },
        sessionOptions(session)
      );
    }
  };

  const resolveUniqueDocumentTarget = async ({
    collection,
    idValue,
    nameValue,
    label,
    paths,
    filter = {},
    exactMatchPaths = [],
    candidateLimit = 20,
    candidateLabel = (row) => String(row?.name || '')
  }) => {
    const trimmedId = String(idValue || '').trim();
    if (trimmedId) {
      const _id = toObjectId(trimmedId);
      if (!_id) return { error: `Invalid ${label.toLowerCase()}Id` };
      const row = await collection.findOne({ _id });
      if (!row) return { error: `${label} not found` };
      const access = assertDocumentAccessible(row, visibleOwnerUserIds, label);
      if (!access.ok) return { error: access.error };
      return { id: String(row._id), row };
    }
    const query = normalizeSearchText(nameValue);
    if (!query) return { error: `${label.toLowerCase()}Id or ${label.toLowerCase()}Name is required` };
    const normalizedFilter = filter && Object.keys(filter).length ? filter : {};
    const escapedQuery = escapeRegExp(query);
    const exactPaths = (Array.isArray(exactMatchPaths) ? exactMatchPaths : []).filter(Boolean);
    if (exactPaths.length) {
      const exactRows = await collection.find({
        ...(normalizedFilter || {}),
        $or: exactPaths.map((path) => ({ [path]: { $regex: `^${escapedQuery}$`, $options: 'i' } }))
      }).limit(Math.max(1, candidateLimit)).toArray();
      if (exactRows.length === 1) {
        return {
          id: String(exactRows[0]._id),
          row: exactRows[0],
          resolutionMeta: { resolutionMode: 'exact_match', candidateCount: 1, appliedFilter: normalizedFilter }
        };
      }
      if (exactRows.length > 1) {
        return {
          error: `Multiple ${label.toLowerCase()} exact matches found for "${query}". Please provide an exact ID.`,
          needsDisambiguation: true,
          candidates: exactRows.slice(0, candidateLimit).map((row) => ({
            id: String(row?._id || ''),
            name: candidateLabel(row)
          })),
          resolutionMeta: { resolutionMode: 'exact_match', candidateCount: exactRows.length, appliedFilter: normalizedFilter }
        };
      }
    }
    const rows = await searchCollectionHybrid({
      collection,
      query,
      paths,
      filter: normalizedFilter,
      limit: Math.max(5, candidateLimit)
    });
    if (!rows.length) {
      return {
        error: `${label} not found for "${query}"`,
        resolutionMeta: { resolutionMode: 'hybrid_search', candidateCount: 0, appliedFilter: normalizedFilter }
      };
    }
    if (rows.length > 1) {
      return {
        error: `Multiple ${label.toLowerCase()} matches found for "${query}". Please provide an exact ID.`,
        needsDisambiguation: true,
        candidates: rows.slice(0, candidateLimit).map((row) => ({
          id: String(row?._id || ''),
          name: candidateLabel(row)
        })),
        resolutionMeta: { resolutionMode: 'hybrid_search', candidateCount: rows.length, appliedFilter: normalizedFilter }
      };
    }
    return {
      id: String(rows[0]._id),
      row: rows[0],
      resolutionMeta: { resolutionMode: 'hybrid_search', candidateCount: 1, appliedFilter: normalizedFilter }
    };
  };

  const accountWorkloadToolResult = await handleAccountWorkloadMongoTool(name, args, {
    accounts,
    contacts,
    workloads,
    resolveAccountRef,
    resolveContactRefs,
    resolveUniqueDocumentTarget,
    hasInputItems,
    addWorkloadRefToContacts,
    removeWorkloadRefFromContacts,
    syncWorkloadNameOnContacts,
    sessionOptions,
    visibleOwnerUserIds
  });
  if (accountWorkloadToolResult !== undefined) return accountWorkloadToolResult;

  const milestoneToolResult = await handleMilestoneMongoTool(name, args, {
    milestones,
    workloads,
    resolveAccountRef,
    resolveWorkloadRefs,
    resolveUniqueDocumentTarget,
    hasInputItems,
    visibleOwnerUserIds
  });
  if (milestoneToolResult !== undefined) return milestoneToolResult;

  if (name === 'addContact') {
    const normalizedFields = extractStandardContactFields(args || {});
    const contactName = String(normalizedFields.name || '').trim();
    if (!contactName) return { error: 'name is required' };
    if (normalizedFields.linkedIn == null) {
      const inferredLinkedIn = extractLinkedInUrlFromText(normalizedFields.freeText);
      if (inferredLinkedIn) normalizedFields.linkedIn = inferredLinkedIn;
    }
    const accountIdValue = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    let accountRef = null;
    if (accountIdValue !== undefined) {
      accountRef = await resolveAccountRef(accountIdValue);
      if (accountRef.error) return { error: accountRef.error };
    }
    const searchQuery = normalizeSearchText(normalizedFields.email || contactName);
    const possibleMatches = await searchCollectionHybrid({
      collection: contacts,
      query: searchQuery,
      paths: [
        'name',
        'preferredName',
        'email',
        'title',
        'department',
        'accountName',
        'linkedIn',
        'location',
        'tags',
        'freeText',
        'notes.text'
      ],
      filter: accountRef ? { accountId: accountRef.accountId } : {},
      limit: 10
    });
    const guard = buildContactCreateGuardResult({
      contactName,
      contactEmail: normalizedFields.email,
      accountName: accountRef ? accountRef.accountName : null,
      confirm: args.confirm,
      candidates: mapContactCandidateRows(possibleMatches)
    });
    if (guard.block) return guard.response;
    const contactLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'contact documentLinks');
    if (contactLinksResult.error) return { error: contactLinksResult.error };
    const nowIso = new Date().toISOString();
    const rawNotes = pickFirstDefined(args || {}, ['notes', 'Notes']);
    const normalizedNotes = normalizeContactNotesArray(rawNotes, nowIso);
    if (normalizedNotes.error) return { error: normalizedNotes.error };
    const workloadRefResult = await resolveWorkloadRefs(
      normalizedFields.workloadIds,
      accountRef ? accountRef.accountId : null
    );
    if (hasInputItems(normalizedFields.workloadIds) && workloadRefResult.allFailed) {
      return { error: 'Unable to resolve any provided workloadIds', warnings: workloadRefResult.failures };
    }
    const doc = {
      name: normalizedFields.name || '',
      preferredName: normalizedFields.preferredName ?? null,
      pronouns: normalizedFields.pronouns ?? null,
      title: normalizedFields.title ?? null,
      department: normalizedFields.department ?? null,
      email: normalizedFields.email ?? null,
      phone: normalizedFields.phone ?? null,
      mobile: normalizedFields.mobile ?? null,
      location: normalizedFields.location ?? null,
      timeZone: normalizedFields.timeZone ?? null,
      linkedIn: normalizedFields.linkedIn ?? null,
      imageUrl: normalizedFields.imageUrl ?? null,
      website: normalizedFields.website ?? null,
      relationshipStatus: normalizedFields.relationshipStatus ?? null,
      lastContactDate: normalizedFields.lastContactDate ?? null,
      nextFollowUpDate: normalizedFields.nextFollowUpDate ?? null,
      owner: normalizedFields.owner ?? null,
      tags: normalizedFields.tags ?? [],
      source: normalizedFields.source ?? null,
      accountId: accountRef ? accountRef.accountId : null,
      accountName: accountRef ? accountRef.accountName : null,
      parentAccountId: accountRef ? accountRef.parentAccountId : null,
      parentAccountName: accountRef ? accountRef.parentAccountName : null,
      reportsTo: (() => {
        const reportsToValue = pickFirstDefined(args || {}, ['reportsTo', 'ReportsTo']);
        return reportsToValue && typeof reportsToValue === 'object' ? reportsToValue : null;
      })(),
      notes: normalizedNotes.notes,
      freeText: normalizedFields.freeText ?? null,
      documentLinks: contactLinksResult.links ?? [],
      workloadIds: workloadRefResult.workloadRefs ?? [],
      createdAt: nowIso,
      updatedAt: nowIso
    };
    if (!doc.name) return { error: 'name is required' };
    const exactAccountId = doc.accountId || null;
    const exactNameRegex = new RegExp(`^${escapeRegexLiteral(doc.name)}$`, 'i');
    const exactNameMatches = await contacts
      .find({ name: exactNameRegex, accountId: exactAccountId })
      .sort({ updatedAt: -1 })
      .toArray();
    const exactEmailRegex = doc.email ? new RegExp(`^${escapeRegexLiteral(doc.email)}$`, 'i') : null;
    const exactEmailMatches = doc.email
      ? await contacts
        .find({ email: exactEmailRegex, accountId: exactAccountId })
        .sort({ updatedAt: -1 })
        .toArray()
      : [];
    if (exactEmailMatches.length > 1 || (!doc.email && exactNameMatches.length > 1)) {
      const candidates = mapContactCandidateRows(doc.email ? exactEmailMatches : exactNameMatches).slice(0, 5);
      return {
        error: `Multiple existing contacts match "${doc.name}"${doc.email ? ` / ${doc.email}` : ''}. Please choose which one to update.`,
        needsDisambiguation: true,
        candidates
      };
    }
    const existingForUpsert = exactEmailMatches[0] || exactNameMatches[0] || null;
    if (existingForUpsert) {
      const set = { updatedAt: nowIso };
      for (const [field, value] of Object.entries(normalizedFields)) {
        if (field === 'workloadIds') continue;
        if (value === undefined) continue;
        set[field] = value ?? null;
      }
      if (rawNotes !== undefined) set.notes = normalizedNotes.notes;
      if (hasInputItems(normalizedFields.workloadIds)) set.workloadIds = workloadRefResult.workloadRefs ?? [];
      if (args.documentLinks !== undefined) {
        set.documentLinks = mergeDocumentLinks(existingForUpsert.documentLinks, contactLinksResult.links ?? []);
      }
      await contacts.updateOne({ _id: existingForUpsert._id }, { $set: set });
      const updatedExisting = await contacts.findOne({ _id: existingForUpsert._id });
      return {
        ok: true,
        deduped: true,
        created: false,
        contactId: String(existingForUpsert._id),
        contact: normalizeContactForRead(updatedExisting || { ...existingForUpsert, ...set, _id: existingForUpsert._id }),
        warnings: workloadRefResult.failures && workloadRefResult.failures.length ? workloadRefResult.failures : undefined
      };
    }
    const possibleExactDuplicateCount = new Set(
      [...exactNameMatches, ...exactEmailMatches].map((row) => String(row?._id || ''))
    ).size;
    const result = await contacts.insertOne(doc);
    return {
      ok: true,
      contactId: String(result.insertedId),
      contact: { ...doc, _id: String(result.insertedId) },
      warnings: workloadRefResult.failures && workloadRefResult.failures.length ? workloadRefResult.failures : undefined
    };
  }

  if (name === 'getContact') {
    const _id = toObjectId(args.contactId);
    if (!_id) return { error: 'Invalid contactId' };
    const row = await contacts.findOne({ _id });
    if (!row) return { error: 'Contact not found' };
    return normalizeContactForRead(row);
  }

  if (name === 'deleteContact') {
    if (args.confirm !== true) {
      return {
        error:
          'Confirmation required: re-run deleteContact with confirm=true after the user explicitly confirms permanent deletion.'
      };
    }
    const deleteContactAccountIdFilter = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    const contactTarget = await resolveUniqueDocumentTarget({
      collection: contacts,
      idValue: args.contactId,
      nameValue: args.contactName,
      label: 'Contact',
      paths: [
        'name',
        'preferredName',
        'email',
        'title',
        'department',
        'accountName',
        'linkedIn',
        'location',
        'tags',
        'freeText',
        'notes.text'
      ],
      filter: deleteContactAccountIdFilter ? { accountId: String(deleteContactAccountIdFilter).trim() } : {},
      exactMatchPaths: ['name', 'preferredName', 'email'],
      candidateLabel: (row) => `${String(row?.name || '')}${row?.email ? ` <${String(row.email)}>` : ''}`.trim()
    });
    if (contactTarget.error) {
      return contactTarget.needsDisambiguation
        ? { error: contactTarget.error, needsDisambiguation: true, candidates: contactTarget.candidates }
        : { error: contactTarget.error };
    }
    const contactIdStr = String(contactTarget.id);
    const contactObjectId = toObjectId(contactIdStr);
    if (!contactObjectId) return { error: 'Invalid contactId' };

    const txResult = await runWithOptionalTransaction(async ({ session }) => {
      const nowIso = new Date().toISOString();
      const workloadOr = [
        { contactIds: contactIdStr },
        { contactIds: contactObjectId },
        { 'contacts.contactId': contactIdStr }
      ];

      const workloadsToFix = await workloads.find({ $or: workloadOr }, sessionOptions(session)).toArray();
      let workloadsUpdated = 0;
      for (const w of workloadsToFix) {
        const rawIds = Array.isArray(w.contactIds) ? w.contactIds : [];
        const nextIds = rawIds.map((id) => String(id)).filter((id) => id !== contactIdStr);
        const rawContacts = Array.isArray(w.contacts) ? w.contacts : [];
        const nextContacts = rawContacts.filter((c) => String(c?.contactId || '') !== contactIdStr);
        if (nextIds.length === rawIds.length && nextContacts.length === rawContacts.length) continue;
        await workloads.updateOne(
          { _id: w._id },
          { $set: { contactIds: nextIds, contacts: nextContacts, updatedAt: nowIso } },
          sessionOptions(session)
        );
        workloadsUpdated += 1;
      }

      const reportsResult = await contacts.updateMany(
        { 'reportsTo.contactId': contactIdStr },
        { $set: { reportsTo: null, updatedAt: nowIso } },
        sessionOptions(session)
      );
      const reportsToCleared = reportsResult.modifiedCount || 0;

      const delResult = await contacts.deleteOne({ _id: contactObjectId }, sessionOptions(session));
      if (!delResult.deletedCount) return { error: 'Contact not found' };
      return { workloadsUpdated, reportsToCleared };
    });
    if (txResult?.error) return txResult;
    return {
      ok: true,
      contactId: contactIdStr,
      deleted: true,
      workloadsUpdated: Number(txResult?.workloadsUpdated || 0),
      reportsToCleared: Number(txResult?.reportsToCleared || 0)
    };
  }

  if (name === 'listContacts') {
    const filter = {};
    const listEmail = pickFirstDefined(args || {}, ['email', 'Email']);
    if (listEmail) filter.email = String(listEmail).trim();
    const listAccountId = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    if (listAccountId) filter.accountId = String(listAccountId).trim();
    const q = normalizeSearchText(args.q);
    const limit = Math.max(1, Math.min(200, Number(args.limit || 50)));
    const rows = await searchCollectionHybrid({
      collection: contacts,
      query: q,
      paths: [
        'name',
        'preferredName',
        'email',
        'title',
        'department',
        'accountName',
        'linkedIn',
        'location',
        'tags',
        'freeText',
        'notes.text'
      ],
      filter,
      limit
    });
    return { contacts: rows.map((r) => normalizeContactForRead(r)) };
  }

  if (name === 'updateContact') {
    const contactAccountIdFilter = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    const contactTarget = await resolveUniqueDocumentTarget({
      collection: contacts,
      idValue: args.contactId,
      nameValue: args.contactName,
      label: 'Contact',
      paths: [
        'name',
        'preferredName',
        'email',
        'title',
        'department',
        'accountName',
        'linkedIn',
        'location',
        'tags',
        'freeText',
        'notes.text'
      ],
      filter: contactAccountIdFilter ? { accountId: String(contactAccountIdFilter).trim() } : {},
      exactMatchPaths: ['name', 'preferredName', 'email'],
      candidateLabel: (row) => `${String(row?.name || '')}${row?.email ? ` <${String(row.email)}>` : ''}`.trim()
    });
    if (contactTarget.error) {
      return contactTarget.needsDisambiguation
        ? { error: contactTarget.error, needsDisambiguation: true, candidates: contactTarget.candidates }
        : { error: contactTarget.error };
    }
    const _id = toObjectId(contactTarget.id);
    if (!_id) return { error: 'Invalid contactId' };
    const existing = await contacts.findOne({ _id });
    if (!existing) return { error: 'Contact not found' };
    const nowIso = new Date().toISOString();
    const set = { updatedAt: nowIso };
    const normalizedFields = extractStandardContactFields(args || {});
    if (normalizedFields.linkedIn == null) {
      const linkedInSource = normalizedFields.freeText !== undefined
        ? normalizedFields.freeText
        : existing.freeText;
      const inferredLinkedIn = extractLinkedInUrlFromText(linkedInSource);
      if (inferredLinkedIn) normalizedFields.linkedIn = inferredLinkedIn;
    }
    const hasReplaceNotes = pickFirstDefined(args || {}, ['notes', 'Notes']) !== undefined;
    const hasAddNote = args.addNote !== undefined;
    const hasEditNote = args.editNote !== undefined;
    const hasRemoveNote = args.removeNoteId !== undefined;
    const hasClearNotes = args.clearNotes === true;
    const noteOpsCount = [hasReplaceNotes, hasAddNote, hasEditNote, hasRemoveNote, hasClearNotes].filter(Boolean).length;
    if (args.documentLinks !== undefined && args.addDocumentLinks !== undefined) {
      return { error: 'Provide either documentLinks or addDocumentLinks, not both' };
    }
    if (hasReplaceNotes && noteOpsCount > 1) {
      return { error: 'notes replacement cannot be combined with addNote/editNote/removeNoteId/clearNotes' };
    }
    if (hasClearNotes && noteOpsCount > 1) {
      return { error: 'clearNotes cannot be combined with notes/addNote/editNote/removeNoteId' };
    }
    if (normalizedFields.name !== undefined) set.name = normalizedFields.name;
    if (normalizedFields.preferredName !== undefined) set.preferredName = normalizedFields.preferredName;
    if (normalizedFields.pronouns !== undefined) set.pronouns = normalizedFields.pronouns;
    if (normalizedFields.email !== undefined) set.email = normalizedFields.email;
    if (normalizedFields.phone !== undefined) set.phone = normalizedFields.phone;
    if (normalizedFields.mobile !== undefined) set.mobile = normalizedFields.mobile;
    if (normalizedFields.title !== undefined) set.title = normalizedFields.title;
    if (normalizedFields.department !== undefined) set.department = normalizedFields.department;
    if (normalizedFields.location !== undefined) set.location = normalizedFields.location;
    if (normalizedFields.timeZone !== undefined) set.timeZone = normalizedFields.timeZone;
    if (normalizedFields.linkedIn !== undefined) set.linkedIn = normalizedFields.linkedIn;
    if (normalizedFields.imageUrl !== undefined) set.imageUrl = normalizedFields.imageUrl;
    if (normalizedFields.website !== undefined) set.website = normalizedFields.website;
    if (normalizedFields.relationshipStatus !== undefined) set.relationshipStatus = normalizedFields.relationshipStatus;
    if (normalizedFields.lastContactDate !== undefined) set.lastContactDate = normalizedFields.lastContactDate;
    if (normalizedFields.nextFollowUpDate !== undefined) set.nextFollowUpDate = normalizedFields.nextFollowUpDate;
    if (normalizedFields.owner !== undefined) set.owner = normalizedFields.owner;
    if (normalizedFields.tags !== undefined) set.tags = normalizedFields.tags;
    if (normalizedFields.source !== undefined) set.source = normalizedFields.source;
    if (args.documentLinks !== undefined) {
      const replaceLinksResult = normalizeDocumentLinksInput(args.documentLinks, 'contact documentLinks');
      if (replaceLinksResult.error) return { error: replaceLinksResult.error };
      set.documentLinks = replaceLinksResult.links ?? [];
    } else if (args.addDocumentLinks !== undefined) {
      const addLinksResult = normalizeDocumentLinksInput(args.addDocumentLinks, 'contact addDocumentLinks');
      if (addLinksResult.error) return { error: addLinksResult.error };
      set.documentLinks = mergeDocumentLinks(existing.documentLinks, addLinksResult.links);
    }
    if (hasReplaceNotes) {
      const normalized = normalizeContactNotesArray(pickFirstDefined(args || {}, ['notes', 'Notes']), nowIso);
      if (normalized.error) return { error: normalized.error };
      set.notes = normalized.notes;
    } else if (hasClearNotes) {
      set.notes = [];
    } else if (hasAddNote || hasEditNote || hasRemoveNote) {
      const nextNotes = normalizeStoredContactNotes(existing.notes);
      if (hasAddNote) {
        const built = buildContactNote(args.addNote, nowIso);
        if (built.error) return { error: built.error };
        nextNotes.push(built.note);
      }
      if (hasEditNote) {
        if (!args.editNote || typeof args.editNote !== 'object' || Array.isArray(args.editNote)) {
          return { error: 'editNote must be an object containing id and optional text/author' };
        }
        const noteId = String(args.editNote.id || '').trim();
        if (!noteId) return { error: 'editNote.id is required' };
        const idx = nextNotes.findIndex((note) => String(note.id) === noteId);
        if (idx === -1) return { error: `Note not found: ${noteId}` };
        const current = nextNotes[idx];
        const hasText = args.editNote.text !== undefined;
        const hasAuthor = args.editNote.author !== undefined;
        if (!hasText && !hasAuthor) {
          return { error: 'editNote must include text or author to update' };
        }
        const nextText = hasText ? String(args.editNote.text || '').trim() : current.text;
        const nextAuthor = hasAuthor ? String(args.editNote.author || '').trim() : current.author;
        if (!nextText) return { error: 'editNote.text cannot be empty' };
        if (!nextAuthor) return { error: 'editNote.author cannot be empty' };
        nextNotes[idx] = {
          ...current,
          text: nextText,
          author: nextAuthor,
          updatedAt: nowIso
        };
      }
      if (hasRemoveNote) {
        const removeId = String(args.removeNoteId || '').trim();
        if (!removeId) return { error: 'removeNoteId cannot be empty' };
        const filtered = nextNotes.filter((note) => String(note.id) !== removeId);
        if (filtered.length === nextNotes.length) return { error: `Note not found: ${removeId}` };
        set.notes = filtered;
      } else {
        set.notes = nextNotes;
      }
    } else if (existing.notes !== undefined) {
      set.notes = normalizeStoredContactNotes(existing.notes);
    }
    const accountIdValue = pickFirstDefined(args || {}, ['accountId', 'AccountId']);
    let workloadWarnings = [];
    if (normalizedFields.freeText !== undefined) set.freeText = normalizedFields.freeText;
    if (normalizedFields.workloadIds !== undefined) {
      const expectedAccountId = accountIdValue !== undefined
        ? String(accountIdValue || '').trim()
        : String(existing.accountId || '').trim();
      const workloadRefResult = await resolveWorkloadRefs(normalizedFields.workloadIds, expectedAccountId);
      if (hasInputItems(normalizedFields.workloadIds) && workloadRefResult.allFailed) {
        return { error: 'Unable to resolve any provided workloadIds', warnings: workloadRefResult.failures };
      }
      set.workloadIds = workloadRefResult.workloadRefs;
      workloadWarnings = workloadRefResult.failures || [];
    }
    if (accountIdValue !== undefined) {
      const accountRef = await resolveAccountRef(accountIdValue);
      if (accountRef.error) return { error: accountRef.error };
      set.accountId = accountRef.accountId;
      set.accountName = accountRef.accountName;
      set.parentAccountId = accountRef.parentAccountId;
      set.parentAccountName = accountRef.parentAccountName;
    }
    if (args.clearReportsTo === true || args.ClearReportsTo === true) {
      set.reportsTo = null;
    } else {
      const reportsToValue = pickFirstDefined(args || {}, ['reportsTo', 'ReportsTo']);
      if (reportsToValue && typeof reportsToValue === 'object') set.reportsTo = reportsToValue;
    }
    for (const legacyKey of CONTACT_LEGACY_FIELD_KEYS) {
      if (set[legacyKey] !== undefined) delete set[legacyKey];
    }
    const result = await contacts.updateOne({ _id }, { $set: set });
    if (!result.matchedCount) return { error: 'Contact not found' };
    const row = await contacts.findOne({ _id });
    return {
      ok: true,
      contact: normalizeContactForRead(row),
      warnings: workloadWarnings.length ? workloadWarnings : undefined
    };
  }

  if (name === 'standardizeContactFields') {
    const nowIso = new Date().toISOString();
    const dryRun = args?.dryRun !== false;
    const limit = Math.max(1, Math.min(10000, Number(args?.limit || 1000)));
    const rows = await contacts.find({}).limit(limit).toArray();
    let scanned = 0;
    let changed = 0;
    const sampleChanges = [];
    for (const row of rows) {
      scanned += 1;
      const { patch, legacyUnsets, hasChanges } = buildContactStandardizationPatch(row, nowIso);
      if (!hasChanges) continue;
      changed += 1;
      if (!dryRun) {
        const update = {};
        if (Object.keys(patch).length) update.$set = patch;
        if (Object.keys(legacyUnsets).length) update.$unset = legacyUnsets;
        await contacts.updateOne({ _id: row._id }, update);
      }
      if (sampleChanges.length < 25) {
        sampleChanges.push({
          contactId: String(row._id),
          name: String(row?.name || row?.Name || '').trim() || null,
          changedKeys: [...Object.keys(patch), ...Object.keys(legacyUnsets)].sort()
        });
      }
    }
    return {
      ok: true,
      dryRun,
      scanned,
      changed,
      limit,
      sampleChanges
    };
  }

  const initiativeToolResult = await handleInitiativeMongoTool(name, args, {
    initiatives,
    contacts,
    workloads,
    resolveInitiativeAccounts,
    resolveContactRefsForAccountSet,
    resolveWorkloadRefsForAccountSet,
    enrichInitiativeDoc,
    hasInputItems,
    resolveUniqueDocumentTarget,
    visibleOwnerUserIds
  });
  if (initiativeToolResult !== undefined) return initiativeToolResult;

  return { error: `Unknown Mongo tool: ${name}` };
}

function buildWorkflowPrompt(docUrl, extraPrompt) {
  const rawDoc = (docUrl || '').trim();
  const extras = (extraPrompt || '').trim();
  return `Create a New Workload Presentation using the user's notes source and instructions.\n\nNotes source: ${rawDoc || 'not provided'}\n\nAdditional instructions:\n${extras || 'none provided'}`;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text;
}

function normalizeLimit(value, fallback = 25, max = 200) {
  return Math.max(1, Math.min(max, Number(value || fallback) || fallback));
}

function summarizeText(value, maxLen = 140) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
}

function normalizeResponseMode(value, fallback = RESPONSE_MODE_CHAT_DEFAULT) {
  const text = String(value || '').trim().toLowerCase();
  if (text === RESPONSE_MODE_VOICE_CONVERSATIONAL) return RESPONSE_MODE_VOICE_CONVERSATIONAL;
  if (text === RESPONSE_MODE_VOICE_WHIMSICAL) return RESPONSE_MODE_VOICE_WHIMSICAL;
  if (text === RESPONSE_MODE_CHAT_DEFAULT) return RESPONSE_MODE_CHAT_DEFAULT;
  return fallback;
}

function isVoiceSpeechMode(responseMode) {
  const mode = normalizeResponseMode(responseMode, RESPONSE_MODE_CHAT_DEFAULT);
  return mode === RESPONSE_MODE_VOICE_CONVERSATIONAL || mode === RESPONSE_MODE_VOICE_WHIMSICAL;
}

function voiceChatSystemPromptForMode(responseMode) {
  const mode = normalizeResponseMode(responseMode, RESPONSE_MODE_CHAT_DEFAULT);
  if (mode === RESPONSE_MODE_VOICE_WHIMSICAL) return VOICE_WHIMSICAL_SYSTEM_PROMPT;
  return VOICE_CONVERSATIONAL_SYSTEM_PROMPT;
}

function voiceSpeechRewritePromptForMode(responseMode) {
  const mode = normalizeResponseMode(responseMode, RESPONSE_MODE_CHAT_DEFAULT);
  if (mode === RESPONSE_MODE_VOICE_WHIMSICAL) return VOICE_WHIMSICAL_SPEECH_REWRITE_SYSTEM_PROMPT;
  return VOICE_SPEECH_REWRITE_SYSTEM_PROMPT;
}

function withResponseModeInstruction(messages, responseMode) {
  if (!isVoiceSpeechMode(responseMode)) return Array.isArray(messages) ? messages : [];
  const next = Array.isArray(messages) ? [...messages] : [];
  next.unshift({ role: 'system', content: voiceChatSystemPromptForMode(responseMode) });
  return next;
}

function isVoiceFollowupSegment(segment) {
  const text = String(segment || '').trim().toLowerCase();
  if (!text) return false;
  if (/[?]\s*$/.test(text)) return true;
  if (/\blet me know\b/.test(text)) return true;
  if (/\bwould you like\b/.test(text)) return true;
  if (/\bdo you want me to\b/.test(text)) return true;
  if (/\bif you(?:'d| would)? (want|like|need)\b/.test(text)) return true;
  if (/\bif needed\b/.test(text) && /\bi can\b/.test(text)) return true;
  if (/\bfollow-?up task\b/.test(text) && /\b(can|could|want|like|if)\b/.test(text)) return true;
  return false;
}

function removeVoiceFollowupText(text, responseMode) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (!isVoiceSpeechMode(responseMode)) return source;
  const parts = source
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = parts.filter((part) => !isVoiceFollowupSegment(part));
  const out = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (out) return out;
  return source.replace(/\s+/g, ' ').replace(/\?+/g, '.').trim();
}

async function maybeRewriteForSpeech(text, options = {}) {
  const source = String(text || '').trim();
  if (!source) return '';
  const responseMode = normalizeResponseMode(options.responseMode, RESPONSE_MODE_CHAT_DEFAULT);
  if (!isVoiceSpeechMode(responseMode)) return source;
  const rewriteForSpeech = options.rewriteForSpeech !== false;
  if (!rewriteForSpeech) return source;
  if (source.length > 6000) return source;
  try {
    const response = await callModel(
      [
        { role: 'system', content: voiceSpeechRewritePromptForMode(responseMode) },
        { role: 'user', content: source }
      ],
      [],
      { temperature: 0.2, max_tokens: 700 }
    );
    const rewritten = String(response?.choices?.[0]?.message?.content || '').trim();
    return removeVoiceFollowupText(rewritten || source, responseMode);
  } catch (err) {
    console.warn('[voice/rewrite] falling back to original text', err?.message || String(err));
    return removeVoiceFollowupText(source, responseMode);
  }
}

function normalizeDocumentForRead(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const out = { ...doc };
  if (out._id) out._id = String(out._id);
  return out;
}

function withEmailContext(messages, emailContext) {
  if (!emailContext || typeof emailContext !== 'object') return messages;
  const parts = [];
  if (emailContext.subject) parts.push(`Subject: ${emailContext.subject}`);
  if (emailContext.from) parts.push(`From: ${emailContext.from}`);
  if (emailContext.to) parts.push(`To: ${emailContext.to}`);
  if (emailContext.date) parts.push(`Date: ${emailContext.date}`);
  if (emailContext.snippetOrBody || emailContext.body) parts.push(`Body: ${emailContext.snippetOrBody || emailContext.body}`);
  if (!parts.length) return messages;
  const block = `Current email I'm looking at:\n${parts.join('\n')}`;
  const next = Array.isArray(messages) ? [...messages] : [];
  if (next.length && next[0].role === 'user') {
    next[0] = { role: 'user', content: `${block}\n\n${next[0].content || ''}` };
  } else {
    next.unshift({ role: 'user', content: block });
  }
  return next;
}

function parseBooleanFlag(value, fallback = false) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return fallback;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return fallback;
}

function normalizeAgentMode(value, fallback = 'legacy') {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'langgraph') return 'langgraph';
  if (text === 'legacy') return 'legacy';
  return fallback;
}

const shouldIncludeAgentTraceInResponse = parseBooleanFlag(AGENT_INCLUDE_TRACE_IN_RESPONSE, false);
const shouldLogAgentTrace = parseBooleanFlag(AGENT_TRACE_LOGS, false);
const shouldEnableLangGraphChat = parseBooleanFlag(AGENT_ENABLE_CHAT_LANGGRAPH, false);
const defaultAgentMode = normalizeAgentMode(AGENT_ORCHESTRATOR_MODE, 'legacy');
const workflowAgentMode = normalizeAgentMode(AGENT_WORKFLOW_MODE, defaultAgentMode);
const chatAgentMode = normalizeAgentMode(
  AGENT_CHAT_MODE,
  shouldEnableLangGraphChat ? 'langgraph' : defaultAgentMode
);

const legacyAgentRunner = createLegacyAgentRunner({
  mainSystemPrompt: MAIN_SYSTEM_PROMPT,
  fetchGoogleToolDefinitions,
  mongoToolDefinitions,
  callModel,
  runMongoTool,
  executeGoogleTool,
  maxIterations: 10
});

const langGraphAgentRunner = createLangGraphAgentRunner({
  mainSystemPrompt: MAIN_SYSTEM_PROMPT,
  fetchGoogleToolDefinitions,
  mongoToolDefinitions,
  callModel,
  runMongoTool,
  executeGoogleTool,
  maxIterations: 10,
  includeTraceInResponse: shouldIncludeAgentTraceInResponse,
  traceLogger: shouldLogAgentTrace
    ? (metrics) => console.log('[agent.langgraph.trace]', JSON.stringify(metrics))
    : null
});

function resolveAgentMode(route) {
  if (route === 'workflow') return workflowAgentMode;
  if (route === 'chat') return chatAgentMode;
  return defaultAgentMode;
}

async function runAgentLoop(initialMessages, agentContext = {}, options = {}) {
  const mode = normalizeAgentMode(options.mode, defaultAgentMode);
  if (mode === 'langgraph') {
    return langGraphAgentRunner(initialMessages, agentContext, {
      resumeState: options.resumeState || null,
      threadId: options.threadId || agentContext?.conversationId || agentContext?.userId || null
    });
  }
  return legacyAgentRunner(initialMessages, agentContext);
}

app.post('/api/auth/google/exchange', async (req, res) => {
  try {
    if (!googleClientId || !googleAuthClient) {
      return jsonErr(res, 'Google Sign-In is not configured on the server', 503);
    }
    const idToken = req.body?.idToken ? String(req.body.idToken).trim() : '';
    if (!idToken) return jsonErr(res, 'idToken is required', 400);
    const ticket = await googleAuthClient.verifyIdToken({
      idToken,
      audience: googleClientId
    });
    const payload = ticket.getPayload() || {};
    if (!payload.sub) return jsonErr(res, 'Invalid Google token payload', 401);
    const authUser = await upsertGoogleAuthUser(payload);
    const token = signAppUserToken(authUser);
    return jsonOk(res, {
      token,
      expiresIn: jwtExpirySeconds,
      tokenType: 'Bearer',
      user: authUser
    });
  } catch (err) {
    return jsonErr(res, 'Google token verification failed', 401, { message: err?.message || String(err) });
  }
});

app.get('/api/health', (_req, res) => {
  jsonOk(res, { service: 'mcp-node-api', status: 'healthy' });
});

app.get('/config.js', (_req, res) => {
  const payload = {
    apiBaseUrl: '',
    googleClientId: String(GOOGLE_CLIENT_ID || '').trim()
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.status(200).send(`window.__WEB_UX_CONFIG__ = ${JSON.stringify(payload)};`);
});

function extractElevenLabsTranscriptText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.text === 'string') return data.text.trim();
  const transcripts = data.transcripts;
  if (Array.isArray(transcripts)) {
    const parts = transcripts
      .map((t) => (t && typeof t.text === 'string' ? t.text.trim() : ''))
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  return '';
}

/** ElevenLabs/FastAPI often return `detail` as a string or an array of { loc, msg, type }. */
function formatElevenLabsErrorMessage(data, rawText) {
  if (data && typeof data === 'object') {
    if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
    if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
    const d = data.detail;
    if (typeof d === 'string' && d.trim()) return d.trim();
    if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.message === 'string' && d.message.trim()) {
      return d.message.trim();
    }
    if (Array.isArray(d)) {
      const parts = d.map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.msg === 'string') return item.msg;
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      });
      const joined = parts.filter(Boolean).join('; ');
      if (joined) return joined;
    }
  }
  const slice = typeof rawText === 'string' ? rawText.trim().slice(0, 400) : '';
  return slice || 'Unknown error';
}

app.post('/mcp', async (req, res) => {
  try {
    await handleMcpHttpRequest(req, res, {
      mongoToolDefinitions,
      runMongoTool,
      ensureAppReady
    });
  } catch (err) {
    if (!res.headersSent) {
      return jsonErr(res, err.message || String(err), 500);
    }
  }
});

app.post('/api/voice/realtime/session', requireEndUserAuth, async (req, res) => {
  try {
    const xaiApiKey = String(XAI_API_KEY || '').trim();
    if (!xaiApiKey) {
      return jsonErr(res, 'Voice realtime is not configured (missing XAI_API_KEY)', 503);
    }
    const mcpPublicUrl = resolveMcpPublicUrl(req);
    if (!mcpPublicUrl) {
      return jsonErr(res, 'MCP_PUBLIC_URL is required (or send Host header)', 503);
    }
    const expiresSeconds = Math.min(3600, Math.max(60, Number(req.body?.expiresSeconds) || 300));
    const out = await mintXaiRealtimeClientSecret({
      userId: req.auth.userId,
      mcpPublicUrl,
      expiresSeconds
    });
    return jsonOk(res, {
      clientSecret: out.clientSecret,
      expiresAt: out.expiresAt,
      model: 'grok-voice-latest',
      mcpPublicUrl
    });
  } catch (err) {
    console.error('[voice/realtime/session]', err?.message || err);
    return jsonErr(res, err.message || String(err), 502);
  }
});

app.post(
  '/api/voice/transcribe',
  requireEndUserAuth,
  voiceUpload.single('file'),
  async (req, res) => {
    try {
      const elevenKey = String(ELEVENLABS_API_KEY || '').trim();
      if (!elevenKey) {
        return jsonErr(res, 'Voice is not configured (missing ELEVENLABS_API_KEY)', 503);
      }
      const file = req.file;
      if (!file || !file.buffer) {
        return jsonErr(res, 'file is required (multipart field name: file)', 400);
      }
      const mime = file.mimetype || 'application/octet-stream';
      const name = file.originalname || 'recording.webm';
      const formData = new FormData();
      const audioFile = new File([file.buffer], name, { type: mime });
      formData.append('file', audioFile);
      const sttModel = String(ELEVENLABS_STT_MODEL_ID || '').trim();
      if (sttModel) formData.append('model_id', sttModel);

      const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey },
        body: formData
      });
      const rawText = await r.text();
      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (_e) {
        console.error('[voice/transcribe] ElevenLabs STT non-JSON response', {
          status: r.status,
          snippet: typeof rawText === 'string' ? rawText.slice(0, 500) : ''
        });
        return jsonErr(
          res,
          `ElevenLabs STT returned invalid JSON (HTTP ${r.status})`,
          502,
          rawText.slice(0, 500)
        );
      }
      if (!r.ok) {
        const msg = formatElevenLabsErrorMessage(data, rawText);
        console.error('[voice/transcribe] ElevenLabs STT error', {
          httpStatus: r.status,
          message: msg,
          bytes: file.buffer?.length
        });
        return jsonErr(res, `ElevenLabs STT failed: ${msg}`, r.status >= 400 && r.status < 600 ? r.status : 502);
      }
      const text = extractElevenLabsTranscriptText(data);
      return jsonOk(res, { text });
    } catch (err) {
      return jsonErr(res, err.message || err.toString(), 500);
    }
  }
);

app.post('/api/voice/speak', requireEndUserAuth, async (req, res) => {
  try {
    const elevenKey = String(ELEVENLABS_API_KEY || '').trim();
    if (!elevenKey) {
      return jsonErr(res, 'Voice is not configured (missing ELEVENLABS_API_KEY)', 503);
    }
    const voiceId = String(ELEVENLABS_VOICE_ID || '').trim();
    if (!voiceId) {
      return jsonErr(res, 'Voice is not configured (missing ELEVENLABS_VOICE_ID)', 503);
    }
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return jsonErr(res, 'text is required', 400);
    if (text.length > 50000) return jsonErr(res, 'text too long', 400);
    const responseMode = normalizeResponseMode(req.body?.responseMode, RESPONSE_MODE_CHAT_DEFAULT);
    const rewriteForSpeech = parseBooleanFlag(req.body?.rewriteForSpeech, true);
    const spokenText = await maybeRewriteForSpeech(text, { responseMode, rewriteForSpeech });

    const ttsModel = String(ELEVENLABS_TTS_MODEL_ID || 'eleven_turbo_v2').trim();
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': elevenKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text: spokenText,
        model_id: ttsModel
      })
    });
    if (!r.ok) {
      let errBody = '';
      try {
        errBody = await r.text();
      } catch (_e) {
        errBody = '';
      }
      let data = {};
      try {
        data = errBody ? JSON.parse(errBody) : {};
      } catch (_e) {
        data = {};
      }
      const msg = formatElevenLabsErrorMessage(data, errBody);
      console.error('[voice/speak] ElevenLabs TTS error', { httpStatus: r.status, message: msg });
      return jsonErr(
        res,
        `ElevenLabs TTS failed: ${msg}`,
        r.status >= 400 && r.status < 600 ? r.status : 502
      );
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', ct);
    return res.status(200).send(buf);
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.post('/api/chat', requireApiAuth, async (req, res) => {
  try {
    const baseMessages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!baseMessages.length) return jsonErr(res, 'messages[] is required', 400);
    const withContext = withEmailContext(baseMessages, req.body.emailContext);
    const responseMode = normalizeResponseMode(req.body?.responseMode, RESPONSE_MODE_CHAT_DEFAULT);
    const chatMode = resolveAgentMode('chat');
    const graphResumeState = req.body?.graphState && typeof req.body.graphState === 'object'
      ? req.body.graphState
      : null;
    const { conversationId, userId: requestedUserId } = getConversationMeta(req.body);
    const userId = resolveEffectiveUserId(req, requestedUserId);
    if (!userId) return jsonErr(res, 'userId is required for machine-authenticated requests', 400);
    const userProfile = await loadUserProfileForUserId(userId);
    const missingRequired = getMissingUserProfileFields(userProfile, REQUIRED_PROFILE_FIELDS);
    const missingOptional = getMissingUserProfileFields(userProfile, OPTIONAL_PROFILE_FIELDS);
    if (missingRequired.length) {
      return jsonOk(res, {
        needsProfile: true,
        missingRequired,
        missingOptional,
        reply: removeVoiceFollowupText(buildProfileGateReply(missingRequired, missingOptional), responseMode)
      });
    }
    const profileMessage = buildUserProfileContext(userProfile);
    if (!conversationId) {
      const messages = withResponseModeInstruction([
        ...(profileMessage ? [profileMessage] : []),
        ...withContext
      ], responseMode);
      const out = await runAgentLoop(messages, {
        userId,
        userProfile,
        initiatedByUserId: userId,
        authType: req.auth?.type || null
      }, {
        mode: chatMode,
        resumeState: graphResumeState,
        threadId: userId || null
      });
      const response = { ...out };
      if (response.reply != null) {
        response.reply = removeVoiceFollowupText(response.reply, responseMode);
      }
      delete response.transcriptMessages;
      return jsonOk(res, response);
    }
    const messages = await loadMemoryAwareMessages(conversationId, userId, withContext, userProfile);
    const initialMessages = withResponseModeInstruction(messages, responseMode);
    const out = await runAgentLoop(initialMessages, {
      userId,
      userProfile,
      conversationId,
      initiatedByUserId: userId,
      authType: req.auth?.type || null
    }, {
      mode: chatMode,
      resumeState: graphResumeState,
      threadId: conversationId
    });
    const transcriptMessages = Array.isArray(out.transcriptMessages) ? out.transcriptMessages : [];
    const persistedTurns = transcriptMessages
      .slice(initialMessages.length + 1)
      .filter((m) => {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
        const text = m.content == null ? '' : String(m.content);
        return text.trim().length > 0;
      })
      .map((m) => {
        if (m.role !== 'assistant') return m;
        return {
          ...m,
          content: removeVoiceFollowupText(m.content, responseMode)
        };
      });
    await appendConversationMessages(await getMongoDb(), memoryConfig, {
      conversationId,
      userId,
      messages: persistedTurns,
      title: req.body.title ? String(req.body.title) : null
    });
    {
      const latestAssistantTurn = [...persistedTurns].reverse().find((turn) => turn?.role === 'assistant');
      const latestUserTurn = [...persistedTurns].reverse().find((turn) => turn?.role === 'user');
      const latestMessageText = summarizeText(
        latestAssistantTurn?.content || latestUserTurn?.content || '',
        400
      );
      const sessionMeta = await generateConversationSessionMeta({
        title: req.body.title ? String(req.body.title) : null,
        latestMessage: latestMessageText
      });
      await upsertConversationSessionMeta(await getMongoDb(), memoryConfig, {
        conversationId,
        userId,
        title: req.body.title ? String(req.body.title) : undefined,
        sessionLabel: sessionMeta.sessionLabel,
        sessionDescription: sessionMeta.sessionDescription
      });
    }
    const summaryInfo = await triggerSummaryRefresh(conversationId);
    const response = { ...out, conversationId, memory: summaryInfo };
    if (response.reply != null) {
      response.reply = removeVoiceFollowupText(response.reply, responseMode);
    }
    delete response.transcriptMessages;
    return jsonOk(res, response);
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/memory/profile', requireApiAuth, async (req, res) => {
  try {
    const userId = resolveEffectiveUserId(req, req.query?.userId);
    if (!userId) return jsonErr(res, 'userId is required', 400);
    await ensureMemorySetup();
    const db = await getMongoDb();
    const profile = await getUserProfile(db, memoryConfig, userId);
    return jsonOk(res, { userId, profile: profile || null });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/memory/profile/status', requireApiAuth, async (req, res) => {
  try {
    const userId = resolveEffectiveUserId(req, req.query?.userId);
    if (!userId) return jsonErr(res, 'userId is required', 400);
    await ensureMemorySetup();
    const db = await getMongoDb();
    const profile = await getUserProfile(db, memoryConfig, userId);
    const missingRequired = getMissingUserProfileFields(profile, REQUIRED_PROFILE_FIELDS);
    const missingOptional = getMissingUserProfileFields(profile, OPTIONAL_PROFILE_FIELDS);
    return jsonOk(res, {
      userId,
      profile: profile || null,
      exists: Boolean(profile),
      missingRequired,
      missingOptional,
      isCompleteForChat: missingRequired.length === 0
    });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.post('/api/memory/profile', requireApiAuth, async (req, res) => {
  try {
    const userId = resolveEffectiveUserId(req, req.body?.userId);
    if (!userId) return jsonErr(res, 'userId is required', 400);
    const sourceRaw = req.body?.source ? String(req.body.source).trim() : 'user_input';
    const source = PROFILE_ALLOWED_SOURCE_VALUES.has(sourceRaw) ? sourceRaw : null;
    if (!source) {
      return jsonErr(res, `source must be one of: ${Array.from(PROFILE_ALLOWED_SOURCE_VALUES).join(', ')}`, 400);
    }
    const { patch, invalidKeys } = sanitizeUserProfilePatch(req.body?.patch);
    if (!patch || !Object.keys(patch).length) {
      return jsonErr(res, 'patch must include at least one allowed field', 400, { invalidKeys });
    }
    await ensureMemorySetup();
    const db = await getMongoDb();
    const profile = await upsertUserProfile(db, memoryConfig, { userId, patch, source });
    return jsonOk(res, { userId, profile, invalidKeys });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.post('/api/workflow', requireNodeApiKey, async (req, res) => {
  try {
    const prompt = buildWorkflowPrompt(req.body.docUrl, req.body.extraPrompt);
    const workflowMode = resolveAgentMode('workflow');
    const graphResumeState = req.body?.graphState && typeof req.body.graphState === 'object'
      ? req.body.graphState
      : null;
    const out = await runAgentLoop([{ role: 'user', content: prompt }], {}, {
      mode: workflowMode,
      resumeState: graphResumeState,
      threadId: req.body?.threadId ? String(req.body.threadId).trim() : 'workflow'
    });
    const response = { ...out };
    delete response.transcriptMessages;
    return jsonOk(res, response);
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.post('/api/memory/rebuild', requireNodeApiKey, async (req, res) => {
  try {
    await ensureMemorySetup();
    const db = await getMongoDb();
    const conversationId = req.body?.conversationId ? String(req.body.conversationId).trim() : null;
    const jobId = await createMemoryJob(db, memoryConfig, {
      type: 'rebuild_summaries',
      conversationId
    });
    setTimeout(async () => {
      try {
        await updateMemoryJob(db, memoryConfig, jobId, { status: 'running' });
        const ids = await listConversationIds(db, memoryConfig, conversationId);
        let processedConversations = 0;
        let processedMessages = 0;
        for (const id of ids) {
          const result = await rebuildConversationSummary(db, memoryConfig, id);
          processedConversations += 1;
          processedMessages += result.processed || 0;
          await updateMemoryJob(db, memoryConfig, jobId, {
            status: 'running',
            processedConversations,
            processedMessages
          });
        }
        await updateMemoryJob(db, memoryConfig, jobId, {
          status: 'completed',
          processedConversations,
          processedMessages
        });
      } catch (err) {
        await updateMemoryJob(db, memoryConfig, jobId, {
          status: 'failed',
          error: err?.message || String(err)
        });
      }
    }, 0);
    return jsonOk(res, { jobId, status: 'queued' }, 202);
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/memory/latest-session', requireApiAuth, async (req, res) => {
  try {
    await ensureMemorySetup();
    const db = await getMongoDb();
    const userId = resolveEffectiveUserId(req, req.query?.userId);
    const limit = req.query?.limit ? Number(req.query.limit) : 200;
    const latest = await getLatestConversation(db, memoryConfig, userId);
    if (!latest) {
      return jsonOk(res, {
        conversationId: null,
        userId: userId || null,
        title: null,
        messages: []
      });
    }
    const messages = await getConversationMessages(db, memoryConfig, latest.conversationId, limit);
    return jsonOk(res, {
      conversationId: latest.conversationId,
      userId: latest.userId || null,
      title: latest.title || null,
      updatedAt: latest.updatedAt || null,
      messages: messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/chat/sessions', requireApiAuth, async (req, res) => {
  try {
    await ensureMemorySetup();
    const db = await getMongoDb();
    const userId = resolveEffectiveUserId(req, req.query?.userId);
    if (!userId) return jsonErr(res, 'userId is required', 400);
    const limit = normalizeLimit(req.query?.limit, 25, 100);
    const sessions = await listConversationSessions(db, memoryConfig, { userId, limit });
    const enrichedSessions = await Promise.all(
      sessions.map(async (session) => {
        const currentLabel = String(session?.sessionLabel || '').trim();
        const currentDescription = String(session?.sessionDescription || '').trim();
        if (currentLabel && currentDescription) return session;
        const latestMessageText = summarizeText(session?.latestMessage?.content || '', 400);
        const generated = await generateConversationSessionMeta({
          title: session?.title || null,
          latestMessage: latestMessageText
        });
        await upsertConversationSessionMeta(db, memoryConfig, {
          conversationId: session?.conversationId,
          userId,
          sessionLabel: generated.sessionLabel,
          sessionDescription: generated.sessionDescription
        });
        return {
          ...session,
          sessionLabel: generated.sessionLabel,
          sessionDescription: generated.sessionDescription
        };
      })
    );
    return jsonOk(res, { userId, sessions: enrichedSessions });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/chat/sessions/:conversationId/messages', requireApiAuth, async (req, res) => {
  try {
    await ensureMemorySetup();
    const db = await getMongoDb();
    const conversationId = req.params?.conversationId ? String(req.params.conversationId).trim() : '';
    if (!conversationId) return jsonErr(res, 'conversationId is required', 400);
    const limit = normalizeLimit(req.query?.limit, 200, 500);
    const messages = await getConversationMessagesDetailed(db, memoryConfig, conversationId, limit);
    return jsonOk(res, { conversationId, messages });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/tasks/open', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const db = await getMongoDb();
    const visibility = await resolveCrmVisibilityForRequest(req, db);
    if (visibility.error) return jsonErr(res, visibility.error, visibility.status || 400);
    const { visibleOwnerUserIds } = visibility;
    const taskLists = withVisibleCollection(db.collection(MONGO_TASK_LISTS_COLLECTION), visibleOwnerUserIds);
    const tasks = withVisibleCollection(db.collection(MONGO_TASKS_COLLECTION), visibleOwnerUserIds);
    const limit = normalizeLimit(req.query?.limit, 100, 500);
    const owner = req.query?.owner ? String(req.query.owner).trim() : '';
    const q = normalizeSearchText(req.query?.q);
    const openStatuses = new Set(['open', 'in_progress', 'blocked']);

    const ownerFilter = owner ? buildTaskListOwnerOrNameFilter(owner) : {};
    const ownerScopedRows = owner
      ? await taskLists.find(ownerFilter, { projection: { _id: 1 } }).limit(5000).toArray()
      : [];
    const ownerScopedIds = ownerScopedRows.map((row) => String(row._id));
    if (owner && !ownerScopedIds.length) return jsonOk(res, { openTasks: [] });

    const baseTaskFilter = {
      status: { $in: Array.from(openStatuses) },
      ...(owner ? { taskListId: { $in: ownerScopedIds } } : {})
    };
    let taskDocs = [];
    if (!q) {
      taskDocs = await tasks.find(baseTaskFilter).sort({ updatedAt: -1 }).limit(limit).toArray();
    } else {
      const listRowsByNameOrOwner = await searchCollectionHybrid({
        collection: taskLists,
        query: q,
        paths: ['name', 'owner'],
        filter: ownerFilter,
        limit: 500
      });
      const listIdsByNameOrOwner = new Set(listRowsByNameOrOwner.map((row) => String(row?._id || '')).filter(Boolean));
      const taskRowsByTaskText = await searchCollectionHybrid({
        collection: tasks,
        query: q,
        paths: ['task'],
        filter: baseTaskFilter,
        limit: Math.max(limit * 5, 200)
      });
      const fromNamedLists = listIdsByNameOrOwner.size
        ? await tasks.find({
          ...baseTaskFilter,
          taskListId: { $in: Array.from(listIdsByNameOrOwner) }
        }).sort({ updatedAt: -1 }).limit(Math.max(limit * 3, 120)).toArray()
        : [];
      const merged = new Map();
      for (const taskDoc of taskRowsByTaskText) merged.set(String(taskDoc?._id || taskDoc?.taskId || ''), taskDoc);
      for (const taskDoc of fromNamedLists) merged.set(String(taskDoc?._id || taskDoc?.taskId || ''), taskDoc);
      taskDocs = Array.from(merged.values())
        .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
        .slice(0, limit);
    }

    const listIds = Array.from(new Set(taskDocs.map((taskDoc) => String(taskDoc?.taskListId || '').trim()).filter(Boolean)));
    const taskListObjectIds = listIds.map((id) => toObjectId(id)).filter(Boolean);
    const listRows = taskListObjectIds.length
      ? await taskLists.find({ _id: { $in: taskListObjectIds } }).project({ name: 1, owner: 1 }).toArray()
      : [];
    const listMetaById = new Map(listRows.map((row) => [String(row._id), row]));
    const openTasks = taskDocs.map((taskDoc) => {
      const normalized = normalizeTaskForRead(taskDoc);
      const listMeta = listMetaById.get(String(normalized.taskListId || '')) || null;
      return {
        taskId: normalized.taskId,
        task: normalized.task,
        status: normalized.status,
        priority: normalized.priority,
        dueDate: normalized.dueDate,
        taskOwner: normalized.owner,
        person: normalized.person,
        accountId: normalized.accountId,
        workloadId: normalized.workloadId,
        documentLinks: normalized.documentLinks ?? [],
        links: normalized.links ?? [],
        attachments: normalized.attachments ?? [],
        docs: normalized.docs ?? [],
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
        taskListId: normalized.taskListId,
        taskListName: listMeta?.name ? String(listMeta.name) : normalized.taskListName,
        owner: listMeta?.owner ? String(listMeta.owner) : null
      };
    });
    return jsonOk(res, { openTasks });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.delete('/api/tasks/:taskListId/:taskId', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const taskListId = String(req.params?.taskListId || '').trim();
    const taskId = String(req.params?.taskId || '').trim();
    if (!taskListId) return jsonErr(res, 'taskListId is required', 400);
    if (!taskId) return jsonErr(res, 'taskId is required', 400);

    const _id = toObjectId(taskListId);
    if (!_id) return jsonErr(res, 'Invalid taskListId', 400);

    const db = await getMongoDb();
    const visibility = await resolveCrmVisibilityForRequest(req, db);
    if (visibility.error) return jsonErr(res, visibility.error, visibility.status || 400);
    const { visibleOwnerUserIds } = visibility;
    const taskLists = withVisibleCollection(db.collection(MONGO_TASK_LISTS_COLLECTION), visibleOwnerUserIds);
    const tasks = withVisibleCollection(db.collection(MONGO_TASKS_COLLECTION), visibleOwnerUserIds);
    const list = await taskLists.findOne({ _id }, { projection: { _id: 1 } });
    if (!list) return jsonErr(res, 'Task list not found', 404);

    const taskLookupFilter = buildTaskLookupFilter(taskId);
    const result = await tasks.deleteOne({
      taskListId,
      ...(taskLookupFilter || {})
    });
    if (!result.deletedCount) return jsonErr(res, 'Task not found', 404);
    await taskLists.updateOne({ _id }, { $set: { updatedAt: new Date().toISOString() } });
    return jsonOk(res, { ok: true, deleted: true, taskListId, taskId });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/workloads', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const db = await getMongoDb();
    const visibility = await resolveCrmVisibilityForRequest(req, db);
    if (visibility.error) return jsonErr(res, visibility.error, visibility.status || 400);
    const { visibleOwnerUserIds } = visibility;
    const limit = normalizeLimit(req.query?.limit, 100, 500);
    const accountId = req.query?.accountId ? String(req.query.accountId).trim() : '';
    const q = normalizeSearchText(req.query?.q);
    const filter = accountId ? { accountId } : {};
    const rows = await searchCollectionHybrid({
      collection: withVisibleCollection(db.collection(MONGO_WORKLOADS_COLLECTION), visibleOwnerUserIds),
      query: q,
      paths: ['name', 'description', 'notes', 'accountName', 'stage', 'contacts.name', 'contacts.email'],
      filter,
      limit
    });
    return jsonOk(res, { workloads: rows.map(normalizeDocumentForRead) });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/milestones', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const out = await runMongoTool('listMilestones', {
      q: req.query?.q,
      accountId: req.query?.accountId,
      workloadId: req.query?.workloadId,
      status: req.query?.status,
      from: req.query?.from,
      to: req.query?.to,
      limit: req.query?.limit
    }, {
      initiatedByUserId: req.auth?.userId || null,
      userId: req.auth?.userId || null
    });
    if (!out || out.error) {
      const message = out?.error ? String(out.error) : 'Failed to list milestones';
      return jsonErr(res, message, 400, out?.warnings);
    }
    return jsonOk(res, { milestones: Array.isArray(out.milestones) ? out.milestones : [] });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/accounts', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const db = await getMongoDb();
    const visibility = await resolveCrmVisibilityForRequest(req, db);
    if (visibility.error) return jsonErr(res, visibility.error, visibility.status || 400);
    const { visibleOwnerUserIds } = visibility;
    const limit = normalizeLimit(req.query?.limit, 100, 500);
    const q = normalizeSearchText(req.query?.q);
    const rows = await searchCollectionHybrid({
      collection: withVisibleCollection(db.collection(MONGO_ACCOUNTS_COLLECTION), visibleOwnerUserIds),
      query: q,
      paths: ['name', 'parentAccountName', 'documentLinks.name'],
      filter: {},
      limit
    });
    return jsonOk(res, { accounts: rows.map(normalizeDocumentForRead) });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/contacts', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const db = await getMongoDb();
    const visibility = await resolveCrmVisibilityForRequest(req, db);
    if (visibility.error) return jsonErr(res, visibility.error, visibility.status || 400);
    const { visibleOwnerUserIds } = visibility;
    const limit = normalizeLimit(req.query?.limit, 100, 500);
    const accountId = req.query?.accountId ? String(req.query.accountId).trim() : '';
    const q = normalizeSearchText(req.query?.q);
    const filter = accountId ? { accountId } : {};
    const rows = await searchCollectionHybrid({
      collection: withVisibleCollection(db.collection(MONGO_CONTACTS_COLLECTION), visibleOwnerUserIds),
      query: q,
      paths: [
        'name',
        'preferredName',
        'email',
        'title',
        'department',
        'accountName',
        'linkedIn',
        'location',
        'tags',
        'freeText',
        'notes.text'
      ],
      filter,
      limit
    });
    return jsonOk(res, {
      contacts: rows.map((row) => {
        return normalizeContactForRead(row);
      })
    });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/initiatives', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const mode = String(req.query?.mode || '').trim().toLowerCase();
    const useSemantic = mode === 'semantic' || mode === 'vector';
    if (useSemantic) {
      const out = await runMongoTool('searchInitiatives', {
        q: req.query?.q,
        accountId: req.query?.accountId,
        limit: req.query?.limit
      }, {
        initiatedByUserId: req.auth?.userId || null,
        userId: req.auth?.userId || null
      });
      if (!out || out.error) {
        const message = out?.error ? String(out.error) : 'Failed to search initiatives';
        return jsonErr(res, message, 400, out?.warnings);
      }
      return jsonOk(res, {
        initiatives: Array.isArray(out.initiatives) ? out.initiatives : [],
        searchMode: out.searchMode,
        vectorError: out.vectorError
      });
    }
    const out = await runMongoTool('listInitiatives', {
      q: req.query?.q,
      accountId: req.query?.accountId,
      limit: req.query?.limit
    }, {
      initiatedByUserId: req.auth?.userId || null,
      userId: req.auth?.userId || null
    });
    if (!out || out.error) {
      const message = out?.error ? String(out.error) : 'Failed to list initiatives';
      return jsonErr(res, message, 400, out?.warnings);
    }
    return jsonOk(res, { initiatives: Array.isArray(out.initiatives) ? out.initiatives : [] });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.delete('/api/contacts/:contactId', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const contactId = String(req.params?.contactId || '').trim();
    if (!contactId) return jsonErr(res, 'contactId is required', 400);
    const out = await runMongoTool('deleteContact', { contactId, confirm: true }, {
      initiatedByUserId: req.auth?.userId || null,
      userId: req.auth?.userId || null
    });
    if (!out || out.ok !== true) {
      const message = out?.error ? String(out.error) : 'Failed to delete contact';
      const status = /not found/i.test(message) ? 404 : 400;
      return jsonErr(res, message, status);
    }
    return jsonOk(res, out);
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

app.get('/api/dashboard/snapshot', requireApiAuth, async (req, res) => {
  try {
    await ensureCrmSetup();
    const db = await getMongoDb();
    const visibility = await resolveCrmVisibilityForRequest(req, db);
    if (visibility.error) return jsonErr(res, visibility.error, visibility.status || 400);
    const { visibleOwnerUserIds } = visibility;
    const taskLists = withVisibleCollection(db.collection(MONGO_TASK_LISTS_COLLECTION), visibleOwnerUserIds);
    const tasks = withVisibleCollection(db.collection(MONGO_TASKS_COLLECTION), visibleOwnerUserIds);
    const workloads = withVisibleCollection(db.collection(MONGO_WORKLOADS_COLLECTION), visibleOwnerUserIds);
    const accounts = withVisibleCollection(db.collection(MONGO_ACCOUNTS_COLLECTION), visibleOwnerUserIds);
    const contacts = withVisibleCollection(db.collection(MONGO_CONTACTS_COLLECTION), visibleOwnerUserIds);

    const [
      latestOpenTaskDocs,
      latestWorkloads,
      latestAccounts,
      latestContacts,
      totalOpenTasks,
      totalWorkloads,
      totalAccounts,
      totalContacts
    ] = await Promise.all([
      tasks.find({ status: { $in: ['open', 'in_progress', 'blocked'] } }).sort({ updatedAt: -1 }).limit(20).toArray(),
      workloads.find({}).sort({ updatedAt: -1 }).limit(10).toArray(),
      accounts.find({}).sort({ updatedAt: -1 }).limit(10).toArray(),
      contacts.find({}).sort({ updatedAt: -1 }).limit(10).toArray(),
      tasks.countDocuments({ status: { $in: ['open', 'in_progress', 'blocked'] } }),
      workloads.countDocuments({}),
      accounts.countDocuments({}),
      contacts.countDocuments({})
    ]);
    const snapshotListIds = Array.from(
      new Set(latestOpenTaskDocs.map((taskDoc) => String(taskDoc?.taskListId || '').trim()).filter(Boolean))
    );
    const snapshotListObjectIds = snapshotListIds.map((id) => toObjectId(id)).filter(Boolean);
    const snapshotTaskLists = snapshotListObjectIds.length
      ? await taskLists.find({ _id: { $in: snapshotListObjectIds } }).project({ name: 1 }).toArray()
      : [];
    const listNameById = new Map(snapshotTaskLists.map((row) => [String(row._id), row?.name ? String(row.name) : null]));
    const latestOpenTasks = latestOpenTaskDocs
      .map((taskDoc) => {
        const task = normalizeTaskForRead(taskDoc);
        return {
          taskId: task.taskId,
          task: task.task,
          status: task.status,
          updatedAt: task.updatedAt,
          taskListId: task.taskListId,
          taskListName: listNameById.get(String(task.taskListId || '')) || task.taskListName || null
        };
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    return jsonOk(res, {
      cards: {
        openTasks: {
          total: totalOpenTasks,
          recent: latestOpenTasks.slice(0, 8)
        },
        workloads: {
          total: totalWorkloads,
          recent: latestWorkloads.map((row) => ({
            id: String(row._id),
            name: row.name ? String(row.name) : null,
            accountName: row.accountName ? String(row.accountName) : null,
            updatedAt: toIsoOrNull(row.updatedAt)
          }))
        },
        accounts: {
          total: totalAccounts,
          recent: latestAccounts.map((row) => ({
            id: String(row._id),
            name: row.name ? String(row.name) : null,
            updatedAt: toIsoOrNull(row.updatedAt)
          }))
        },
        contacts: {
          total: totalContacts,
          recent: latestContacts.map((row) => ({
            id: String(row._id),
            name: row.name ? String(row.name) : null,
            title: row.title ? String(row.title) : null,
            accountName: row.accountName ? String(row.accountName) : null,
            updatedAt: toIsoOrNull(row.updatedAt)
          }))
        }
      }
    });
  } catch (err) {
    return jsonErr(res, err.message || err.toString(), 500);
  }
});

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch (_err) {
    return false;
  }
})();

let appReadyPromise = null;

async function ensureAppReady() {
  if (!appReadyPromise) {
    appReadyPromise = Promise.all([ensureMemorySetup(), ensureCrmSetup()]).catch((err) => {
      appReadyPromise = null;
      throw err;
    });
  }
  await appReadyPromise;
}

if (isMainModule) {
  app.listen(Number(PORT), () => {
    // Keep startup output simple for local usage.
    console.log(`Node API listening on port ${PORT}`);
    ensureAppReady().catch((err) => {
      console.error(`Startup setup failed: ${err.message || err}`);
    });
  });
}

export {
  app,
  ensureAppReady,
  mongoToolDefinitions,
  runMongoTool,
  closeMongoClientConnection,
  signAppUserToken,
  verifyAppUserToken,
  withAuditFieldsForInsert,
  withAuditFieldsForUpdate,
  resolveAuditActorId
};
