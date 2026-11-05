import 'dotenv/config';
import OpenAI from 'openai';
import { Chat } from './chat/chat.js';
import { createPool } from './db/pool.js';
import { createApp } from './api/app.js';
import { appleVerifier, googleVerifier } from './api/accounts.js';
import { Apns, apnsConfigFromEnv } from './push/apns.js';
import { PushDevices } from './push/devices.js';
import { startSync } from './sync/run.js';

// API and sync worker in one process: `npm run dev` locally, `npm start` on Render.
const port = Number(process.env.PORT ?? 4310);
const pool = createPool();
// Ask needs an OpenAI key; without one, POST /chat answers 503.
const askFrom = (db: typeof pool) => (process.env.OPENAI_API_KEY
  ? new Chat(new OpenAI(), db, {
    model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
    reasoningEffort: (process.env.OPENAI_REASONING_EFFORT ?? 'low') as 'low',
  })
  : null);
// Names only, never values: shows a misspelled or misplaced key in the deploy log.
const openAiNames = Object.keys(process.env).filter((k) => /open.?ai/i.test(k)).map((k) => JSON.stringify(k));
console.log(process.env.OPENAI_API_KEY
  ? `Ask: on (${process.env.OPENAI_MODEL ?? 'gpt-5-mini'})`
  : `Ask: off, OPENAI_API_KEY is not set (OpenAI variables seen: ${openAiNames.join(', ') || 'none'})`);
// Sign in with Google: the iOS app's OAuth client id(s), comma-separated. Unset: /auth/google answers 503.
const googleIds = (process.env.GOOGLE_CLIENT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const google = googleIds.length ? googleVerifier(googleIds) : null;
// Sign in with Apple: tokens for the app's bundle id (APPLE_CLIENT_ID to override).
const apple = appleVerifier((process.env.APPLE_CLIENT_ID ?? 'com.aaronheo.shorttracklive').split(',').map((s) => s.trim()));
const replayHeat = process.env.REPLAY_HEAT ? Number(process.env.REPLAY_HEAT) : null;
// Server push needs APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID; without them the phone does its own alerts.
const apnsConfig = apnsConfigFromEnv();
const apns = apnsConfig ? new Apns(apnsConfig) : null;
console.log(apns ? 'Push: on' : 'Push: off, APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID are not set');
createApp(pool, { replayHeat, token: process.env.API_TOKEN, chat: askFrom(pool), google, apple, push: new PushDevices(pool, apns) })
  .listen(port, () => console.log(`API on http://localhost:${port}`));
startSync({ push: apns }).catch((err) => {
  console.error(err);
  process.exit(1);
});
