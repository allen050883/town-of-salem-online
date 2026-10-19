import { accusationTotal, alivePlayers, conspiracyPickers, currentConstable, nextAlive } from './reducer';
import type { Card, GameEvent, GameState, PlayerId, TryalKind, Winner } from './types';

/** The game as one player sees it: hidden information removed */
export interface PlayerView {
  me: PlayerId;
  seats: PlayerId[];
  players: Record<PlayerId, PublicPlayer>;
  myHand: Card[];
  deckCount: number;
  discardCount: number;
  turn: GameState['turn'];
  phase: PhaseView;
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
  /** Only Witches can see who the other Witches are */
  isWitch: boolean | null;
}

export type PhaseView =
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
  | { kind: 'game_over'; winner: Winner };

export function projectFor(s: GameState, me: PlayerId): PlayerView {
  const meP = s.players[me];
  const amWitch = !!meP?.everWitch;
  const constable = currentConstable(s);
  const amConstable = constable?.id === me;
  const over = s.phase.kind === 'game_over';

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
      accusations: accusationTotal(p),
      isWitch: amWitch || over || !p.alive ? p.everWitch : null,
    };
  }

  return {
    me,
    seats: s.seats,
    players,
    myHand: meP?.hand ?? [],
    deckCount: s.deck.length,
    discardCount: s.discard.length,
    turn: s.turn,
    phase: projectPhase(s, me, amWitch, amConstable),
    amWitch,
    amConstable,
  };
}

function projectPhase(s: GameState, me: PlayerId, amWitch: boolean, amConstable: boolean): PhaseView {
  const ph = s.phase;
  const alive = !!s.players[me]?.alive;
  switch (ph.kind) {
    case 'dawn':
      return { kind: 'dawn', mustAct: alive && amWitch && !ph.votes[me], votes: amWitch ? ph.votes : null };
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
        votes: amWitch ? ph.votes : null,
        victim: amWitch ? ph.victim : null,
        gavel: amConstable ? ph.gavel : null,
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

export function eventsFor(events: GameEvent[], me: PlayerId): GameEvent[] {
  return events.filter((e) => !e.visibleTo || e.visibleTo.includes(me));
}

export { alivePlayers };
