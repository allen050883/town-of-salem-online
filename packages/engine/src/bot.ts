import { ACCUSATION_VALUE, CARD_COLOR, isDisabledInEndgame, isRed } from './cards';
import type { PlayerView, PublicPlayer } from './projection';
import type { Action, Card, CardType, PlayerId } from './types';

/**
 * A computer player. It decides only from its own PlayerView, so it never sees more than a human in its seat would:
 * a Witch bot knows its fellow Witches, a town bot knows only its own tryal cards.
 * Returns null when nothing is asked of this player right now.
 */
export function botAction(v: PlayerView, rand: () => number = Math.random): Action | null {
  const me = v.players[v.me];
  if (!me?.alive || v.spectator) return null;
  return new Bot(v, me, rand).decide();
}

/** Value of each card for Samuel Parris / John Proctor picks (higher is better) */
export const CARD_WORTH: Partial<Record<CardType, number>> = {
  witness: 10,
  evidence: 7,
  arson: 6,
  robbery: 6,
  curse: 5,
  alibi: 5,
  asylum: 5,
  piety: 5,
  scapegoat: 4,
  stocks: 4,
  matchmaker: 2,
  accusation: 3,
};

class Bot {
  readonly alive: PlayerId[];
  readonly others: PlayerId[];
  readonly endgame: boolean;

  constructor(
    readonly v: PlayerView,
    readonly me: PublicPlayer,
    readonly rand: () => number,
  ) {
    this.alive = v.seats.filter((id) => v.players[id]!.alive);
    this.others = this.alive.filter((id) => id !== v.me);
    this.endgame = this.alive.length === 2;
  }

  // ----- Small tools -----

  pick<T>(items: readonly T[]): T | undefined {
    return items.length ? items[Math.floor(this.rand() * items.length)] : undefined;
  }

  chance(p: number) {
    return this.rand() < p;
  }

  p(id: PlayerId) {
    return this.v.players[id]!;
  }

  /** Fellow Witches (only a Witch can see them) */
  ally(id: PlayerId) {
    return this.v.amWitch && this.p(id).isWitch === true;
  }

  /** Players this bot works against: everyone else for the town, non-witches for a Witch */
  enemies() {
    return this.others.filter((id) => !this.ally(id));
  }

  allies() {
    return this.others.filter((id) => this.ally(id));
  }

  has(id: PlayerId, type: CardType) {
    return this.p(id).front.some((c) => c.type === type);
  }

  /**
   * How much this bot wants to accuse a player. The town follows the crowd (accusation points) with some noise and
   * goes easier on players whose revealed cards were all innocent; a Witch also favors players close to a trial.
   */
  suspicion(id: PlayerId) {
    const p = this.p(id);
    const revealedInnocent = p.tryals.filter((t) => t.revealed && t.kind !== 'witch').length;
    const progress = p.accusations / p.threshold;
    return progress * 4 - revealedInnocent * (this.v.amWitch ? 0 : 0.8) + this.rand() * 2.5;
  }

  byScore(ids: PlayerId[], score: (id: PlayerId) => number) {
    return [...ids].sort((a, b) => score(b) - score(a));
  }

  // ----- Decisions -----

  decide(): Action | null {
    const v = this.v;
    const ph = v.phase;
    switch (ph.kind) {
      case 'roles':
        return ph.picked ? null : { type: 'PICK_ROLE', role: this.pick(ph.offers)! };
      case 'dawn': {
        if (!ph.mustAct) return null;
        // The black cat holder gets a card revealed on a conspiracy: put it on the town
        const target = this.pick(this.enemies()) ?? v.me;
        return { type: 'DAWN_GIVE_CAT', target };
      }
      case 'reveal':
        return ph.chooser === v.me ? this.chooseReveal(ph.target) : null;
      case 'arrange':
        return ph.deck ? this.arrange(ph.deck) : null;
      case 'salvage':
        return ph.cards ? { type: 'SALVAGE', cardIds: this.best(ph.cards, 3).map((c) => c.id) } : null;
      case 'night':
        return ph.mustAct ? this.night(ph.step) : null;
      case 'conspiracy': {
        if (!ph.mustPick) return null;
        const t = this.pick(this.p(ph.leftOf).tryals.filter((x) => !x.revealed));
        return t ? { type: 'CONSPIRACY_PICK', tryalId: t.id } : null;
      }
      case 'turn':
        return v.turn.player === v.me ? this.turn() : null;
      case 'game_over':
        return null;
    }
  }

  chooseReveal(target: PlayerId): Action | null {
    const hidden = this.p(target).tryals.filter((t) => !t.revealed);
    if (target === this.v.me) {
      // My own card (black cat): never give away a Witch card if there is anything else
      const safe = hidden.filter((t) => t.kind !== 'witch');
      const t = this.pick(safe.length ? safe : hidden);
      return t ? { type: 'CHOOSE_REVEAL', tryalId: t.id } : null;
    }
    const t = this.pick(hidden);
    return t ? { type: 'CHOOSE_REVEAL', tryalId: t.id } : null;
  }

  /** Tituba: put the best cards on top so the two she draws are good */
  arrange(deck: Card[]): Action {
    const order = [...deck].sort((a, b) => (CARD_WORTH[b.type] ?? 0) - (CARD_WORTH[a.type] ?? 0) || (this.rand() < 0.5 ? -1 : 1));
    return { type: 'ARRANGE_DECK', order: order.map((c) => c.id) };
  }

  best(cards: Card[], n: number) {
    return [...cards]
      .filter((c) => CARD_COLOR[c.type] !== 'black' && !(this.endgame && isDisabledInEndgame(c.type)))
      .sort((a, b) => (CARD_WORTH[b.type] ?? 0) - (CARD_WORTH[a.type] ?? 0))
      .slice(0, n);
  }

  night(step: 'witches' | 'constable' | 'confess'): Action {
    const v = this.v;
    if (step === 'witches') {
      // Kill someone the gavel probably isn't on: skip Asylum, prefer the least accused (the town trusts them)
      const targets = this.enemies().filter((id) => !this.has(id, 'asylum'));
      const pool = targets.length ? targets : this.enemies().length ? this.enemies() : this.others;
      const target = this.byScore(pool, (id) => -this.p(id).accusations + this.rand() * 3)[0] ?? v.me;
      return { type: 'WITCH_VOTE', target };
    }
    if (step === 'constable') {
      const pool = v.amWitch && this.allies().length ? this.allies() : this.others.filter((id) => !this.has(id, 'asylum'));
      const target = this.pick(pool.length ? pool : this.others)!;
      return { type: 'CONSTABLE_GAVEL', target };
    }
    // Confession: only ever reveal a card that isn't a Witch card
    if (v.myAbilities.phips && this.chance(0.35)) return { type: 'CONFESS' };
    const hidden = this.me.tryals.filter((t) => !t.revealed);
    const innocent = hidden.filter((t) => t.kind === 'not_a_witch');
    if (hidden.length >= 2 && innocent.length && this.chance(v.amWitch ? 0.1 : 0.15)) {
      return { type: 'CONFESS', tryalId: this.pick(innocent)!.id };
    }
    return { type: 'NIGHT_PASS' };
  }

  turn(): Action | null {
    const v = this.v;
    const mode = v.turn.mode;
    if (mode === 'drawing') return null;
    if (mode === 'idle') {
      if (v.myAbilities.parris && this.chance(0.6)) {
        const picks = this.best(v.discard, 2).filter((c) => (CARD_WORTH[c.type] ?? 0) >= 5);
        if (picks.length) return { type: 'DRAW_DISCARD', cardIds: picks.map((c) => c.id) };
      }
      if (v.myAbilities.tituba && v.deckCount > 3 && this.chance(0.35)) return { type: 'ARRANGE_START' };
      const play = this.choosePlay();
      // Hold a few cards back sometimes; with an empty or weak hand, draw
      if (play && (v.myHand.length >= 3 || this.chance(0.55))) return play;
      return { type: 'DRAW' };
    }
    const play = this.choosePlay();
    return play && this.chance(0.7) ? play : { type: 'END_TURN' };
  }

  /** The best legal play from the hand, or null */
  choosePlay(): Action | null {
    const plays: { action: Action; score: number }[] = [];
    for (const c of this.v.myHand) {
      const a = this.playFor(c);
      if (a) plays.push(a);
    }
    plays.sort((a, b) => b.score - a.score);
    return plays[0]?.action ?? null;
  }

  playFor(c: Card): { action: Action; score: number } | null {
    const v = this.v;
    const t = c.type;
    if (CARD_COLOR[t] === 'black' || (this.endgame && isDisabledInEndgame(t))) return null;
    const play = (target: PlayerId, extra: Partial<Extract<Action, { type: 'PLAY_CARD' }>> = {}): Action => ({
      type: 'PLAY_CARD',
      cardId: c.id,
      target,
      ...extra,
    });
    const enemies = this.enemies();
    const sarahSafe = (id: PlayerId) => this.p(id).effectiveRole !== 'sarah';

    // Will Griggs: an Alibi doubles as a Witness
    if (t === 'alibi' && this.me.effectiveRole === 'griggs' && this.chance(0.6)) {
      const r = this.redPlay(7);
      if (r) return { action: play(r.target, { asWitness: true }), score: r.score };
    }

    if (isRed(t)) {
      const r = this.redPlay(ACCUSATION_VALUE[t] ?? 1);
      return r ? { action: play(r.target), score: r.score } : null;
    }

    switch (t) {
      case 'alibi': {
        // Witches clear their friends; the town clears whoever looks most innocent
        const pool = this.others.filter((id) => this.p(id).front.some((x) => x.type === 'accusation' || x.type === 'evidence'));
        const friends = pool.filter((id) => this.ally(id));
        if (v.amWitch) return friends.length ? { action: play(this.pick(friends)!), score: 6 } : null;
        const target = this.byScore(pool, (id) => -this.suspicion(id))[0];
        return target && this.chance(0.4) ? { action: play(target), score: 2 } : null;
      }
      case 'arson': {
        const target = this.byScore(enemies.filter(sarahSafe), (id) => this.p(id).handCount)[0];
        return target && this.p(target).handCount >= 2 ? { action: play(target), score: 3 + this.p(target).handCount / 2 } : null;
      }
      case 'robbery': {
        const target = this.byScore(enemies.filter(sarahSafe), (id) => this.p(id).handCount)[0];
        if (!target || this.p(target).handCount < 2) return null;
        const receivers = this.others.filter((id) => id !== target);
        const second = this.pick(receivers.filter((id) => this.ally(id))) ?? this.byScore(receivers, (id) => -this.suspicion(id))[0];
        return second ? { action: play(target, { secondTarget: second }), score: 3 } : null;
      }
      case 'scapegoat': {
        // Move a pile of accusations off a friend (Witch) or off the least suspicious player (town) onto an enemy
        const loaded = this.others.filter((id) => this.p(id).accusations >= 3);
        const from = v.amWitch ? loaded.find((id) => this.ally(id)) : this.byScore(loaded, (id) => -this.suspicion(id))[0];
        if (!from) return null;
        const to = this.byScore(
          enemies.filter((id) => id !== from),
          (id) => this.suspicion(id),
        )[0];
        return to ? { action: play(from, { secondTarget: to }), score: v.amWitch ? 6 : 1.5 } : null;
      }
      case 'curse': {
        // Strip protection (or the black cat... from a friend) where it hurts most
        for (const id of this.byScore(this.others, (x) => (this.ally(x) ? -1 : this.suspicion(x)))) {
          const blues = this.p(id).front.filter((x) => CARD_COLOR[x.type] === 'blue');
          const want = this.ally(id)
            ? blues.find((x) => x.type === 'stocks' || x.type === 'black_cat')
            : blues.find((x) => x.type === 'asylum' || x.type === 'piety') ?? (this.chance(0.3) ? blues[0] : undefined);
          if (want) return { action: play(id, { targetCardId: want.id }), score: 3.5 };
        }
        return null;
      }
      case 'stocks': {
        const target = this.byScore(enemies, (id) => this.suspicion(id) + this.p(id).handCount / 3)[0];
        return target ? { action: play(target), score: 2.5 } : null;
      }
      case 'matchmaker': {
        // Complete an existing pair with someone else, or start one between two enemies
        const holders = this.alive.filter((id) => this.has(id, 'matchmaker'));
        const pool = enemies.filter((id) => !holders.includes(id));
        const target = this.pick(pool);
        return target && this.chance(0.5) ? { action: play(target), score: 1 } : null;
      }
      case 'asylum':
      case 'piety': {
        if (this.others.length < 2) return null;
        const friends = this.allies().filter((id) => !this.has(id, t));
        if (v.amWitch) return friends.length ? { action: play(this.pick(friends)!), score: 4 } : null;
        // The town shields the player who has proven most innocent
        const target = this.byScore(
          this.others.filter((id) => !this.has(id, t)),
          (id) => -this.suspicion(id),
        )[0];
        return target && this.chance(0.6) ? { action: play(target), score: 2 } : null;
      }
      default:
        return null;
    }
  }

  /** Best target for `points` of accusation; finishing off a trial scores highest */
  redPlay(points: number): { target: PlayerId; score: number } | null {
    const pool = this.enemies().filter((id) => !this.has(id, 'piety') && this.p(id).tryals.some((t) => !t.revealed));
    if (!pool.length) return null;
    const scored = pool.map((id) => {
      const p = this.p(id);
      // Thomas Danforth needs one point less
      const need = p.threshold - (this.me.effectiveRole === 'danforth' ? 1 : 0) - p.accusations;
      const finishes = points >= need;
      return { target: id, score: (finishes ? 8 : 4) + this.suspicion(id) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]!;
  }
}
