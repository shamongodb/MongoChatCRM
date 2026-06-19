import { Annotation } from '@langchain/langgraph';

function coerceMessages(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

export const AgentGraphState = Annotation.Root({
  messages: Annotation(),
  tools: Annotation(),
  mongoToolNames: Annotation(),
  agentContext: Annotation(),
  iterations: Annotation(),
  maxIterations: Annotation(),
  finalResult: Annotation(),
  lastAssistantMessage: Annotation(),
  pendingToolCalls: Annotation(),
  actionRequired: Annotation(),
  reply: Annotation(),
  done: Annotation(),
  trace: Annotation()
});

export function createInitialGraphState({
  mainSystemPrompt,
  initialMessages,
  tools,
  mongoToolNames,
  agentContext = {},
  maxIterations = 10,
  resumeState
}) {
  const resumeMessages = coerceMessages(resumeState?.messages);
  const incomingMessages = coerceMessages(initialMessages);
  const messages = resumeMessages.length
    ? [...resumeMessages, ...incomingMessages]
    : [{ role: 'system', content: mainSystemPrompt }, ...incomingMessages];

  const resumedAgentContext = resumeState?.agentContext && typeof resumeState.agentContext === 'object'
    ? resumeState.agentContext
    : {};

  return {
    messages,
    tools: Array.isArray(tools) ? tools : [],
    mongoToolNames: Array.isArray(mongoToolNames) ? mongoToolNames : [],
    agentContext: {
      ...resumedAgentContext,
      ...(agentContext && typeof agentContext === 'object' ? agentContext : {})
    },
    iterations: Number.isFinite(Number(resumeState?.iterations)) ? Number(resumeState.iterations) : 0,
    maxIterations: Math.max(1, Number(maxIterations || 10)),
    finalResult: resumeState?.finalResult || null,
    lastAssistantMessage: null,
    pendingToolCalls: [],
    actionRequired: null,
    reply: null,
    done: false,
    trace: Array.isArray(resumeState?.trace) ? resumeState.trace.slice(-50) : []
  };
}

export function buildTraceMetrics(trace) {
  const rows = Array.isArray(trace) ? trace : [];
  const nodePath = rows.map((row) => row?.node).filter(Boolean);
  return {
    nodePath,
    actionRequiredCount: rows.filter((row) => row?.event === 'action_required').length,
    retries: rows.filter((row) => row?.event === 'retry').length
  };
}

export function toGraphStateSnapshot(state) {
  return {
    messages: coerceMessages(state?.messages),
    agentContext: state?.agentContext && typeof state.agentContext === 'object' ? state.agentContext : {},
    iterations: Number(state?.iterations || 0),
    finalResult: state?.finalResult || null,
    trace: Array.isArray(state?.trace) ? state.trace.slice(-50) : []
  };
}
