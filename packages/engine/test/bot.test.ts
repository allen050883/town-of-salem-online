import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng';
import { botAction, createGame, projectFor, reduce, waitingOn } from '../src';
import type { GameState } from '../src';
import { NAMES, card, give, scenario } from './helpers';

/** Play a whole game with bots in every seat, each deciding from its own view only */
function botGame(n: number, seed: number, roles: boolean) {
  const rng = new Rng(seed * 31);
  const rand = () => rng.next();
  let s: GameState = createGame(
    NAMES.slice(0, n).map((id) => ({ id, name: id })),
    seed,
    { roles, extraWitch: false },
  );
  let actions = 0;
  let rejected = 0;
  let timeouts = 0;
  for (let i = 0; i < 4000 && s.phase.kind !== 'game_over'; i++) {
    let moved = false;
    for (const pid of waitingOn(s)) {
      const a = botAction(projectFor(s, pid), rand);
      if (!a) continue;
      const r = reduce(s, { actor: pid, action: a });
      if (r.ok) {
        s = r.state;
        actions++;
        moved = true;
        break;
      }
      rejected++;
    }
    if (!moved) {
      s = (reduce(s, { actor: 'system', action: { type: 'TIMEOUT' } }) as { state: GameState }).state;
      timeouts++;
    }
  }
  return { s, actions, rejected, timeouts };
}

describe('computer players', () => {
  it('finish full games for 4–12 players, rarely get rejected, and almost never need the timer', () => {
    let actions = 0;
    let rejected = 0;
    let timeouts = 0;
    const winners = { town: 0, witches: 0 };
    for (let seed = 1; seed <= 72; seed++) {
      const n = 4 + (seed % 9);
      const g = botGame(n, seed, seed % 2 === 0);
      expect(g.s.phase.kind).toBe('game_over');
      if (g.s.phase.kind === 'game_over') winners[g.s.phase.winner]++;
      actions += g.actions;
      rejected += g.rejected;
      timeouts += g.timeouts;
    }
    console.log('bot games', { winners, actions, rejected, timeouts });
    expect(rejected / actions).toBeLessThan(0.02);
    expect(timeouts).toBe(0);
    // Both sides can win
    expect(winners.town).toBeGreaterThan(0);
    expect(winners.witches).toBeGreaterThan(0);
  }, 120_000);

  it('a witch bot never accuses a fellow witch and finishes a trial when it can', () => {
    const s = scenario();
    s.players.C!.everWitch = true; // A and C are witches
    s.players.D!.front.push(card('evidence'), card('evidence'));
    give(s, 'A', 'evidence');
    const a = botAction(projectFor(s, 'A'), () => 0.5);
    expect(a).toMatchObject({ type: 'PLAY_CARD', target: 'D' });
  });

  it('a bot never reveals its own Witch card when the black cat is on it', () => {
    let s = scenario();
    s.deck = [card('conspiracy'), card('accusation'), card('night')];
    s = (reduce(s, { actor: 'A', action: { type: 'DRAW' } }) as { state: GameState }).state;
    for (let i = 0; i < 20; i++) {
      const a = botAction(projectFor(s, 'A'), Math.random);
      expect(a).toMatchObject({ type: 'CHOOSE_REVEAL' });
      expect(a && a.type === 'CHOOSE_REVEAL' && a.tryalId).not.toBe('A-t0');
    }
  });
});
