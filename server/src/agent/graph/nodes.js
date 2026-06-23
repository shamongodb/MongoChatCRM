function appendTrace(state, nextEntry) {
  const trace = Array.isArray(state.trace) ? [...state.trace] : [];
  trace.push({ at: new Date().toISOString(), ...nextEntry });
  return trace.slice(-200);
}

function parseToolArguments(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  try {
    return JSON.parse(String(rawArgs));
  } catch (err) {
    throw new Error(`Invalid tool arguments JSON: ${err?.message || String(err)}`);
  }
}

function createActionRequired(toolName, toolCallId, result) {
  if (!result || typeof result !== 'object') return null;
  if (!result.needsDisambiguation && !result.needsConfirmation) return null;
  return {
    type: result.needsConfirmation ? 'confirmation' : 'disambiguation',
    toolName,
    toolCallId: toolCallId || null,
    details: result
  };
}

export function buildGraphNodes({ callModel, runMongoTool, executeGoogleTool }) {
  async function initState(state) {
    return {
      trace: appendTrace(state, { node: 'initState' })
    };
  }

  async function modelStep(state) {
    const iterations = Number(state.iterations || 0);
    const maxIterations = Number(state.maxIterations || 10);
    if (iterations >= maxIterations) {
      return {
        done: true,
        reply: 'I hit the iteration limit. Please try a more specific request.',
        trace: appendTrace(state, { node: 'modelStep', event: 'iteration_limit' })
      };
    }

    const response = await callModel(state.messages || [], state.tools || []);
    const assistantMessage = response?.choices?.[0]?.message;
    if (!assistantMessage) throw new Error('Model returned no assistant message');

    const nextMessages = [...(state.messages || []), assistantMessage];
    return {
      iterations: iterations + 1,
      messages: nextMessages,
      lastAssistantMessage: assistantMessage,
      pendingToolCalls: Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [],
      trace: appendTrace(state, {
        node: 'modelStep',
        event: 'assistant_message',
        hasToolCalls: Array.isArray(assistantMessage.tool_calls) && assistantMessage.tool_calls.length > 0
      })
    };
  }

  async function routeTool(state) {
    const calls = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : [];
    const mongoToolNames = new Set(Array.isArray(state.mongoToolNames) ? state.mongoToolNames : []);
    const currentMessages = Array.isArray(state.messages) ? [...state.messages] : [];
    let finalResult = state.finalResult || null;
    let actionRequired = null;
    let executedToolCount = 0;
    const agentContext = {
      ...(state.agentContext && typeof state.agentContext === 'object' ? state.agentContext : {})
    };

    for (const toolCall of calls) {
      const fnName = toolCall?.function?.name;
      const args = parseToolArguments(toolCall?.function?.arguments || '{}');
      const toolContext = {
        userId: agentContext.userId || null,
        userProfile: agentContext.userProfile || null,
        initiatedByUserId: agentContext.initiatedByUserId || agentContext.userId || null,
        authType: agentContext.authType || null
      };
      let result;
      if (mongoToolNames.has(fnName)) {
        result = await runMongoTool(fnName, args, toolContext);
      } else {
        result = await executeGoogleTool(fnName, args, toolContext);
      }

      if (fnName === 'updateUserProfileMemory' && result?.ok && result?.profile) {
        agentContext.userProfile = result.profile;
      }
      if (result && typeof result === 'object' && result.url) {
        finalResult = { url: result.url };
      }

      const needsAction = createActionRequired(fnName, toolCall?.id, result);
      if (needsAction) {
        actionRequired = needsAction;
      }

      currentMessages.push({
        role: 'tool',
        tool_call_id: toolCall?.id,
        name: fnName,
        content: JSON.stringify(result)
      });
      executedToolCount += 1;

      // Pause the graph immediately once human input is required.
      if (actionRequired) break;
    }

    return {
      messages: currentMessages,
      pendingToolCalls: [],
      finalResult,
      actionRequired,
      done: Boolean(actionRequired),
      agentContext,
      trace: appendTrace(state, {
        node: 'routeTool',
        event: actionRequired ? 'action_required' : 'tool_complete',
        toolCount: executedToolCount
      })
    };
  }

  async function finalizeReply(state) {
    if (state.done && state.reply) {
      return { trace: appendTrace(state, { node: 'finalizeReply', event: 'already_done' }) };
    }
    const assistantText = state?.lastAssistantMessage?.content == null
      ? ''
      : String(state.lastAssistantMessage.content).trim();

    const reply = state.actionRequired
      ? assistantText || 'I need your confirmation before I can continue.'
      : (assistantText || "I'm not sure how to respond. Please try rephrasing or provide more context.");

    return {
      done: true,
      reply,
      trace: appendTrace(state, { node: 'finalizeReply' })
    };
  }

  return {
    initState,
    modelStep,
    routeTool,
    finalizeReply
  };
}

export function routeFromInit(state) {
  if (state?.done) return 'finalizeReply';
  return 'modelStep';
}

export function routeAfterModel(state) {
  if (state?.done) return 'finalizeReply';
  const toolCalls = Array.isArray(state?.pendingToolCalls) ? state.pendingToolCalls : [];
  if (toolCalls.length) return 'routeTool';
  return 'finalizeReply';
}

export function routeAfterTools(state) {
  if (state?.done || state?.actionRequired) return 'finalizeReply';
  const iterations = Number(state?.iterations || 0);
  const maxIterations = Number(state?.maxIterations || 10);
  if (iterations >= maxIterations) return 'finalizeReply';
  return 'modelStep';
}
