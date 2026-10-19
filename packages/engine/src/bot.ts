import { CARD_COLOR } from './cards';
import type { PlayerView, PublicPlayer } from './projection';
import type { Action, Card, PlayerId } from './types';

/**
 * Simple bot: decides the next action from what one player can see (PlayerView), and never peeks at hidden info.
 * Returns null when there is nothing to do right now. It isn't strong, but it plays a full game by the rules,
 * for demos and filling seats.
 */
export function botAction(v: PlayerView, random: () => number = Math.random): Action | null {
  const me = v.players[v.me];
  if (!me?.alive) return null;
  const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(random() * xs.length)] : undefined);
  const alive = v.seats.map((id) => v.players[id]!).filter((p) => p.alive);
  const others = alive.filter((p) => p.id !== v.me);
  // Witches can see their teammates; townsfolk see null (unknown)
  const isAlly = (p: PublicPlayer) => v.amWitch && p.isWitch === true;
  const enemies = others.filter((p) => !isAlly(p));
  const unrevealed = (p: PublicPlayer) => p.tryals.filter((t) => !t.revealed);
  const ph = v.phase;

  switch (ph.kind) {
    case 'dawn': {
      if (!ph.mustAct) return null;
      // Usually place the black cat on a townsperson; sometimes on yourself to deflect suspicion
      const target = random() < 0.25 ? me : (pick(enemies) ?? me);
      return { type: 'DAWN_GIVE_CAT', target: target.id };
    }
    case 'turn': {
      if (v.turn.player !== v.me) return null;
      const playable = v.myHand.filter((c) => others.length > 0 && !(alive.length === 2 && isEndgameBlocked(c)));
      if (v.turn.mode === 'idle') {
        if (playable.length === 0 || random() < 0.35) return { type: 'DRAW' };
      } else if (playable.length === 0 || random() < 0.45) {
        return { type: 'END_TURN' };
      }
      for (const card of shuffle(playable, random)) {
        const a = planCard(card, v, { others, enemies, isAlly, unrevealed, pick, random });
        if (a) return a;
      }
      return v.turn.mode === 'idle' ? { type: 'DRAW' } : { type: 'END_TURN' };
    }
    case 'reveal': {
      if (ph.chooser !== v.me) return null;
      const t = pick(unrevealed(v.players[ph.target]!));
      return t ? { type: 'CHOOSE_REVEAL', tryalId: t.id } : null;
    }
    case 'night': {
      if (!ph.mustAct) return null;
      if (ph.step === 'witches') {
        const t = pick(enemies) ?? pick(others) ?? me;
        return { type: 'WITCH_VOTE', target: t.id };
      }
      if (ph.step === 'constable') {
        const t = pick(others);
        return t ? { type: 'CONSTABLE_GAVEL', target: t.id } : null;
      }
      const mine = unrevealed(me).filter((t) => t.kind !== 'witch');
      // Occasionally confess with a non-witch card to stay safe
      if (mine.length > 1 && random() < 0.12) return { type: 'CONFESS', tryalId: pick(mine)!.id };
      return { type: 'NIGHT_PASS' };
    }
    case 'conspiracy': {
      if (!ph.mustPick) return null;
      const t = pick(unrevealed(v.players[ph.leftOf]!));
      return t ? { type: 'CONSPIRACY_PICK', tryalId: t.id } : null;
    }
    case 'game_over':
      return null;
  }
}

function isEndgameBlocked(c: Card) {
  return CARD_COLOR[c.type] === 'blue' || c.type === 'scapegoat' || c.type === 'robbery';
}

function shuffle<T>(xs: T[], random: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

interface Ctx {
  others: PublicPlayer[];
  enemies: PublicPlayer[];
  isAlly: (p: PublicPlayer) => boolean;
  unrevealed: (p: PublicPlayer) => PublicPlayer['tryals'];
  pick: <T>(xs: T[]) => T | undefined;
  random: () => number;
}

function planCard(card: Card, v: PlayerView, { others, enemies, isAlly, pick, random }: Ctx): Action | null {
  const play = (target: PlayerId, extra: Partial<Extract<Action, { type: 'PLAY_CARD' }>> = {}): Action => ({
    type: 'PLAY_CARD',
    cardId: card.id,
    target,
    ...extra,
  });
  const hasBlue = (p: PublicPlayer) => p.front.filter((c) => CARD_COLOR[c.type] === 'blue');
  const piety = (p: PublicPlayer) => p.front.some((c) => c.type === 'piety');

  switch (CARD_COLOR[card.type]) {
    case 'red': {
      // Pile on whoever already has the most accusations
      const targets = enemies.filter((p) => !piety(p));
      if (!targets.length) return null;
      const max = Math.max(...targets.map((p) => p.accusations));
      const t = pick(targets.filter((p) => p.accusations === max || random() < 0.3))!;
      return play(t.id);
    }
    case 'blue': {
      // Protective blue cards (asylum, piety) go to allies or anyone; harmful ones (stocks, matchmaker, black cat) go to enemies
      const helpful = card.type === 'asylum' || card.type === 'piety';
      const pool = helpful ? (v.amWitch ? others.filter(isAlly) : others) : enemies;
      const t = pick(pool.length ? pool : others);
      return t ? play(t.id) : null;
    }
    case 'green': {
      if (card.type === 'alibi') {
        const pool = others.filter((p) => p.front.some((c) => c.type === 'accusation' || c.type === 'evidence'));
        const t = pick(v.amWitch ? pool.filter(isAlly).concat(pool) : pool);
        return t ? play(t.id) : null;
      }
      if (card.type === 'curse') {
        const pool = others.filter((p) => hasBlue(p).length > 0);
        const t = pick(pool);
        if (!t) return null;
        return play(t.id, { targetCardId: pick(hasBlue(t))!.id });
      }
      if (card.type === 'arson') {
        const t = pick(enemies.filter((p) => p.handCount > 0));
        return t ? play(t.id) : null;
      }
      if (card.type === 'robbery' || card.type === 'scapegoat') {
        if (others.length < 2) return null;
        const from = pick(others)!;
        const to = pick(others.filter((p) => p.id !== from.id))!;
        return play(from.id, { secondTarget: to.id });
      }
      return null;
    }
    default:
      return null;
  }
}
