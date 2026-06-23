/**
 * Format xAI client_secrets `value` for browser WebSocket subprotocol auth.
 * @see https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens
 */
export function formatClientSecretSubprotocol(clientSecret) {
  const raw = String(clientSecret || '').trim();
  if (!raw) throw new Error('Empty voice client secret');
  if (raw.startsWith('xai-client-secret.')) return raw;
  return `xai-client-secret.${raw}`;
}

export const XAI_REALTIME_WS_URL = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest';
