import type pg from 'pg';
import { Ingest, SETTLE_DAYS, eventState } from '../db/ingest.js';
import { competitionName, roundName } from '../domain/normalize.js';
import { isuLocalDate } from '../domain/time.js';
import { isRelay, type IsuClient } from '../isu/client.js';
import type { IsuEvent } from '../isu/types.js';

// Polling policy. ISU only ever gets one request at a time from us (IsuClient
// queues them, at most one per second).
const STRUCTURE_EVERY = 60_000; // live event: schedule, competitions, rounds
const HOT_HEATS_EVERY = 5_000; // a round that's racing (or due within ±15 min)
const START_LISTS_EVERY = 10 * 60_000; // upcoming rounds in the next 24 h
const EVENT_LIST_EVERY = 24 * 60 * 60_000; // current season's event list
const LIVE_EVENT_LIST_EVERY = 30 * 60_000; // ...more often while an event is live, to see it finish
const HOT_WINDOW = 15 * 60_000;
// ISU's results before this season are fragments: one race per round, a few skaters in each.
const HISTORY_FROM = '2019/2020';
// ISU event ids the backfill leaves out. ISU lists the 2022 Junior Worlds twice;
// this copy lacks the women's 500 m and 1000 m finals (the other, 4103, is whole).
const SKIP_EVENTS = new Set([4096]);
const FINISH_CHECK_EVERY = 6 * 60 * 60_000; // a just-finished event, fetched whole and fresh
const PULLED_RECENTLY = 12 * 60 * 60_000; // a finished event still settling isn't fetched again sooner

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
   * Store every event of these seasons. Finished events are pulled until
   * they settle a week after they end (see Ingest.markSynced), then skipped.
   * Upcoming events get just their event row.
   */
  async backfill(seasonTitles: string[], opts: { maxDbBytes?: number } = {}): Promise<void> {
    for (const title of seasonTitles) {
      const events = await this.isu.events(title);
      this.log(`${title}: ${events.length} events`);
      for (const ev of events) {
        if (SKIP_EVENTS.has(Number(ev.event_id ?? ev.id))) continue;
        if (opts.maxDbBytes && await this.dbBytes() > opts.maxDbBytes) {
          this.log(`database is over ${Math.round(opts.maxDbBytes / 1e6)} MB; stopping the backfill here`);
          return;
        }
        await this.ingest.upsertEvent(ev);
        if (eventState(ev.state) === 'upcoming') continue;
        if (await this.upToDate(ev.slug)) continue;
        for (let attempt = 1; ; attempt++) {
          try {
            await this.pullWholeEvent(ev);
            break;
          } catch (err) {
            // A dropped connection is worth another go (ISU responses are
            // cached, so it's cheap). Older events can also have data we don't
            // handle yet; skip those and keep going.
            if (isConnectionError(err) && attempt < 3) {
              this.log(`${ev.name} (${ev.season}): ${(err as Error).message}, retrying`);
              await sleep(10_000 * attempt);
              continue;
            }
            this.log(`${ev.name} (${ev.season}): skipped, ${(err as Error).message}`);
            break;
          }
        }
      }
    }
  }

  /** Every season ISU has full results for, newest first (for the one-off history backfill). */
  async allSeasons(): Promise<string[]> {
    return (await this.isu.seasons()).map((s) => s.title).filter((t) => t >= HISTORY_FROM);
  }

  private async dbBytes(): Promise<number> {
    const res = await this.pool.query<{ bytes: string }>('select pg_database_size(current_database()) as bytes');
    return Number(res.rows[0]!.bytes);
  }

  private async pullWholeEvent(ev: IsuEvent): Promise<void> {
    const before = this.isu.requests;
    // Settled events can come from the disk cache; newer ones are fetched
    // fresh, since ISU keeps correcting results for days after an event.
    const settled = eventState(ev.state) === 'finished'
      && Date.parse(isuLocalDate(ev.to_date)) < Date.now() - SETTLE_DAYS * 86_400_000;
    const tree = await this.isu.pullEvent(ev, settled);
    const client = await this.pool.connect();
    // A connection that drops mid-transaction also emits 'error' on the
    // client; the failing query rejects too, so just keep it from crashing.
    const onError = () => {};
    client.on('error', onError);
    let failed: Error | undefined;
    try {
      await client.query('begin');
      const { eventId } = await new Ingest(client).loadTree(tree);
      const { complete, gaps } = await new Ingest(client).markSynced(eventId);
      await client.query('commit');
      const outcome = gaps ? `, incomplete at ISU (${gaps}), hidden` : complete ? ', complete' : '';
      this.log(`${ev.name} (${ev.season}): loaded, ${this.isu.requests - before} ISU requests${outcome}`);
    } catch (err) {
      failed = err as Error;
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.off('error', onError);
      client.release(failed && isConnectionError(failed) ? failed : undefined); // a broken connection is discarded
    }
  }

  /** Settled, or a finished event pulled within the last 12 hours. */
  private async upToDate(slug: string): Promise<boolean> {
    const res = await this.pool.query<{ up_to_date: boolean }>(
      `select results_complete or (state = 'finished' and synced_at > now() - make_interval(secs => $2)) as up_to_date
       from event where slug = $1`, [slug, PULLED_RECENTLY / 1000]);
    return res.rows[0]?.up_to_date ?? false;
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
      const events = await this.isu.events(current);
      for (const ev of events) await this.ingest.upsertEvent(ev);
      this.log(`refreshed ${current} event list`);
      // Finished events that haven't settled, fetched again for ISU's corrections.
      for (const ev of events) {
        if (eventState(ev.state) === 'finished' && !(await this.upToDate(ev.slug))) await this.pullWholeEvent(ev);
      }
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
        named.push({ title: competitionName(comp.name, comp.gender, isRelay(comp)), label: roundName(r.name), roundId: rid });
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

  /** A full, fresh pull of an event that has just ended (then daily until it settles). */
  private async finishEvent(ev: { id: number; slug: string }): Promise<void> {
    const events = await this.isu.events((await this.seasons()).current);
    const isuEvent = events.find((e) => e.slug === ev.slug);
    if (isuEvent && eventState(isuEvent.state) === 'finished') await this.pullWholeEvent({ ...isuEvent });
  }

}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The database connection went away (vs a problem with the data). */
export function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return ['ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(e.code ?? '')
    || /Connection terminated|not queryable|connection error|Query read timeout|timeout exceeded when trying to connect/i.test(e.message ?? '');
}
