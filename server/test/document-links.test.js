import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeDocumentLinks,
  normalizeDocumentLinksInput
} from '../src/document-links.js';

test('normalizeDocumentLinksInput accepts markdown links with names', () => {
  const result = normalizeDocumentLinksInput(['[QBR Plan](https://example.com/qbr)'], 'documentLinks');
  assert.equal(result.error, undefined);
  assert.equal(Array.isArray(result.links), true);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].name, 'QBR Plan');
  assert.equal(result.links[0].url, 'https://example.com/qbr');
});

test('normalizeDocumentLinksInput requires a name for bare URL', () => {
  const result = normalizeDocumentLinksInput(['https://example.com/no-name'], 'documentLinks');
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /name is required/i);
});

test('mergeDocumentLinks appends and deduplicates by URL', () => {
  const merged = mergeDocumentLinks(
    [{ name: 'Deck', url: 'https://example.com/deck' }],
    [{ name: 'Updated Deck Name', url: 'https://example.com/deck' }, { name: 'Notes', url: 'https://example.com/notes' }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].url, 'https://example.com/deck');
  assert.equal(merged[1].url, 'https://example.com/notes');
});
