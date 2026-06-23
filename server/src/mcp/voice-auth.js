import jwt from 'jsonwebtoken';

const MCP_VOICE_AUDIENCE = 'mcp-voice';

export function createMcpVoiceAuthConfig(env = process.env) {
  const jwtSigningSecret = String(env.JWT_SIGNING_SECRET || '').trim() || 'dev-insecure-jwt-secret-change-me';
  const jwtIssuer = String(env.JWT_ISSUER || 'mcp-node-api').trim() || 'mcp-node-api';
  return { jwtSigningSecret, jwtIssuer, mcpVoiceAudience: MCP_VOICE_AUDIENCE };
}

export function signMcpVoiceSessionToken(userId, ttlSeconds = 300, config = createMcpVoiceAuthConfig()) {
  const sub = String(userId || '').trim();
  if (!sub) throw new Error('userId is required for MCP voice session token');
  return jwt.sign(
    { sub, typ: 'mcp_session' },
    config.jwtSigningSecret,
    {
      algorithm: 'HS256',
      expiresIn: Math.max(60, Number(ttlSeconds) || 300),
      issuer: config.jwtIssuer,
      audience: config.mcpVoiceAudience
    }
  );
}

export function verifyMcpVoiceSessionToken(token, config = createMcpVoiceAuthConfig()) {
  const payload = jwt.verify(String(token || '').trim(), config.jwtSigningSecret, {
    algorithms: ['HS256'],
    issuer: config.jwtIssuer,
    audience: config.mcpVoiceAudience
  });
  const userId = String(payload?.sub || '').trim();
  if (!userId) throw new Error('MCP voice token missing user subject');
  return { userId };
}

export function extractBearerToken(headerValue) {
  const auth = String(headerValue || '').trim();
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice(7).trim();
}
