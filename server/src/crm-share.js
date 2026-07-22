function normalizeText(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

export function normalizeShareEmail(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function normalizeShareUserIdList(value, maxItems = 200) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const userId = normalizeText(item);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    out.push(userId);
    if (out.length >= Math.max(1, Number(maxItems) || 200)) break;
  }
  return out;
}

export function resolveShareTargetUserId(authUserRow) {
  return normalizeText(authUserRow?.userId);
}

export function isSelfShare(ownerUserId, targetUserId) {
  const owner = normalizeText(ownerUserId);
  const target = normalizeText(targetUserId);
  return Boolean(owner && target && owner === target);
}

export function addShareUserId(currentShareUserIds, targetUserId) {
  const target = normalizeText(targetUserId);
  const current = normalizeShareUserIdList(currentShareUserIds);
  if (!target) return { nextShareUserIds: current, added: false };
  if (current.includes(target)) return { nextShareUserIds: current, added: false };
  return {
    nextShareUserIds: [...current, target],
    added: true
  };
}

export function removeShareUserId(currentShareUserIds, targetUserId) {
  const target = normalizeText(targetUserId);
  const current = normalizeShareUserIdList(currentShareUserIds);
  if (!target) return { nextShareUserIds: current, removed: false };
  const nextShareUserIds = current.filter((userId) => userId !== target);
  return {
    nextShareUserIds,
    removed: nextShareUserIds.length !== current.length
  };
}

export function mapSharedWithUsers(shareUserIds, authUsers) {
  const ids = normalizeShareUserIdList(shareUserIds);
  const rows = Array.isArray(authUsers) ? authUsers : [];
  const byUserId = new Map();
  for (const row of rows) {
    const userId = normalizeText(row?.userId);
    if (!userId || byUserId.has(userId)) continue;
    byUserId.set(userId, {
      userId,
      email: normalizeShareEmail(row?.email),
      name: normalizeText(row?.name)
    });
  }
  return ids.map((userId) => {
    const match = byUserId.get(userId);
    return {
      userId,
      email: match?.email || null,
      name: match?.name || null
    };
  });
}
