import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { IsuEvent, IsuScheduleItem } from './types.js';

/** One recorded ISU response (a line of an exported recording, see dev/export-recording.ts). */
export interface RecordedResponse {
  at: string; // when our worker fetched it (ISO)
  key: string; // sha1 of method, path and body, as IsuClient computes it
  method: string;
  path: string;
  body: string | null;
  json: unknown; // ISU's whole envelope: { status, message, data, ... }
}

export async function readRecording(file: string): Promise<RecordedResponse[]> {
  const text = gunzipSync(await readFile(file)).toString('utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RecordedResponse);
}

/**
 * A clock that runs `speed` times faster than real time from `start`, and can
 * be paused or moved forward. The fake ISU, the sync worker and the API all
 * read it, so a replayed weekend looks live to the whole server.
 */
export class VirtualClock {
  private base: number;
  private realBase: number;
  private _speed: number;
  private _paused = false;

  constructor(start: number, speed = 1, private readonly realNow: () => number = Date.now) {
    this.base = start;
    this.realBase = realNow();
    this._speed = speed;
  }

  now(): number {
    return this._paused ? this.base : this.base + (this.realNow() - this.realBase) * this._speed;
  }

  get speed(): number { return this._speed; }
  get paused(): boolean { return this._paused; }

  setSpeed(speed: number): void { this.rebase(); this._speed = speed; }
  pause(): void { this.rebase(); this._paused = true; }
  resume(): void { this.rebase(); this._paused = false; }

  /** Moves to `at`. Only forward: the database already holds what happened before now. */
  jump(at: number): void {
    if (at < this.now()) throw new Error('the clock only moves forward; restart the replay to go back');
    this.rebase();
    this.base = at;
  }

  private rebase(): void {
    this.base = this.now();
    this.realBase = this.realNow();
  }
}

/**
 * Stands in for front-api.isu.org (pass `fetch` as IsuClient's fetchImpl).
 * Each request gets what ISU answered to the same request most recently
 * before the clock's time. A request asked before its first recorded answer
 * gets that first answer; one never recorded (other events, standings) gets
 * an empty answer, as ISU gives for missing data.
 */
export class FakeIsu {
  private readonly byKey = new Map<string, RecordedResponse[]>();
  private readonly times = new Map<RecordedResponse, number>();
  /** Requests never recorded, by path: what the replay couldn't answer. */
  readonly unanswered = new Map<string, number>();
  requests = 0;

  constructor(responses: RecordedResponse[], readonly clock: VirtualClock) {
    for (const r of responses) {
      this.times.set(r, Date.parse(r.at));
      const list = this.byKey.get(r.key) ?? [];
      list.push(r);
      this.byKey.set(r.key, list);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => this.times.get(a)! - this.times.get(b)!);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.requests++;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const payload = typeof init?.body === 'string' ? init.body : '';
    return Response.json(this.answer(method, url.pathname, payload));
  };

  /** ISU's envelope for one request at the clock's time. */
  answer(method: string, path: string, payload: string): unknown {
    const key = createHash('sha1').update(`${method} ${path} ${payload}`).digest('hex');
    const list = this.byKey.get(key);
    if (list) {
      const now = this.clock.now();
      let found = list[0]!;
      for (const r of list) {
        if (this.times.get(r)! > now) break;
        found = r;
      }
      return found.json;
    }
    // The worker asks for the seasons to know which event list to read; we
    // never recorded that, so it's made from the recorded event list.
    if (path === '/common/get-season') return { status: 200, data: this.seasons() };
    this.unanswered.set(path, (this.unanswered.get(path) ?? 0) + 1);
    return { status: 200, message: 'Not in the recording', data: null };
  }

  /** The recorded event lists' season as current, plus the one before it. */
  private seasons() {
    const season = this.latest('/events/list')
      .map((r) => (JSON.parse(r.body ?? '{}') as { season?: string }).season)
      .find(Boolean) ?? '2026/2027';
    const first = Number(season.slice(0, 4));
    return [
      { season_id: '0', title: season, from: `${first}-07-01`, to: `${first + 1}-06-30`, is_current: 1 },
      { season_id: '0', title: `${first - 1}/${first}`, from: `${first - 1}-07-01`, to: `${first}-06-30`, is_current: 0 },
    ];
  }

  /** The newest response for each request on this path. */
  private latest(path: string): RecordedResponse[] {
    return [...this.byKey.values()].filter((l) => l[0]!.path === path).map((l) => l.at(-1)!);
  }

  /** What was raced, from the last recorded schedule of each event: for choosing where to start a replay. */
  schedule(): { slug: string; items: IsuScheduleItem[] }[] {
    return [...this.byKey.values()]
      .filter((l) => l[0]!.path.startsWith('/events/getschedule/'))
      .map((l) => ({
        slug: decodeURIComponent(l[0]!.path.split('/').at(-1)!),
        items: ((l.at(-1)!.json as { data?: { value?: IsuScheduleItem[] } }).data?.value ?? []),
      }));
  }

  /** The events in the recorded event list. */
  events(): IsuEvent[] {
    return this.latest('/events/list').flatMap((r) => ((r.json as { data?: IsuEvent[] }).data ?? []));
  }

  /** The first and last recorded times. */
  span(): { from: number; to: number } {
    let from = Infinity, to = -Infinity;
    for (const t of this.times.values()) { from = Math.min(from, t); to = Math.max(to, t); }
    return { from, to };
  }
}
