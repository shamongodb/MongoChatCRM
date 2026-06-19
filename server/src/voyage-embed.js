const VOYAGE_EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';

export function getVoyageEmbedModel() {
  return String(process.env.MONGO_VOYAGE_EMBED_MODEL || 'voyage-3-large').trim() || 'voyage-3-large';
}

export function getVoyageEmbedDimensionsExpected() {
  const raw = String(process.env.MONGO_VOYAGE_EMBED_DIMENSIONS || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * @param {string[]} texts
 * @returns {Promise<{ embeddings: number[][] | null, model?: string, error?: string }>}
 */
export async function embedVoyageTexts(texts) {
  const apiKey = String(process.env.MONGO_VOYAGE_API_KEY || '').trim();
  if (!apiKey) return { embeddings: null, error: 'MONGO_VOYAGE_API_KEY is not set' };
  const inputs = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t == null ? '' : t).trim())
    .filter(Boolean);
  if (!inputs.length) return { embeddings: null, error: 'no input texts' };
  const model = getVoyageEmbedModel();
  const body = { model, input: inputs.length === 1 ? inputs[0] : inputs };
  let res;
  try {
    res = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return { embeddings: null, error: err?.message || String(err) };
  }
  if (!res.ok) {
    const t = await res.text();
    return { embeddings: null, error: `Voyage API ${res.status}: ${t.slice(0, 240)}` };
  }
  let data;
  try {
    data = await res.json();
  } catch (_err) {
    return { embeddings: null, error: 'Voyage API returned non-JSON' };
  }
  const rows = Array.isArray(data?.data) ? data.data : [];
  const embeddings = rows.map((row) => row.embedding).filter((e) => Array.isArray(e) && e.length);
  if (!embeddings.length) return { embeddings: null, error: 'Voyage API returned no embeddings' };
  const expected = getVoyageEmbedDimensionsExpected();
  for (const emb of embeddings) {
    if (expected != null && emb.length !== expected) {
      return {
        embeddings: null,
        error: `Embedding length ${emb.length} does not match MONGO_VOYAGE_EMBED_DIMENSIONS=${expected}`
      };
    }
  }
  return { embeddings, model: data.model || model, error: undefined };
}

/**
 * @param {string} text
 * @returns {Promise<{ embedding: number[] | null, model?: string, error?: string }>}
 */
export async function embedSingleText(text) {
  const t = String(text || '').trim();
  if (!t) return { embedding: null, error: 'empty text' };
  const batch = await embedVoyageTexts([t]);
  if (batch.error) return { embedding: null, error: batch.error };
  const embedding = batch.embeddings?.[0] || null;
  if (!embedding) return { embedding: null, error: 'no embedding returned' };
  return { embedding, model: batch.model };
}
