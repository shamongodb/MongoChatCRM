function normalizeMessage(message) {
  return {
    role: message.role,
    content: message.content == null ? '' : (typeof message.content === 'string' ? message.content : String(message.content)),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {})
  };
}

function sanitizeReplayMessage(message) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) return null;
  return {
    role: message.role,
    content: message.content == null ? '' : (typeof message.content === 'string' ? message.content : String(message.content))
  };
}

function sameMessage(a, b) {
  if (!a || !b) return false;
  return a.role === b.role && String(a.content || '') === String(b.content || '');
}

function trimValue(value, maxChars = 240) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeObject(input, maxEntries = 12, maxValueChars = 140) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  const keys = Object.keys(input).slice(0, Math.max(0, maxEntries));
  for (const key of keys) {
    const normalizedKey = trimValue(key, 60);
    const normalizedValue = trimValue(input[key], maxValueChars);
    if (normalizedKey && normalizedValue) out[normalizedKey] = normalizedValue;
  }
  return out;
}

export function extractLatestUserTurn(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return [normalizeMessage(messages[i])];
    }
  }
  const last = messages[messages.length - 1];
  return last ? [normalizeMessage(last)] : [];
}

export function buildUserProfileContext(userProfile, maxChars = 1200) {
  if (!userProfile || typeof userProfile !== 'object') return null;
  const summary = {
    displayName: trimValue(userProfile.displayName, 120),
    role: trimValue(userProfile.role, 120),
    organization: trimValue(userProfile.organization, 120),
    timezone: trimValue(userProfile.timezone, 80),
    constraints: Array.isArray(userProfile.constraints)
      ? userProfile.constraints.map((item) => trimValue(item, 120)).filter(Boolean).slice(0, 10)
      : [],
    aliases: normalizeObject(userProfile.aliases, 10, 120),
    preferences: normalizeObject(userProfile.preferences, 10, 120)
  };
  const compact = Object.fromEntries(Object.entries(summary).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  }));
  if (!Object.keys(compact).length) return null;
  const serialized = JSON.stringify(compact, null, 2);
  const bounded = serialized.length > maxChars
    ? `${serialized.slice(0, Math.max(0, maxChars - 3))}...`
    : serialized;
  return {
    role: 'system',
    content: `Known user profile memory:\n${bounded}`
  };
}

export function buildUserProfileOnboardingContext({ userId, userProfile }) {
  const normalizedUserId = userId ? String(userId).trim() : '';
  if (!normalizedUserId || userProfile) return null;
  return null;
}

export function buildShortTermContext({ summaryText, recentMessages, incomingMessages, userProfile, maxRecentMessages = 12 }) {
  const recent = Array.isArray(recentMessages)
    ? recentMessages
      .map(sanitizeReplayMessage)
      .filter(Boolean)
      .slice(-Math.max(1, maxRecentMessages))
    : [];
  const incoming = Array.isArray(incomingMessages) ? incomingMessages.map(normalizeMessage) : [];
  const dedupedIncoming = [...incoming];
  while (recent.length && dedupedIncoming.length && sameMessage(recent[recent.length - 1], dedupedIncoming[0])) {
    dedupedIncoming.shift();
  }
  const out = [];
  const profileContext = buildUserProfileContext(userProfile);
  if (profileContext) out.push(profileContext);
  if (summaryText && String(summaryText).trim()) {
    out.push({
      role: 'system',
      content: `Conversation memory summary:\n${String(summaryText).trim()}`
    });
  }
  out.push(...recent, ...dedupedIncoming);
  return out;
}
