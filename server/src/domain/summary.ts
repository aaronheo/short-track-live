// Plain-language facts about a finished heat, computed from ISU lap data.
// Positions come from ISU's per-lap Rank, which counts every starter (a
// penalized skater's laps are removed, so one place per lap can be empty).

export interface SummaryEntry {
  last: string;
  rank: number | null;
  laps: { lap: number; pos: number | null; lapMs: number | null }[];
}

function ord(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export function summarize(entries: SummaryEntry[]): string[] {
  const finishers = entries.filter((e) => e.rank != null && e.laps.length > 0).sort((a, b) => a.rank! - b.rank!);
  const winner = finishers[0];
  if (!winner) return [];
  const totalLaps = Math.max(...finishers.map((e) => e.laps.length));
  const starters = Math.max(...entries.flatMap((e) => e.laps.map((l) => l.pos ?? 0)));
  const posAt = (e: SummaryEntry, lap: number) => e.laps.find((l) => l.lap === lap)?.pos ?? null;
  const facts: string[] = [];

  // How the winner won.
  let leadFrom = totalLaps + 1;
  for (let lap = totalLaps; lap >= 1 && posAt(winner, lap) === 1; lap--) leadFrom = lap;
  if (leadFrom === 1) facts.push(`${winner.last} led from start to finish.`);
  else if (leadFrom <= totalLaps - 1) {
    facts.push(`${winner.last} took the lead on lap ${leadFrom} and led the last ${totalLaps - leadFrom + 1} laps.`);
  } else facts.push(`${winner.last} took the lead on the final lap.`);

  // Biggest late climb.
  const toGo = totalLaps >= 9 ? 4 : 2;
  const checkLap = totalLaps - toGo;
  let climb: { e: SummaryEntry; from: number } | null = null;
  for (const e of finishers.slice(1)) {
    const from = posAt(e, checkLap);
    if (from && from - e.rank! >= 2 && (!climb || from - e.rank! > climb.from - climb.e.rank!)) climb = { e, from };
  }
  if (climb) facts.push(`${climb.e.last} was ${ord(climb.from)} with ${toGo} laps to go and finished ${ord(climb.e.rank!)}.`);

  // Fastest lap.
  let fastest: { e: SummaryEntry; lap: number; ms: number } | null = null;
  for (const e of finishers) for (const l of e.laps) {
    if (l.lapMs != null && (!fastest || l.lapMs < fastest.ms)) fastest = { e, lap: l.lap, ms: l.lapMs };
  }
  if (fastest) facts.push(`Fastest lap: ${fastest.e.last}, ${seconds(fastest.ms)} on lap ${fastest.lap}.`);

  // A late fade: in the top 3 for a long stretch, then lost 3+ places.
  for (const e of finishers.slice(1)) {
    let start = 0, end = 0, best = 0;
    for (let lap = 2, run = 0; lap <= totalLaps; lap++) {
      const p = posAt(e, lap);
      run = p != null && p <= 3 ? run + 1 : 0;
      if (run > best) { best = run; end = lap; start = lap - run + 1; }
    }
    const final = posAt(e, totalLaps);
    if (best >= 4 && final != null && final - 3 >= 3 && end < totalLaps) {
      const where = final === starters ? 'last' : ord(final);
      facts.push(`${e.last} ran in the top 3 from lap ${start} to lap ${end}, then dropped to ${where}.`);
      break;
    }
  }
  return facts;
}
