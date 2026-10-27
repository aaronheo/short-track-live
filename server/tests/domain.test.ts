import { describe, expect, it } from 'vitest';
import { shortCountry } from '../src/domain/codes.js';
import { distanceLabel, medal, roundLabel, shortEventName } from '../src/domain/format.js';
import { normalizeEntries, titleName } from '../src/domain/normalize.js';
import { placesCard } from '../src/domain/places.js';
import { parseRule } from '../src/domain/rules.js';
import { summarize } from '../src/domain/summary.js';
import { isConnectionError } from '../src/sync/worker.js';
import { clock, dayLabel, lapsFor, localWallClockToUtc, millis, venueTimeZone, weekdayMonthDay } from '../src/domain/time.js';
import { WORLDS, WT1_2026, placeHeats, round, tree } from './fixtures.js';

describe('time', () => {
  it('turns ISU heat dates (local time with a fake Z) into real UTC', () => {
    // WT1 Vancouver: Women 500 m Heats, Heat 1 is "13:16:55Z"; it ran at 20:16:55 UTC (PDT = UTC-7).
    expect(localWallClockToUtc('2026-10-23T13:16:55.000Z', 'America/Los_Angeles')?.toISOString())
      .toBe('2026-10-23T20:16:55.000Z');
    // Across a DST change (Montréal, first Sunday of November).
    expect(localWallClockToUtc('2026-11-01T12:00:00.000Z', 'America/Toronto')?.toISOString())
      .toBe('2026-11-01T17:00:00.000Z');
  });

  it('decides venue time zones instead of trusting ISU', () => {
    expect(venueTimeZone('Montréal', 'CAN', 'America/Halifax')).toBe('America/Toronto');
    expect(venueTimeZone('Salt Lake City', 'USA', 'America/Chicago')).toBe('America/Denver');
    expect(venueTimeZone('Shanghai', 'CHN', 'UTC')).toBe('Asia/Shanghai');
    expect(venueTimeZone('Astana', 'KAZ', 'Asia/Qyzylorda')).toBe('Asia/Qyzylorda');
  });

  it('formats venue times', () => {
    const d = new Date('2026-10-23T23:41:00Z');
    expect(clock(d, 'America/Los_Angeles')).toBe('16:41');
    expect(dayLabel(d, 'America/Los_Angeles')).toBe('Fri 23');
    expect(weekdayMonthDay(d, 'America/Los_Angeles')).toBe('Fri Oct 23');
  });

  it('parses race times', () => {
    expect(millis('1:24.537')).toBe(84537);
    expect(millis('42.888')).toBe(42888);
    expect(millis('+0.520')).toBe(520);
    expect(millis('PEN')).toBeNull();
    expect(millis('no time')).toBeNull();
    expect(lapsFor(1500)).toBe(14);
    expect(lapsFor(500)).toBe(5);
  });
});

describe('normalize', () => {
  it('drops a skater ISU lists twice in one heat, keeping the ranked entry', () => {
    const { rnd } = round(tree(WT1_2026), 'Women 500 m', 'Heats');
    const heat5 = rnd.heats.find((h) => h.name === 'Heat 5')!;
    const raw = heat5.event_result_round_heats_competitors!;
    expect(raw.filter((c) => c.skaters?.last_name === 'BETTI')).toHaveLength(2);
    const betti = normalizeEntries(raw).filter((e) => e.last === 'Betti');
    expect(betti).toHaveLength(1);
    expect(betti[0]!.rank).toBe(2);
  });

  it('shortens event names for the app', () => {
    expect(shortEventName('ISU Short Track World Tour #1')).toBe('World Tour #1');
    expect(shortEventName('ISU CNSG Short Track World Championships')).toBe('World Championships');
    expect(shortEventName('Olympic Winter Games 2026 Short Track Speed Skating')).toBe('Olympic Winter Games 2026');
  });

  it('shortens formal country names for relay teams', () => {
    expect(shortCountry("People's Republic of China")).toBe('China');
    expect(shortCountry('Republic of Korea')).toBe('Korea');
    expect(shortCountry('Canada')).toBe('Canada');
  });

  it('title-cases ISU surnames', () => {
    expect(titleName("VAN 'T WOUT")).toBe("Van 't Wout");
    expect(titleName('GAGNON-LAMARCHE')).toBe('Gagnon-Lamarche');
    expect(titleName('Sighel')).toBe('Sighel');
  });
});

describe('places card', () => {
  it('matches the design for the live Men 1500 m quarterfinal', () => {
    const { rnd } = round(tree(WT1_2026), 'Men 1500 m', 'Quarterfinals');
    const card = placesCard(parseRule(rnd.qualification_rule), placeHeats(rnd), rnd.heats.length)!;
    expect(card.title).toBe('Semifinal places');
    expect(card.qualified).toMatchObject({ count: 8, total: 14 });
    expect(card.qualified.skaters.map((s) => s.last)).toEqual(['Nadalini', 'Lee', 'Treacy', 'Miyata', 'Roussel', 'Bae', 'Rim', 'Shin']);
    expect(card.time).toMatchObject({ label: 'Fastest third places', filled: 4, total: 5, note: '1 spot open' });
    expect(card.time!.rows.map((r) => [r.kind, r.last ?? null, r.time ?? null])).toEqual([
      ['in', 'Niewinski', '2:17.547'], ['in', 'Moon', '2:19.364'], ['in', "Van 't Wout", '2:25.831'],
      ['in', 'Zhang', '2:28.045'], ['open', null, null],
    ]);
  });

  it('counts an advanced skater against the time spots (Worlds 2026 Men 1000 m QF)', () => {
    const { rnd } = round(tree(WORLDS), 'Men 1000 m', 'Quarterfinals');
    const card = placesCard(parseRule(rnd.qualification_rule), placeHeats(rnd), rnd.heats.length)!;
    expect(card.qualified).toMatchObject({ count: 8, total: 8 });
    expect(card.time).toMatchObject({ filled: 2, total: 2, note: 'Round finished' });
    expect(card.time!.rows.map((r) => [r.kind, r.last, r.badge ?? null])).toEqual([
      ['advanced', 'De Clemente', 'ADV'], ['in', 'Roussel', 'q'],
      ['out', 'Previtali', null], ['out', 'Shin', null], ['out', "Van 't Wout", null],
    ]);
  });
});

describe('race summary', () => {
  it('describes Men 1500 m QF Heat 1 the way the design does', () => {
    const { rnd } = round(tree(WT1_2026), 'Men 1500 m', 'Quarterfinals');
    const entries = normalizeEntries(rnd.heats.find((h) => h.name === 'Heat 1')!.event_result_round_heats_competitors)
      .map((e) => ({ last: e.last, rank: e.rank, laps: e.laps.map((l) => ({ lap: l.lap, pos: l.pos, lapMs: l.lapMs })) }));
    expect(summarize(entries)).toEqual([
      'Nadalini took the lead on lap 8 and led the last 7 laps.',
      'Moon was 7th with 4 laps to go and finished 3rd.',
      'Fastest lap: Nadalini, 8.64 s on lap 8.',
      'Bozdag ran in the top 3 from lap 2 to lap 11, then dropped to last.',
    ]);
  });
});

describe('athlete race labels', () => {
  it('names the distance the same way at every event', () => {
    expect(distanceLabel('Men 1000 m', 1000, false)).toBe('1000 m');
    expect(distanceLabel("Men's 1000m", 1000, false)).toBe('1000 m');
    expect(distanceLabel('Men 5000 m Relay', 5000, true)).toBe('5000 m Relay');
    expect(distanceLabel("Women's 3000m Relay", 3000, true)).toBe('3000 m Relay');
    expect(distanceLabel('Mixed Team Relay', 2000, true)).toBe('Mixed Team Relay');
  });

  it('says which race of the round it was', () => {
    expect(roundLabel('Finals', 'Final A')).toBe('Final A');
    expect(roundLabel('Finals', 'Final')).toBe('Final');
    expect(roundLabel('Heats', 'Heat 4')).toBe('Heat 4');
    expect(roundLabel('Semifinals', 'Heat 1')).toBe('Semifinal · Heat 1');
    expect(roundLabel('Rep. Quarterfinals', 'Heat 2')).toBe('Rep. Quarterfinal · Heat 2');
    expect(roundLabel('Preliminaries', 'Heat 5')).toBe('Preliminary · Heat 5');
    expect(roundLabel('Semifinals', 'Semifinal 2')).toBe('Semifinal 2');
  });

  it('counts podiums in A finals only', () => {
    expect(medal('Final A', 2)).toBe(2);
    expect(medal('Final', 1)).toBe(1);
    expect(medal('Final B', 1)).toBeNull();
    expect(medal('Final A', 4)).toBeNull();
    expect(medal('Heat 1', 1)).toBeNull();
  });
});

describe('sync retries', () => {
  it('tells a dropped database connection from bad data', () => {
    expect(isConnectionError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionError(new Error('Client has encountered a connection error and is not queryable'))).toBe(true);
    expect(isConnectionError(new Error('null value in column "distance" violates not-null constraint'))).toBe(false);
  });
});
