import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const thisFile = fileURLToPath(import.meta.url);
const rootDir = join(dirname(thisFile), '..');
const require = createRequire(import.meta.url);

function resolveDotenvConfig() {
  const candidates = [
    'dotenv',
    join(rootDir, 'server/node_modules/dotenv'),
    join(rootDir, 'web-ux/node_modules/dotenv')
  ];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (typeof mod?.config === 'function') return mod.config;
      if (typeof mod?.default?.config === 'function') return mod.default.config;
    } catch (_err) {
      // Try the next location.
    }
  }
  throw new Error('Unable to resolve dotenv. Install dependencies before starting the app.');
}

const config = resolveDotenvConfig();
config({ path: join(rootDir, '.env') });
