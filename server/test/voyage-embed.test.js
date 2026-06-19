import test from 'node:test';
import assert from 'node:assert/strict';
import { embedVoyageTexts, getVoyageEmbedModel } from '../src/voyage-embed.js';

test('getVoyageEmbedModel returns a non-empty default', () => {
  assert.match(getVoyageEmbedModel(), /./);
});

test('embedVoyageTexts returns error when MONGO_VOYAGE_API_KEY is unset', async () => {
  const prevKey = process.env.MONGO_VOYAGE_API_KEY;
  delete process.env.MONGO_VOYAGE_API_KEY;
  const out = await embedVoyageTexts(['hello world']);
  assert.equal(out.embeddings, null);
  assert.ok(out.error);
  assert.match(out.error, /MONGO_VOYAGE_API_KEY/);
  if (prevKey !== undefined) process.env.MONGO_VOYAGE_API_KEY = prevKey;
});

test('embedVoyageTexts returns error for empty input list', async () => {
  process.env.MONGO_VOYAGE_API_KEY = 'test-key';
  const out = await embedVoyageTexts(['', '  ']);
  assert.equal(out.embeddings, null);
  assert.ok(out.error);
  delete process.env.MONGO_VOYAGE_API_KEY;
});

test('embedVoyageTexts rejects wrong embedding length when MONGO_VOYAGE_EMBED_DIMENSIONS set', async () => {
  const prevKey = process.env.MONGO_VOYAGE_API_KEY;
  const prevDim = process.env.MONGO_VOYAGE_EMBED_DIMENSIONS;
  process.env.MONGO_VOYAGE_API_KEY = 'test-key';
  process.env.MONGO_VOYAGE_EMBED_DIMENSIONS = '1024';
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { data: [{ embedding: [0.1, 0.2] }], model: 'mock' };
    }
  });
  const out = await embedVoyageTexts(['x']);
  assert.equal(out.embeddings, null);
  assert.ok(out.error);
  assert.match(out.error, /1024/);
  globalThis.fetch = prevFetch;
  if (prevKey !== undefined) process.env.MONGO_VOYAGE_API_KEY = prevKey;
  else delete process.env.MONGO_VOYAGE_API_KEY;
  if (prevDim !== undefined) process.env.MONGO_VOYAGE_EMBED_DIMENSIONS = prevDim;
  else delete process.env.MONGO_VOYAGE_EMBED_DIMENSIONS;
});
