import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { extractBearerToken, verifyMcpVoiceSessionToken } from './voice-auth.js';
import { createMongoMcpServer } from './mcp-server-factory.js';

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return req.body ? JSON.parse(req.body) : undefined;
      } catch (_err) {
        return undefined;
      }
    }
    return req.body;
  }
  if (typeof req.on !== 'function') return undefined;
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', resolve);
    req.on('error', reject);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

export async function handleMcpHttpRequest(req, res, deps) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }

  let userId;
  try {
    const token = extractBearerToken(req.headers?.authorization);
    if (!token) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    userId = verifyMcpVoiceSessionToken(token).userId;
  } catch (err) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.message || 'Unauthorized' }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.message || 'Invalid JSON body' }));
    return;
  }

  const server = createMongoMcpServer({
    mongoToolDefinitions: deps.mongoToolDefinitions,
    runMongoTool: deps.runMongoTool,
    ensureAppReady: deps.ensureAppReady,
    userId
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err?.message || 'MCP handler error' }));
    }
  } finally {
    try {
      await transport.close();
    } catch (_err) {
      // ignore
    }
    try {
      await server.close();
    } catch (_err) {
      // ignore
    }
  }
}
