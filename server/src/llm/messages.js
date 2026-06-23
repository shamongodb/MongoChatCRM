import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from '@langchain/core/messages';

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return String(content);
}

export function toLangChainMessages(messages) {
  return (messages || []).map((message) => {
    const role = String(message?.role || '').toLowerCase();
    const content = normalizeContent(message?.content);

    if (role === 'system') {
      return new SystemMessage(content);
    }
    if (role === 'user') {
      return new HumanMessage(content);
    }
    if (role === 'assistant') {
      const out = { content };
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        out.tool_calls = message.tool_calls.map((call) => ({
          id: call.id,
          type: call.type || 'function',
          name: call?.function?.name || call.name,
          args: typeof call?.function?.arguments === 'string'
            ? safeParseJson(call.function.arguments)
            : (call?.function?.arguments || call.args || {})
        }));
      }
      return new AIMessage(out);
    }
    if (role === 'tool') {
      return new ToolMessage({
        content,
        tool_call_id: message.tool_call_id,
        name: message.name
      });
    }
    return new HumanMessage(content);
  });
}

function safeParseJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_err) {
    return {};
  }
}

function serializeToolCallArgs(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch (_err) {
    return '{}';
  }
}

export function aiMessageToOpenAIAssistant(aiMessage) {
  const content = normalizeContent(aiMessage?.content);
  const out = {
    role: 'assistant',
    content
  };

  const toolCalls = Array.isArray(aiMessage?.tool_calls) ? aiMessage.tool_calls : [];
  if (toolCalls.length) {
    out.tool_calls = toolCalls.map((call, index) => {
      const name = call?.name || call?.function?.name || '';
      const args = call?.args ?? call?.function?.arguments ?? {};
      return {
        id: call?.id || `call_${index + 1}`,
        type: call?.type || 'function',
        function: {
          name,
          arguments: serializeToolCallArgs(args)
        }
      };
    });
  }

  return out;
}
