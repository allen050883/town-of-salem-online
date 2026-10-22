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
  /** Will Griggs: an Alibi played as a Witness keeps its type but counts as `as` while in front of a player */
  as?: CardType;
}

/** The 15 Town Hall characters */
export type RoleId =
  | 'abigail'
  | 'ann'
  | 'cotton'
  | 'giles'
  | 'george'
  | 'proctor'
  | 'martha'
  | 'mary'
  | 'rebecca'
  | 'parris'
  | 'sarah'
  | 'danforth'
  | 'tituba'
  | 'griggs'
  | 'phips';

/** Abilities with a limited number of uses per game */
export type LimitedAbility = 'parris' | 'tituba' | 'phips';

export interface GameOptions {
  /** Deal Town Hall characters */
  roles: boolean;
  /** Advanced variant: one extra Witch card (2 for 4–5 players, 3 for 6–12) */
  extraWitch: boolean;
}

export const DEFAULT_OPTIONS: GameOptions = { roles: true, extraWitch: false };

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
  /** Town Hall character (public); null when playing without characters or before picking */
  role: RoleId | null;
  /** Times each limited ability has been used */
  uses: Partial<Record<LimitedAbility, number>>;
}

export type Winner = 'town' | 'witches';

/** What happens after a reveal finishes */
export type RevealThen = 'resume' | 'conspiracy_pass';

/** John Proctor's pick from a dead player's hand */
export interface Salvage {
  chooser: PlayerId;
  from: PlayerId;
  cards: Card[];
}

export type Phase =
  | { kind: 'roles'; offers: Record<PlayerId, RoleId[]>; picks: Record<PlayerId, RoleId> }
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
      /** What each confession revealed (null = confessed without turning a card, William Phips) */
      confessKinds?: Record<PlayerId, TryalKind | null>;
      passed: PlayerId[];
    }
  | { kind: 'conspiracy'; picks: Record<PlayerId, string> }
  /** Tituba is rearranging the deck before drawing */
  | { kind: 'arrange'; player: PlayerId }
  /** John Proctor picks from the front of `state.salvage`; `resume` is the phase it interrupted */
  | { kind: 'salvage'; resume: Phase }
  | { kind: 'game_over'; winner: Winner };

export interface TurnState {
  player: PlayerId;
  /** idle: hasn't acted yet; drawing: chose to draw; playing: has played cards */
  mode: 'idle' | 'drawing' | 'playing';
  drawsLeft: number;
  /** Giles Corey: accusations drawn during this draw, and whether the bonus card was already drawn */
  accusationsDrawn: number;
  bonusDrawn: boolean;
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
  options: GameOptions;
  /** Pending John Proctor picks; the first one is active while phase is 'salvage' */
  salvage: Salvage[];
  rng: number;
  /** Incrementing id for log events */
  seq: number;
}

export type Action =
  | { type: 'PICK_ROLE'; role: RoleId }
  | { type: 'DAWN_GIVE_CAT'; target: PlayerId }
  | { type: 'DRAW' }
  /** Samuel Parris: take up to 2 non-black cards from the discard pile instead of drawing */
  | { type: 'DRAW_DISCARD'; cardIds: string[] }
  /** Tituba: look at the deck and rearrange it, then draw */
  | { type: 'ARRANGE_START' }
  | { type: 'ARRANGE_DECK'; order: string[] }
  /** John Proctor: keep up to 3 of the dead player's cards */
  | { type: 'SALVAGE'; cardIds: string[] }
  /** asWitness: Will Griggs plays an Alibi as a Witness */
  | { type: 'PLAY_CARD'; cardId: string; target: PlayerId; secondTarget?: PlayerId; targetCardId?: string; asWitness?: boolean }
  | { type: 'END_TURN' }
  | { type: 'CHOOSE_REVEAL'; tryalId: string }
  | { type: 'WITCH_VOTE'; target: PlayerId }
  | { type: 'CONSTABLE_GAVEL'; target: PlayerId }
  /** Without tryalId: William Phips confesses without revealing */
  | { type: 'CONFESS'; tryalId?: string }
  | { type: 'NIGHT_PASS' }
  | { type: 'CONSPIRACY_PICK'; tryalId: string }
  /** Sent by the server when the current phase's timer expires; the engine fills in defaults */
  | { type: 'TIMEOUT' };

/** actor is the player who performed the action; TIMEOUT uses 'system' */
export interface ActionEnvelope {
  actor: PlayerId | 'system';
  action: Action;
}

/** What happened to one player, for the client to highlight (e.g. "+1 指控") */
export interface EventFx {
  target: PlayerId;
  label: string;
}

/** A moment the whole table should see full-screen, in the order it happens (the night's protection, confessions, the Witches' target, who dies, the winner) */
export type Announcement =
  /** Daybreak: whom the Constable protects (null = nobody) */
  | { kind: 'protect'; player: PlayerId | null }
  | { kind: 'confess'; players: { id: PlayerId; revealed: TryalKind | null }[] }
  | { kind: 'target'; player: PlayerId }
  | { kind: 'survive'; player: PlayerId; reason: string }
  | { kind: 'peace' }
  | { kind: 'death'; player: PlayerId; cause: string; wasWitch: boolean }
  | { kind: 'victory'; winner: Winner; witches: PlayerId[] }
  /** Someone drew the Conspiracy: the black cat holder (if any, unless immune) reveals a card first */
  | { kind: 'conspiracy'; drawer: PlayerId; catHolder: PlayerId | null; immune: boolean }
  /** Everyone now takes a tryal card from the player on their left */
  | { kind: 'conspiracyPass' };

/** Log event; visibleTo omitted means public */
export interface GameEvent {
  seq: number;
  text: string;
  visibleTo?: PlayerId[];
  fx?: EventFx[];
  announce?: Announcement;
}

export type ReduceResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: string };
