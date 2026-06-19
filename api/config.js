import '../scripts/load-env.js';

export default function handler(_req, res) {
  const payload = {
    apiBaseUrl: '',
    googleClientId: String(process.env.GOOGLE_CLIENT_ID || '').trim()
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.status(200).send(`window.__WEB_UX_CONFIG__ = ${JSON.stringify(payload)};`);
}
