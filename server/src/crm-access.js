const OWNER_USER_ID_FIELD = 'ownerUserId';

function normalizeUserId(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

export function resolveCrmActor(toolContext = {}) {
  const initiatedByUserId = normalizeUserId(toolContext?.initiatedByUserId);
  if (initiatedByUserId) return initiatedByUserId;
  return normalizeUserId(toolContext?.userId);
}

export function stampOwnerUserId(doc, actorId) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const next = { ...doc };
  if (!normalizeUserId(next[OWNER_USER_ID_FIELD]) && normalizeUserId(actorId)) {
    next[OWNER_USER_ID_FIELD] = normalizeUserId(actorId);
  }
  return next;
}

export function buildOwnerVisibilityFilter(visibleOwnerIds) {
  const ids = Array.isArray(visibleOwnerIds)
    ? Array.from(new Set(visibleOwnerIds.map((item) => normalizeUserId(item)).filter(Boolean)))
    : [];
  return { [OWNER_USER_ID_FIELD]: { $in: ids } };
}

export function mergeCrmFilter(baseFilter, visibilityFilter) {
  const left = baseFilter && typeof baseFilter === 'object' ? baseFilter : {};
  const right = visibilityFilter && typeof visibilityFilter === 'object' ? visibilityFilter : {};
  if (!Object.keys(left).length) return right;
  if (!Object.keys(right).length) return left;
  return { $and: [left, right] };
}

export function assertDocumentAccessible(doc, visibleOwnerIds, label = 'Document') {
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: `${label} not found` };
  }
  const visibleSet = new Set(
    (Array.isArray(visibleOwnerIds) ? visibleOwnerIds : [])
      .map((item) => normalizeUserId(item))
      .filter(Boolean)
  );
  const ownerUserId = normalizeUserId(doc?.[OWNER_USER_ID_FIELD]);
  if (!ownerUserId || !visibleSet.has(ownerUserId)) {
    return { ok: false, error: `${label} not found or not accessible` };
  }
  return { ok: true, ownerUserId };
}

export async function getVisibleOwnerUserIds(db, {
  userId,
  userProfilesCollection = 'user_profiles'
} = {}) {
  const actorUserId = normalizeUserId(userId);
  if (!actorUserId) return [];
  const rows = await db.collection(userProfilesCollection)
    .find({ crmShareAllWith: actorUserId }, { projection: { userId: 1 } })
    .limit(1000)
    .toArray();
  const visible = new Set([actorUserId]);
  for (const row of rows) {
    const owner = normalizeUserId(row?.userId);
    if (owner) visible.add(owner);
  }
  return Array.from(visible);
}

export {
  OWNER_USER_ID_FIELD
};
