import { createGame, reduce } from '../src';
import type { Action, Card, CardType, GameState, PlayerId, TryalKind } from '../src';

export const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

export function newGame(n = 4, seed = 1): GameState {
  return createGame(
    NAMES.slice(0, n).map((id) => ({ id, name: id })),
    seed,
  );
}

/** Force a player's tryals (for constructing test scenarios) */
export function setTryals(s: GameState, pid: PlayerId, kinds: TryalKind[]) {
  const p = s.players[pid]!;
  p.tryals = kinds.map((kind, i) => ({ id: `${pid}-t${i}`, kind, revealed: false }));
  p.everWitch = kinds.includes('witch');
}

let cardSeq = 0;
export function card(type: CardType): Card {
  return { id: `x${cardSeq++}`, type };
}

export function give(s: GameState, pid: PlayerId, ...types: CardType[]): Card[] {
  const cards = types.map(card);
  s.players[pid]!.hand.push(...cards);
  return cards;
}

/** Skip dawn: place the black cat in front of `holder` and start their turn */
export function skipDawn(s: GameState, holder: PlayerId = 'A'): GameState {
  let cur = s;
  for (const w of Object.values(cur.players).filter((p) => p.everWitch)) {
    cur = must(cur, w.id, { type: 'DAWN_GIVE_CAT', target: holder });
  }
  return cur;
}

export function must(s: GameState, actor: PlayerId | 'system', action: Action): GameState {
  const r = reduce(s, { actor, action });
  if (!r.ok) throw new Error(`${actor} ${JSON.stringify(action)}: ${r.error}`);
  return r.state;
}

export function fails(s: GameState, actor: PlayerId, action: Action): string {
  const r = reduce(s, { actor, action });
  if (r.ok) throw new Error(`expected failure: ${JSON.stringify(action)}`);
  return r.error;
}

/** Standard 4-player scenario: A is the witch, B is the constable, C and D are townsfolk; A holds the black cat and it's A's turn */
export function scenario(seed = 1): GameState {
  const s = newGame(4, seed);
  setTryals(s, 'A', ['witch', 'not_a_witch', 'not_a_witch']);
  setTryals(s, 'B', ['constable', 'not_a_witch', 'not_a_witch']);
  setTryals(s, 'C', ['not_a_witch', 'not_a_witch', 'not_a_witch']);
  setTryals(s, 'D', ['not_a_witch', 'not_a_witch', 'not_a_witch']);
  for (const p of Object.values(s.players)) p.hand = [];
  return skipDawn(s, 'A');
}
