import { describe, expect, it } from 'vitest';
import { TRYAL_TABLE, accusationTotal, projectFor } from '../src';
import { card, fails, give, must, newGame, scenario, setTryals, skipDawn } from './helpers';

describe('setup', () => {
  it.each(Object.keys(TRYAL_TABLE).map(Number))('%i players: tryal counts and starting hands are correct', (n) => {
    const s = newGame(n, n);
    const t = TRYAL_TABLE[n]!;
    const all = Object.values(s.players).flatMap((p) => p.tryals);
    expect(all.length).toBe(t.notAWitch + t.witch + t.constable);
    expect(all.filter((x) => x.kind === 'witch').length).toBe(t.witch);
    const per = all.length / n;
    for (const p of Object.values(s.players)) {
      expect(p.tryals.length).toBe(per);
      expect(p.hand.length).toBe(3);
      expect(p.hand.every((c) => c.type !== 'night' && c.type !== 'conspiracy')).toBe(true);
    }
    expect(s.deck.at(-1)!.type).toBe('night');
    expect(s.deck.filter((c) => c.type === 'conspiracy').length).toBe(1);
  });

  it('at dawn the witches give out the black cat, and the holder goes first', () => {
    const s = skipDawn(newGame(4, 3), 'C');
    expect(s.players.C!.front.some((c) => c.type === 'black_cat')).toBe(true);
    expect(s.phase.kind).toBe('turn');
    expect(s.turn.player).toBe('C');
  });
});

describe('accusations and reveals', () => {
  it('7 accusations trigger a reveal; afterwards red cards are cleared and overflow does not carry over', () => {
    let s = scenario();
    const [w] = give(s, 'A', 'witness');
    s.players.C!.front.push(card('evidence'));
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'C' });
    expect(s.phase).toMatchObject({ kind: 'reveal', chooser: 'A', target: 'C' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'C-t0' });
    expect(s.players.C!.tryals[0]!.revealed).toBe(true);
    expect(accusationTotal(s.players.C!)).toBe(0);
    expect(s.phase.kind).toBe('turn');
    expect(s.turn.mode).toBe('playing');
  });

  it('revealing a Witch card kills that player; when every Witch card is revealed, the town wins', () => {
    let s = scenario();
    s.turn.player = 'B';
    const [w] = give(s, 'B', 'witness');
    s = must(s, 'B', { type: 'PLAY_CARD', cardId: w!.id, target: 'A' });
    s = must(s, 'B', { type: 'CHOOSE_REVEAL', tryalId: 'A-t0' });
    expect(s.players.A!.alive).toBe(false);
    expect(s.phase).toEqual({ kind: 'game_over', winner: 'town' });
  });

  it('cannot play on yourself; cannot play red cards on a player with Piety', () => {
    const s = scenario();
    const [a, b] = give(s, 'A', 'accusation', 'accusation');
    expect(fails(s, 'A', { type: 'PLAY_CARD', cardId: a!.id, target: 'A' })).toMatch('自己');
    s.players.C!.front.push(card('piety'));
    expect(fails(s, 'A', { type: 'PLAY_CARD', cardId: b!.id, target: 'C' })).toMatch('信徒');
  });

  it('cannot draw after playing a card; cannot end the turn before playing or drawing', () => {
    let s = scenario();
    expect(fails(s, 'A', { type: 'END_TURN' })).toBeTruthy();
    const [a] = give(s, 'A', 'accusation');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: a!.id, target: 'C' });
    expect(fails(s, 'A', { type: 'DRAW' })).toBeTruthy();
    s = must(s, 'A', { type: 'END_TURN' });
    expect(s.turn.player).toBe('B');
  });

  it('Alibi removes up to 3 accusations', () => {
    let s = scenario();
    s.players.C!.front.push(card('accusation'), card('accusation'), card('accusation'), card('accusation'));
    const [al] = give(s, 'A', 'alibi');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: al!.id, target: 'C' });
    expect(accusationTotal(s.players.C!)).toBe(1);
  });

  it('Scapegoat moves red and blue cards and can trigger a reveal', () => {
    let s = scenario();
    s.players.C!.front.push(card('witness'));
    s.players.C!.front.pop();
    s.players.C!.front.push(card('evidence'), card('evidence'), card('asylum'));
    s.players.D!.front.push(card('accusation'));
    const [sg] = give(s, 'A', 'scapegoat');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: sg!.id, target: 'C', secondTarget: 'D' });
    expect(s.players.C!.front).toHaveLength(0);
    expect(s.players.D!.front.some((c) => c.type === 'asylum')).toBe(true);
    expect(s.phase).toMatchObject({ kind: 'reveal', target: 'D', chooser: 'A' });
  });
});

describe('blue cards', () => {
  it('Stocks skips one turn and is then discarded', () => {
    let s = scenario();
    const [st] = give(s, 'A', 'stocks');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: st!.id, target: 'B' });
    s = must(s, 'A', { type: 'END_TURN' });
    expect(s.turn.player).toBe('C');
    expect(s.players.B!.front.some((c) => c.type === 'stocks')).toBe(false);
  });

  it('when a matched (Matchmaker) player dies, their partner dies too', () => {
    let s = scenario();
    s.players.C!.front.push(card('matchmaker'));
    s.players.D!.front.push(card('matchmaker'));
    setTryals(s, 'C', ['not_a_witch']);
    const [w] = give(s, 'A', 'witness');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'C' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'C-t0' });
    expect(s.players.C!.alive).toBe(false);
    expect(s.players.D!.alive).toBe(false);
  });

  it('two Matchmakers on the same player are both discarded', () => {
    let s = scenario();
    s.players.C!.front.push(card('matchmaker'));
    const [m] = give(s, 'A', 'matchmaker');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: m!.id, target: 'C' });
    expect(s.players.C!.front.some((c) => c.type === 'matchmaker')).toBe(false);
  });
});

function toNight(seed = 1) {
  const s = scenario(seed);
  s.deck = [card('night')];
  s.discard = [card('accusation'), card('accusation'), card('alibi')];
  return must(s, 'A', { type: 'DRAW' });
}

describe('night', () => {
  it('the witch kills; the constable protects someone else; the victim dies', () => {
    let s = toNight();
    expect(s.phase).toMatchObject({ kind: 'night', step: 'witches' });
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    expect(s.phase).toMatchObject({ step: 'constable' });
    expect(fails(s, 'B', { type: 'CONSTABLE_GAVEL', target: 'B' })).toMatch('自己');
    s = must(s, 'B', { type: 'CONSTABLE_GAVEL', target: 'D' });
    for (const p of ['A', 'B', 'C', 'D']) s = must(s, p, { type: 'NIGHT_PASS' });
    expect(s.players.C!.alive).toBe(false);
    expect(s.deck.at(-1)!.type).toBe('night');
    expect(s.turn.player).toBe('B');
  });

  it('the Gavel, confessing, and Asylum all save the victim', () => {
    // Gavel
    let s = toNight();
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    s = must(s, 'B', { type: 'CONSTABLE_GAVEL', target: 'C' });
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(s.players.C!.alive).toBe(true);

    // Confession
    s = toNight();
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    s = must(s, 'B', { type: 'CONSTABLE_GAVEL', target: 'D' });
    s = must(s, 'C', { type: 'CONFESS', tryalId: 'C-t1' });
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(s.players.C!.alive).toBe(true);
    expect(s.players.C!.tryals[1]!.revealed).toBe(true);

    // Asylum
    s = toNight();
    s.players.C!.front.push(card('asylum'));
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    s = must(s, 'system', { type: 'TIMEOUT' });
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(s.players.C!.alive).toBe(true);
  });

  it('only Witches see the night votes', () => {
    let s = toNight();
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    const witchView = projectFor(s, 'A').phase;
    const townView = projectFor(s, 'C').phase;
    expect(witchView.kind === 'night' && witchView.victim).toBe('C');
    expect(townView.kind === 'night' && townView.victim).toBe(null);
  });
});

describe('conspiracy', () => {
  it('first reveal one of the black cat holder\'s cards, then everyone takes one from the left; whoever gets a witch card becomes a Witch', () => {
    let s = scenario();
    s.deck = [card('conspiracy'), card('accusation'), card('night')];
    s = must(s, 'A', { type: 'DRAW' });
    // A holds the black cat: A (the drawer) reveals one of A's own tryals
    expect(s.phase).toMatchObject({ kind: 'reveal', chooser: 'A', target: 'A' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'A-t1' });
    expect(s.phase.kind).toBe('conspiracy');
    // D's left is A; D takes A's witch card
    s = must(s, 'A', { type: 'CONSPIRACY_PICK', tryalId: 'B-t1' });
    s = must(s, 'B', { type: 'CONSPIRACY_PICK', tryalId: 'C-t0' });
    s = must(s, 'C', { type: 'CONSPIRACY_PICK', tryalId: 'D-t0' });
    s = must(s, 'D', { type: 'CONSPIRACY_PICK', tryalId: 'A-t0' });
    expect(s.players.D!.everWitch).toBe(true);
    expect(s.players.A!.everWitch).toBe(true); // a Witch stays a Witch for good
    expect(s.players.A!.tryals.some((t) => t.kind === 'witch')).toBe(false);
    // Continue the draw: A's second card is the accusation
    expect(s.players.A!.hand.map((c) => c.type)).toEqual(['accusation']);
    expect(s.turn.player).toBe('B');
  });
});

describe('endgame', () => {
  it('when only 2 players are left, blue cards are removed and Scapegoat cannot be played', () => {
    let s = scenario();
    setTryals(s, 'D', ['not_a_witch']);
    setTryals(s, 'C', ['not_a_witch']);
    s.players.B!.front.push(card('asylum'));
    s.players.C!.front.push(card('matchmaker'));
    s.players.D!.front.push(card('matchmaker'));
    const [w, sg] = give(s, 'A', 'witness', 'scapegoat');
    s = must(s, 'A', { type: 'PLAY_CARD', cardId: w!.id, target: 'D' });
    s = must(s, 'A', { type: 'CHOOSE_REVEAL', tryalId: 'D-t0' });
    expect(s.players.B!.front).toHaveLength(0);
    expect(fails(s, 'A', { type: 'PLAY_CARD', cardId: sg!.id, target: 'B', secondTarget: 'A' })).toBeTruthy();
  });

  it('the witches win when every living player is a Witch', () => {
    let s = toNight();
    setTryals(s, 'C', ['not_a_witch']);
    s.players.B!.alive = false;
    s.players.D!.alive = false;
    s = must(s, 'A', { type: 'WITCH_VOTE', target: 'C' });
    // B is dead so there is no constable; this goes straight to the confession window
    s = must(s, 'system', { type: 'TIMEOUT' });
    expect(s.phase).toEqual({ kind: 'game_over', winner: 'witches' });
  });
});
