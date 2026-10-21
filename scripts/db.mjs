// Applies Supabase migrations from supabase/migrations using the official Supabase CLI.
//   npm run db:status   – list local vs applied migrations
//   npm run db:dry-run  – show what would be applied
//   npm run db:push     – apply pending migrations
//
// Reads SUPABASE_DB_URL (+ SUPABASE_DB_PASSWORD) from apps/worker/.env. Never prints them.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, 'apps', 'worker', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};

let url = process.env.SUPABASE_DB_URL?.trim();
const password = process.env.SUPABASE_DB_PASSWORD ?? '';
if (!url) {
  fail(
    'SUPABASE_DB_URL is empty in apps/worker/.env.\n' +
      '  Supabase Dashboard → Connect → "Session pooler" → copy the URI into SUPABASE_DB_URL,\n' +
      '  and put your database password in SUPABASE_DB_PASSWORD.',
  );
}
// The dashboard URI contains a [YOUR-PASSWORD] placeholder; fill it in, percent-encoded.
if (url.includes('[YOUR-PASSWORD]')) {
  if (!password) fail('SUPABASE_DB_URL still has [YOUR-PASSWORD]; set SUPABASE_DB_PASSWORD.');
  url = url.replace('[YOUR-PASSWORD]', encodeURIComponent(password));
}
try {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('not a postgres URL');
  if (u.hostname.startsWith('db.') && u.hostname.endsWith('.supabase.co')) {
    console.warn(
      '! This is the direct connection (IPv6 only on the free plan). If it fails, use the "Session pooler" URI instead.',
    );
  }
} catch (e) {
  fail(`SUPABASE_DB_URL is not a valid connection string (${e.message}).`);
}

const action = process.argv[2] ?? 'status';
const args = {
  status: ['migration', 'list', '--db-url', url],
  'dry-run': ['db', 'push', '--dry-run', '--db-url', url],
  push: ['db', 'push', '--db-url', url],
}[action];
if (!args) fail(`Unknown action "${action}" (use status, dry-run or push).`);

const cli = createRequire(import.meta.url).resolve('supabase/dist/supabase.js');
const result = spawnSync(process.execPath, [cli, ...args, '--workdir', root], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(result.status ?? 1);
