/**
 * Node smoke test for xAI Voice + MongoDB MCP (server-side API key).
 * Usage: XAI_API_KEY=... MCP_PUBLIC_URL=https://your-app.vercel.app/mcp node scripts/xai-voice-smoke-test.js
 */
import '../scripts/load-env.js';
import WebSocket from 'ws';
import { signMcpVoiceSessionToken } from '../server/src/mcp/voice-auth.js';

const XAI_API_KEY = String(process.env.XAI_API_KEY || '').trim();
const MCP_PUBLIC_URL = String(process.env.MCP_PUBLIC_URL || '').trim();
const VOICE_ID = String(process.env.XAI_VOICE_ID || 'uidnqelhbc30').trim();
const TEST_USER_ID = String(process.env.MCP_TEST_USER_ID || 'smoke-test-user').trim();

if (!XAI_API_KEY) {
  console.error('Set XAI_API_KEY');
  process.exit(1);
}
if (!MCP_PUBLIC_URL) {
  console.error('Set MCP_PUBLIC_URL (e.g. http://localhost:8787/mcp for local)');
  process.exit(1);
}

const mcpToken = signMcpVoiceSessionToken(TEST_USER_ID, 300);
const url = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest';

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${XAI_API_KEY}` }
});

ws.on('open', () => {
  console.log('WebSocket open — sending session.update');
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      voice: VOICE_ID,
      instructions:
        'You are a CRM voice assistant. Use mongodb-crm tools for MongoDB data. Be brief.',
      turn_detection: { type: 'server_vad' },
      input_audio_transcription: { model: 'grok-2-audio' },
      tools: [
        {
          type: 'mcp',
          server_url: MCP_PUBLIC_URL,
          server_label: 'mongodb-crm',
          server_description: 'MongoDB CRM',
          allowed_tools: ['listAccounts'],
          authorization: `Bearer ${mcpToken}`
        }
      ],
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 } },
        output: { format: { type: 'audio/pcm', rate: 24000 } }
      }
    }
  }));

  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'List my accounts briefly.' }]
    }
  }));
  ws.send(JSON.stringify({ type: 'response.create' }));
});

ws.on('message', (raw) => {
  const event = JSON.parse(raw.toString());
  switch (event.type) {
    case 'session.created':
      console.log('session.created', event.session?.id);
      break;
    case 'response.output_audio_transcript.delta':
      process.stdout.write(event.delta || '');
      break;
    case 'response.mcp_call.in_progress':
      console.log('\n[mcp] in progress', event);
      break;
    case 'response.mcp_call.completed':
      console.log('\n[mcp] completed');
      break;
    case 'response.mcp_call.failed':
      console.error('\n[mcp] failed', event);
      break;
    case 'response.done':
      console.log('\nresponse.done tokens:', event.response?.usage?.total_tokens);
      ws.close();
      break;
    case 'error':
      console.error('error:', event);
      ws.close();
      break;
    default:
      break;
  }
});

ws.on('error', (err) => {
  console.error('ws error', err.message || err);
  process.exit(1);
});

ws.on('close', () => {
  process.exit(0);
});
