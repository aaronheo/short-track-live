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
const MONTREAL = 'isu-short-track-world-tour-2-montreal';

/**
 * A fresh database with Montréal as ISU showed it at `start`, and a worker and
 * API reading a clock that only moves when `at` moves it.
 */
async function replay(slice: string, start: string) {
  const pool = createPool(url);
  await pool.query('drop schema public cascade; create schema public;');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  const clock = new VirtualClock(Date.parse(start), 1, () => 0);
  const fake = new FakeIsu(await readRecording(path.resolve(import.meta.dirname, '../../data/recordings', slice)), clock);
  const isu = new IsuClient({ fetchImpl: fake.fetch, minIntervalMs: 0, cacheDir: mkdtempSync(path.join(os.tmpdir(), 'fake-isu-')) });
  const worker = new SyncWorker(isu, pool, () => {});
  const app = createApp(pool, {
    now: () => new Date(clock.now()),
    google: async (idToken) => ({ sub: idToken, email: `${idToken}@example.com`, name: idToken }),
  });
  // As live-replay does when it starts mid-event.
  await new Ingest(pool).loadTree(await isu.pullEvent(fake.events().find((e) => e.slug === MONTREAL)!));
  await worker.tick(clock.now());
  const at = async (time: string) => {
    clock.jump(Date.parse(time));
    await worker.tick(clock.now());
  };
  const roundId = async (isuId: number) => (await pool.query<{ id: number }>('select id from round where isu_id = $1', [isuId])).rows[0]!.id;
  return { pool, app, at, roundId };
}

type Replay = Awaited<ReturnType<typeof replay>>;

// World Tour #2 in Montréal, Oct 31 2026: Final B went off at 18:39 UTC, Final A at 18:45.
describe.skipIf(!url)('replaying the men\'s 500 m finals in Montréal', () => {
  let r: Replay;
  let roundId: number;
  const round = async () => (await request(r.app).get(`/rounds/${roundId}`).expect(200)).body as RoundResponse;
  const finalA = async () => (await round()).heats.find((h) => h.name === 'Final A')!;

  beforeAll(async () => {
    r = await replay('wt2-montreal-2026-men-500m-finals.ndjson.gz', '2026-10-31T18:30:00Z');
    roundId = await r.roundId(22931);
  }, 60_000);
  afterAll(async () => { await r?.pool.end(); });

  it('shows both finals as start lists beforehand', async () => {
    const view = await round();
    expect(view.round).toMatchObject({ competition: 'Men 500 m', name: 'Finals' });
    expect(view.heats.map((h) => [h.name, h.state])).toEqual([['Final B', 'start_list'], ['Final A', 'start_list']]);
    expect((await finalA()).entries.every((e) => e.rank == null)).toBe(true);
  });

  it('goes live when Final A starts, and the events list says so', async () => {
    await r.at('2026-10-31T18:41:00Z'); // Final B is done
    expect((await round()).heats.map((h) => h.state)).toEqual(['official', 'start_list']);
    const next = (await request(r.app).get('/seasons/2026%2F2027/events').expect(200)).body;
    expect(next.live.onTheIce).toMatchObject({ heat: 'Final A', isLive: false });
    await r.at('2026-10-31T18:46:00Z');
    expect((await finalA()).state).toBe('running');
    const events = (await request(r.app).get('/seasons/2026%2F2027/events').expect(200)).body;
    expect(events.live.onTheIce).toMatchObject({ competition: 'Men 500 m', round: 'Finals', heat: 'Final A', isLive: true });
  });

  it('posts the result, then makes it official', async () => {
    await r.at('2026-10-31T18:47:00Z');
    expect((await finalA()).entries.filter((e) => e.rank != null)).toHaveLength(5);
    await r.at('2026-10-31T18:48:00Z');
    const final = await finalA();
    expect(final.state).toBe('official');
    expect(final.entries.filter((e) => e.rank != null)).toHaveLength(4);
    expect((await round()).round.state).toBe('finished');
    const heat = (await request(r.app).get(`/heats/${final.id}`).expect(200)).body;
    expect(heat.heat.name).toBe('Final A');
  });
});

// Men's 1500 m quarterfinals, Oct 30 2026. Heat 7 (off at 20:44 UTC): Kruzbergs
// crossed 3rd, was penalized when the result went official at 20:49:45, and the
// referee advanced Pelletier.
describe.skipIf(!url)('picking a quarterfinal the referee changed', () => {
  let r: Replay;
  let heatId: number;
  let a: string;
  let b: string;
  const session = async (sub: string, nickname: string) => {
    const token = (await request(r.app).post('/auth/google').send({ idToken: sub }).expect(200)).body.session as string;
    await request(r.app).put('/me/nickname').set('X-Session', token).send({ nickname }).expect(200);
    return token;
  };
  const pickView = async (token: string) => (await request(r.app).get(`/picks/heats/${heatId}`).set('X-Session', token).expect(200)).body;
  const heat7 = async () => {
    const round = (await request(r.app).get(`/rounds/${await r.roundId(22949)}`).expect(200)).body as RoundResponse;
    return round.heats.find((h) => h.name === 'Heat 7')!;
  };
  const ids = (view: { entries: { entryId: number; last: string }[] }, ...names: string[]) =>
    names.map((n) => view.entries.find((e) => e.last.toUpperCase() === n)!.entryId);

  beforeAll(async () => {
    r = await replay('wt2-montreal-2026-men-1500m-qf.ndjson.gz', '2026-10-30T20:25:00Z');
    heatId = (await heat7()).id;
    a = await session('pick-a', 'Called It');
    b = await session('pick-b', 'Start Order');
  }, 60_000);
  afterAll(async () => { await r?.pool.end(); });

  it('takes picks until the race two ahead starts', async () => {
    const view = await pickView(a);
    expect(view).toMatchObject({ title: 'Men 1500 m', race: 'Quarterfinal · Heat 7', locked: false });
    expect(view.entries.map((e: { last: string }) => e.last.toUpperCase()))
      .toEqual(['KRUZBERGS', 'VEKHOV', 'GAGNON-LAMARCHE', 'NIEWINSKI', 'DONCHEV', 'PELLETIER']);
    await request(r.app).put(`/picks/heats/${heatId}`).set('X-Session', a).send({
      finish: ids(view, 'NIEWINSKI', 'VEKHOV', 'DONCHEV', 'PELLETIER', 'GAGNON-LAMARCHE'),
      penalized: ids(view, 'KRUZBERGS'), advanced: [],
    }).expect(200);
    // b goes with the start order.
    await request(r.app).put(`/picks/heats/${heatId}`).set('X-Session', b)
      .send({ finish: view.entries.map((e: { entryId: number }) => e.entryId), penalized: [], advanced: [] }).expect(200);

    // Picks close at heat 5's planned start, two races ahead.
    await r.at(view.locksAt);
    const locked = await pickView(a);
    expect(locked.locked).toBe(true);
    expect(locked.crowd.picks).toBe(2);
    await request(r.app).put(`/picks/heats/${heatId}`).set('X-Session', a)
      .send({ finish: view.entries.map((e: { entryId: number }) => e.entryId), penalized: [], advanced: [] }).expect(409);
  });

  it('shows the unofficial result without scoring it', async () => {
    await r.at('2026-10-30T20:47:00Z');
    const heat = await heat7();
    expect(heat.state).toBe('unofficial');
    expect(heat.entries.find((e) => e.last.toUpperCase() === 'KRUZBERGS')).toMatchObject({ rank: 3, status: null });
    expect((await pickView(a)).result).toBeNull();
  });

  it('penalizes, advances and scores once official', async () => {
    await r.at('2026-10-30T20:50:00Z');
    const heat = await heat7();
    expect(heat.state).toBe('official');
    expect(heat.entries.find((e) => e.last.toUpperCase() === 'KRUZBERGS')).toMatchObject({ rank: null, status: 'PEN' });
    expect(heat.qualified.map((q) => [q.last.toUpperCase(), q.badge])).toEqual(
      [['NIEWINSKI', 'Q'], ['VEKHOV', 'Q'], ['DONCHEV', 'q'], ['PELLETIER', 'ADV']]);

    // a: places 1-4 exact (3 each), Gagnon-Lamarche exact at 5th, the penalty called (5).
    // The most anyone could get: 3 for each finisher, 5 for the advancement and 5 for the penalty.
    expect((await pickView(a)).result.score).toMatchObject({ points: 4 * 3 + 3 + 5, max: 4 * 3 + 5 + 5 });
    // b: only Vekhov in his start place (2nd).
    expect((await pickView(b)).result.score).toMatchObject({ points: 3 });
    const home = (await request(r.app).get('/picks').set('X-Session', b).expect(200)).body;
    expect(home.leaderboard.map((l: { nickname: string; points: number }) => [l.nickname, l.points]))
      .toEqual([['Called It', 20], ['Start Order', 3]]);
  });
});

// Men's 1500 m repechage quarterfinals: official on Oct 31, but when the event
// finished on Nov 1 ISU added a penalty for Akar to Heat 1.
describe.skipIf(!url)('a correction after the event', () => {
  let r: Replay;
  const heat1 = async () => {
    const round = (await request(r.app).get(`/rounds/${await r.roundId(22950)}`).expect(200)).body as RoundResponse;
    return round.heats.find((h) => h.name === 'Heat 1')!;
  };

  beforeAll(async () => {
    r = await replay('wt2-montreal-2026-men-1500m-rep-qf-correction.ndjson.gz', '2026-11-01T22:00:00Z');
  }, 60_000);
  afterAll(async () => { await r?.pool.end(); });

  it('is picked up when the finished event is fetched again', async () => {
    expect((await heat1()).entries.map((e) => e.last.toUpperCase())).not.toContain('AKAR');
    await r.at('2026-11-01T22:33:00Z'); // ISU's list says Finished; the worker pulls the whole event
    const heat = await heat1();
    expect(heat.state).toBe('official');
    expect(heat.entries.find((e) => e.last.toUpperCase() === 'AKAR')).toMatchObject({ rank: null, status: 'PEN' });
    expect(heat.sanctions).toBe('1 PEN');
  });
});
