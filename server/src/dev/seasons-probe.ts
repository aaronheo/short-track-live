// Dev: how much history ISU has (seasons, events per season).
import { IsuClient } from '../isu/client.js';

const isu = new IsuClient({ cacheDir: '.cache/isu' });
const seasons = await isu.seasons();
console.log(seasons.length, 'seasons:', seasons.map((s) => s.title).join(', '));
for (const i of [2, 5, 10, 20, seasons.length - 1]) {
  const title = seasons[i]?.title;
  if (!title) continue;
  const events = await isu.events(title);
  console.log(title, events.length, 'events:', events.slice(0, 3).map((e) => e.name).join(' | '));
}
