import { describe, expect, it } from 'vitest';
import { describeRule, parseRule } from '../src/domain/rules.js';
import { OLYMPICS, WORLDS, WT1_2025, WT1_2026, tree } from './fixtures.js';

describe('parseRule', () => {
  it.each([
    ['The first and second placed skaters from each race and up to a maximum of five fastest third place skaters qualify for Semifinals.',
      { autoPlaces: 2, timeSpots: 5, timePlace: 3, destination: 'Semifinals' }],
    ['The first and second placed skaters from each race and up to a maximum of two fastest third place skater qualify for Final A. Remainder may qualify for Final B.',
      { autoPlaces: 2, timeSpots: 2, timePlace: 3, destination: 'Final A' }],
    ['The first placed skater from each race qualify for Quarterfinals.',
      { autoPlaces: 1, timeSpots: 0, timePlace: null, destination: 'Quarterfinals' }],
    ['The first and second placed skaters from each race and up to a maximum of one fastest third place skater qualify for Final, the third and fourth placed skaters from each race and up to a maximum of next two fastest fifth place skaters qualify for Final B.',
      { autoPlaces: 2, timeSpots: 1, timePlace: 3, destination: 'Final' }],
    ['The first and second placed teams from each race qualify for Final A, the third and fourth placed teams from each race qualify for Final B.',
      { autoPlaces: 2, timeSpots: 0, timePlace: null, destination: 'Final A' }],
    ['The first placed skater from each race and up to a maximum of four fastest second place skaters qualify for Rep Semifinals.',
      { autoPlaces: 1, timeSpots: 4, timePlace: 2, destination: 'Rep Semifinals' }],
    ['The first and second placed skaters from each race and up to a maximum of four fastest third place skaters qualify for Rep. Semifinals.',
      { autoPlaces: 2, timeSpots: 4, timePlace: 3, destination: 'Rep. Semifinals' }],
    ['The 2 best athletes in each Heat (Q) and the 4 fastest 3rd placed athletes (q) qualify for the quarterfinals.',
      { autoPlaces: 2, timeSpots: 4, timePlace: 3, destination: 'Quarterfinals' }],
    ['The 2 best athletes in each Semifinal (Q) and the fastest 3rd placed athlete (q) qualify for Final A. The next 5 athletes qualify for Final B.',
      { autoPlaces: 2, timeSpots: 1, timePlace: 3, destination: 'Final A' }],
    ['The 1st and 2nd teams in each Semifinal qualify for Final A and the 3rd and 4th teams qualify for Final B.',
      { autoPlaces: 2, timeSpots: 0, timePlace: null, destination: 'Final A' }],
    ['The first, second and third placed skaters from each race and up to a maximum of one fastest fourth place skater qualify for Quarterfinals.',
      { autoPlaces: 3, timeSpots: 1, timePlace: 4, destination: 'Quarterfinals' }],
    ['The 3 best athletes in each Quarterfinal (Q) and the 3 fastest 4th placed athletes (q) qualify for the semifinals.',
      { autoPlaces: 3, timeSpots: 3, timePlace: 4, destination: 'Semifinals' }],
    ['The first and second placed skaters from each race and up to a maximum of eleven fastest third place skaters qualify for Heats.',
      { autoPlaces: 2, timeSpots: 11, timePlace: 3, destination: 'Heats' }],
  ])('%s', (text, expected) => {
    expect(parseRule(text)).toEqual(expected);
  });

  it('returns null for empty or unknown text', () => {
    expect(parseRule('')).toBeNull();
    expect(parseRule(null)).toBeNull();
    expect(parseRule('Results are provisional.')).toBeNull();
  });

  it('parses every non-empty rule in the sample events', () => {
    const rules = [WT1_2026, WT1_2025, OLYMPICS, WORLDS].flatMap((slug) =>
      tree(slug).competitions.flatMap((c) => c.rounds.map((r) => r.qualification_rule ?? '').filter(Boolean)));
    expect(rules.length).toBeGreaterThan(50);
    expect(rules.filter((r) => !parseRule(r))).toEqual([]);
  });
});

describe('describeRule', () => {
  it('reads like the design', () => {
    expect(describeRule({ autoPlaces: 2, timeSpots: 5, timePlace: 3, destination: 'Semifinals' }))
      .toBe('Top 2 in each heat, plus the 5 fastest third places');
    expect(describeRule({ autoPlaces: 2, timeSpots: 1, timePlace: 3, destination: 'Final A' }))
      .toBe('Top 2 in each heat, plus the fastest third place');
    expect(describeRule({ autoPlaces: 1, timeSpots: 0, timePlace: null, destination: null }))
      .toBe('Winner of each heat');
  });
});
