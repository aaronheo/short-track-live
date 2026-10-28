import 'dotenv/config';
import OpenAI from 'openai';
import { Chat } from '../chat/chat.js';
import { createPool } from '../db/pool.js';
import { createApp } from './app.js';
import { googleVerifier } from './accounts.js';

const port = Number(process.env.PORT ?? 4310);
const pool = createPool();
// Ask needs an OpenAI key; without one, POST /chat answers 503.
const askFrom = (db: typeof pool) => (process.env.OPENAI_API_KEY
  ? new Chat(new OpenAI(), db, {
    model: process.env.OPENAI_MODEL ?? 'gpt-5.5',
    reasoningEffort: (process.env.OPENAI_REASONING_EFFORT ?? 'low') as 'low',
  })
  : null);
// Sign in with Google: the iOS app's OAuth client id(s), comma-separated. Unset: /auth/google answers 503.
const googleIds = (process.env.GOOGLE_CLIENT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const google = googleIds.length ? googleVerifier(googleIds) : null;
const replayHeat = process.env.REPLAY_HEAT ? Number(process.env.REPLAY_HEAT) : null;

createApp(pool, { replayHeat, token: process.env.API_TOKEN, chat: askFrom(pool), google }).listen(port, () => {
  console.log(`API on http://localhost:${port}${replayHeat ? ` (replaying heat ${replayHeat})` : ''}`);
});
