// Worker entry point. Run with: npm start -w @arb/worker
// Leave it running; it connects during market hours and idles otherwise.
// Pass --force to hold the feed open outside market hours (testing only).

import { loadAngelConfig } from './config';
import { loadSupabaseConfig, Publisher } from './publisher';
import { ScreenerService, WORKER_VERSION } from './service';

async function main() {
  const angel = loadAngelConfig();
  const publisher = new Publisher(loadSupabaseConfig());
  const service = new ScreenerService(angel, publisher, { forceRun: process.argv.includes('--force') });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nReceived ${signal}, shutting down…`);
    await service.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  console.log(`Arbitrage screener worker v${WORKER_VERSION} — press Ctrl+C to stop`);
  await service.start();

  // --exit-after=SECONDS: graceful automatic stop, for test runs.
  const exitAfter = Number(process.argv.find((a) => a.startsWith('--exit-after='))?.split('=')[1]);
  if (exitAfter > 0) setTimeout(() => void stop(`--exit-after=${exitAfter}`), exitAfter * 1000);
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
