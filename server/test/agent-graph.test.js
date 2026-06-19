import test from 'node:test';
import assert from 'node:assert/strict';
import { createLangGraphAgentRunner } from '../src/agent/graph/index.js';

function mongoToolDef(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} test tool`,
      parameters: { type: 'object', properties: {} }
    }
  };
}

test('langgraph runner routes Mongo tool calls and returns final reply', async () => {
  let modelCalls = 0;
  const modelResponses = [
    {
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'createTaskList', arguments: '{}' }
          }]
        }
      }]
    },
    {
      choices: [{
        message: {
          role: 'assistant',
          content: 'Task list created successfully.'
        }
      }]
    }
  ];

  let mongoCalls = 0;
  const runner = createLangGraphAgentRunner({
    mainSystemPrompt: 'system prompt',
    fetchGoogleToolDefinitions: async () => [],
    mongoToolDefinitions: () => [mongoToolDef('createTaskList')],
    callModel: async () => modelResponses[modelCalls++],
    runMongoTool: async () => {
      mongoCalls += 1;
      return { ok: true, taskListId: 'abc123' };
    },
    executeGoogleTool: async () => ({ ok: true })
  });

  const out = await runner([{ role: 'user', content: 'create a task list' }], { userId: 'u_1' });
  assert.equal(out.reply, 'Task list created successfully.');
  assert.equal(mongoCalls, 1);
  assert.equal(Array.isArray(out.transcriptMessages), true);
  assert.equal(out.transcriptMessages.some((m) => m.role === 'tool' && m.name === 'createTaskList'), true);
});

test('langgraph runner returns actionRequired payload and resumable state', async () => {
  let modelCalls = 0;
  const runner = createLangGraphAgentRunner({
    mainSystemPrompt: 'system prompt',
    fetchGoogleToolDefinitions: async () => [],
    mongoToolDefinitions: () => [mongoToolDef('addAccount')],
    callModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: 'I found a close account match.',
              tool_calls: [{
                id: 'call_2',
                type: 'function',
                function: { name: 'addAccount', arguments: '{"name":"Lumen"}' }
              }]
            }
          }]
        };
      }
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: 'Confirmed. Creating the account now.'
          }
        }]
      };
    },
    runMongoTool: async () => ({
      needsConfirmation: true,
      candidates: [{ id: 'acc1', name: 'Lumen Technologies' }]
    }),
    executeGoogleTool: async () => ({ ok: true })
  });

  const firstOut = await runner([{ role: 'user', content: 'Create account Lumen' }], { userId: 'u_2' });
  assert.equal(firstOut.actionRequired?.type, 'confirmation');
  assert.ok(firstOut.graphState);

  const resumedOut = await runner(
    [{ role: 'user', content: 'Yes, create a new account' }],
    { userId: 'u_2' },
    { resumeState: firstOut.graphState }
  );
  assert.equal(resumedOut.reply, 'Confirmed. Creating the account now.');
  assert.equal(resumedOut.actionRequired, undefined);
});

test('langgraph runner stops tools after confirmation required', async () => {
  const mongoCalls = [];
  const callModel = async (_messages, _tools) => ({
    choices: [{
      message: {
        role: 'assistant',
        content: 'Need your confirmation first.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'addAccount', arguments: '{"name":"Acme"}' }
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'createTaskList', arguments: '{"name":"Follow-ups"}' }
          }
        ]
      }
    }]
  });

  const runner = createLangGraphAgentRunner({
    mainSystemPrompt: 'system prompt',
    fetchGoogleToolDefinitions: async () => [],
    mongoToolDefinitions: () => [mongoToolDef('addAccount'), mongoToolDef('createTaskList')],
    callModel,
    runMongoTool: async (name) => {
      mongoCalls.push(name);
      if (name === 'addAccount') {
        return { needsConfirmation: true, candidates: [{ id: 'a1', name: 'Acme Corp' }] };
      }
      return { ok: true };
    },
    executeGoogleTool: async () => ({ ok: true })
  });

  const out = await runner(
    [{ role: 'user', content: 'Create account and list' }],
    { userId: 'u_42' },
    { threadId: 'thread-xyz' }
  );

  assert.equal(out.actionRequired?.type, 'confirmation');
  assert.equal(mongoCalls.length, 1);
  assert.equal(mongoCalls[0], 'addAccount');
});
