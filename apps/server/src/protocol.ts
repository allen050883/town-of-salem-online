/** Messages and payloads shared by the server and the web client (type-only imports on the client) */
import type { Action, ActionEnvelope, GameOptions, PlayerId, PlayerView, SeatInput, Winner } from '@salem/engine';

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
}

export interface Member {
  id: PlayerId;
  name: string;
  connected: boolean;
}

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
  view: PlayerView | null;
  log: LogEntry[];
  /** Phase deadline (epoch ms) */
  deadline: number | null;
  /** Dead players' remaining last words */
  lastWordsLeft: number | null;
  /** Members with voice chat turned on */
  voice: PlayerId[];
  /** The last finished game in this room, viewable as a replay */
  lastReplayId: string | null;
}

export interface JoinOptions {
  playerId?: string;
  name?: string;
  /** Join as a spectator even if a seat is free */
  spectate?: boolean;
}

/** WebRTC signaling, relayed by the server between two members of the room */
export interface RtcSignal {
  to: PlayerId;
  /** An SDP offer/answer or an ICE candidate, passed through untouched (DOM types aren't available on the server) */
  data: { sdp?: { type: 'offer' | 'answer'; sdp?: string }; candidate?: Record<string, unknown> };
}
export interface RtcRelay {
  from: PlayerId;
  data: RtcSignal['data'];
}

/** Client → server messages */
export interface ClientMessages {
  start: undefined;
  backToLobby: undefined;
  sync: undefined;
  action: Action;
  chat: { text: string };
  options: Partial<GameOptions>;
  /** Spectator takes a free seat / player moves to the spectator benches (lobby only) */
  seat: { spectate: boolean };
  voice: { on: boolean };
  rtc: RtcSignal;
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
