import { DECK_COUNTS } from './cards';
import { Rng } from './rng';
import type { Card, CardType, GameState, Player, PlayerId, Tryal } from './types';

/** 5th edition rulebook setup table */
export const TRYAL_TABLE: Record<number, { notAWitch: number; witch: number; constable: number }> = {
  4: { notAWitch: 18, witch: 1, constable: 1 },
  5: { notAWitch: 23, witch: 1, constable: 1 },
  6: { notAWitch: 27, witch: 2, constable: 1 },
  7: { notAWitch: 32, witch: 2, constable: 1 },
  8: { notAWitch: 29, witch: 2, constable: 1 },
  9: { notAWitch: 33, witch: 2, constable: 1 },
  10: { notAWitch: 27, witch: 2, constable: 1 },
  11: { notAWitch: 30, witch: 2, constable: 1 },
  12: { notAWitch: 33, witch: 2, constable: 1 },
};

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 12;
export const STARTING_HAND = 3;

export interface SeatInput {
  id: PlayerId;
  name: string;
}

export function createGame(seats: SeatInput[], seed: number): GameState {
  const n = seats.length;
  const table = TRYAL_TABLE[n];
  if (!table) throw new Error(`Player count must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);

  const rng = new Rng(seed);

  let tid = 0;
  const tryals: Tryal[] = [];
  const addTryals = (kind: Tryal['kind'], count: number) => {
    for (let i = 0; i < count; i++) tryals.push({ id: `t${tid++}`, kind, revealed: false });
  };
  addTryals('witch', table.witch);
  addTryals('constable', table.constable);
  addTryals('not_a_witch', table.notAWitch);
  const shuffledTryals = rng.shuffle(tryals);
  const perPlayer = shuffledTryals.length / n;

  let cid = 0;
  const mk = (type: CardType): Card => ({ id: `c${cid++}`, type });
  const base: Card[] = [];
  for (const [type, count] of Object.entries(DECK_COUNTS) as [CardType, number][]) {
    for (let i = 0; i < count; i++) base.push(mk(type));
  }
  let deck = rng.shuffle(base);

  const players: Record<PlayerId, Player> = {};
  seats.forEach((s, i) => {
    const own = shuffledTryals.slice(i * perPlayer, (i + 1) * perPlayer);
    players[s.id] = {
      id: s.id,
      name: s.name,
      alive: true,
      tryals: own,
      hand: deck.slice(i * STARTING_HAND, (i + 1) * STARTING_HAND),
      front: [],
      everWitch: own.some((t) => t.kind === 'witch'),
    };
  });
  deck = deck.slice(n * STARTING_HAND);

  // Shuffle conspiracy back in, night at the bottom, black cat set aside (given out at dawn)
  deck = rng.shuffle([...deck, mk('conspiracy')]);
  deck.push(mk('night'));
  const blackCat = mk('black_cat');

  return {
    seats: seats.map((s) => s.id),
    players,
    deck,
    discard: [],
    // The black cat is parked in removed until dawn
    removed: [blackCat],
    phase: { kind: 'dawn', votes: {} },
    turn: { player: seats[0]!.id, mode: 'idle', drawsLeft: 0 },
    rng: rng.seed,
    seq: 0,
  };
}
