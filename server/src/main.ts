import 'dotenv/config';
import { createPool } from './db/pool.js';
import { createApp } from './api/app.js';
import { startSync } from './sync/run.js';

// API and sync worker in one process: `npm run dev` locally, `npm start` on Render.
const port = Number(process.env.PORT ?? 4310);
const replayHeat = process.env.REPLAY_HEAT ? Number(process.env.REPLAY_HEAT) : null;
createApp(createPool(), { replayHeat, token: process.env.API_TOKEN }).listen(port, () => console.log(`API on http://localhost:${port}`));
startSync().catch((err) => {
  console.error(err);
  process.exit(1);
});
