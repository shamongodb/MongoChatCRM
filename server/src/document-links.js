function normalizeDocLinkUrl(value, maxLen = 2000) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().slice(0, Math.max(1, maxLen));
  } catch (_err) {
    return '';
  }
}

function parseNamedUrlFromText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const markdownMatch = value.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i);
  if (markdownMatch) {
    return { name: String(markdownMatch[1] || '').trim(), url: String(markdownMatch[2] || '').trim() };
  }
  const urlMatch = value.match(/https?:\/\/\S+/i);
  if (!urlMatch) return null;
  const url = String(urlMatch[0] || '').replace(/[),.;]+$/, '');
  const before = value.slice(0, urlMatch.index).trim().replace(/[:\-–\s]+$/, '').trim();
  const after = value.slice((urlMatch.index || 0) + urlMatch[0].length).trim();
  const inferredName = before || after;
  return { name: inferredName, url };
}

function normalizeOneDocumentLink(raw, fieldLabel) {
  if (raw == null) return { error: `${fieldLabel} items must be a string or object with name and url.` };
  let name = '';
  let url = '';
  if (typeof raw === 'string') {
    const parsed = parseNamedUrlFromText(raw);
    if (!parsed) {
      return { error: `${fieldLabel} must include a valid http(s) link.` };
    }
    name = String(parsed.name || '').trim();
    url = String(parsed.url || '').trim();
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    name = String(raw.name || raw.title || raw.label || '').trim();
    url = String(raw.url || raw.link || raw.href || '').trim();
  } else {
    return { error: `${fieldLabel} items must be a string or object with name and url.` };
  }

  const normalizedUrl = normalizeDocLinkUrl(url);
  if (!normalizedUrl) {
    return { error: `${fieldLabel} url must be a valid http(s) URL.` };
  }
  if (!name) {
    return { error: `${fieldLabel} name is required for ${normalizedUrl}. Ask the user what to call this document, then retry.` };
  }
  return { value: { name, url: normalizedUrl } };
}

export function normalizeDocumentLinksInput(rawValue, fieldLabel = 'documentLinks') {
  if (rawValue === undefined) return { links: undefined };
  if (rawValue === null) return { links: [] };
  const source = Array.isArray(rawValue) ? rawValue : [rawValue];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const normalized = normalizeOneDocumentLink(item, fieldLabel);
    if (normalized.error) return { error: normalized.error };
    const next = normalized.value;
    const dedupeKey = String(next.url || '').toLowerCase();
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(next);
  }
  return { links: out };
}

export function mergeDocumentLinks(existingLinks, addedLinks) {
  const existing = Array.isArray(existingLinks) ? existingLinks : [];
  const added = Array.isArray(addedLinks) ? addedLinks : [];
  const out = [];
  const seen = new Set();
  for (const item of [...existing, ...added]) {
    const normalized = normalizeOneDocumentLink(item, 'documentLinks');
    if (normalized.error) continue;
    const next = normalized.value;
    const dedupeKey = String(next.url || '').toLowerCase();
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(next);
  }
  return out;
}
