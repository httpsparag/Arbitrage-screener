// Supabase Edge Function helper (uses the official CLI; no Docker needed).
//   node scripts/fn.mjs secrets          – upload Angel One + scanner secrets from apps/worker/.env
//   node scripts/fn.mjs deploy [name…]   – bundle the engine and deploy functions (default: all)
//   node scripts/fn.mjs schedule         – store the scan key + project URL in Vault for Supabase Cron
//   node scripts/fn.mjs invoke <name> [action] – call a function now (e.g. invoke scan close)
//   node scripts/fn.mjs probe            – run the angel-probe function
//
// Needs SUPABASE_ACCESS_TOKEN (Supabase → Account → Access Tokens) in apps/worker/.env.
// Never prints secret values.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, 'apps', 'worker', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const require = createRequire(import.meta.url);

const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};

const url = process.env.SUPABASE_URL?.trim();
const ref = url && new URL(url).hostname.split('.')[0];
if (!ref) fail('SUPABASE_URL is missing in apps/worker/.env');

const cli = require.resolve('supabase/dist/supabase.js');
const run = (args) => {
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    fail('SUPABASE_ACCESS_TOKEN is missing in apps/worker/.env (Supabase → Account → Access Tokens → Generate new token).');
  }
  const r = spawnSync(process.execPath, [cli, ...args, '--project-ref', ref, '--workdir', root], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Reads a generated secret from .env, creating and saving it on first use. */
function ensureLocalSecret(name, comment) {
  if (process.env[name]) return process.env[name];
  const value = randomBytes(24).toString('base64url');
  writeFileSync(envFile, `\n# ${comment}\n${name}=${value}\n`, { flag: 'a' });
  process.env[name] = value;
  return value;
}

const FUNCTIONS = ['scan', 'refresh-universe'];
const [action, ...rest] = process.argv.slice(2);

if (action === 'secrets') {
  const keys = ['ANGEL_API_KEY', 'ANGEL_CLIENT_CODE', 'ANGEL_PIN', 'ANGEL_TOTP_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) fail(`Missing in apps/worker/.env: ${missing.join(', ')}`);
  const probeKey = ensureLocalSecret('PROBE_KEY', 'Shared secret for calling the angel-probe function');
  const scanKey = ensureLocalSecret('SCAN_KEY', 'Shared secret the scheduler uses to call the scan functions');
  const dir = mkdtempSync(join(tmpdir(), 'arb-secrets-'));
  const file = join(dir, 'secrets.env');
  try {
    const lines = [
      ...['ANGEL_API_KEY', 'ANGEL_CLIENT_CODE', 'ANGEL_PIN', 'ANGEL_TOTP_SECRET'].map((k) => `${k}=${process.env[k]}`),
      // SUPABASE_* names are reserved for platform secrets, so the service key gets its own name.
      `ARB_SERVICE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      `PROBE_KEY=${probeKey}`,
      `SCAN_KEY=${scanKey}`,
    ];
    writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    run(['secrets', 'set', '--env-file', file]);
    console.log(`✔ Uploaded ${lines.length} secrets (values not shown)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else if (action === 'deploy') {
  const names = rest.length ? rest : FUNCTIONS;
  const b = spawnSync(process.execPath, [join(root, 'scripts', 'bundle-core.mjs')], { stdio: 'inherit', cwd: root });
  if (b.status !== 0) process.exit(b.status ?? 1);
  run(['functions', 'deploy', ...names, '--use-api', '--no-verify-jwt']);
} else if (action === 'schedule') {
  const scanKey = process.env.SCAN_KEY;
  if (!scanKey) fail('SCAN_KEY missing; run `npm run fn:secrets` first.');
  let dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) fail('SUPABASE_DB_URL missing in apps/worker/.env');
  if (dbUrl.includes('[YOUR-PASSWORD]')) dbUrl = dbUrl.replace('[YOUR-PASSWORD]', encodeURIComponent(process.env.SUPABASE_DB_PASSWORD ?? ''));
  const { Client } = require('pg');
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const [name, value] of [['arb_project_url', url], ['arb_scan_key', scanKey]]) {
      await client.query('delete from vault.secrets where name = $1', [name]);
      await client.query('select vault.create_secret($1, $2)', [value, name]);
    }
    const jobs = await client.query("select jobname, schedule, active from cron.job where jobname like 'arb-%' order by jobname");
    console.log('✔ Vault secrets stored (values not shown). Scheduled jobs:');
    for (const j of jobs.rows) console.log(`   ${j.jobname.padEnd(22)} ${j.schedule.padEnd(14)} ${j.active ? 'active' : 'inactive'}`);
  } finally {
    await client.end();
  }
} else if (action === 'invoke') {
  const [name, act] = rest;
  if (!name) fail('Usage: node scripts/fn.mjs invoke <function> [action]');
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'x-scan-key': process.env.SCAN_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(act ? { action: act, manual: true } : { manual: true }),
  });
  console.log(`HTTP ${res.status} ${await res.text()}`);
} else if (action === 'probe') {
  const key = process.env.PROBE_KEY;
  if (!key) fail('PROBE_KEY missing; run `node scripts/fn.mjs secrets` first.');
  const res = await fetch(`${url}/functions/v1/angel-probe`, { method: 'POST', headers: { 'x-probe-key': key } });
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(await res.json().catch(async () => ({ body: await res.text() })), null, 2));
} else {
  fail('Usage: node scripts/fn.mjs secrets | deploy [name…] | schedule | invoke <name> [action] | probe');
}
