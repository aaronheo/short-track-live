import 'dotenv/config';
import { createPool } from '../db/pool.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4310);
const replayHeat = process.env.REPLAY_HEAT ? Number(process.env.REPLAY_HEAT) : null;

createApp(createPool(), { replayHeat }).listen(port, () => {
  console.log(`API on http://localhost:${port}${replayHeat ? ` (replaying heat ${replayHeat})` : ''}`);
});
