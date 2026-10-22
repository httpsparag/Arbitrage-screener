// Bundles @arb/core (TypeScript) into one ES module for Supabase Edge Functions (Deno),
// so the cloud scanner runs exactly the same tested calculation engine.

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'packages/core/src/index.ts')],
  outfile: join(root, 'supabase/functions/_shared/core.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  banner: { js: '// GENERATED from packages/core by scripts/bundle-core.mjs — do not edit.\n// deno-lint-ignore-file' },
  logLevel: 'info',
});
