import type pg from 'pg';
import { Ingest, eventState } from '../db/ingest.js';
import type { IsuClient } from '../isu/client.js';
import type { IsuEvent } from '../isu/types.js';

// Polling policy. ISU only ever gets one request at a time from us (IsuClient
// queues them, at most one per second).
const STRUCTURE_EVERY = 60_000; // live event: schedule, competitions, rounds
const HOT_HEATS_EVERY = 5_000; // a round that's racing (or due within ±15 min)
const START_LISTS_EVERY = 10 * 60_000; // upcoming rounds in the next 24 h
const EVENT_LIST_EVERY = 24 * 60 * 60_000; // current season's event list
const LIVE_EVENT_LIST_EVERY = 30 * 60_000; // ...more often while an event is live, to see it finish
const HOT_WINDOW = 15 * 60_000;
const FINISH_CHECK_EVERY = 10 * 60_000; // a finished event, until all its heats are official

type Log = (msg: string) => void;

export class SyncWorker {
  private readonly ingest: Ingest;
  private lastStructure = new Map<number, number>();
  private lastHeats = new Map<number, number>();
  private lastEventList = 0;
  private lastFinishCheck = new Map<number, number>();
  private stopped = false;

  constructor(
    private readonly isu: IsuClient,
    private readonly pool: pg.Pool,
    private readonly log: Log = (m) => console.log(`[sync] ${m}`),
  ) {
    this.ingest = new Ingest(pool);
  }

  /** The current season's title per ISU, plus the one before it. */
  async seasons(): Promise<{ current: string; previous: string | null }> {
    const all = await this.isu.seasons();
    const i = all.findIndex((s) => s.is_current === 1);
    return { current: all[i]!.title, previous: all[i + 1]?.title ?? null };
  }

  /**
   * Store every event of these seasons. Finished events are pulled once (and
   * from the disk cache if we've seen them) and marked complete; complete
   * events are skipped. Upcoming events get just their event row.
   */
  async backfill(seasonTitles: string[]): Promise<void> {
    for (const title of seasonTitles) {
      const events = await this.isu.events(title);
      this.log(`${title}: ${events.length} events`);
      for (const ev of events) {
        await this.ingest.upsertEvent(ev);
        if (eventState(ev.state) === 'upcoming') continue;
        if (await this.isComplete(ev.slug)) continue;
        await this.pullWholeEvent(ev);
      }
    }
  }

  private async pullWholeEvent(ev: IsuEvent): Promise<void> {
    const before = this.isu.requests;
    const finished = eventState(ev.state) === 'finished';
    const tree = await this.isu.pullEvent(ev, finished);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { eventId } = await new Ingest(client).loadTree(tree);
      const complete = await new Ingest(client).markSynced(eventId);
      await client.query('commit');
      this.log(`${ev.name} (${ev.season}): loaded, ${this.isu.requests - before} ISU requests${complete ? ', complete' : ''}`);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  private async isComplete(slug: string): Promise<boolean> {
    const res = await this.pool.query<{ results_complete: boolean }>('select results_complete from event where slug = $1', [slug]);
    return res.rows[0]?.results_complete ?? false;
  }

  /** Runs until stop(): event-list refresh, live polling. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick(Date.now());
      } catch (err) {
        this.log(`tick failed: ${(err as Error).message}; backing off 30 s`);
        await sleep(30_000);
      }
      await sleep(1_000);
    }
  }

  stop(): void { this.stopped = true; }

  async tick(now: number): Promise<void> {
    const live = await this.liveEvents(now);
    const listEvery = live.length ? LIVE_EVENT_LIST_EVERY : EVENT_LIST_EVERY;
    if (now - this.lastEventList >= listEvery) {
      this.lastEventList = now;
      const { current } = await this.seasons();
      for (const ev of await this.isu.events(current)) await this.ingest.upsertEvent(ev);
      this.log(`refreshed ${current} event list`);
    }

    for (const ev of live) {
      if (now - (this.lastStructure.get(ev.id) ?? 0) >= STRUCTURE_EVERY) {
        this.lastStructure.set(ev.id, now);
        await this.refreshStructure(ev);
      }
      for (const r of await this.roundsToPoll(ev.id, now)) {
        const every = r.hot ? HOT_HEATS_EVERY : START_LISTS_EVERY;
        if (now - (this.lastHeats.get(r.id) ?? 0) < every) continue;
        this.lastHeats.set(r.id, now);
        const heats = await this.isu.heats(r.comp_isu_id, r.isu_id, r.is_relay);
        await this.ingest.loadRoundHeats(r.isu_id, heats, r.is_relay);
      }
      if (ev.state === 'finished' && now - (this.lastFinishCheck.get(ev.id) ?? 0) >= FINISH_CHECK_EVERY) {
        this.lastFinishCheck.set(ev.id, now);
        await this.finishEvent(ev);
      }
    }
  }

  /**
   * Events worth polling: marked live, or within a day of their dates and not
   * yet complete (ISU flips the state late).
   */
  private async liveEvents(now: number) {
    const res = await this.pool.query<{ id: number; slug: string; state: string }>(
      `select e.id, e.slug, e.state from event e
       where not e.results_complete
         and (e.state = 'live' or $1::date between e.starts_on - 1 and e.ends_on + 1)`,
      [new Date(now).toISOString().slice(0, 10)]);
    return res.rows;
  }

  /** Competitions, rounds and schedule for one live event (no heats). */
  private async refreshStructure(ev: { id: number; slug: string }): Promise<void> {
    const comps = await this.isu.competitions(ev.slug);
    const roundIds = new Map<number, number>();
    const roundKeys = new Map<string, number>();
    const norm = (s: string) => s.toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9]/g, '');
    const named: { title: string; label: string; roundId: number }[] = [];
    for (const comp of comps) {
      const compId = await this.ingest.upsertCompetition(ev.id, comp);
      const rounds = await this.isu.rounds(comp.event_result_id);
      const ids = await this.ingest.upsertRounds(compId, rounds);
      for (const r of rounds) {
        const rid = ids.get(r.event_result_round_id)!;
        roundIds.set(r.event_result_round_id, rid);
        roundKeys.set(norm(comp.name) + '|' + norm(r.name), rid);
        named.push({ title: comp.name, label: r.name, roundId: rid });
      }
    }
    const derived = await this.ingest.withStarts(named);
    await this.ingest.rebuildSchedule(ev.id, await this.isu.schedule(ev.slug), roundIds, roundKeys, derived);
    if (comps.length && comps.every((c) => eventState(c.status) === 'finished')) {
      await this.pool.query(`update event set state = 'finished' where id = $1`, [ev.id]);
    }
  }

  /** Rounds that are racing or due soon (hot), and upcoming ones whose start lists may change. */
  private async roundsToPoll(eventId: number, now: number) {
    const res = await this.pool.query<{ id: number; isu_id: number; comp_isu_id: number; is_relay: boolean; hot: boolean }>(
      `select r.id, r.isu_id, c.isu_id as comp_isu_id, c.is_relay,
         (r.state = 'live'
           or exists (select 1 from heat h where h.round_id = r.id and h.state in ('running', 'unofficial'))
           or exists (select 1 from schedule_item si where si.round_id = r.id
                      and si.starts_at between $2::timestamptz - make_interval(secs => $3) and $2::timestamptz + make_interval(secs => $3))
         ) as hot
       from round r join competition c on c.id = r.competition_id
       where c.event_id = $1 and r.state <> 'finished'
         and (r.state = 'live' or r.starts_at is null or r.starts_at < $2::timestamptz + interval '24 hours')`,
      [eventId, new Date(now).toISOString(), HOT_WINDOW / 1000]);
    // Finished rounds whose heats aren't all official yet still need polling.
    const pending = await this.pool.query<{ id: number; isu_id: number; comp_isu_id: number; is_relay: boolean }>(
      `select distinct r.id, r.isu_id, c.isu_id as comp_isu_id, c.is_relay
       from round r join competition c on c.id = r.competition_id join heat h on h.round_id = r.id
       where c.event_id = $1 and r.state = 'finished' and h.state <> 'official'`, [eventId]);
    return [...res.rows, ...pending.rows.map((r) => ({ ...r, hot: true }))];
  }

  /** One last full pull when an event ends, then it's never fetched again. */
  private async finishEvent(ev: { id: number; slug: string }): Promise<void> {
    const events = await this.isu.events((await this.seasons()).current);
    const isuEvent = events.find((e) => e.slug === ev.slug);
    if (isuEvent && eventState(isuEvent.state) === 'finished') await this.pullWholeEvent({ ...isuEvent });
  }

}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
