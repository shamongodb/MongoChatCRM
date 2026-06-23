import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import {
  buildLlmConfig,
  isLlmConfigured,
  assertLlmConfigured
} from '../src/llm/config.js';
import { createChatModel } from '../src/llm/factory.js';
import { createCallModel } from '../src/llm/call-model.js';
import {
  toLangChainMessages,
  aiMessageToOpenAIAssistant
} from '../src/llm/messages.js';
import { ChatXAI } from '@langchain/xai';
import { AzureChatOpenAI } from '@langchain/openai';

test('buildLlmConfig normalizes provider and reasoning effort', () => {
  const cfg = buildLlmConfig({
    LLM_PROVIDER: 'GROK',
    XAI_API_KEY: 'test-key',
    XAI_MODEL: 'grok-4.3',
    XAI_REASONING_EFFORT: 'HIGH',
    AZURE_API_KEY: 'azure-key',
    AZURE_ENDPOINT: 'https://example.openai.azure.com/openai/deployments/gpt/chat/completions'
  });
  assert.equal(cfg.provider, 'grok');
  assert.equal(cfg.xaiApiKey, 'test-key');
  assert.equal(cfg.xaiModel, 'grok-4.3');
  assert.equal(cfg.xaiReasoningEffort, 'high');
});

test('isLlmConfigured validates azure and grok requirements', () => {
  assert.equal(isLlmConfigured(buildLlmConfig({
    LLM_PROVIDER: 'grok',
    XAI_API_KEY: 'key'
  })), true);
  assert.equal(isLlmConfigured(buildLlmConfig({
    LLM_PROVIDER: 'grok'
  })), false);
  assert.equal(isLlmConfigured(buildLlmConfig({
    LLM_PROVIDER: 'azure',
    AZURE_API_KEY: 'key',
    AZURE_OPENAI_DEPLOYMENT: 'gpt-4',
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com'
  })), true);
  assert.equal(isLlmConfigured(buildLlmConfig({
    LLM_PROVIDER: 'azure',
    AZURE_API_KEY: 'key'
  })), false);
});

test('assertLlmConfigured throws for missing credentials', () => {
  assert.throws(
    () => assertLlmConfigured(buildLlmConfig({ LLM_PROVIDER: 'grok' })),
    /XAI_API_KEY/
  );
  assert.throws(
    () => assertLlmConfigured(buildLlmConfig({ LLM_PROVIDER: 'azure' })),
    /AZURE_API_KEY/
  );
});

test('createChatModel returns provider-specific model classes', () => {
  const grokModel = createChatModel(buildLlmConfig({
    LLM_PROVIDER: 'grok',
    XAI_API_KEY: 'test-key',
    XAI_MODEL: 'grok-4.3'
  }));
  assert.ok(grokModel instanceof ChatXAI);

  const azureModel = createChatModel(buildLlmConfig({
    LLM_PROVIDER: 'azure',
    AZURE_API_KEY: 'azure-key',
    AZURE_OPENAI_DEPLOYMENT: 'gpt-4',
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com'
  }));
  assert.ok(azureModel instanceof AzureChatOpenAI);
});

test('message adapters round-trip assistant tool calls', () => {
  const plain = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Find tasks' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'listTasks', arguments: '{"limit":5}' }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'listTasks',
      content: '{"ok":true}'
    }
  ];
  const lcMessages = toLangChainMessages(plain);
  assert.equal(lcMessages.length, 4);

  const aiMessage = new AIMessage({
    content: '',
    tool_calls: [{
      id: 'call_2',
      name: 'createTaskList',
      args: { title: 'Demo' },
      type: 'tool_call'
    }]
  });
  const assistant = aiMessageToOpenAIAssistant(aiMessage);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].function.name, 'createTaskList');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"title":"Demo"}');
});

test('createCallModel binds tools and returns OpenAI-shaped response', async () => {
  const cfg = buildLlmConfig({
    LLM_PROVIDER: 'grok',
    XAI_API_KEY: 'test-key'
  });
  let boundTools = null;
  const callModel = createCallModel(cfg, {
    createModel: () => ({
      bindTools(tools) {
        boundTools = tools;
        return {
          invoke: async () => new AIMessage({ content: 'Task created.' })
        };
      },
      invoke: async () => new AIMessage({ content: 'Task created.' })
    })
  });

  const tools = [{
    type: 'function',
    function: { name: 'createTaskList', parameters: { type: 'object', properties: {} } }
  }];
  const response = await callModel(
    [{ role: 'user', content: 'create list' }],
    tools
  );

  assert.equal(boundTools.length, 1);
  assert.equal(response.choices[0].message.content, 'Task created.');
  assert.equal(response.choices[0].message.role, 'assistant');
});
