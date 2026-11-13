// Copies recorded ISU responses (isu_recording) into a file the fake ISU can
// replay (see src/isu/fake.ts), so a replay never touches the real database.
//
//   npm run recording:export -- --from 2026-10-29 --to 2026-11-03 --out recordings/wt2-montreal-2026.ndjson.gz
//
// One JSON line per response: { at, key, method, path, body, json }, gzipped.

import 'dotenv/config';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, createGzip } from 'node:zlib';
import { createPool } from '../db/pool.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const from = arg('from') ?? '2026-10-29';
const to = arg('to') ?? '2026-11-03';
const out = path.resolve(arg('out') ?? 'recordings/wt2-montreal-2026.ndjson.gz');

const pool = createPool();
await mkdir(path.dirname(out), { recursive: true });
const gzip = createGzip();
const done = new Promise((resolve, reject) => gzip.pipe(createWriteStream(out)).on('finish', resolve).on('error', reject));

let lastId = 0;
let rows = 0;
for (;;) {
  const res = await pool.query<{ id: number; fetched_at: Date; key: string; method: string; path: string; body: string | null; data: Buffer }>(
    `select id, fetched_at, key, method, path, body, data from isu_recording
     where fetched_at >= $1 and fetched_at < $2 and id > $3 order by id limit 2000`, [from, to, lastId]);
  if (!res.rows.length) break;
  for (const r of res.rows) {
    const line = { at: r.fetched_at.toISOString(), key: r.key, method: r.method, path: r.path, body: r.body, json: JSON.parse(gunzipSync(r.data).toString('utf8')) };
    if (!gzip.write(JSON.stringify(line) + '\n')) await new Promise((r) => gzip.once('drain', r));
  }
  rows += res.rows.length;
  lastId = res.rows.at(-1)!.id;
}
gzip.end();
await done;
await pool.end();
console.log(`${rows} responses from ${from} to ${to} → ${path.relative(process.cwd(), out)}`);
