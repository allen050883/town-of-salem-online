import { describe, expect, it } from 'vitest';
import { accusationTotal, createGame, effectiveRole, projectFor } from '../src';
import type { GameState, PlayerId, RoleId } from '../src';
import { NAMES, card, fails, give, must, scenario, setTryals } from './helpers';

function withRoles(s: GameState, roles: Partial<Record<PlayerId, RoleId>>): GameState {
  for (const [pid, role] of Object.entries(roles)) s.players[pid]!.role = role!;
  return s;
}

function toNight(s: GameState) {
  s.deck = [card('night')];
  s.discard = [card('accusation')];
  return must(s, s.turn.player, { type: 'DRAW' });
}

describe('character setup', () => {
  it('up to 7 players are offered 2 characters and keep 1; the rest are dealt 1', () => {
    const seats = (n: number) => NAMES.slice(0, n).map((id) => ({ id, name: id }));
    let s = createGame(seats(5), 1, { roles: true, extraWitch: false });
    expect(s.phase.kind).toBe('roles');
    const offers = s.phase.kind === 'roles' ? s.phase.offers : {};
    expect(Object.values(offers).every((o) => o.length === 2)).toBe(true);
    expect(fails(s, 'A', { type: 'PICK_ROLE', role: offers.B![0]! })).toBeTruthy();
    for (const id of s.seats) s = must(s, id, { type: 'PICK_ROLE', role: offers[id]![1]! });
    expect(s.phase.kind).toBe('dawn');
    expect(s.players.C!.role).toBe(offers.C![1]);

    const big = createGame(seats(9), 1, { roles: true, extraWitch: false });
    expect(big.phase.kind).toBe('dawn');
    const roles = Object.values(big.players).map((p) => p.role);
    expect(new Set(roles).size).toBe(9);
  });

  it('the extra-witch variant adds one Witch card', () => {
    const s = createGame(NAMES.slice(0, 6).map((id) => ({ id, name: id })), 2, { roles: false, extraWitch: true });
    const all = Object.values(s.players).flatMap((p) => p.tryals);
    expect(all.filter((t) => t.kind === 'witch')).toHaveLength(3);
    expect(all).toHaveLength(30);
  });

  it('roles are public; characters time out to the first offer', () => {
    let s = createGame(NAMES.slice(0, 4).map((id) => ({ id, name: id })), 3, { roles: true, extraWitch: false });
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(projectFor(s, 'B').players.A!.role).toBe(s.players.A!.role);
  });
});

describe('accusation characters', () => {
  it('Cotton Mather: evidence on him counts 1', () => {
    const s = withRoles(scenario(), { C: 'cotton' });
    s.players.C!.front.push(card('evidence'), card('accusation'));
    expect(accusationTotal(s.players.C!, s)).toBe(2);
  });

  it('George Burroughs: needs 8 points', () => {
    let s = withRoles(scenario(), { C: 'george' });
    s.players.C!.front.push(card('evidence'), card('evidence'));
    const [a, b] = give(s, 'A', 'accusation', 'accusation');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: a!.id, target: 'C' });
    expect(s.phase.kind).toBe('turn');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: b!.id, target: 'C' });
    expect(s.phase.kind).toBe('reveal');
  });

  it('Thomas Danforth: his accusations trigger a trial at 6', () => {
    let s = withRoles(scenario(), { A: 'danforth' });
    s.players.C!.front.push(card('evidence'), card('accusation'), card('accusation'));
    const [a] = give(s, 'A', 'accusation');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: a!.id, target: 'C' });
    expect(s.phase).toMatchObject({ kind: 'reveal', chooser: 'A' });
  });

  it('Will Griggs: an Alibi can be played as a 7-point Witness; others cannot', () => {
    let s = withRoles(scenario(), { A: 'griggs' });
    const [al] = give(s, 'A', 'alibi');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: al!.id, target: 'C', asWitness: true });
    expect(s.phase).toMatchObject({ kind: 'reveal', target: 'C' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'C-t0' });
    // The alibi is discarded as a plain card again
    expect(s.discard.find((c) => c.id === al!.id)?.as).toBeUndefined();

    const t = scenario();
    const [al2] = give(t, 'A', 'alibi');
    t.players.C!.front.push(card('accusation'));
    expect(fails(t, 'A', { type: 'PLAY_CARD', cardId: al2!.id, target: 'C', asWitness: true })).toMatch('醫生');
  });

  it('Abigail Williams: her own red cards are discarded after a trial she started', () => {
    let s = withRoles(scenario(), { A: 'abigail' });
    s.players.A!.front.push(card('evidence'), card('accusation'));
    const [w] = give(s, 'A', 'witness');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'C' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'C-t0' });
    expect(accusationTotal(s.players.A!)).toBe(0);
  });

  it('Ann Putnam: draws 2 when she starts a trial, skipping black cards', () => {
    let s = withRoles(scenario(), { A: 'ann' });
    s.deck = [card('conspiracy'), card('arson'), card('alibi'), card('accusation'), card('night')];
    const [w] = give(s, 'A', 'witness');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'C' });
    expect(s.players.A!.hand.map((c) => c.type).sort()).toEqual(['alibi', 'arson']);
    expect(s.deck.some((c) => c.type === 'conspiracy')).toBe(true);
    expect(s.deck.at(-1)!.type).toBe('night');
  });

  it('Rebecca Nurse: draws 1 when someone else is revealed by a trial', () => {
    let s = withRoles(scenario(), { D: 'rebecca' });
    s.deck = [card('arson'), card('night')];
    const [w] = give(s, 'A', 'witness');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'C' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'C-t0' });
    expect(s.players.D!.hand.map((c) => c.type)).toEqual(['arson']);
  });
});

describe('drawing characters', () => {
  it('Giles Corey: two accusations in one draw give a third card', () => {
    let s = withRoles(scenario(), { A: 'giles' });
    s.deck = [card('accusation'), card('accusation'), card('alibi'), card('arson'), card('night')];
    s = must(s, 'A', { type: 'DRAW' });
    expect(s.players.A!.hand.map((c) => c.type)).toEqual(['accusation', 'accusation', 'alibi']);
    expect(s.turn.player).toBe('B');
  });

  it('Samuel Parris: takes up to 2 non-black cards from the discard pile, twice per game', () => {
    let s = withRoles(scenario(), { A: 'parris', B: 'parris' });
    const keep = [card('witness'), card('arson')];
    s.discard = [...keep, card('accusation'), card('conspiracy')];
    expect(fails(s, 'A', { type: 'DRAW_DISCARD', cardIds: [s.discard[3]!.id] })).toBeTruthy();
    s = must(s, 'A', { type: 'DRAW_DISCARD', cardIds: keep.map((c) => c.id) });
    expect(s.players.A!.hand.map((c) => c.type)).toEqual(['witness', 'arson']);
    expect(s.turn.player).toBe('B');
    expect(projectFor(s, 'A').myAbilities.parris).toBe(1);
    s.players.A!.uses.parris = 2;
    expect(projectFor(s, 'A').myAbilities.parris).toBeUndefined();
  });

  it('Tituba: sees and rearranges the deck (night stays at the bottom), then draws', () => {
    let s = withRoles(scenario(), { A: 'tituba' });
    const [x, y, z] = [card('arson'), card('witness'), card('alibi')];
    s.deck = [x!, y!, z!, card('night')];
    s = must(s, 'A', { type: 'ARRANGE_START' });
    const view = projectFor(s, 'A').phase;
    expect(view.kind === 'arrange' && view.deck?.length).toBe(3);
    const other = projectFor(s, 'B').phase;
    expect(other.kind === 'arrange' && other.deck).toBe(null);
    s = must(s, 'A', { type: 'ARRANGE_DECK', order: [y!.id, z!.id, x!.id] });
    expect(s.players.A!.hand.map((c) => c.type)).toEqual(['witness', 'alibi']);
    expect(s.deck.map((c) => c.type)).toEqual(['arson', 'night']);
    expect(s.turn.player).toBe('B');
    s.turn.player = 'A';
    s.turn.mode = 'idle';
    expect(fails(s, 'A', { type: 'ARRANGE_START' })).toBeTruthy();
  });
});

describe('protective characters', () => {
  it('Sarah Good: Arson and Robbery do not work on her', () => {
    const s = withRoles(scenario(), { C: 'sarah' });
    const [ar, rb] = give(s, 'A', 'arson', 'robbery');
    expect(fails(s, 'A', { type: 'PLAY_CARD', cardId: ar!.id, target: 'C' })).toMatch('無效');
    expect(fails(s, 'A', { type: 'PLAY_CARD', cardId: rb!.id, target: 'C', secondTarget: 'D' })).toMatch('無效');
  });

  it('Mary Warren: Matchmaker does not link her', () => {
    let s = withRoles(scenario(), { D: 'mary' });
    s.players.C!.front.push(card('matchmaker'));
    s.players.D!.front.push(card('matchmaker'));
    setTryals(s, 'C', ['not_a_witch']);
    const [w] = give(s, 'A', 'witness');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'C' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'C-t0' });
    expect(s.players.C!.alive).toBe(false);
    expect(s.players.D!.alive).toBe(true);
  });

  it('Mary Warren: the black cat does not reveal her card on a conspiracy', () => {
    let s = withRoles(scenario(), { A: 'mary' });
    s.deck = [card('conspiracy'), card('accusation'), card('night')];
    s = must(s, 'A', { type: 'DRAW' });
    expect(s.phase.kind).toBe('conspiracy');
    expect(s.players.A!.tryals.every((t) => !t.revealed)).toBe(true);
  });

  it('William Phips: once per game confesses without revealing and survives', () => {
    let s = withRoles(scenario(), { C: 'phips' });
    s = toNight(s);
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    s = must(s, 'B', { type: 'CONSTABLE_GAVEL', target: 'D' });
    expect(fails(s, 'D', { type: 'CONFESS' })).toBeTruthy();
    s = must(s, 'C', { type: 'CONFESS' });
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(s.players.C!.alive).toBe(true);
    expect(s.players.C!.tryals.every((t) => !t.revealed)).toBe(true);
    expect(s.players.C!.uses.phips).toBe(1);
  });
});

describe('John Proctor', () => {
  it('picks up to 3 cards from a dead player, the rest are discarded, then play resumes', () => {
    let s = withRoles(scenario(), { D: 'proctor' });
    setTryals(s, 'C', ['not_a_witch']);
    const loot = give(s, 'C', 'witness', 'arson', 'alibi', 'curse');
    const [w] = give(s, 'A', 'witness');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'C' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'C-t0' });
    expect(s.phase.kind).toBe('salvage');
    const others = projectFor(s, 'B').phase;
    expect(others.kind === 'salvage' && others.cards).toBe(null);
    expect(fails(s, 'D', { type: 'SALVAGE', cardIds: loot.map((c) => c.id) })).toMatch('3');
    expect(fails(s, 'A', { type: 'END_TURN' })).toBeTruthy();
    s = must(s, 'D', { type: 'SALVAGE', cardIds: [loot[0]!.id, loot[1]!.id] });
    expect(s.players.D!.hand.map((c) => c.type)).toEqual(['witness', 'arson']);
    expect(s.discard.some((c) => c.id === loot[3]!.id)).toBe(true);
    expect(s.phase.kind).toBe('turn');
    expect(s.turn.player).toBe('A');
    s = must(s, 'A', { type: 'END_TURN' });
  });

  it('a night death interrupts the night resolution and play continues afterwards', () => {
    let s = withRoles(scenario(), { D: 'proctor' });
    give(s, 'C', 'witness');
    s = toNight(s);
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    s = must(s, 'B', { type: 'CONSTABLE_GAVEL', target: 'D' });
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(s.players.C!.alive).toBe(false);
    expect(s.phase).toMatchObject({ kind: 'salvage', resume: { kind: 'turn' } });
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(s.players.D!.hand.map((c) => c.type)).toEqual(['witness']);
    expect(s.phase.kind).toBe('turn');
  });
});

describe('Martha Corey', () => {
  it('copies the first living player on her right, and follows deaths', () => {
    const s = withRoles(scenario(), { A: 'george', B: 'cotton', C: 'martha', D: 'sarah' });
    // C's right is B
    expect(effectiveRole(s, 'C')).toBe('cotton');
    s.players.B!.alive = false;
    expect(effectiveRole(s, 'C')).toBe('george');
  });
});
