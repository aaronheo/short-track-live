import 'dotenv/config';
import path from 'node:path';
import { createPool } from '../db/pool.js';
import { IsuClient } from '../isu/client.js';
import { IsuRecorder } from '../isu/recorder.js';
import { SyncWorker } from './worker.js';

/**
 * npm run backfill           store the current and previous seasons, then exit
 * npm run backfill:history   store every season ISU has, newest first, then exit
 *                            (resumable; stops when the database reaches BACKFILL_MAX_DB_MB, default 400)
 * npm run sync               backfill (skips complete events), then poll live events forever
 */
export async function startSync(opts: { backfillOnly?: boolean; allHistory?: boolean } = {}) {
  const pool = createPool();
  // Live events' ISU responses go to isu_recording unless ISU_RECORD=0.
  const isu = new IsuClient({
    cacheDir: path.resolve(process.env.ISU_CACHE_DIR ?? '.cache/isu'),
    recorder: process.env.ISU_RECORD === '0' ? undefined : new IsuRecorder(pool),
  });
  const worker = new SyncWorker(isu, pool);
  const { current, previous } = await worker.seasons();
  if (opts.allHistory) {
    await worker.backfill(await worker.allSeasons(), { maxDbBytes: Number(process.env.BACKFILL_MAX_DB_MB ?? 400) * 1e6 });
  } else {
    await worker.backfill(previous ? [previous, current] : [current]);
  }
  console.log(`[sync] backfill done (${isu.requests} ISU requests this run)`);
  if (opts.backfillOnly) {
    await pool.end();
    return;
  }
  process.on('SIGINT', () => { worker.stop(); process.exit(0); });
  await worker.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSync({
    backfillOnly: process.argv.includes('--backfill-only') || process.argv.includes('--all-history'),
    allHistory: process.argv.includes('--all-history'),
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
