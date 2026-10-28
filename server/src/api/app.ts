import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ChatEvents, ChatMessage } from '../chat/chat.js';
import { RateLimit } from '../chat/chat.js';
import type { Db } from '../db/pool.js';
import { replayRound } from '../dev/replay.js';
import { Athletes, type RaceFilters } from './athletes.js';
import { Favorites } from './favorites.js';
import { Repo } from './repo.js';
import { dayOfEvent, eventSummary, heatView, onTheIce, roundView, scheduleView, type EventsResponse } from './views.js';

export interface AppOptions {
  now?: () => Date;
  /** Dev: our heat id to replay as live (see dev/replay.ts). */
  replayHeat?: number | null;
  /**
   * Bearer token the app must send. Set in production (API_TOKEN) so the
   * public URL doesn't republish ISU's data to anyone; unset locally.
   */
  token?: string | null;
  /** Ask (POST /chat); unset when there's no OPENAI_API_KEY. */
  chat?: { answer(messages: ChatMessage[], events: ChatEvents, signal?: AbortSignal): Promise<void> } | null;
  /** Ask requests per hour for the whole server. */
  chatPerHour?: number;
}

/**
 * Read-only API for the iOS app. Responses carry an ETag (Express default), so
 * a poll with If-None-Match gets a cheap 304 when nothing changed.
 */
export function createApp(db: Db, opts: AppOptions = {}) {
  const repo = new Repo(db);
  const now = opts.now ?? (() => new Date());
  const replayStart = Date.now();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  if (opts.token) {
    const expected = Buffer.from(`Bearer ${opts.token}`);
    app.use((req, res, next) => {
      const given = Buffer.from(req.get('authorization') ?? '');
      if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
      res.status(401).json({ error: 'Unauthorized' });
    });
  }

  app.get('/seasons', wrap(async (_req, res) => {
    res.json((await repo.seasons()).map((s) => ({ title: s.title, startsOn: s.starts_on, endsOn: s.ends_on })));
  }));

  // Season titles contain a slash, so the path uses a dash: /seasons/2025-2026/events.
  // /seasons/current/events is the latest season we have.
  app.get('/seasons/:season/events', wrap(async (req, res) => {
    const seasons = await repo.seasons();
    const param = String(req.params.season);
    const title = param === 'current' ? seasons[0]?.title ?? '' : param.replace('-', '/');
    if (!seasons.some((s) => s.title === title)) return res.status(404).json({ error: 'Unknown season' });
    const events = await repo.events(title);
    const liveRow = events.find((e) => e.state === 'live') ?? null;
    let live: EventsResponse['live'] = null;
    if (liveRow) {
      const ice = await repo.onTheIce(liveRow.id);
      const view = ice ? await loadRound(ice.round_id) : null;
      live = { ...eventSummary(liveRow), ...dayOfEvent(liveRow, now()), onTheIce: view ? onTheIce(view) : null };
    }
    const body: EventsResponse = { season: title, seasons: seasons.map((s) => s.title), live, events: events.map(eventSummary) };
    res.json(body);
  }));

  app.get('/events/:slug/schedule', wrap(async (req, res) => {
    const event = await repo.event(String(req.params.slug));
    if (!event) return res.status(404).json({ error: 'Unknown event' });
    const view = scheduleView(event, await repo.schedule(event.id));
    if (opts.replayHeat) {
      const heat = await repo.heat(opts.replayHeat);
      for (const item of view.days.flatMap((d) => d.items)) {
        if (heat && item.roundId === heat.round_id) {
          const round = await loadRound(heat.round_id);
          if (round) { item.state = 'live'; item.liveDetail = onTheIce(round).heat; }
        }
      }
      for (const d of view.days) d.live = d.items.some((i) => i.state === 'live');
    }
    res.json(view);
  }));

  async function loadRound(id: number) {
    const round = await repo.round(id);
    if (!round) return null;
    let heats = await repo.heats(id);
    let entries = await repo.entriesForRound(id);
    if (opts.replayHeat && heats.some((h) => h.id === opts.replayHeat)) {
      const replayed = replayRound(heats, entries, await repo.lapsForRound(id), opts.replayHeat, Date.now(), replayStart);
      if (replayed) { heats = replayed.heats; entries = replayed.entries; round.state = 'live'; }
    }
    return roundView(round, await repo.siblingRounds(round.competition_id), heats, entries);
  }

  app.get('/rounds/:id', wrap(async (req, res) => {
    const view = await loadRound(Number(req.params.id));
    if (!view) return res.status(404).json({ error: 'Unknown round' });
    res.json(view);
  }));

  app.get('/heats/:id', wrap(async (req, res) => {
    const heat = await repo.heat(Number(req.params.id));
    const round = heat ? await repo.round(heat.round_id) : null;
    if (!heat || !round) return res.status(404).json({ error: 'Unknown heat' });
    res.json(heatView(round, heat, await repo.entriesForHeat(heat.id), await repo.lapsForHeat(heat.id)));
  }));

  const athletes = new Athletes(db);
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  app.get('/athletes', wrap(async (req, res) => {
    const q = text(req.query.q) ?? '';
    res.json({ query: q, results: q.length >= 2 ? await athletes.search(q) : [] });
  }));

  app.get('/athletes/:id', wrap(async (req, res) => {
    const view = await athletes.athlete(Number(req.params.id));
    if (!view) return res.status(404).json({ error: 'Unknown athlete' });
    res.json(view);
  }));

  // ?season=2025-2026&event=<slug>&distance=500|1000|1500|relay&sort=asc|desc&cursor=…&limit=30
  app.get('/athletes/:id/races', wrap(async (req, res) => {
    const filters: RaceFilters = {
      season: text(req.query.season)?.replace('-', '/') ?? null,
      event: text(req.query.event),
      distance: text(req.query.distance),
    };
    res.json(await athletes.races(Number(req.params.id), filters, {
      sort: req.query.sort === 'asc' ? 'asc' : 'desc',
      cursor: text(req.query.cursor),
      limit: Number(req.query.limit) || undefined,
    }));
  }));

  // Favorites live on the phone, which polls this for notifications: ?skaters=12,57,251
  const favorites = new Favorites(db);
  app.get('/favorites/races', wrap(async (req, res) => {
    const ids = (text(req.query.skaters) ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    res.json(await favorites.races([...new Set(ids)].slice(0, 100), now()));
  }));

  app.get('/favorites/suggested', wrap(async (_req, res) => {
    res.json(await favorites.suggested());
  }));

  // Ask. Body: { messages: [{ role: 'user' | 'assistant', content }] }, the
  // whole conversation (nothing is stored). Streams server-sent events:
  // {type:'step', text}, {type:'delta', text}, {type:'reset'}, then {type:'done'} or {type:'error', message}.
  const chatLimit = new RateLimit(opts.chatPerHour ?? 60);
  app.post('/chat', express.json({ limit: '64kb' }), wrap(async (req, res) => {
    if (!opts.chat) return res.status(503).json({ error: 'Ask isn’t set up on this server.' });
    const raw: unknown = req.body?.messages;
    const messages = Array.isArray(raw) ? raw.filter((m): m is ChatMessage =>
      !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0) : [];
    if (!messages.length || messages.length !== (raw as unknown[]).length || messages.length > 30
      || messages.at(-1)!.role !== 'user' || messages.some((m) => m.content.length > 4000)) {
      return res.status(400).json({ error: 'Send the conversation as messages ending with a question.' });
    }
    if (!chatLimit.take()) return res.status(429).json({ error: 'That’s a lot of questions. Try again in a bit.' });

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event: object) => { res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      await opts.chat.answer(messages, {
        step: (text) => send({ type: 'step', text }),
        delta: (text) => send({ type: 'delta', text }),
        reset: () => send({ type: 'reset' }),
      }, abort.signal);
      send({ type: 'done' });
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error(err);
        send({ type: 'error', message: 'Something went wrong answering that. Try again.' });
      }
    }
    res.end();
  }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  return app;
}
