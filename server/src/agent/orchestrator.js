function parseToolArguments(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  try {
    return JSON.parse(String(rawArgs));
  } catch (err) {
    throw new Error(`Invalid tool arguments JSON: ${err?.message || String(err)}`);
  }
}

export function createLegacyAgentRunner({
  mainSystemPrompt,
  fetchGoogleToolDefinitions,
  mongoToolDefinitions,
  callModel,
  runMongoTool,
  executeGoogleTool,
  maxIterations = 10
}) {
  if (!mainSystemPrompt) throw new Error('createLegacyAgentRunner requires mainSystemPrompt');

  return async function runLegacyAgentLoop(initialMessages, agentContext = {}) {
    const googleTools = await fetchGoogleToolDefinitions();
    const mongoTools = mongoToolDefinitions();
    const tools = [...googleTools, ...mongoTools];
    const mongoToolNames = new Set(mongoTools.map((toolDef) => toolDef.function.name));

    const messages = [
      { role: 'system', content: mainSystemPrompt },
      ...(Array.isArray(initialMessages) ? initialMessages : [])
    ];

    let iterations = 0;
    let finalResult = null;

    while (iterations < maxIterations) {
      iterations += 1;
      const response = await callModel(messages, tools);
      const assistantMessage = response?.choices?.[0]?.message;
      if (!assistantMessage) throw new Error('Azure returned no assistant message');
      messages.push(assistantMessage);

      if (Array.isArray(assistantMessage.tool_calls) && assistantMessage.tool_calls.length) {
        for (const toolCall of assistantMessage.tool_calls) {
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

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: fnName,
            content: JSON.stringify(result)
          });
        }
        continue;
      }

      const reply = assistantMessage.content && String(assistantMessage.content).trim()
        ? assistantMessage.content
        : "I'm not sure how to respond. Please try rephrasing or provide more context.";

      return {
        reply,
        finalResult: finalResult || undefined,
        transcriptMessages: messages
      };
    }

    return {
      reply: 'I hit the iteration limit. Please try a more specific request.',
      finalResult: finalResult || undefined,
      transcriptMessages: messages
    };
  };
}
