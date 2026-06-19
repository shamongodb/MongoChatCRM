function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeName(value) {
  const normalized = normalizeName(value);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

function buildTokenSet(tokens) {
  const out = new Set();
  for (const token of tokens) {
    const text = String(token || '').trim();
    if (text) out.add(text);
  }
  return out;
}

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left) return right.length;
  if (!right) return left.length;
  const dp = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) dp[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const temp = dp[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = temp;
    }
  }
  return dp[right.length];
}

function computeNameSimilarityFlags(targetName, candidateName) {
  const target = normalizeName(targetName);
  const candidate = normalizeName(candidateName);
  if (!target || !candidate) return { isExact: false, isClose: false };
  if (target === candidate) return { isExact: true, isClose: true };
  const targetTokens = tokenizeName(target);
  const candidateTokens = tokenizeName(candidate);
  const targetSet = buildTokenSet(targetTokens);
  const candidateSet = buildTokenSet(candidateTokens);
  const sharedTokens = targetTokens.filter((token) => candidateSet.has(token)).length;
  const minTokenCount = Math.min(targetSet.size, candidateSet.size);
  const tokenOverlap = minTokenCount ? (sharedTokens / minTokenCount) : 0;
  if (tokenOverlap >= 1 && targetSet.size > 1 && candidateSet.size > 1) {
    return { isExact: false, isClose: true };
  }
  const includesMatch = target.includes(candidate) || candidate.includes(target);
  if (includesMatch) return { isExact: false, isClose: true };
  if (tokenOverlap >= 0.75) return { isExact: false, isClose: true };
  const maxLen = Math.max(target.length, candidate.length);
  const distance = levenshteinDistance(target, candidate);
  const ratio = maxLen ? (distance / maxLen) : 1;
  return { isExact: false, isClose: ratio <= 0.2 || distance <= 2 };
}

export function mapWorkloadCandidateRows(rows) {
  const candidates = [];
  const seen = new Set();
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const workloadId = String(row?._id || '').trim();
    const name = String(row?.name || '').trim();
    if (!workloadId || !name || seen.has(workloadId)) continue;
    seen.add(workloadId);
    candidates.push({
      workloadId,
      name,
      accountId: row?.accountId ? String(row.accountId) : null,
      accountName: row?.accountName ? String(row.accountName) : null
    });
  }
  return candidates;
}

function classifyCandidates(workloadName, candidates, limit = 5) {
  const output = [];
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list) {
    const flags = computeNameSimilarityFlags(workloadName, candidate?.name);
    if (!flags.isClose) continue;
    output.push({
      workloadId: String(candidate.workloadId || '').trim(),
      name: String(candidate.name || '').trim(),
      accountId: candidate.accountId ? String(candidate.accountId).trim() : null,
      accountName: candidate.accountName ? String(candidate.accountName).trim() : null,
      matchType: flags.isExact ? 'exact' : 'close'
    });
    if (output.length >= limit) break;
  }
  return output.filter((row) => row.workloadId && row.name);
}

function classifyAccountCandidates(accountName, candidates, limit = 5) {
  const output = [];
  const list = Array.isArray(candidates) ? candidates : [];
  for (const candidate of list) {
    const flags = computeNameSimilarityFlags(accountName, candidate?.name);
    if (!flags.isClose) continue;
    output.push({
      accountId: String(candidate.accountId || '').trim(),
      name: String(candidate.name || '').trim(),
      parentAccountId: candidate.parentAccountId ? String(candidate.parentAccountId).trim() : null,
      parentAccountName: candidate.parentAccountName ? String(candidate.parentAccountName).trim() : null,
      matchType: flags.isExact ? 'exact' : 'close'
    });
    if (output.length >= limit) break;
  }
  return output.filter((row) => row.accountId && row.name);
}

function classifyContactCandidates(contactName, contactEmail, candidates, limit = 5) {
  const output = [];
  const list = Array.isArray(candidates) ? candidates : [];
  const targetEmail = String(contactEmail || '').trim().toLowerCase();
  for (const candidate of list) {
    const candidateEmail = String(candidate?.email || '').trim().toLowerCase();
    const emailExact = !!targetEmail && !!candidateEmail && targetEmail === candidateEmail;
    const nameFlags = computeNameSimilarityFlags(contactName, candidate?.name);
    if (!emailExact && !nameFlags.isClose) continue;
    output.push({
      contactId: String(candidate.contactId || '').trim(),
      name: String(candidate.name || '').trim(),
      email: candidate.email ? String(candidate.email).trim() : null,
      accountId: candidate.accountId ? String(candidate.accountId).trim() : null,
      accountName: candidate.accountName ? String(candidate.accountName).trim() : null,
      matchType: emailExact || nameFlags.isExact ? 'exact' : 'close'
    });
    if (output.length >= limit) break;
  }
  return output.filter((row) => row.contactId && row.name);
}

export function buildWorkloadCreateGuardResult({
  workloadName,
  accountName,
  confirm,
  candidates
}) {
  const candidateMatches = classifyCandidates(workloadName, candidates, 5);
  if (confirm === true) {
    return { block: false, response: null, candidates: candidateMatches };
  }
  if (candidateMatches.length) {
    return {
      block: true,
      response: {
        error: `Potential existing workloads found for "${String(workloadName || '').trim()}" in account "${String(accountName || '').trim()}". Ask the user whether to use an existing workload or create a new one, then re-run addWorkload with confirm=true.`,
        needsConfirmation: true,
        candidates: candidateMatches
      },
      candidates: candidateMatches
    };
  }
  return {
    block: true,
    response: {
      error: `Confirmation required: before creating "${String(workloadName || '').trim()}", confirm with the user and re-run addWorkload with confirm=true.`,
      needsConfirmation: true,
      candidates: []
    },
    candidates: []
  };
}

export function mapAccountCandidateRows(rows) {
  const candidates = [];
  const seen = new Set();
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const accountId = String(row?._id || '').trim();
    const name = String(row?.name || '').trim();
    if (!accountId || !name || seen.has(accountId)) continue;
    seen.add(accountId);
    candidates.push({
      accountId,
      name,
      parentAccountId: row?.parentAccountId ? String(row.parentAccountId) : null,
      parentAccountName: row?.parentAccountName ? String(row.parentAccountName) : null
    });
  }
  return candidates;
}

export function mapContactCandidateRows(rows) {
  const candidates = [];
  const seen = new Set();
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const contactId = String(row?._id || '').trim();
    const name = String(row?.name || '').trim();
    if (!contactId || !name || seen.has(contactId)) continue;
    seen.add(contactId);
    candidates.push({
      contactId,
      name,
      email: row?.email ? String(row.email) : null,
      accountId: row?.accountId ? String(row.accountId) : null,
      accountName: row?.accountName ? String(row.accountName) : null
    });
  }
  return candidates;
}

export function buildAccountCreateGuardResult({
  accountName,
  confirm,
  candidates
}) {
  const candidateMatches = classifyAccountCandidates(accountName, candidates, 5);
  if (confirm === true) {
    return { block: false, response: null, candidates: candidateMatches };
  }
  if (candidateMatches.length) {
    return {
      block: true,
      response: {
        error: `Potential existing accounts found for "${String(accountName || '').trim()}". Ask the user whether to use an existing account or create a new one, then re-run addAccount with confirm=true.`,
        needsConfirmation: true,
        candidates: candidateMatches
      },
      candidates: candidateMatches
    };
  }
  return {
    block: true,
    response: {
      error: `Confirmation required: before creating account "${String(accountName || '').trim()}", confirm with the user and re-run addAccount with confirm=true.`,
      needsConfirmation: true,
      candidates: []
    },
    candidates: []
  };
}

export function buildContactCreateGuardResult({
  contactName,
  contactEmail,
  accountName,
  confirm,
  candidates
}) {
  const candidateMatches = classifyContactCandidates(contactName, contactEmail, candidates, 5);
  if (confirm === true) {
    return { block: false, response: null, candidates: candidateMatches };
  }
  if (candidateMatches.length) {
    return {
      block: true,
      response: {
        error: `Potential existing contacts found for "${String(contactName || '').trim()}"${accountName ? ` in account "${String(accountName).trim()}"` : ''}. Ask the user whether to use an existing contact or create a new one, then re-run addContact with confirm=true.`,
        needsConfirmation: true,
        candidates: candidateMatches
      },
      candidates: candidateMatches
    };
  }
  return {
    block: true,
    response: {
      error: `Confirmation required: before creating contact "${String(contactName || '').trim()}"${accountName ? ` in account "${String(accountName).trim()}"` : ''}, confirm with the user and re-run addContact with confirm=true.`,
      needsConfirmation: true,
      candidates: []
    },
    candidates: []
  };
}
