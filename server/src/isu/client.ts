import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IsuResponse } from './recorder.js';
import type {
  EventTree, IsuCompetition, IsuEvent, IsuHeat, IsuRound, IsuScheduleItem, IsuSeason, IsuStandingEntry, IsuStandingList,
} from './types.js';

const BASE = 'https://front-api.isu.org';
export const SHORT_TRACK = 3; // discipline_id: 1 figure, 2 synchro, 3 short track, 4 speed skating

type Body = { json?: unknown; form?: Record<string, string | number> };

export interface ClientOptions {
  /** Minimum gap between requests to ISU. */
  minIntervalMs?: number;
  /** Raw responses are written here; `cached` reads come from here. */
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  /** Gets each response fetched from ISU while `recording` is on (see IsuRecorder). */
  recorder?: { save(r: IsuResponse): Promise<void> };
}

/**
 * Talks to ISU one request at a time, at most one per `minIntervalMs`.
 * Every response is kept on disk, so finished data is fetched once and
 * re-reads (`{ cached: true }`) never reach ISU.
 */
export class IsuClient {
  private readonly minIntervalMs: number;
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly recorder?: ClientOptions['recorder'];
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  requests = 0;
  /** Set by the sync worker while it polls a live event. */
  recording = false;

  constructor(opts: ClientOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.cacheDir = opts.cacheDir ?? path.resolve('.cache/isu');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retries = opts.retries ?? 3;
    this.recorder = opts.recorder;
  }

  seasons() {
    return this.call<IsuSeason[]>('GET', '/common/get-season', {}, true);
  }

  /** `season` is the title, e.g. "2025/2026" (season_id does not filter). */
  async events(season: string, cached = false): Promise<IsuEvent[]> {
    const out: IsuEvent[] = [];
    for (let page = 1; ; page++) {
      const res = await this.request('POST', '/events/list', {
        json: { discipline_id: SHORT_TRACK, season, event_level: 'ISU', page, pagesize: 50 },
      }, cached);
      out.push(...((res.data as IsuEvent[] | null) ?? []));
      if (res.is_next_page !== 'Y') return out;
    }
  }

  /** One item per round. Empty for many past events; the Olympics' items have no round ids. */
  async schedule(slug: string, cached = false): Promise<IsuScheduleItem[]> {
    const data = await this.call<{ value?: IsuScheduleItem[] } | null>(
      'GET', `/events/getschedule/${encodeURIComponent(slug)}`, {}, cached);
    return data?.value ?? [];
  }

  async competitions(slug: string, cached = false): Promise<IsuCompetition[]> {
    return (await this.call<IsuCompetition[] | null>('POST', '/events/get-event-result', {
      json: { slug, gender: '', discipline_distance: '' },
    }, cached)) ?? [];
  }

  async rounds(eventResultId: number, cached = false): Promise<IsuRound[]> {
    return (await this.call<IsuRound[] | null>('POST', '/events/get-event-result-round', {
      json: { event_result_id: String(eventResultId) },
    }, cached)) ?? [];
  }

  async heats(eventResultId: number, roundId: number, team: boolean, cached = false): Promise<IsuHeat[]> {
    return (await this.call<IsuHeat[] | null>(
      'POST', `/events/get-event-result-round-heats-stk-${team ? 'team' : 'single'}`,
      { form: { event_result_id: eventResultId, event_result_round_id: roundId, country_code: '' } },
      cached)) ?? [];
  }

  /** ISU's published standings for one season (`seasonId` is ISU's, our season.isu_id). */
  async standingLists(seasonId: number): Promise<IsuStandingList[]> {
    return (await this.call<IsuStandingList[] | null>('POST', '/events/get-world-standings-list', {
      json: { page: 1, discipline_id: SHORT_TRACK, season_id: seasonId, pagesize: 100 },
    }, false)) ?? [];
  }

  /** Everyone in one standing, best first. Relays and nations are teams. */
  async standing(id: number, team: boolean): Promise<IsuStandingEntry[]> {
    const out: IsuStandingEntry[] = [];
    for (let page = 1; ; page++) {
      const res = await this.request('POST', `/events/get-world-standings-stk-ssk-detail-skater-${team ? 'team' : 'single'}`, {
        json: { page, pagesize: 200, world_standings_list_fsk_id: id },
      }, false);
      out.push(...((res.data as IsuStandingEntry[] | null) ?? []));
      if (res.is_next_page !== 'Y') return out;
    }
  }

  /** Everything for one event. Use `cached` for finished events. */
  async pullEvent(event: IsuEvent, cached = false): Promise<EventTree> {
    const tree: EventTree = { event, schedule: await this.schedule(event.slug, cached), competitions: [] };
    for (const comp of await this.competitions(event.slug, cached)) {
      const rounds = [];
      for (const round of await this.rounds(comp.event_result_id, cached)) {
        const heats = await this.heats(comp.event_result_id, round.event_result_round_id, isRelay(comp), cached);
        rounds.push({ ...round, heats });
      }
      tree.competitions.push({ ...comp, rounds });
    }
    return tree;
  }

  private async call<T>(method: string, apiPath: string, body: Body, cached: boolean): Promise<T> {
    return (await this.request(method, apiPath, body, cached)).data as T;
  }

  private request(method: string, apiPath: string, body: Body, cached: boolean) {
    const run = () => this.send(method, apiPath, body, cached);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async send(method: string, apiPath: string, body: Body, cached: boolean): Promise<IsuEnvelope> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      language_code: 'en',
      site_type: 'fan',
      'User-Agent': 'Mozilla/5.0 (short-track-live prototype)',
    };
    let payload: string | undefined;
    if (body.json !== undefined) {
      payload = JSON.stringify(body.json);
      headers['Content-Type'] = 'application/json';
    } else if (body.form) {
      payload = new URLSearchParams(Object.entries(body.form).map(([k, v]) => [k, String(v)])).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const key = createHash('sha1').update(`${method} ${apiPath} ${payload ?? ''}`).digest('hex');
    const file = path.join(this.cacheDir, `${key}.json`);
    if (cached) {
      const hit = await readFile(file, 'utf8').catch(() => null);
      if (hit) return JSON.parse(hit) as IsuEnvelope;
    }

    for (let attempt = 0; ; attempt++) {
      const wait = this.minIntervalMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.requests++;
      try {
        const res = await this.fetchImpl(BASE + apiPath, { method, headers, body: payload });
        if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
        const json = (await res.json()) as IsuEnvelope;
        if (json.status !== 200) throw new Error(`${method} ${apiPath} -> ${json.status} ${json.message ?? ''}`);
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(file, JSON.stringify(json));
        if (this.recording) await this.recorder?.save({ key, method, path: apiPath, body: payload, json });
        return json;
      } catch (err) {
        const retryable = err instanceof RetryableError || err instanceof TypeError; // TypeError = network
        if (!retryable || attempt >= this.retries) throw err;
        await sleep(2000 * 2 ** attempt);
      }
    }
  }
}

interface IsuEnvelope {
  status: number;
  message?: string;
  data: unknown;
  is_next_page?: 'Y' | 'N';
}

class RetryableError extends Error {}

export function isRelay(comp: Pick<IsuCompetition, 'discipline_type' | 'name'>): boolean {
  return ['couples', 'team'].includes((comp.discipline_type ?? '').toLowerCase())
    || comp.name.toLowerCase().includes('relay');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
