import { signMcpVoiceSessionToken } from './voice-auth.js';

export const DEFAULT_VOICE_MCP_ALLOWED_TOOLS = [
  'listAccounts',
  'getAccount',
  'listWorkloads',
  'getWorkload',
  'listContacts',
  'getContact',
  'listTaskLists',
  'getTaskList',
  'searchInitiatives',
  'listInitiatives',
  'listMilestones',
  'updateUserProfileMemory'
];

const CRM_VOICE_INSTRUCTIONS =
  'You are a CRM voice assistant for MongieCRM. Use mongodb-crm tools for accounts, workloads, contacts, tasks, milestones, and initiatives stored in MongoDB. Be concise and conversational for speech. If data is not available via tools, say so honestly. Do not claim to access Google Drive, Docs, or calendar.';

export function resolveMcpPublicUrl(req, env = process.env) {
  const fromEnv = String(env.MCP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}/mcp`;
}

export function buildXaiVoiceSessionConfig({
  userId,
  mcpPublicUrl,
  mcpTokenTtlSeconds = 300,
  voiceId,
  allowedTools = DEFAULT_VOICE_MCP_ALLOWED_TOOLS
} = {}) {
  const mcpToken = signMcpVoiceSessionToken(userId, mcpTokenTtlSeconds);
  const voice = String(voiceId || process.env.XAI_VOICE_ID || 'uidnqelhbc30').trim();

  return {
    voice,
    instructions: CRM_VOICE_INSTRUCTIONS,
    turn_detection: { type: 'server_vad' },
    input_audio_transcription: { model: 'grok-2-audio' },
    tools: [
      {
        type: 'mcp',
        server_url: mcpPublicUrl,
        server_label: 'mongodb-crm',
        server_description: 'MongoDB CRM data (accounts, workloads, contacts, tasks, initiatives)',
        allowed_tools: allowedTools,
        authorization: `Bearer ${mcpToken}`
      }
    ],
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 } },
      output: { format: { type: 'audio/pcm', rate: 24000 } }
    }
  };
}

export async function mintXaiRealtimeClientSecret({ userId, mcpPublicUrl, expiresSeconds = 300, voiceId } = {}) {
  const xaiApiKey = String(process.env.XAI_API_KEY || '').trim();
  if (!xaiApiKey) throw new Error('XAI_API_KEY is required for voice realtime sessions');
  if (!mcpPublicUrl) throw new Error('MCP_PUBLIC_URL could not be resolved');

  const session = buildXaiVoiceSessionConfig({
    userId,
    mcpPublicUrl,
    mcpTokenTtlSeconds: expiresSeconds,
    voiceId
  });

  const r = await fetch('https://api.x.ai/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${xaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expires_after: { seconds: expiresSeconds },
      model: 'grok-voice-latest',
      session
    })
  });

  const raw = await r.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    throw new Error(`xAI client_secrets returned invalid JSON (HTTP ${r.status})`);
  }
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || raw.slice(0, 400) || `HTTP ${r.status}`;
    throw new Error(`xAI client_secrets failed: ${msg}`);
  }
  if (!data?.value) throw new Error('xAI client_secrets response missing value');

  return {
    clientSecret: String(data.value),
    expiresAt: data.expires_at ?? null,
    session
  };
}
