import { describe, expect, it } from 'vitest';
import { list, medalNote, ordinal, result, upNext, type AlertRace } from '../src/domain/alerts.js';
import { shortCountry, statusCode } from '../src/domain/codes.js';
import { distanceLabel, medal, raceCodes, roundLabel, shortEventName, shownTime } from '../src/domain/format.js';
import { competitionName, genderName, heatName, heatState, normalizeEntries, roundName, titleName } from '../src/domain/normalize.js';
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

  it('spells each distance one way, gender first', () => {
    const cases: [string, string, boolean, string][] = [
      ['1000 m', 'Ladies', false, 'Women 1000 m'],
      ['1000 M', 'Men', false, 'Men 1000 m'],
      ['1000m (2)', 'Ladies', false, 'Women 1000 m (2)'],
      ['Ladies 500 m', 'Ladies', false, 'Women 500 m'],
      ['Women 500 m ', 'Ladies', false, 'Women 500 m'],
      ["Men's 1000m", 'Men', false, 'Men 1000 m'],
      ['Men 1000 m', 'Men', false, 'Men 1000 m'],
      ['1500 m SF', 'Men', false, 'Men 1500 m Superfinal'],
      ['1500 M Super Final', 'Ladies', false, 'Women 1500 m Superfinal'],
      ['Women 3000 m Superfinal', 'Ladies', false, 'Women 3000 m Superfinal'],
      ['3000m Relay', 'Ladies', true, 'Women 3000 m Relay'],
      ['Women Relay 3000 m', 'Women', true, 'Women 3000 m Relay'],
      ["Men's 5000m Relay", 'Men', true, 'Men 5000 m Relay'],
      ['2000 m Relay', 'Mixed', true, 'Mixed Team Relay'],
      ['Mixed Relay 2000 m', 'Mixed', true, 'Mixed Team Relay'],
    ];
    for (const [name, gender, relay, want] of cases) expect(competitionName(name, gender, relay)).toBe(want);
    expect(genderName('Ladies')).toBe('Women');
    expect(genderName('Mixed')).toBe('Mixed');
  });

  it('takes a heat as raced when it has results, whatever ISU calls it', () => {
    const raced = [{ final_rank: 1, final_result: '41.200', result_status: '' }] as never;
    const listed = [{ final_rank: null, final_result: 'no time', result_status: '' }] as never;
    const withdrawn = [{ final_rank: null, final_result: 'WDR', result_status: '' }] as never;
    const h = (status: string, result_status: string, event_result_round_heats_competitors: never) =>
      ({ status, result_status, event_result_round_heats_competitors });
    expect(heatState(h('Scheduled', '', raced))).toBe('unofficial');
    expect(heatState(h('Scheduled', '', raced), true)).toBe('official');
    expect(heatState(h('Scheduled', 'Start List', withdrawn), true)).toBe('official');
    expect(heatState(h('Scheduled', 'Start List', listed))).toBe('start_list');
    expect(heatState(h('Finished', 'Live', raced))).toBe('unofficial');
    expect(heatState(h('Live', 'Live', raced))).toBe('running');
    // Over is over: a race ISU has no results for shows them as "No time".
    expect(heatState(h('Scheduled', 'Start List', listed), true)).toBe('official');
    expect(heatState(h('Live', 'Live', raced), true)).toBe('official');
  });

  it('names unnamed heats after their round or their order', () => {
    expect(heatName('', 'Final A', 1, 1)).toBe('Final A');
    expect(heatName('', 'Finals', 1, 1)).toBe('Final');
    expect(heatName(' ', 'Quarterfinals', 2, 4)).toBe('Heat 2');
    expect(heatName('', 'Heats', 1, 1)).toBe('Heat 1');
    expect(heatName('Super Final', 'Final', 1, 1)).toBe('Super Final');
  });

  it('gives each skater in a race a three-letter code', () => {
    const skater = (name: string, last: string, nation: string | null = null) => ({ name, last, nation });
    expect(raceCodes([skater('Thomas Nadalini', 'Nadalini'), skater('Wonjun Moon', 'Moon')], false)).toEqual(['NAD', 'MOO']);
    expect(raceCodes([skater('Jens Van \'t Wout', 'Van \'t Wout'), skater('Melle Van \'t Wout', 'Van \'t Wout'), skater('Sébastien Lepape', 'Lepape')], false))
      .toEqual(['VAN J', 'VAN M', 'LEP']);
    expect(raceCodes([skater('Netherlands', 'Netherlands', 'NED'), skater('Canada', 'Canada', 'CAN')], true)).toEqual(['NED', 'CAN']);
  });

  it('says "No time" only for a race that is over', () => {
    expect(shownTime('40.064', null, 'official')).toBe('40.064');
    expect(shownTime(null, null, 'official')).toBe('No time');
    expect(shownTime(null, 'PEN', 'official')).toBeNull();
    expect(shownTime(null, null, 'start_list')).toBeNull();
  });

  it('reads outcomes written in the time field', () => {
    expect(statusCode('', 'WDR')).toBe('WDR');
    expect(statusCode('', 'DQ')).toBe('PEN');
    expect(statusCode('Did Not Start', '')).toBe('DNS');
    expect(statusCode('', '1:24.537')).toBeNull();
  });

  it('spells out abbreviated rounds', () => {
    expect(roundName('REPQ')).toBe('Rep. Quarterfinals');
    expect(roundName('HEAS')).toBe('Heats');
    expect(roundName('Rep Semifinals')).toBe('Rep. Semifinals');
    expect(roundName('Rep. Heats')).toBe('Rep. Heats');
    expect(roundName('Final A')).toBe('Final A');
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
    expect(isConnectionError(new Error('Query read timeout'))).toBe(true);
    expect(isConnectionError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isConnectionError(new Error('null value in column "distance" violates not-null constraint'))).toBe(false);
  });
});

describe('favorite alerts', () => {
  const race = (heat: string, round: string, destination: string | null = null): AlertRace => ({
    competition: 'Women 1000 m', distanceM: 1000, round, heat, destination, event: 'World Tour #1, Vancouver',
  });
  const skater = (name: string, rank: number | null, time: string | null, qualification: string | null = null, status: string | null = null) =>
    ({ name, last: name.split(' ').slice(1).join(' '), rank, time, status, qualification });

  it('says who is up next', () => {
    expect(upNext(race('Final', 'Finals'), [skater('Courtney Sarault', null, null)])).toEqual({
      title: 'Courtney Sarault is up next', body: 'Women 1000 m Final · World Tour #1, Vancouver',
    });
    expect(upNext(race('Heat 2', 'Semifinals', 'Final A'), [skater('Xandra Velzeboer', null, null), skater('Gilli Kim', null, null), skater('Courtney Sarault', null, null)]))
      .toEqual({ title: 'Velzeboer, Kim and Sarault are up next', body: 'Women 1000 m Semifinal, Heat 2 · World Tour #1, Vancouver' });
  });

  it('gives one skater’s result', () => {
    expect(result(race('Final', 'Finals'), [skater('Minjeong Choi', 1, '1:32.954')]))
      .toEqual({ title: 'Minjeong Choi won the 1000 m Final', body: '1:32.954 · Women 1000 m · World Tour #1, Vancouver' });
    expect(result(race('Final', 'Finals'), [skater('Gilli Kim', 5, '1:33.678')]).title).toBe('Gilli Kim 5th in the 1000 m Final');
    expect(result(race('Final B', 'Finals'), [skater('Courtney Sarault', 1, '1:33.415')]).title).toBe('Courtney Sarault 1st in the 1000 m Final B');
    expect(result(race('Heat 3', 'Quarterfinals', 'Semifinals'), [skater('Xandra Velzeboer', 1, '1:32.294', 'Q')]))
      .toEqual({ title: 'Xandra Velzeboer 1st in Quarterfinal, Heat 3', body: '1:32.294 · Qualified for the semifinals · Women 1000 m' });
    expect(result(race('Heat 2', 'Semifinals', 'Final A'), [skater('Courtney Sarault', 3, '1:31.488', 'QB')]).body)
      .toBe('1:31.488 · Qualified for Final B · Women 1000 m');
    expect(result(race('Heat 5', 'Rep. Quarterfinals'), [skater('Gilli Kim', null, 'DNS', null, 'DNS')]))
      .toEqual({ title: 'Gilli Kim did not start', body: 'Women 1000 m Rep. Quarterfinal, Heat 5 · World Tour #1, Vancouver' });
  });

  it('puts several favorites in one race in one alert', () => {
    expect(result(race('Heat 2', 'Semifinals', 'Finals'), [
      skater('Courtney Sarault', 3, '1:31.488', 'QB'), skater('Xandra Velzeboer', 1, '1:31.289', 'Q'), skater('Gilli Kim', 2, '1:31.388', 'Q'),
    ])).toEqual({
      title: 'Velzeboer 1st, Kim 2nd, Sarault 3rd',
      body: 'Velzeboer and Kim qualified for the final, Sarault for Final B · Women 1000 m Semifinal, Heat 2',
    });
  });

  it('writes ordinals, lists and medal notes', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
    expect(list(['A', 'B', 'C'])).toBe('A, B and C');
    expect(medalNote([{ place: 1, distanceM: 1500 }, { place: 1, distanceM: 500 }, { place: 1, distanceM: 1000 }])).toBe('Gold 500, 1000 and 1500 m');
    expect(medalNote([{ place: 2, distanceM: 500 }, { place: 1, distanceM: 1500 }])).toBe('Gold 1500 m, silver 500 m');
  });
});
