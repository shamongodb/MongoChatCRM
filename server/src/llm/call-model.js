import { createChatModel as defaultCreateChatModel } from './factory.js';
import { assertLlmConfigured } from './config.js';
import { aiMessageToOpenAIAssistant, toLangChainMessages } from './messages.js';

export function createCallModel(cfg, { createModel = defaultCreateChatModel } = {}) {
  let baseModel = null;

  return async function callModel(messages, tools = [], options = {}) {
    if (!baseModel) {
      assertLlmConfigured(cfg);
      baseModel = createModel(cfg);
    }
    const lcMessages = toLangChainMessages(messages);
    const model = Array.isArray(tools) && tools.length
      ? baseModel.bindTools(tools)
      : baseModel;

    const invokeOpts = {};
    if (options && typeof options === 'object') {
      if (options.temperature !== undefined) invokeOpts.temperature = options.temperature;
      if (options.max_tokens !== undefined) invokeOpts.maxTokens = options.max_tokens;
      if (options.response_format?.type === 'json_object') {
        invokeOpts.responseFormat = { type: 'json_object' };
      }
    }

    const aiMessage = await model.invoke(lcMessages, invokeOpts);
    return {
      choices: [{ message: aiMessageToOpenAIAssistant(aiMessage) }]
    };
  };
}
