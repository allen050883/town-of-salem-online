import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng';
import { CARD_COLOR, conspiracyPickers, createGame, currentConstable, nextAlive, reduce, unrevealed, usesLeft } from '../src';
import type { Action, GameOptions, GameState, PlayerId } from '../src';
import { NAMES } from './helpers';

type Move = { actor: PlayerId; action: Action };

/** Phase-aware random bot: produce a few plausible actions for the current phase */
function botMoves(s: GameState, rng: Rng): Move[] {
  const alive = s.seats.filter((id) => s.players[id]!.alive);
  const any = () => rng.pick(alive);
  const ph = s.phase;
  switch (ph.kind) {
    case 'roles':
      return Object.keys(ph.offers)
        .filter((id) => !ph.picks[id])
        .map((id) => ({ actor: id, action: { type: 'PICK_ROLE', role: rng.pick(ph.offers[id]!) } }));
    case 'arrange': {
      const order = rng.shuffle(s.deck.filter((c) => c.type !== 'night').map((c) => c.id));
      return [{ actor: ph.player, action: { type: 'ARRANGE_DECK', order } }];
    }
    case 'salvage': {
      const sv = s.salvage[0]!;
      const ids = rng.shuffle(sv.cards.map((c) => c.id)).slice(0, rng.int(5));
      return [{ actor: sv.chooser, action: { type: 'SALVAGE', cardIds: ids } }];
    }
    case 'dawn':
      return alive.filter((id) => s.players[id]!.everWitch).map((id) => ({ actor: id, action: { type: 'DAWN_GIVE_CAT', target: any() } }));
    case 'turn': {
      const me = s.turn.player;
      const p = s.players[me]!;
      const moves: Move[] = [];
      if (s.turn.mode === 'idle' && usesLeft(s, me, 'tituba') > 0 && rng.next() < 0.3) moves.push({ actor: me, action: { type: 'ARRANGE_START' } });
      if (s.turn.mode === 'idle' && usesLeft(s, me, 'parris') > 0 && rng.next() < 0.3) {
        const ids = rng.shuffle(s.discard.filter((c) => CARD_COLOR[c.type] !== 'black').map((c) => c.id)).slice(0, 2);
        moves.push({ actor: me, action: { type: 'DRAW_DISCARD', cardIds: ids } });
      }
      if (s.turn.mode === 'idle' && rng.next() < 0.4) moves.push({ actor: me, action: { type: 'DRAW' } });
      if (s.turn.mode === 'playing' && rng.next() < 0.5) moves.push({ actor: me, action: { type: 'END_TURN' } });
      for (const c of rng.shuffle(p.hand).slice(0, 3)) {
        const target = any();
        const front = s.players[target]!.front;
        moves.push({
          actor: me,
          action: {
            type: 'PLAY_CARD',
            cardId: c.id,
            target,
            secondTarget: any(),
            targetCardId: front.length ? rng.pick(front).id : undefined,
            asWitness: rng.next() < 0.5,
          },
        });
      }
      moves.push({ actor: me, action: s.turn.mode === 'idle' ? { type: 'DRAW' } : { type: 'END_TURN' } });
      return moves;
    }
    case 'reveal':
      return [{ actor: ph.chooser, action: { type: 'CHOOSE_REVEAL', tryalId: rng.pick(unrevealed(s.players[ph.target]!)).id } }];
    case 'night': {
      if (ph.step === 'witches') {
        return alive.filter((id) => s.players[id]!.everWitch).map((id) => ({ actor: id, action: { type: 'WITCH_VOTE', target: any() } }));
      }
      if (ph.step === 'constable') {
        const c = currentConstable(s)!;
        return [{ actor: c.id, action: { type: 'CONSTABLE_GAVEL', target: any() } }];
      }
      return alive
        .filter((id) => !ph.passed.includes(id))
        .flatMap((id): Move[] => {
          const r = rng.next();
          if (r < 0.1 && usesLeft(s, id, 'phips') > 0) return [{ actor: id, action: { type: 'CONFESS' } }];
          return r < 0.15
            ? [{ actor: id, action: { type: 'CONFESS', tryalId: rng.pick(unrevealed(s.players[id]!)).id } }]
            : [{ actor: id, action: { type: 'NIGHT_PASS' } }];
        });
    }
    case 'conspiracy':
      return conspiracyPickers(s)
        .filter((id) => !ph.picks[id])
        .map((id) => ({ actor: id, action: { type: 'CONSPIRACY_PICK', tryalId: rng.pick(unrevealed(s.players[nextAlive(s, id)]!)).id } }));
    case 'game_over':
      return [];
  }
}

function playRandomGame(n: number, seed: number, options: GameOptions, maxSteps = 3000) {
  const rng = new Rng(seed * 7919);
  let s = createGame(
    NAMES.slice(0, n).map((id) => ({ id, name: id })),
    seed,
    options,
  );
  const totalCards = (st: GameState) =>
    st.deck.length +
    st.discard.length +
    st.removed.length +
    st.salvage.reduce((a, sv) => a + sv.cards.length, 0) +
    Object.values(st.players).reduce((a, p) => a + p.hand.length + p.front.length, 0);
  const cardCount = totalCards(s);
  for (let step = 0; step < maxSteps; step++) {
    if (s.phase.kind === 'game_over') return { state: s, steps: step };
    let moved = false;
    if (rng.next() > 0.03) {
      for (const m of botMoves(s, rng)) {
        const r = reduce(s, m);
        if (r.ok) {
          s = r.state;
          moved = true;
          break;
        }
      }
    }
    if (!moved) {
      const r = reduce(s, { actor: 'system', action: { type: 'TIMEOUT' } });
      if (!r.ok) throw new Error(`stuck in ${s.phase.kind}: ${r.error}`);
      s = r.state;
    }
    expect(totalCards(s)).toBe(cardCount);
  }
  return { state: s, steps: maxSteps };
}

describe('random simulation', () => {
  it('random full games for 4–12 players finish without errors, never deadlock, and conserve the card count', () => {
    const winners = { town: 0, witches: 0, unfinished: 0 };
    for (let seed = 1; seed <= 180; seed++) {
      const n = 4 + (seed % 9);
      // Alternate between the base game, Town Hall characters, and characters plus the extra witch
      const options = { roles: seed % 3 !== 0, extraWitch: seed % 3 === 2 };
      const { state } = playRandomGame(n, seed, options);
      if (state.phase.kind === 'game_over') winners[state.phase.winner]++;
      else winners.unfinished++;
    }
    console.log('simulation results', winners);
    expect(winners.unfinished).toBe(0);
  }, 120_000);
});
