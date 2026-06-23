const VALID_PROVIDERS = new Set(['azure', 'grok']);
const VALID_REASONING_EFFORT = new Set(['none', 'low', 'medium', 'high']);

function normalizeProvider(value) {
  const text = String(value || 'azure').trim().toLowerCase();
  return VALID_PROVIDERS.has(text) ? text : 'azure';
}

function normalizeReasoningEffort(value) {
  const text = String(value || 'low').trim().toLowerCase();
  return VALID_REASONING_EFFORT.has(text) ? text : 'low';
}

export function getAzureOpenAIEndpoint(env = process.env) {
  const explicit = String(env.AZURE_OPENAI_ENDPOINT || '').trim();
  if (explicit) return explicit;
  const fallback = String(env.AZURE_ENDPOINT || '').trim();
  if (!fallback) return '';
  const idx = fallback.indexOf('/openai/');
  return idx === -1 ? fallback : fallback.slice(0, idx);
}

export function buildLlmConfig(env = process.env) {
  const provider = normalizeProvider(env.LLM_PROVIDER);
  const azureOpenAIEndpoint = getAzureOpenAIEndpoint(env);
  return {
    provider,
    azureApiKey: String(env.AZURE_API_KEY || '').trim(),
    azureEndpoint: String(env.AZURE_ENDPOINT || '').trim(),
    azureOpenAIEndpoint,
    langchainDeployment: String(env.AZURE_OPENAI_DEPLOYMENT || '').trim(),
    langchainApiVersion: String(env.AZURE_OPENAI_API_VERSION || '2024-02-01').trim(),
    xaiApiKey: String(env.XAI_API_KEY || '').trim(),
    xaiModel: String(env.XAI_MODEL || 'grok-4.3').trim(),
    xaiReasoningEffort: normalizeReasoningEffort(env.XAI_REASONING_EFFORT)
  };
}

export function isLlmConfigured(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (cfg.provider === 'grok') {
    return Boolean(cfg.xaiApiKey);
  }
  const endpoint = cfg.azureOpenAIEndpoint || cfg.azureEndpoint;
  return Boolean(cfg.azureApiKey && cfg.langchainDeployment && endpoint);
}

export function assertLlmConfigured(cfg) {
  if (cfg.provider === 'grok') {
    if (!cfg.xaiApiKey) {
      throw new Error('XAI_API_KEY is required when LLM_PROVIDER=grok');
    }
    return;
  }
  const endpoint = cfg.azureOpenAIEndpoint || cfg.azureEndpoint;
  if (!cfg.azureApiKey || !endpoint) {
    throw new Error('AZURE_API_KEY and AZURE_ENDPOINT (or AZURE_OPENAI_ENDPOINT) are required when LLM_PROVIDER=azure');
  }
  if (!cfg.langchainDeployment) {
    throw new Error('AZURE_OPENAI_DEPLOYMENT is required when LLM_PROVIDER=azure');
  }
}
