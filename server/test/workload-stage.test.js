import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKLOAD_STAGE,
  WORKLOAD_STAGE_VALUES,
  parseWorkloadStage
} from '../src/workload-stage.js';

test('parseWorkloadStage defaults missing create stage to Research', () => {
  const result = parseWorkloadStage(undefined, { defaultWhenMissing: true });
  assert.equal(result.ok, true);
  assert.equal(result.stage, DEFAULT_WORKLOAD_STAGE);
});

test('parseWorkloadStage accepts only allowed values (case-insensitive)', () => {
  for (const stage of WORKLOAD_STAGE_VALUES) {
    const canonical = parseWorkloadStage(stage.toLowerCase(), { defaultWhenMissing: false });
    assert.equal(canonical.ok, true);
    assert.equal(canonical.stage, stage);
  }
});

test('parseWorkloadStage rejects invalid values', () => {
  const result = parseWorkloadStage('Proposal', { defaultWhenMissing: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /stage must be one of/i);
});
