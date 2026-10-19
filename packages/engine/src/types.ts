export type PlayerId = string;

export type CardType =
  // Red: accusations
  | 'accusation'
  | 'evidence'
  | 'witness'
  // Green: one-shot
  | 'alibi'
  | 'arson'
  | 'curse'
  | 'robbery'
  | 'scapegoat'
  // Blue: stays in front of a player
  | 'stocks'
  | 'matchmaker'
  | 'asylum'
  | 'piety'
  | 'black_cat'
  // Black: resolved immediately when drawn
  | 'night'
  | 'conspiracy';

export type CardColor = 'red' | 'green' | 'blue' | 'black';

export interface Card {
  id: string;
  type: CardType;
}

export type TryalKind = 'witch' | 'constable' | 'not_a_witch';

export interface Tryal {
  id: string;
  kind: TryalKind;
  revealed: boolean;
}

export interface Player {
  id: PlayerId;
  name: string;
  alive: boolean;
  tryals: Tryal[];
  hand: Card[];
  /** Red and blue cards in front of the player */
  front: Card[];
  /** Has ever held a Witch card (permanently a Witch) */
  everWitch: boolean;
}

export type Winner = 'town' | 'witches';

/** What happens after a reveal finishes */
export type RevealThen = 'resume' | 'conspiracy_pass';

export type Phase =
  | { kind: 'dawn'; votes: Record<PlayerId, PlayerId> }
  | { kind: 'turn' }
  | { kind: 'reveal'; chooser: PlayerId; target: PlayerId; then: RevealThen }
  | {
      kind: 'night';
      step: 'witches' | 'constable' | 'confess';
      votes: Record<PlayerId, PlayerId>;
      victim: PlayerId | null;
      gavel: PlayerId | null;
      confessed: PlayerId[];
      passed: PlayerId[];
    }
  | { kind: 'conspiracy'; picks: Record<PlayerId, string> }
  | { kind: 'game_over'; winner: Winner };

export interface TurnState {
  player: PlayerId;
  /** idle: hasn't acted yet; drawing: chose to draw; playing: has played cards */
  mode: 'idle' | 'drawing' | 'playing';
  drawsLeft: number;
}

export interface GameState {
  /** Seat order (clockwise) */
  seats: PlayerId[];
  players: Record<PlayerId, Player>;
  deck: Card[];
  discard: Card[];
  /** Cards removed from the game (e.g. blue cards in the 2-player endgame) */
  removed: Card[];
  phase: Phase;
  turn: TurnState;
  rng: number;
  /** Incrementing id for log events */
  seq: number;
}

export type Action =
  | { type: 'DAWN_GIVE_CAT'; target: PlayerId }
  | { type: 'DRAW' }
  | { type: 'PLAY_CARD'; cardId: string; target: PlayerId; secondTarget?: PlayerId; targetCardId?: string }
  | { type: 'END_TURN' }
  | { type: 'CHOOSE_REVEAL'; tryalId: string }
  | { type: 'WITCH_VOTE'; target: PlayerId }
  | { type: 'CONSTABLE_GAVEL'; target: PlayerId }
  | { type: 'CONFESS'; tryalId: string }
  | { type: 'NIGHT_PASS' }
  | { type: 'CONSPIRACY_PICK'; tryalId: string }
  /** Sent by the server when the current phase's timer expires; the engine fills in defaults */
  | { type: 'TIMEOUT' };

/** actor is the player who performed the action; TIMEOUT uses 'system' */
export interface ActionEnvelope {
  actor: PlayerId | 'system';
  action: Action;
}

/** Log event; visibleTo omitted means public */
export interface GameEvent {
  seq: number;
  text: string;
  visibleTo?: PlayerId[];
}

export type ReduceResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };
