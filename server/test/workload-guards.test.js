import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccountCreateGuardResult,
  buildContactCreateGuardResult,
  buildWorkloadCreateGuardResult,
  mapAccountCandidateRows,
  mapContactCandidateRows,
  mapWorkloadCandidateRows
} from '../src/workload-guards.js';

test('addWorkload guard blocks create when confirm is not true', () => {
  const result = buildWorkloadCreateGuardResult({
    workloadName: 'Lumen - GLM Solr Search',
    accountName: 'Lumen',
    confirm: false,
    candidates: []
  });
  assert.equal(result.block, true);
  assert.equal(result.response.needsConfirmation, true);
  assert.match(result.response.error, /confirm=true/);
});

test('addWorkload guard returns duplicate candidates when similar workloads exist', () => {
  const rows = mapWorkloadCandidateRows([
    {
      _id: '663f1d9816f0ec9aabb11aa1',
      name: 'Lumen - GLM Solr Search',
      accountId: '663f1d9816f0ec9aabb11a90',
      accountName: 'Lumen'
    },
    {
      _id: '663f1d9816f0ec9aabb11aa2',
      name: 'Lumen GLM Solr Search Pilot',
      accountId: '663f1d9816f0ec9aabb11a90',
      accountName: 'Lumen'
    }
  ]);
  const result = buildWorkloadCreateGuardResult({
    workloadName: 'Lumen - GLM Solr Search',
    accountName: 'Lumen',
    confirm: false,
    candidates: rows
  });
  assert.equal(result.block, true);
  assert.equal(result.response.needsConfirmation, true);
  assert.equal(Array.isArray(result.response.candidates), true);
  assert.equal(result.response.candidates.length, 2);
  assert.equal(result.response.candidates[0].matchType, 'exact');
});

test('addWorkload guard allows create when user confirmed new workload', () => {
  const rows = mapWorkloadCandidateRows([
    {
      _id: '663f1d9816f0ec9aabb11aa1',
      name: 'Lumen - GLM Solr Search',
      accountId: '663f1d9816f0ec9aabb11a90',
      accountName: 'Lumen'
    }
  ]);
  const result = buildWorkloadCreateGuardResult({
    workloadName: 'Lumen - GLM Solr Search',
    accountName: 'Lumen',
    confirm: true,
    candidates: rows
  });
  assert.equal(result.block, false);
  assert.equal(result.response, null);
});

test('addAccount guard blocks create without confirmation and returns candidates', () => {
  const candidates = mapAccountCandidateRows([
    {
      _id: '663f1d9816f0ec9aabb11a11',
      name: 'Lumen',
      parentAccountId: null,
      parentAccountName: null
    }
  ]);
  const result = buildAccountCreateGuardResult({
    accountName: 'Lumen',
    confirm: false,
    candidates
  });
  assert.equal(result.block, true);
  assert.equal(result.response.needsConfirmation, true);
  assert.equal(result.response.candidates.length, 1);
  assert.equal(result.response.candidates[0].matchType, 'exact');
});

test('addContact guard treats exact email match as existing candidate', () => {
  const candidates = mapContactCandidateRows([
    {
      _id: '663f1d9816f0ec9aabb11b11',
      name: 'Bill Padfield',
      email: 'bill.padfield@lumen.com',
      accountId: '663f1d9816f0ec9aabb11a90',
      accountName: 'Lumen'
    }
  ]);
  const result = buildContactCreateGuardResult({
    contactName: 'Bill Padfield',
    contactEmail: 'bill.padfield@lumen.com',
    accountName: 'Lumen',
    confirm: false,
    candidates
  });
  assert.equal(result.block, true);
  assert.equal(result.response.needsConfirmation, true);
  assert.equal(result.response.candidates.length, 1);
  assert.equal(result.response.candidates[0].matchType, 'exact');
});

test('addAccount and addContact guards allow create when confirm=true', () => {
  const accountResult = buildAccountCreateGuardResult({
    accountName: 'Lumen',
    confirm: true,
    candidates: []
  });
  const contactResult = buildContactCreateGuardResult({
    contactName: 'Bill Padfield',
    contactEmail: 'bill.padfield@lumen.com',
    accountName: 'Lumen',
    confirm: true,
    candidates: []
  });
  assert.equal(accountResult.block, false);
  assert.equal(contactResult.block, false);
});

test('addWorkload guard treats token reordering as close match', () => {
  const rows = mapWorkloadCandidateRows([
    {
      _id: '663f1d9816f0ec9aabb11aa9',
      name: 'Migration GLM PS',
      accountId: '663f1d9816f0ec9aabb11a90',
      accountName: 'Lumen'
    }
  ]);
  const result = buildWorkloadCreateGuardResult({
    workloadName: 'PS GLM Migration',
    accountName: 'Lumen',
    confirm: false,
    candidates: rows
  });
  assert.equal(result.block, true);
  assert.equal(result.response.needsConfirmation, true);
  assert.equal(result.response.candidates.length, 1);
  assert.equal(result.response.candidates[0].matchType, 'close');
});

test('addContact guard treats punctuation variants as exact normalized match', () => {
  const candidates = mapContactCandidateRows([
    {
      _id: '663f1d9816f0ec9aabb11b19',
      name: 'Sharon-Modiz',
      email: null,
      accountId: '663f1d9816f0ec9aabb11a90',
      accountName: 'Lumen'
    }
  ]);
  const result = buildContactCreateGuardResult({
    contactName: 'Sharon Modiz',
    contactEmail: null,
    accountName: 'Lumen',
    confirm: false,
    candidates
  });
  assert.equal(result.block, true);
  assert.equal(result.response.needsConfirmation, true);
  assert.equal(result.response.candidates.length, 1);
  assert.equal(result.response.candidates[0].matchType, 'exact');
});
