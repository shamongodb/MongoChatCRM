export const WORKLOAD_STAGE_VALUES = Object.freeze([
  'Research',
  'Discovery',
  'Scope',
  'Technical Validation',
  'Closed'
]);

export const DEFAULT_WORKLOAD_STAGE = 'Research';

const STAGE_LOOKUP = new Map(
  WORKLOAD_STAGE_VALUES.map((stage) => [stage.toLowerCase(), stage])
);

export function formatWorkloadStageChoices() {
  return WORKLOAD_STAGE_VALUES.map((stage) => `"${stage}"`).join(', ');
}

export function parseWorkloadStage(value, { defaultWhenMissing = false } = {}) {
  if (value === undefined || value === null) {
    if (defaultWhenMissing) return { ok: true, stage: DEFAULT_WORKLOAD_STAGE };
    return { ok: true, stage: undefined };
  }
  const text = String(value).trim();
  if (!text) {
    if (defaultWhenMissing) return { ok: true, stage: DEFAULT_WORKLOAD_STAGE };
    return {
      ok: false,
      error: `stage must be one of: ${formatWorkloadStageChoices()}`
    };
  }
  const canonical = STAGE_LOOKUP.get(text.toLowerCase());
  if (!canonical) {
    return {
      ok: false,
      error: `stage must be one of: ${formatWorkloadStageChoices()}`
    };
  }
  return { ok: true, stage: canonical };
}
