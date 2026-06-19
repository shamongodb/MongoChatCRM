import { END, START, StateGraph } from '@langchain/langgraph';
import { buildGraphNodes, routeAfterModel, routeAfterTools, routeFromInit } from './nodes.js';
import { AgentGraphState, buildTraceMetrics, createInitialGraphState, toGraphStateSnapshot } from './state.js';

export function createLangGraphAgentRunner({
  mainSystemPrompt,
  fetchGoogleToolDefinitions,
  mongoToolDefinitions,
  callModel,
  runMongoTool,
  executeGoogleTool,
  maxIterations = 10,
  includeTraceInResponse = false,
  traceLogger = null,
  checkpointer = null
}) {
  if (!mainSystemPrompt) throw new Error('createLangGraphAgentRunner requires mainSystemPrompt');
  const nodes = buildGraphNodes({ callModel, runMongoTool, executeGoogleTool });

  const graph = new StateGraph(AgentGraphState)
    .addNode('initState', nodes.initState)
    .addNode('modelStep', nodes.modelStep)
    .addNode('routeTool', nodes.routeTool)
    .addNode('finalizeReply', nodes.finalizeReply)
    .addEdge(START, 'initState')
    .addConditionalEdges('initState', routeFromInit)
    .addConditionalEdges('modelStep', routeAfterModel)
    .addConditionalEdges('routeTool', routeAfterTools)
    .addEdge('finalizeReply', END)
    .compile(checkpointer ? { checkpointer } : undefined);

  return async function runLangGraphAgentLoop(initialMessages, agentContext = {}, options = {}) {
    const googleTools = await fetchGoogleToolDefinitions();
    const mongoTools = mongoToolDefinitions();
    const tools = [...googleTools, ...mongoTools];
    const mongoToolNames = mongoTools.map((toolDef) => toolDef.function.name);

    const initialState = createInitialGraphState({
      mainSystemPrompt,
      initialMessages,
      tools,
      mongoToolNames,
      agentContext,
      maxIterations,
      resumeState: options.resumeState || null
    });

    const threadIdRaw = options.threadId || agentContext?.conversationId || agentContext?.userId || null;
    const threadId = threadIdRaw ? String(threadIdRaw).trim() : '';
    const invokeConfig = threadId
      ? { configurable: { thread_id: threadId } }
      : undefined;
    const finalState = await graph.invoke(initialState, invokeConfig);
    const metrics = buildTraceMetrics(finalState.trace);
    if (typeof traceLogger === 'function') {
      traceLogger(metrics, finalState.trace);
    }

    const response = {
      reply: finalState.reply || "I'm not sure how to respond. Please try rephrasing or provide more context.",
      finalResult: finalState.finalResult || undefined,
      transcriptMessages: Array.isArray(finalState.messages) ? finalState.messages : []
    };

    if (finalState.actionRequired) {
      response.actionRequired = finalState.actionRequired;
      response.graphState = toGraphStateSnapshot(finalState);
    }
    if (includeTraceInResponse) {
      response.agentMetrics = metrics;
      response.agentTrace = Array.isArray(finalState.trace) ? finalState.trace : [];
    }
    return response;
  };
}
