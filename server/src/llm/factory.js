import { AzureChatOpenAI } from '@langchain/openai';
import { ChatXAI } from '@langchain/xai';

export function createChatModel(cfg, overrides = {}) {
  const temperature = overrides.temperature ?? 0;

  if (cfg.provider === 'grok') {
    return new ChatXAI({
      model: cfg.xaiModel,
      apiKey: cfg.xaiApiKey,
      temperature,
      modelKwargs: {
        reasoning_effort: cfg.xaiReasoningEffort
      }
    });
  }

  const endpoint = cfg.azureOpenAIEndpoint || cfg.azureEndpoint;
  return new AzureChatOpenAI({
    azureOpenAIApiKey: cfg.azureApiKey,
    azureOpenAIEndpoint: endpoint,
    azureOpenAIApiDeploymentName: cfg.langchainDeployment,
    azureOpenAIApiVersion: cfg.langchainApiVersion,
    temperature
  });
}
