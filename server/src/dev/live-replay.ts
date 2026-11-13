// Plays a recorded live weekend back through the real sync worker and API, on
// a local database, so the app sees it as live. See server/TESTING.md.
//
//   npm run replay:live -- --list                  the recorded race days
//   npm run replay:live -- --from day3 --speed 10  day 3 from 15 min before its first race, 10x
//   npm run replay:live -- --from 2026-11-01T19:30:00Z
//
// While it runs: http://localhost:4311/clock shows the time; POST to it to
// change it (?speed=30, ?pause, ?resume, ?jump=+20m or ?jump=<ISO time>).

import 'dotenv/config';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { appleVerifier, googleVerifier } from '../api/accounts.js';
import { createApp } from '../api/app.js';
import { Ingest } from '../db/ingest.js';
import { createPool } from '../db/pool.js';
import { isJunior } from '../domain/format.js';
import { venueTimeZone } from '../domain/time.js';
import { IsuClient } from '../isu/client.js';
import { FakeIsu, VirtualClock, readRecording } from '../isu/fake.js';
import { Apns, apnsConfigFromEnv } from '../push/apns.js';
import { PushDevices } from '../push/devices.js';
import { SyncWorker } from '../sync/worker.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const MIGRATIONS = path.resolve(import.meta.dirname, '../../../supabase/migrations');
const recordingFile = path.resolve(arg('recording') ?? 'recordings/wt2-montreal-2026.ndjson.gz');
// Never the real database: the replay wipes this one on every start.
const dbUrl = process.env.REPLAY_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:54329/shorttrack_replay';
const port = Number(arg('port') ?? 4310);
const controlPort = Number(arg('control-port') ?? 4311);
const LEAD_MS = 15 * 60_000; // a day starts this long before its first race

const recording = await readRecording(recordingFile).catch((err) => {
  console.error(`Can't read ${recordingFile}: ${(err as Error).message}\nExport one first: npm run recording:export (see TESTING.md).`);
  process.exit(1);
});
const probe = new FakeIsu(recording, new VirtualClock(0));
const days = raceDays(probe);

if (process.argv.includes('--list')) {
  for (const [i, d] of days.entries()) {
    console.log(`day${i + 1}  ${d.label}  ${d.items.length} rounds, first at ${fmt(d.first, d.tz)} (${new Date(d.first).toISOString()})`);
    for (const it of d.items) console.log(`        ${fmt(Date.parse(it.start_time), d.tz)}  ${it.event_schedule_title}, ${it.round_information}`);
  }
  process.exit(0);
}

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
  console.error(`REPLAY_DATABASE_URL must be a local database (it's wiped on every start): ${dbUrl.replace(/:[^:@/]*@/, ':***@')}`);
  process.exit(1);
}

const from = arg('from') ?? 'day1';
const dayMatch = /^day(\d)$/.exec(from);
const start = dayMatch ? days[Number(dayMatch[1]) - 1]?.first! - LEAD_MS : Date.parse(from);
if (!Number.isFinite(start)) {
  console.error(`--from takes day1..day${days.length} or an ISO time, not "${from}"`);
  process.exit(1);
}
const clock = new VirtualClock(start, Number(arg('speed') ?? 1));
const fake = new FakeIsu(recording, clock);

const pool = await freshDatabase(dbUrl);
const isu = new IsuClient({ fetchImpl: fake.fetch, minIntervalMs: 0, retries: 0, cacheDir: await mkdtemp(path.join(os.tmpdir(), 'fake-isu-')) });
const apnsConfig = apnsConfigFromEnv();
const push = new PushDevices(pool, apnsConfig ? new Apns(apnsConfig) : null);
const worker = new SyncWorker(isu, pool, (m) => console.log(`[sync ${stamp()}] ${m}`), { push });

const googleIds = (process.env.GOOGLE_CLIENT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);
createApp(pool, {
  now: () => new Date(clock.now()),
  google: googleIds.length ? googleVerifier(googleIds) : null,
  apple: appleVerifier((process.env.APPLE_CLIENT_ID ?? 'com.aaronheo.shorttracklive').split(',').map((s) => s.trim())),
  push,
}).listen(port, () => {
  console.log(`Replaying ${path.basename(recordingFile)} from ${new Date(start).toISOString()} at ${clock.speed}x`);
  console.log(`API on http://localhost:${port} (database ${dbUrl.split('/').at(-1)}), push ${push.enabled ? 'on' : 'off'}`);
  console.log(`Clock: curl localhost:${controlPort}/clock · curl -X POST 'localhost:${controlPort}/clock?speed=30' (or ?pause, ?resume, ?jump=+20m)`);
});
http.createServer((req, res) => controlClock(req, res)).listen(controlPort);

// Starting mid-weekend: load what ISU showed at the start time (earlier days'
// results included), as the worker would have stored it while it was live.
for (const ev of fake.events().filter((e) => !isJunior(e) && days.some((d) => d.slug === e.slug))) {
  if (start <= days.find((d) => d.slug === ev.slug)!.first - LEAD_MS) continue;
  await new Ingest(pool).loadTree(await isu.pullEvent(ev));
  console.log(`[sync ${stamp()}] ${ev.name}: loaded as it was at the start time`);
}

let lastStatus = 0;
for (;;) {
  try {
    await worker.tick(clock.now());
  } catch (err) {
    console.log(`[sync ${stamp()}] tick failed: ${(err as Error).message}`);
  }
  if (Date.now() - lastStatus > 30_000) {
    lastStatus = Date.now();
    console.log(`[clock] ${stamp()} · ${await racing()}`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

/** Race days from the recorded schedule, in the event's time zone. */
function raceDays(f: FakeIsu) {
  const zones = new Map(f.events().map((e) => [e.slug, venueTimeZone(e.city, e.country_code, e.time_zone)]));
  const out = new Map<string, { label: string; slug: string; tz: string; first: number; items: { start_time: string; event_schedule_title: string; round_information: string }[] }>();
  for (const { slug, items } of f.schedule()) {
    const tz = zones.get(slug) ?? 'UTC';
    for (const it of [...items].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
      const at = Date.parse(it.start_time);
      const label = `${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(at)} ${slug}`;
      const day = out.get(label) ?? { label, slug, tz, first: at, items: [] };
      day.items.push(it);
      out.set(label, day);
    }
  }
  return [...out.values()].sort((a, b) => a.first - b.first);
}

function fmt(at: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(at);
}

function stamp(): string {
  const tz = days[0]?.tz ?? 'UTC';
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(clock.now());
  return `${t}${clock.paused ? ' (paused)' : clock.speed !== 1 ? ` ${clock.speed}x` : ''}`;
}

/** What the database says is on the ice, for the status line. */
async function racing(): Promise<string> {
  const res = await pool.query<{ what: string }>(
    `select c.name || ', ' || r.name || ', ' || h.name || ' (' || h.state || ')' as what
     from heat h join round r on r.id = h.round_id join competition c on c.id = r.competition_id
     where h.state in ('running', 'unofficial') order by h.state = 'running' desc, h.id limit 1`);
  return res.rows[0]?.what ?? 'nothing racing';
}

/** A wiped database with every migration applied. Creates it if missing. */
async function freshDatabase(url: string): Promise<pg.Pool> {
  const name = new URL(url).pathname.slice(1);
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
  if (!exists.rowCount) await admin.query(`create database "${name.replace(/"/g, '')}"`);
  await admin.end();
  const db = createPool(url);
  await db.query('drop schema public cascade; create schema public;');
  for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(path.join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

/** GET /clock: the time. POST /clock?speed=30 | ?pause | ?resume | ?jump=+20m | ?jump=<ISO time>. */
function controlClock(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body, null, 2) + '\n');
  };
  if (url.pathname !== '/clock') return reply(404, { error: 'Try /clock' });
  try {
    if (req.method === 'POST') {
      const p = url.searchParams;
      if (p.has('speed')) clock.setSpeed(Number(p.get('speed')));
      if (p.has('pause')) clock.pause();
      if (p.has('resume')) clock.resume();
      const jump = p.get('jump');
      if (jump) {
        const rel = /^\+(\d+)([smh])$/.exec(jump);
        clock.jump(rel ? clock.now() + Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5 }[rel[2] as 's' | 'm' | 'h'] : Date.parse(jump));
      }
      console.log(`[clock] ${stamp()}`);
    }
    reply(200, { now: new Date(clock.now()).toISOString(), local: stamp(), speed: clock.speed, paused: clock.paused, unanswered: Object.fromEntries(fake.unanswered) });
  } catch (err) {
    reply(400, { error: (err as Error).message });
  }
}
