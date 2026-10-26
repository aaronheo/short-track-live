import 'dotenv/config';
import path from 'node:path';
import { createPool } from '../db/pool.js';
import { IsuClient } from '../isu/client.js';
import { SyncWorker } from './worker.js';

/**
 * npm run backfill   store the current and previous seasons, then exit
 * npm run sync       backfill (skips complete events), then poll live events forever
 */
export async function startSync(opts: { backfillOnly?: boolean } = {}) {
  const pool = createPool();
  const isu = new IsuClient({ cacheDir: path.resolve(process.env.ISU_CACHE_DIR ?? '.cache/isu') });
  const worker = new SyncWorker(isu, pool);
  const { current, previous } = await worker.seasons();
  await worker.backfill(previous ? [previous, current] : [current]);
  console.log(`[sync] backfill done (${isu.requests} ISU requests this run)`);
  if (opts.backfillOnly) {
    await pool.end();
    return;
  }
  process.on('SIGINT', () => { worker.stop(); process.exit(0); });
  await worker.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSync({ backfillOnly: process.argv.includes('--backfill-only') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
