import 'dotenv/config';
import OpenAI from 'openai';
import { Chat } from '../chat/chat.js';
import { createPool } from '../db/pool.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4310);
const pool = createPool();
// Ask needs an OpenAI key; without one, POST /chat answers 503.
const askFrom = (db: typeof pool) => (process.env.OPENAI_API_KEY
  ? new Chat(new OpenAI(), db, {
    model: process.env.OPENAI_MODEL ?? 'gpt-5.5',
    reasoningEffort: (process.env.OPENAI_REASONING_EFFORT ?? 'low') as 'low',
  })
  : null);
const replayHeat = process.env.REPLAY_HEAT ? Number(process.env.REPLAY_HEAT) : null;

createApp(pool, { replayHeat, token: process.env.API_TOKEN, chat: askFrom(pool) }).listen(port, () => {
  console.log(`API on http://localhost:${port}${replayHeat ? ` (replaying heat ${replayHeat})` : ''}`);
});
