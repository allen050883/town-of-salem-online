/** Messages and payloads shared by the server and the web client (type-only imports on the client) */
import type { Action, ActionEnvelope, AnnounceItem, EventFx, GameOptions, PlayerId, PlayerView, SeatInput, Winner } from '@salem/engine';

export type Channel = 'public' | 'witch' | 'dead' | 'spectator' | 'system';

/** Entries in the room's message log: game events and chat share one stream */
export interface LogEntry {
  id: number;
  kind: 'event' | 'chat';
  channel: Channel;
  from?: string;
  text: string;
  /** Visible to; omitted means everyone */
  to?: PlayerId[];
  /** Players this event happened to, for the client to highlight */
  fx?: EventFx[];
}

export interface Member {
  id: PlayerId;
  name: string;
  /** LINE profile picture URL (absent for computer players) */
  picture?: string;
  connected: boolean;
  /** A computer player run by the server */
  bot?: boolean;
}

export type { AnnounceItem };

/** Payload pushed to each client */
export interface ClientSnapshot {
  roomCode: string;
  me: PlayerId;
  /** Seated players play; spectators only watch (and can take a seat in the lobby) */
  seat: 'player' | 'spectator';
  hostId: PlayerId | null;
  lobby: Member[];
  spectators: Member[];
  options: GameOptions;
  /** Seats in this game chosen by the host (4–12); null = whoever is seated plays. Empty seats are filled with computer players at the start */
  seatCount: number | null;
  /** Seconds a computer player takes per move (the host can change it any time) */
  botSeconds: number;
  /** How hard the computers think (the host chooses, any time); only matters when the server has a model */
  botMode: 'fast' | 'think';
  /** Whether the server has a model for the computers (otherwise they play with the built-in strategy) */
  aiAvailable: boolean;
  /** Players the computer is playing for (the player turned "AI plays for me" on) */
  autoPlayers: PlayerId[];
  view: PlayerView | null;
  log: LogEntry[];
  /** Phase deadline (epoch ms) */
  deadline: number | null;
  /** Dead players' remaining last words */
  lastWordsLeft: number | null;
  /** Full-screen cards to show in order while the game waits (the night's outcome, deaths, the winner); null when there is nothing to show */
  announce: { id: number; items: AnnounceItem[] } | null;
  /** The last finished game in this room, viewable as a replay */
  lastReplayId: string | null;
  /** The game in progress, null in the lobby */
  gameId: string | null;
}

/** Close code sent to a session replaced by the same member joining from another tab */
export const CLOSE_REPLACED = 4005;
/** Seconds a dropped connection may take to resume its session */
export const RECONNECT_SECONDS = 60;

export interface JoinOptions {
  /** Session token issued after LINE login; the player's id and name come from it, never from the client */
  token?: string;
  /** Join as a spectator even if a seat is free */
  spectate?: boolean;
}

/** Client → server messages */
export interface ClientMessages {
  start: undefined;
  backToLobby: undefined;
  sync: undefined;
  action: Action;
  chat: { text: string };
  options: Partial<GameOptions>;
  /** Host only, in the lobby: how many seats this game has (null = no fixed number) */
  seatCount: { count: number | null };
  /** Host only, any time: seconds a computer player waits before each move */
  botPace: { seconds: number };
  /** Host only, any time: how hard the computers think */
  botMode: { mode: 'fast' | 'think' };
  /** A seated player turns "AI plays for me" on or off */
  autoplay: { on: boolean };
  /** Spectator takes a free seat / player moves to the spectator benches (lobby only) */
  seat: { spectate: boolean };
  /** Host only, in the lobby: add computer players / remove one */
  addBots: { count: number };
  removeBot: { id: PlayerId };
}

/** A finished game: replayed by running the same actions through the engine */
export interface ReplayRecord {
  id: string;
  version: 1;
  roomCode: string;
  startedAt: number;
  endedAt: number | null;
  seats: SeatInput[];
  seed: number;
  options: GameOptions;
  actions: (ActionEnvelope & { at: number })[];
  /** after: number of actions applied before this message was sent */
  chat: { after: number; at: number; channel: Channel; from: string; text: string }[];
  winner: Winner | null;
}

export interface ReplaySummary {
  id: string;
  roomCode: string;
  startedAt: number;
  endedAt: number | null;
  players: string[];
  winner: Winner | null;
}
