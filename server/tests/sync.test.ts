import { describe, expect, it } from 'vitest';
import { prioritizeRounds, type PollRound } from '../src/sync/worker.js';

const round = (id: number, hot: boolean, running = false): PollRound => ({
  id, hot, running, isu_id: id, comp_isu_id: id, is_relay: false,
});

describe('live sync priority', () => {
  it('puts a running heat ahead of all other ISU work', () => {
    const ordered = prioritizeRounds([
      round(1, false),
      round(2, true),
      round(3, true, true),
      round(4, true, true),
    ]);
    expect(ordered.map((r) => r.id)).toEqual([3, 4, 2, 1]);
  });
});
