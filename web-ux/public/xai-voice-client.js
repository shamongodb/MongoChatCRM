import { formatClientSecretSubprotocol, XAI_REALTIME_WS_URL } from './xai-ws-auth.js';

const SAMPLE_RATE = 24000;
const CONNECT_TIMEOUT_MS = 15000;

function float32ToBase64Pcm16(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64Pcm16ToFloat32(base64String) {
  const binaryString = atob(base64String);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
  return float32;
}

export function createXaiVoiceClient({
  apiBaseUrl = '',
  authHeaders,
  onStatus = () => {},
  onUserTurnStart = () => {},
  onUserTranscriptUpdate = () => {},
  onUserTurnEnd = () => {},
  onAssistantTranscriptUpdate = () => {},
  onAssistantTranscriptDone = () => {},
  onError = () => {},
  shouldCancel = () => false
} = {}) {
  let ws = null;
  let clientSecret = null;
  let secretExpiresAt = 0;
  let active = false;
  let mediaStream = null;
  let audioContext = null;
  let processor = null;
  let sourceNode = null;
  let playbackContext = null;
  let playbackTime = 0;
  let assistantTranscriptBuffer = '';
  let connectPromise = null;
  let userTurnFinalized = false;

  function finalizeUserTurn() {
    if (userTurnFinalized) return;
    userTurnFinalized = true;
    onUserTurnEnd();
  }

  function sessionUrl(pathname) {
    const base = String(apiBaseUrl || '').replace(/\/+$/, '');
    return base ? `${base}${pathname}` : pathname;
  }

  function stopPlayback() {
    playbackTime = 0;
    if (playbackContext) {
      try {
        playbackContext.close();
      } catch (_err) {
        // ignore
      }
      playbackContext = null;
    }
  }

  function enqueuePcmPlayback(base64Delta) {
    if (!base64Delta) return;
    if (!playbackContext) {
      playbackContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      playbackTime = playbackContext.currentTime;
    }
    const floats = base64Pcm16ToFloat32(base64Delta);
    const buffer = playbackContext.createBuffer(1, floats.length, SAMPLE_RATE);
    buffer.copyToChannel(floats, 0);
    const node = playbackContext.createBufferSource();
    node.buffer = buffer;
    node.connect(playbackContext.destination);
    const startAt = Math.max(playbackContext.currentTime, playbackTime);
    node.start(startAt);
    playbackTime = startAt + buffer.duration;
  }

  function sendJson(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function handleServerEvent(event) {
    switch (event.type) {
      case 'session.created':
        onStatus('Voice ready');
        break;
      case 'input_audio_buffer.speech_started':
        sendJson({ type: 'response.cancel' });
        stopPlayback();
        userTurnFinalized = false;
        onUserTurnStart();
        onStatus('Listening…');
        break;
      case 'input_audio_buffer.speech_stopped':
        finalizeUserTurn();
        onStatus('Thinking…');
        break;
      case 'conversation.item.input_audio_transcription.updated': {
        const text = String(event.transcript || '').trim();
        if (text) onUserTranscriptUpdate(text);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(event.transcript || '').trim();
        if (text) onUserTranscriptUpdate(text);
        break;
      }
      case 'response.output_audio.delta':
        finalizeUserTurn();
        enqueuePcmPlayback(event.delta);
        break;
      case 'response.output_audio_transcript.delta':
        finalizeUserTurn();
        assistantTranscriptBuffer += String(event.delta || '');
        if (assistantTranscriptBuffer.trim()) {
          onAssistantTranscriptUpdate(assistantTranscriptBuffer.trim());
        }
        break;
      case 'response.output_audio_transcript.done': {
        const text = String(event.transcript || assistantTranscriptBuffer || '').trim();
        assistantTranscriptBuffer = '';
        if (text) onAssistantTranscriptUpdate(text);
        onAssistantTranscriptDone(text);
        break;
      }
      case 'response.mcp_call.in_progress':
        finalizeUserTurn();
        onStatus('Using CRM tools…');
        break;
      case 'response.mcp_call.completed':
        onStatus('Speaking…');
        break;
      case 'response.mcp_call.failed':
        onError(event.message || 'MCP tool call failed');
        break;
      case 'response.done':
        onStatus(active ? 'Listening…' : '');
        break;
      case 'error':
        onError(event.message || event.error?.message || 'Voice agent error');
        break;
      default:
        break;
    }
  }

  async function mintClientSecret() {
    const now = Math.floor(Date.now() / 1000);
    if (clientSecret && secretExpiresAt > now + 30) return clientSecret;

    const res = await fetch(sessionUrl('/api/voice/realtime/session'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresSeconds: 300 })
    });
    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_err) {
      throw new Error('Voice session: server returned non-JSON. Is the API deployed?');
    }
    if (!res.ok || data.ok === false) {
      const detail = data.details ? ` (${JSON.stringify(data.details).slice(0, 200)})` : '';
      throw new Error(`${data.error || `Voice session HTTP ${res.status}`}${detail}`);
    }
    clientSecret = String(data.clientSecret || '').trim();
    secretExpiresAt = Number(data.expiresAt) || now + 300;
    if (!clientSecret) {
      throw new Error('Voice session missing clientSecret. Set XAI_API_KEY on Vercel.');
    }
    return clientSecret;
  }

  function connectWebSocket(secret) {
    const subprotocol = formatClientSecretSubprotocol(secret);

    return new Promise((resolve, reject) => {
      let settled = false;
      let sawSessionCreated = false;
      const socket = new WebSocket(XAI_REALTIME_WS_URL, [subprotocol]);
      ws = socket;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch (_err) {
          // ignore
        }
        reject(new Error('Voice WebSocket timed out waiting for xAI (15s)'));
      }, CONNECT_TIMEOUT_MS);

      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(message));
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      socket.onopen = () => {
        // Wait for session.created before considering the connection ready.
      };

      socket.onerror = () => {
        // onclose follows with code/reason in most browsers.
      };

      socket.onclose = (ev) => {
        if (socket === ws) ws = null;
        if (settled) {
          if (active) onError(`Voice connection closed (${ev.code})`);
          return;
        }
        const reason = String(ev.reason || '').trim();
        const hint = ev.code === 1006
          ? ' — check ad blockers, confirm XAI_API_KEY on Vercel'
          : '';
        fail(
          `Voice WebSocket connection failed (${ev.code}${reason ? `: ${reason}` : ''})${hint}`
        );
      };

      socket.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data);
          if (event.type === 'session.created' && !sawSessionCreated) {
            sawSessionCreated = true;
            succeed();
          }
          if (event.type === 'error' && !sawSessionCreated) {
            fail(event.message || event.error?.message || 'xAI voice session error');
            return;
          }
          handleServerEvent(event);
        } catch (err) {
          onError(err.message || String(err));
        }
      };
    });
  }

  async function ensureConnected() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      clientSecret = null;
      const secret = await mintClientSecret();
      if (shouldCancel()) throw new Error('Voice start canceled');
      await connectWebSocket(secret);
    })();

    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function startMicCapture() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Voice input is not supported in this browser.');
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (ev) => {
      if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      sendJson({
        type: 'input_audio_buffer.append',
        audio: float32ToBase64Pcm16(input)
      });
    };
    sourceNode.connect(processor);
    processor.connect(audioContext.destination);
  }

  function stopMicCapture() {
    if (processor) {
      try {
        processor.disconnect();
      } catch (_err) {
        // ignore
      }
      processor.onaudioprocess = null;
      processor = null;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (_err) {
        // ignore
      }
      sourceNode = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  return {
    get isActive() {
      return active;
    },
    async start() {
      if (active) return;
      onStatus('Connecting…');
      await ensureConnected();
      if (shouldCancel()) {
        await this.stop();
        return;
      }
      active = true;
      assistantTranscriptBuffer = '';
      await startMicCapture();
      onStatus('Listening…');
    },
    async stop() {
      if (!active && (!ws || ws.readyState !== WebSocket.OPEN)) {
        stopMicCapture();
        return;
      }
      active = false;
      stopMicCapture();
      stopPlayback();
      onStatus('');
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.close();
        } catch (_err) {
          // ignore
        }
      }
      ws = null;
    },
    dispose() {
      return this.stop();
    }
  };
}
