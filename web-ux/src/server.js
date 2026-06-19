import '../../scripts/load-env.js';
import express from 'express';
import { Readable } from 'node:stream';

const app = express();

const {
  WEB_UX_PORT = '8790',
  NODE_API_BASE_URL = 'http://localhost:8787',
  NODE_API_KEY = '',
  GOOGLE_CLIENT_ID = ''
} = process.env;

const upstreamBaseUrl = String(NODE_API_BASE_URL || '').trim().replace(/\/+$/, '');

app.get('/config.js', (_req, res) => {
  const payload = {
    // Keep empty for same-origin proxy mode by default.
    apiBaseUrl: '',
    googleClientId: String(GOOGLE_CLIENT_ID || '').trim()
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(`window.__WEB_UX_CONFIG__ = ${JSON.stringify(payload)};`);
});

app.use('/api', async (req, res) => {
  try {
    if (!upstreamBaseUrl) {
      return res.status(503).json({ ok: false, error: 'NODE_API_BASE_URL is not configured' });
    }

    const targetUrl = `${upstreamBaseUrl}${req.originalUrl}`;
    const outgoingHeaders = {};
    for (const [name, value] of Object.entries(req.headers || {})) {
      if (value == null) continue;
      const lower = String(name || '').toLowerCase();
      if (
        lower === 'host' ||
        lower === 'connection' ||
        lower === 'content-length' ||
        lower === 'transfer-encoding' ||
        lower === 'keep-alive' ||
        lower === 'proxy-authenticate' ||
        lower === 'proxy-authorization' ||
        lower === 'te' ||
        lower === 'trailers' ||
        lower === 'upgrade'
      ) {
        continue;
      }
      outgoingHeaders[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    if (NODE_API_KEY && !outgoingHeaders.authorization) {
      outgoingHeaders.authorization = `Bearer ${NODE_API_KEY}`;
    }

    const method = String(req.method || 'GET').toUpperCase();
    const init = {
      method,
      headers: outgoingHeaders,
      redirect: 'manual'
    };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = req;
      init.duplex = 'half';
    }

    const upstreamRes = await fetch(targetUrl, init);
    res.status(upstreamRes.status);

    for (const [name, value] of upstreamRes.headers.entries()) {
      const lower = String(name || '').toLowerCase();
      if (
        lower === 'content-length' ||
        lower === 'transfer-encoding' ||
        lower === 'connection' ||
        lower === 'keep-alive' ||
        lower === 'proxy-authenticate' ||
        lower === 'proxy-authorization' ||
        lower === 'te' ||
        lower === 'trailers' ||
        lower === 'upgrade'
      ) {
        continue;
      }
      res.setHeader(name, value);
    }

    if (!upstreamRes.body) {
      return res.end();
    }
    return Readable.fromWeb(upstreamRes.body).pipe(res);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err?.message || String(err) });
  }
});

app.use(express.static('public'));

app.get('/login', (_req, res) => {
  res.sendFile(new URL('../public/login.html', import.meta.url).pathname);
});

app.get('*', (_req, res) => {
  res.sendFile(new URL('../public/index.html', import.meta.url).pathname);
});

const requestedPort = Number(WEB_UX_PORT);
const maxPortAttempts = 20;

function startServer(port, attempt = 0) {
  const server = app.listen(port, () => {
    if (attempt > 0) {
      console.warn(
        `Port ${requestedPort} was unavailable; Web UX is running on fallback port ${port}`
      );
    }
    console.log(`Web UX listening on port ${port}`);
  });

  server.on('error', (err) => {
    const isPortInUse = err && typeof err === 'object' && err.code === 'EADDRINUSE';
    if (!isPortInUse || attempt >= maxPortAttempts) {
      throw err;
    }

    const nextPort = port + 1;
    console.warn(`Port ${port} is in use, retrying on ${nextPort}...`);
    startServer(nextPort, attempt + 1);
  });
}

startServer(requestedPort);
