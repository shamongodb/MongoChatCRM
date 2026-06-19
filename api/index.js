import '../scripts/load-env.js';
import { app, ensureAppReady } from '../server/src/index.js';

export default async function handler(req, res) {
  await ensureAppReady();
  return app(req, res);
}
