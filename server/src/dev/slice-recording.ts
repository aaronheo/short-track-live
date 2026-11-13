// Cuts a small piece out of an exported recording, for a scenario test
// (tests/replay.test.ts). Keeps the requests whose path or body contains any
// --match, each with its answer as of --from plus every change up to --to.
//
//   npm run recording:slice -- --from 2026-10-31T18:30:00Z --to 2026-10-31T18:50:00Z \
//     --match /events/list --match getschedule --match world-tour-2-montreal --match '"16034"' \
//     --match event_result_round_id=22931& --out ../data/recordings/wt2-montreal-2026-men-500m-finals.ndjson.gz

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readRecording, type RecordedResponse } from '../isu/fake.js';

const values = (name: string) => process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
const one = (name: string) => values(name)[0];

const input = path.resolve(one('in') ?? 'recordings/wt2-montreal-2026.ndjson.gz');
const out = one('out');
const from = Date.parse(one('from') ?? '');
const to = Date.parse(one('to') ?? '');
const match = values('match');
if (!out || !Number.isFinite(from) || !Number.isFinite(to) || !match.length) {
  console.error('Needs --out, --from, --to and at least one --match (see the top of this file).');
  process.exit(1);
}

const byKey = new Map<string, RecordedResponse[]>();
for (const r of await readRecording(input)) {
  if (!match.some((m) => r.path.includes(m) || (r.body ?? '').includes(m))) continue;
  byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
}
const kept: RecordedResponse[] = [];
for (const list of byKey.values()) {
  const before = list.filter((r) => Date.parse(r.at) <= from).at(-1);
  if (before) kept.push(before);
  kept.push(...list.filter((r) => Date.parse(r.at) > from && Date.parse(r.at) <= to));
}
kept.sort((a, b) => a.at.localeCompare(b.at));
const gz = gzipSync(kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
await writeFile(path.resolve(out), gz);
console.log(`${kept.length} responses, ${Math.round(gz.length / 1024)} KB → ${out}`);
