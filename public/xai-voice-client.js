const XAI_REALTIME_URL = 'wss://api.x.ai/v1/realtime?model=grok-voice-latest';
const SAMPLE_RATE = 24000;

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
  onUserTranscript = () => {},
  onAssistantTranscript = () => {},
  onError = () => {}
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
        onStatus('Listening…');
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(event.transcript || '').trim();
        if (text) onUserTranscript(text);
        break;
      }
      case 'response.output_audio.delta':
        enqueuePcmPlayback(event.delta);
        break;
      case 'response.output_audio_transcript.delta':
        assistantTranscriptBuffer += String(event.delta || '');
        break;
      case 'response.output_audio_transcript.done': {
        const text = String(event.transcript || assistantTranscriptBuffer || '').trim();
        assistantTranscriptBuffer = '';
        if (text) onAssistantTranscript(text);
        break;
      }
      case 'response.mcp_call.in_progress':
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
        onError(event.message || 'Voice agent error');
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
      throw new Error('Server returned non-JSON response for voice session.');
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    clientSecret = String(data.clientSecret || '').trim();
    secretExpiresAt = Number(data.expiresAt) || now + 300;
    if (!clientSecret) throw new Error('Voice session response missing clientSecret');
    return clientSecret;
  }

  async function ensureConnected() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      const secret = await mintClientSecret();
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(XAI_REALTIME_URL, [`xai-client-secret.${secret}`]);
        ws = socket;
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('Voice WebSocket connection failed'));
        socket.onclose = (ev) => {
          if (socket === ws) ws = null;
          if (active) onError(`Voice connection closed (${ev.code})`);
        };
        socket.onmessage = (msg) => {
          try {
            handleServerEvent(JSON.parse(msg.data));
          } catch (err) {
            onError(err.message || String(err));
          }
        };
      });
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
      active = true;
      assistantTranscriptBuffer = '';
      await startMicCapture();
      onStatus('Listening…');
    },
    async stop() {
      if (!active) return;
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
