import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ChatEvents, ChatMessage } from '../chat/chat.js';
import { RateLimit } from '../chat/chat.js';
import type { Db } from '../db/pool.js';
import { replayRound } from '../dev/replay.js';
import { cleanNickname } from '../domain/picks.js';
import { Accounts, cleanSettings, parseFavorites, type VerifyGoogle } from './accounts.js';
import { Athletes, type RaceFilters } from './athletes.js';
import { Favorites } from './favorites.js';
import { Picks } from './picks.js';
import { Repo } from './repo.js';
import { Standings } from './standings.js';
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
  /** Sign in with Google; unset when there's no GOOGLE_CLIENT_ID. */
  google?: VerifyGoogle | null;
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
    res.json(heatView(round, heat, await repo.entriesForHeat(heat.id), await repo.lapsForHeat(heat.id),
      round.is_relay ? await repo.relayMembersForHeat(heat.id) : []));
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

  // ISU's standings: /standings is the latest season with standings,
  // /standings/2025-2026 (or ?season=2025-2026) a past one.
  const standings = new Standings(db);
  app.get('/standings', wrap(async (req, res) => {
    res.json(await standings.season(text(req.query.season)?.replace('-', '/') ?? null));
  }));
  app.get('/standings/:season', wrap(async (req, res) => {
    const body = await standings.season(String(req.params.season).replace('-', '/'));
    if (!body.lists.length) return res.status(404).json({ error: 'No standings for that season' });
    res.json(body);
  }));

  // Accounts. POST /auth/google { idToken } signs in and returns a session
  // token; the /me routes take it in X-Session. PUT /me { favorites: [{ id,
  // addedAt }], settings } replaces what's saved with the phone's.
  const accounts = new Accounts(db);
  const sessionOf = (req: Request) => text(req.get('x-session'));
  const signedIn = (fn: (req: Request, res: Response, accountId: number) => Promise<unknown>) => wrap(async (req, res) => {
    const token = sessionOf(req);
    const accountId = token ? await accounts.fromToken(token) : null;
    // signedOut tells the app this is its session, not the API token.
    if (!accountId) return res.status(401).json({ error: 'Sign in again.', signedOut: true });
    return fn(req, res, accountId);
  });

  app.post('/auth/google', express.json({ limit: '16kb' }), wrap(async (req, res) => {
    if (!opts.google) return res.status(503).json({ error: 'Google sign-in isn’t set up on this server.' });
    const idToken = text(req.body?.idToken);
    if (!idToken) return res.status(400).json({ error: 'Send the Google ID token as idToken.' });
    const who = await opts.google(idToken).catch(() => null);
    if (!who) return res.status(401).json({ error: 'Google didn’t confirm that sign-in.' });
    const { token, accountId } = await accounts.signInGoogle(who);
    res.json({ session: token, ...(await accounts.state(accountId)) });
  }));

  app.post('/auth/signout', wrap(async (req, res) => {
    const token = sessionOf(req);
    if (token) await accounts.signOut(token);
    res.status(204).end();
  }));

  app.get('/me', signedIn(async (_req, res, accountId) => {
    res.json(await accounts.state(accountId));
  }));

  app.put('/me', express.json({ limit: '64kb' }), signedIn(async (req, res, accountId) => {
    const saved = parseFavorites(req.body?.favorites);
    if (!saved) return res.status(400).json({ error: 'Send favorites as [{ id, addedAt }].' });
    await accounts.save(accountId, saved, cleanSettings(req.body?.settings));
    res.json(await accounts.state(accountId));
  }));

  app.delete('/me', signedIn(async (_req, res, accountId) => {
    await accounts.remove(accountId);
    res.status(204).end();
  }));

  app.put('/me/nickname', express.json({ limit: '4kb' }), signedIn(async (req, res, accountId) => {
    const nickname = cleanNickname(req.body?.nickname);
    if (!nickname) return res.status(400).json({ error: 'Use 2–20 letters, numbers or spaces.' });
    if (await accounts.setNickname(accountId, nickname) === 'taken') return res.status(409).json({ error: 'Someone already has that name.' });
    res.json({ nickname });
  }));

  // Picks are for signed-in people only; picking also needs a nickname. Signed
  // out, GET /picks says so and nothing more.
  // PUT /picks/heats/:id { finish: [entry ids], penalized: [entry ids] }
  const picks = new Picks(db);
  app.get('/picks', wrap(async (req, res) => {
    const token = sessionOf(req);
    const accountId = token ? await accounts.fromToken(token) : null;
    res.json(await picks.home(accountId, now()));
  }));
  app.get('/picks/heats/:id', signedIn(async (req, res, accountId) => {
    const view = await picks.heat(Number(req.params.id), accountId);
    if (!view) return res.status(404).json({ error: 'Picks are for quarterfinals, semifinals and finals.' });
    res.json(view);
  }));
  app.put('/picks/heats/:id', express.json({ limit: '8kb' }), signedIn(async (req, res, accountId) => {
    const list = (v: unknown) => (Array.isArray(v) && v.every((x) => Number.isInteger(x)) ? (v as number[]) : null);
    const finish = list(req.body?.finish);
    const penalized = list(req.body?.penalized ?? []);
    if (!finish || !penalized) return res.status(400).json({ error: 'Send finish and penalized as entry ids.' });
    const result = await picks.save(accountId, Number(req.params.id), { finish, penalized });
    if (result === 'not_found') return res.status(404).json({ error: 'Picks are for quarterfinals, semifinals and finals.' });
    if (result === 'locked') return res.status(409).json({ error: 'This race has started; picks are locked.', locked: true });
    if (result === 'needs_nickname') return res.status(409).json({ error: 'Choose a nickname first.', needsNickname: true });
    if (result === 'invalid') return res.status(400).json({ error: 'Place or penalize every skater once.' });
    res.json(result);
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
