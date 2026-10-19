import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng';
import { botAction, projectFor, reduce } from '../src';
import { newGame } from './helpers';

describe('bots', () => {
  it('all-bot games (seeing only their own projected view) finish for 4–12 players', () => {
    let rejected = 0;
    let finished = 0;
    for (let seed = 1; seed <= 45; seed++) {
      const n = 4 + (seed % 9);
      const rng = new Rng(seed * 31);
      const random = () => rng.next();
      let s = newGame(n, seed);
      for (let step = 0; step < 3000 && s.phase.kind !== 'game_over'; step++) {
        let moved = false;
        for (const id of s.seats) {
          const a = botAction(projectFor(s, id), random);
          if (!a) continue;
          const r = reduce(s, { actor: id, action: a });
          if (r.ok) {
            s = r.state;
            moved = true;
            break;
          }
          rejected++;
        }
        if (!moved) {
          const r = reduce(s, { actor: 'system', action: { type: 'TIMEOUT' } });
          expect(r.ok).toBe(true);
          if (r.ok) s = r.state;
        }
      }
      if (s.phase.kind === 'game_over') finished++;
    }
    expect(finished).toBe(45);
    // Bots should rarely produce invalid actions
    expect(rejected).toBeLessThan(200);
  });
});
