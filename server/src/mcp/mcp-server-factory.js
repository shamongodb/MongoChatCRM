import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const looseToolArgsSchema = z.object({}).catchall(z.any());

function toolResultText(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function createMongoMcpServer({ mongoToolDefinitions, runMongoTool, ensureAppReady, userId }) {
  const actorId = String(userId || '').trim();
  if (!actorId) throw new Error('userId is required to create MCP server');

  const server = new McpServer({
    name: 'mongodb-crm',
    version: '1.0.0'
  });

  const toolContext = { userId: actorId, initiatedByUserId: actorId };
  const definitions = typeof mongoToolDefinitions === 'function' ? mongoToolDefinitions() : [];

  for (const def of definitions) {
    const fn = def?.function;
    if (!fn?.name) continue;
    const description = String(fn.description || fn.name).trim();
    server.registerTool(
      fn.name,
      {
        description,
        inputSchema: looseToolArgsSchema
      },
      async (args) => {
        await ensureAppReady();
        const result = await runMongoTool(fn.name, args || {}, toolContext);
        if (result?.error) {
          return {
            content: [{ type: 'text', text: String(result.error) }],
            isError: true
          };
        }
        return toolResultText(result);
      }
    );
  }

  return server;
}
