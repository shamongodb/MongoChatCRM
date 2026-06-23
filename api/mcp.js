import '../scripts/load-env.js';
import { ensureAppReady, mongoToolDefinitions, runMongoTool } from '../server/src/index.js';
import { handleMcpHttpRequest } from '../server/src/mcp/http-handler.js';

export default async function handler(req, res) {
  await ensureAppReady();
  return handleMcpHttpRequest(req, res, {
    mongoToolDefinitions,
    runMongoTool,
    ensureAppReady
  });
}
