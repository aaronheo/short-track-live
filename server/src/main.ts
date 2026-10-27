import 'dotenv/config';
import OpenAI from 'openai';
import { Chat } from './chat/chat.js';
import { createPool } from './db/pool.js';
import { createApp } from './api/app.js';
import { startSync } from './sync/run.js';

// API and sync worker in one process: `npm run dev` locally, `npm start` on Render.
const port = Number(process.env.PORT ?? 4310);
const pool = createPool();
// Ask needs an OpenAI key; without one, POST /chat answers 503.
const askFrom = (db: typeof pool) => (process.env.OPENAI_API_KEY
  ? new Chat(new OpenAI(), db, {
    model: process.env.OPENAI_MODEL ?? 'gpt-5.5',
    reasoningEffort: (process.env.OPENAI_REASONING_EFFORT ?? 'low') as 'low',
  })
  : null);
// Names only, never values: shows a misspelled or misplaced key in the deploy log.
const openAiNames = Object.keys(process.env).filter((k) => /open.?ai/i.test(k)).map((k) => JSON.stringify(k));
console.log(process.env.OPENAI_API_KEY
  ? `Ask: on (${process.env.OPENAI_MODEL ?? 'gpt-5.5'})`
  : `Ask: off, OPENAI_API_KEY is not set (OpenAI variables seen: ${openAiNames.join(', ') || 'none'})`);
const replayHeat = process.env.REPLAY_HEAT ? Number(process.env.REPLAY_HEAT) : null;
createApp(pool, { replayHeat, token: process.env.API_TOKEN, chat: askFrom(pool) }).listen(port, () => console.log(`API on http://localhost:${port}`));
startSync().catch((err) => {
  console.error(err);
  process.exit(1);
});
