// The fake ISU (src/isu/fake.ts) and a recorded live race played through the
// real sync worker and API. The scenario needs TEST_DATABASE_URL (see db.test.ts).

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import type { RoundResponse } from '../src/api/views.js';
import { createPool } from '../src/db/pool.js';
import { Ingest } from '../src/db/ingest.js';
import { IsuClient } from '../src/isu/client.js';
import { FakeIsu, VirtualClock, readRecording, type RecordedResponse } from '../src/isu/fake.js';
import { SyncWorker } from '../src/sync/worker.js';

const recorded = (at: string, method: string, apiPath: string, payload: string, data: unknown): RecordedResponse => ({
  at, method, path: apiPath, body: payload || null, json: { status: 200, data },
  key: createHash('sha1').update(`${method} ${apiPath} ${payload}`).digest('hex'),
});
const heatsPath = '/events/get-event-result-round-heats-stk-single';
const heatsForm = 'event_result_id=1&event_result_round_id=2&country_code=';
const t = (s: string) => Date.parse(`2026-10-31T${s}Z`);

describe('virtual clock', () => {
  it('runs at its speed, pauses and only jumps forward', () => {
    let real = 0;
    const clock = new VirtualClock(t('18:00:00'), 10, () => real);
    real = 6_000;
    expect(clock.now()).toBe(t('18:01:00'));
    clock.pause();
    real = 60_000;
    expect(clock.now()).toBe(t('18:01:00'));
    clock.resume();
    clock.setSpeed(1);
    real = 61_000;
    expect(clock.now()).toBe(t('18:01:01'));
    clock.jump(t('18:30:00'));
    expect(clock.now()).toBe(t('18:30:00'));
    expect(() => clock.jump(t('18:00:00'))).toThrow(/only moves forward/);
  });
});

describe('fake ISU', () => {
  const clock = new VirtualClock(t('18:00:00'), 1, () => 0);
  const fake = new FakeIsu([
    recorded('2026-10-31T18:10:00Z', 'POST', heatsPath, heatsForm, [{ name: 'Final', status: 'Scheduled' }]),
    recorded('2026-10-31T18:45:00Z', 'POST', heatsPath, heatsForm, [{ name: 'Final', status: 'Live' }]),
    recorded('2026-10-31T18:47:00Z', 'POST', heatsPath, heatsForm, [{ name: 'Final', status: 'Finished' }]),
    recorded('2026-10-31T18:00:00Z', 'POST', '/events/list',
      JSON.stringify({ discipline_id: 3, season: '2026/2027', event_level: 'ISU', page: 1, pagesize: 50 }), []),
  ], clock);
  const isu = new IsuClient({ fetchImpl: fake.fetch, minIntervalMs: 0, cacheDir: mkdtempSync(path.join(os.tmpdir(), 'fake-isu-')) });
  const status = async () => (await isu.heats(1, 2, false))[0]?.status;

  it('answers each request as ISU last did before the clock', async () => {
    expect(await status()).toBe('Scheduled'); // before the first recording: the first answer
    clock.jump(t('18:46:00'));
    expect(await status()).toBe('Live');
    clock.jump(t('19:00:00'));
    expect(await status()).toBe('Finished');
  });

  it('makes up the seasons from the recorded event list and answers the rest empty', async () => {
    expect((await isu.seasons()).map((s) => [s.title, s.is_current])).toEqual([['2026/2027', 1], ['2025/2026', 0]]);
    expect(await isu.competitions('isu-short-track-world-tour-9')).toEqual([]);
    expect(fake.unanswered.get('/events/get-event-result')).toBe(1);
  });
});

const url = process.env.TEST_DATABASE_URL;
const MIGRATIONS = path.resolve(import.meta.dirname, '../../supabase/migrations');
const RECORDING = path.resolve(import.meta.dirname, '../../data/recordings/wt2-montreal-2026-men-500m-finals.ndjson.gz');

// World Tour #2 in Montréal, Oct 31 2026: Final B went off at 18:39 UTC, Final A at 18:45.
describe.skipIf(!url)('replaying the men\'s 500 m finals in Montréal', () => {
  let pool: pg.Pool;
  let clock: VirtualClock;
  let worker: SyncWorker;
  let app: ReturnType<typeof createApp>;
  let roundId: number;

  const at = async (time: string) => {
    clock.jump(t(time));
    await worker.tick(clock.now());
  };
  const round = async () => (await request(app).get(`/rounds/${roundId}`).expect(200)).body as RoundResponse;
  const finalA = async () => (await round()).heats.find((h) => h.name === 'Final')!;

  beforeAll(async () => {
    pool = createPool(url);
    await pool.query('drop schema public cascade; create schema public;');
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await pool.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
    clock = new VirtualClock(t('18:30:00'), 1, () => 0); // stands still between jumps
    const fake = new FakeIsu(await readRecording(RECORDING), clock);
    const isu = new IsuClient({ fetchImpl: fake.fetch, minIntervalMs: 0, cacheDir: mkdtempSync(path.join(os.tmpdir(), 'fake-isu-')) });
    worker = new SyncWorker(isu, pool, () => {});
    app = createApp(pool, { now: () => new Date(clock.now()) });
    // As live-replay does when it starts mid-event.
    const montreal = fake.events().find((e) => e.slug === 'isu-short-track-world-tour-2-montreal')!;
    await new Ingest(pool).loadTree(await isu.pullEvent(montreal));
    await worker.tick(clock.now());
    roundId = (await pool.query<{ id: number }>('select id from round where isu_id = 22931')).rows[0]!.id;
  }, 60_000);

  afterAll(async () => { await pool?.end(); });

  it('shows both finals as start lists beforehand', async () => {
    const r = await round();
    expect(r.round).toMatchObject({ competition: 'Men 500 m', name: 'Finals' });
    expect(r.heats.map((h) => [h.name, h.state])).toEqual([['Final B', 'start_list'], ['Final', 'start_list']]);
    expect((await finalA()).entries.every((e) => e.rank == null)).toBe(true);
  });

  it('goes live when Final A starts, and the events list says so', async () => {
    await at('18:41:00'); // Final B is done
    expect((await round()).heats.map((h) => h.state)).toEqual(['official', 'start_list']);
    const next = (await request(app).get('/seasons/2026%2F2027/events').expect(200)).body;
    expect(next.live.onTheIce).toMatchObject({ heat: 'Final A', isLive: false });
    await at('18:46:00');
    expect((await finalA()).state).toBe('running');
    const events = (await request(app).get('/seasons/2026%2F2027/events').expect(200)).body;
    expect(events.live.onTheIce).toMatchObject({ competition: 'Men 500 m', round: 'Finals', heat: 'Final A', isLive: true });
  });

  it('posts the result, then makes it official', async () => {
    await at('18:47:00');
    expect((await finalA()).entries.filter((e) => e.rank != null)).toHaveLength(5);
    await at('18:48:00');
    const final = await finalA();
    expect(final.state).toBe('official');
    expect(final.entries.filter((e) => e.rank != null)).toHaveLength(4);
    expect((await round()).round.state).toBe('finished');
  });
});
