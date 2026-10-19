import {
  accusationThreshold,
  accusationTotal,
  alivePlayers,
  conspiracyPickers,
  currentConstable,
  effectiveRole,
  nextAlive,
  usesLeft,
  waitingOn,
} from './reducer';
import type { Card, GameEvent, GameOptions, GameState, LimitedAbility, PlayerId, RoleId, TryalKind, Winner } from './types';

/** The game as one player sees it: hidden information removed */
export interface PlayerView {
  me: PlayerId;
  /** A spectator (or replay viewer) is not seated in the game */
  spectator: boolean;
  options: GameOptions;
  seats: PlayerId[];
  players: Record<PlayerId, PublicPlayer>;
  myHand: Card[];
  deckCount: number;
  discardCount: number;
  /** The discard pile is face up */
  discard: Card[];
  /** Uses left of my limited abilities (Parris, Tituba, Phips) */
  myAbilities: Partial<Record<LimitedAbility, number>>;
  turn: GameState['turn'];
  phase: PhaseView;
  /** Players the current phase is waiting on (secret steps are hidden from those who can't see them) */
  waiting: PlayerId[];
  /** Whether I am a Witch / the Constable */
  amWitch: boolean;
  amConstable: boolean;
}

export interface PublicPlayer {
  id: PlayerId;
  name: string;
  alive: boolean;
  /** kind is null for cards this viewer can't see */
  tryals: { id: string; revealed: boolean; kind: TryalKind | null }[];
  handCount: number;
  front: Card[];
  accusations: number;
  /** Points needed to put this player on trial (George Burroughs needs 8) */
  threshold: number;
  role: RoleId | null;
  /** The ability actually in effect (differs from role for Martha Corey) */
  effectiveRole: RoleId | null;
  /** Only Witches can see who the other Witches are */
  isWitch: boolean | null;
}

export type PhaseView =
  | { kind: 'roles'; offers: RoleId[]; picked: RoleId | null; waiting: PlayerId[] }
  | { kind: 'dawn'; mustAct: boolean; votes: Record<PlayerId, PlayerId> | null }
  | { kind: 'turn' }
  | { kind: 'reveal'; chooser: PlayerId; target: PlayerId }
  | {
      kind: 'night';
      step: 'witches' | 'constable' | 'confess';
      mustAct: boolean;
      /** Visible only to Witches */
      votes: Record<PlayerId, PlayerId> | null;
      victim: PlayerId | null;
      /** Visible only to the Constable */
      gavel: PlayerId | null;
      passed: PlayerId[];
    }
  | { kind: 'conspiracy'; mustPick: boolean; leftOf: PlayerId; picked: boolean }
  /** deck is shown only to the arranging player (night excluded; it stays at the bottom) */
  | { kind: 'arrange'; player: PlayerId; deck: Card[] | null }
  /** cards are shown only to the chooser */
  | { kind: 'salvage'; chooser: PlayerId; from: PlayerId; cards: Card[] | null; count: number }
  | { kind: 'game_over'; winner: Winner };

/**
 * omniscient: show every secret (replays, finished games). A viewer id that isn't seated gets the public view.
 */
export function projectFor(s: GameState, me: PlayerId, omniscient = false): PlayerView {
  const meP = s.players[me];
  const amWitch = !!meP?.everWitch;
  const constable = currentConstable(s);
  const amConstable = constable?.id === me;
  const over = s.phase.kind === 'game_over' || omniscient;

  const players: Record<PlayerId, PublicPlayer> = {};
  for (const id of s.seats) {
    const p = s.players[id]!;
    players[id] = {
      id,
      name: p.name,
      alive: p.alive,
      tryals: p.tryals.map((t) => ({
        id: t.id,
        revealed: t.revealed,
        kind: t.revealed || id === me || over ? t.kind : null,
      })),
      handCount: p.hand.length,
      front: p.front,
      accusations: accusationTotal(p, s),
      threshold: accusationThreshold(s, id),
      role: p.role,
      effectiveRole: p.alive ? effectiveRole(s, id) : p.role,
      isWitch: amWitch || over || !p.alive ? p.everWitch : null,
    };
  }

  const myAbilities: PlayerView['myAbilities'] = {};
  for (const a of ['parris', 'tituba', 'phips'] as const) {
    const n = meP ? usesLeft(s, me, a) : 0;
    if (n > 0) myAbilities[a] = n;
  }

  return {
    me,
    spectator: !meP,
    options: s.options,
    seats: s.seats,
    players,
    myHand: meP?.hand ?? [],
    deckCount: s.deck.length,
    discardCount: s.discard.length,
    discard: s.discard,
    myAbilities,
    turn: s.turn,
    phase: projectPhase(s, me, amWitch, amConstable, omniscient),
    waiting: over || canSeeActors(s, amWitch, amConstable) ? waitingOn(s) : [],
    amWitch,
    amConstable,
  };
}

function projectPhase(s: GameState, me: PlayerId, amWitch: boolean, amConstable: boolean, omniscient: boolean): PhaseView {
  const ph = s.phase;
  const alive = !!s.players[me]?.alive;
  // In a replay, show the secret parts of night and dawn as a Witch / the Constable would
  const seeWitch = amWitch || omniscient;
  const seeConstable = amConstable || omniscient;
  switch (ph.kind) {
    case 'roles':
      return {
        kind: 'roles',
        offers: ph.offers[me] ?? [],
        picked: ph.picks[me] ?? null,
        waiting: Object.keys(ph.offers).filter((id) => !ph.picks[id]),
      };
    case 'arrange':
      return { kind: 'arrange', player: ph.player, deck: ph.player === me || omniscient ? s.deck.filter((c) => c.type !== 'night') : null };
    case 'salvage': {
      const sv = s.salvage[0]!;
      return { kind: 'salvage', chooser: sv.chooser, from: sv.from, cards: sv.chooser === me || omniscient ? sv.cards : null, count: sv.cards.length };
    }
    case 'dawn':
      return { kind: 'dawn', mustAct: alive && amWitch && !ph.votes[me], votes: seeWitch ? ph.votes : null };
    case 'turn':
      return { kind: 'turn' };
    case 'reveal':
      return { kind: 'reveal', chooser: ph.chooser, target: ph.target };
    case 'night': {
      const mustAct =
        alive &&
        ((ph.step === 'witches' && amWitch && !ph.votes[me]) ||
          (ph.step === 'constable' && amConstable) ||
          (ph.step === 'confess' && !ph.passed.includes(me)));
      return {
        kind: 'night',
        step: ph.step,
        mustAct,
        votes: seeWitch ? ph.votes : null,
        victim: seeWitch ? ph.victim : null,
        gavel: seeConstable ? ph.gavel : null,
        passed: ph.passed,
      };
    }
    case 'conspiracy': {
      const pickers = conspiracyPickers(s);
      return {
        kind: 'conspiracy',
        mustPick: pickers.includes(me) && !ph.picks[me],
        leftOf: nextAlive(s, me),
        picked: !!ph.picks[me],
      };
    }
    case 'game_over':
      return { kind: 'game_over', winner: ph.winner };
  }
}

/** During eyes-closed steps, who is acting is itself a secret */
function canSeeActors(s: GameState, amWitch: boolean, amConstable: boolean) {
  const ph = s.phase;
  if (ph.kind === 'dawn' || (ph.kind === 'night' && ph.step === 'witches')) return amWitch;
  if (ph.kind === 'night' && ph.step === 'constable') return amConstable;
  return true;
}

export function eventsFor(events: GameEvent[], me: PlayerId): GameEvent[] {
  return events.filter((e) => !e.visibleTo || e.visibleTo.includes(me));
}

export { alivePlayers };
