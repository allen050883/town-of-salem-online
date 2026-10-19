import { Room, type Client } from '@colyseus/core';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  createGame,
  phaseTimeoutSeconds,
  projectFor,
  reduce,
  type Action,
  type GameState,
  type PlayerId,
  type PlayerView,
} from '@salem/engine';
import { verifyToken, type AuthUser } from './auth';

/** Entries in the room's message log: game events and chat share one stream */
export interface LogEntry {
  id: number;
  kind: 'event' | 'chat';
  channel: 'public' | 'witch' | 'dead' | 'system';
  from?: string;
  text: string;
  /** Visible to; omitted means everyone */
  to?: PlayerId[];
}

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  picture?: string;
  connected: boolean;
}

/** Payload pushed to each client */
export interface ClientSnapshot {
  roomCode: string;
  me: PlayerId;
  hostId: PlayerId | null;
  lobby: LobbyPlayer[];
  view: PlayerView | null;
  log: LogEntry[];
  /** Phase deadline (epoch ms) */
  deadline: number | null;
  /** Dead players' remaining last words */
  lastWordsLeft: number | null;
}

interface JoinOptions {
  /** Session token issued after LINE login */
  token?: string;
}

const LAST_WORDS = 3;
const LOG_LIMIT = 300;

function makeCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

export class SalemRoom extends Room {
  // Seat limits are enforced in onAuth; leave room for a reconnect's new connection while the old one hasn't closed yet
  maxClients = MAX_PLAYERS * 2;

  private lobby: LobbyPlayer[] = [];
  private hostId: PlayerId | null = null;
  /** sessionId → playerId */
  private sessions = new Map<string, PlayerId>();
  private game: GameState | null = null;
  private log: LogEntry[] = [];
  private logSeq = 0;
  private deadline: number | null = null;
  private timer: { clear(): void } | null = null;
  private lastWords = new Map<PlayerId, number>();

  onCreate() {
    this.roomId = makeCode();
    this.setMetadata({ code: this.roomId });

    this.onMessage('start', (client) => this.handleStart(client));
    this.onMessage('action', (client, action: Action) => this.handleAction(client, action));
    this.onMessage('chat', (client, msg: { text?: string }) => this.handleChat(client, msg?.text ?? ''));
    this.onMessage('backToLobby', (client) => this.handleBackToLobby(client));
    // Sent by the client once its handlers are registered, to fetch the current snapshot
    this.onMessage('sync', (client) => this.sendSnapshot(client));
  }

  /** Must be logged in; the return value becomes client.auth */
  onAuth(_client: Client, options: JoinOptions): AuthUser {
    const user = verifyToken(options?.token);
    if (!user) throw new Error('請先用 LINE 登入');
    const known = this.lobby.some((p) => p.id === user.id);
    if (!known && this.game) throw new Error('遊戲已經開始，無法加入');
    if (!known && this.lobby.length >= MAX_PLAYERS) throw new Error('房間已滿');
    return user;
  }

  onJoin(client: Client) {
    const user = client.auth as AuthUser;
    const playerId = user.id;
    const name = user.name;
    // The same player reconnecting (refresh / dropped connection): kick the old session
    for (const [sid, pid] of this.sessions) {
      if (pid === playerId && sid !== client.sessionId) {
        this.sessions.delete(sid);
        this.clients.find((c) => c.sessionId === sid)?.leave();
      }
    }
    this.sessions.set(client.sessionId, playerId);

    const existing = this.lobby.find((p) => p.id === playerId);
    if (existing) {
      existing.connected = true;
      if (!this.game) {
        existing.name = name;
        existing.picture = user.picture;
      }
    } else {
      this.lobby.push({ id: playerId, name, picture: user.picture, connected: true });
      this.pushLog({ kind: 'event', channel: 'system', text: `${name} 加入了房間` });
    }
    if (!this.hostId) this.hostId = playerId;
    this.broadcastSnapshots();
  }

  onLeave(client: Client) {
    const pid = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    if (!pid) return;
    // If the player still has another live session (reconnected), skip this
    if ([...this.sessions.values()].includes(pid)) return;
    const p = this.lobby.find((x) => x.id === pid);
    if (!p) return;
    if (this.game) {
      // During a game, keep the seat; the timer acts on their behalf
      p.connected = false;
    } else {
      this.lobby = this.lobby.filter((x) => x.id !== pid);
      this.pushLog({ kind: 'event', channel: 'system', text: `${p.name} 離開了房間` });
      if (this.hostId === pid) this.hostId = this.lobby[0]?.id ?? null;
    }
    this.broadcastSnapshots();
  }

  onDispose() {
    this.timer?.clear();
  }

  // ---------- Message handlers ----------

  private handleStart(client: Client) {
    const pid = this.sessions.get(client.sessionId);
    if (pid !== this.hostId) return this.sendError(client, '只有房主可以開始遊戲');
    if (this.game && this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲進行中');
    const n = this.lobby.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) return this.sendError(client, `需要 ${MIN_PLAYERS}–${MAX_PLAYERS} 名玩家（目前 ${n} 名）`);

    // Random seats
    const seats = [...this.lobby].sort(() => Math.random() - 0.5).map((p) => ({ id: p.id, name: p.name }));
    this.game = createGame(seats, Math.floor(Math.random() * 2 ** 31));
    this.lastWords.clear();
    this.log = [];
    this.pushLog({ kind: 'event', channel: 'system', text: `遊戲開始！共 ${n} 名玩家。黎明：女巫正在決定把黑貓交給誰…` });
    this.afterStateChange();
  }

  private handleBackToLobby(client: Client) {
    const pid = this.sessions.get(client.sessionId);
    if (pid !== this.hostId) return this.sendError(client, '只有房主可以回到大廳');
    if (!this.game || this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲尚未結束');
    this.game = null;
    this.clearTimer();
    // Remove players who disconnected
    this.lobby = this.lobby.filter((p) => p.connected);
    if (!this.lobby.some((p) => p.id === this.hostId)) this.hostId = this.lobby[0]?.id ?? null;
    this.broadcastSnapshots();
  }

  private handleAction(client: Client, action: Action) {
    const pid = this.sessions.get(client.sessionId);
    if (!pid || !this.game) return;
    if (!action || typeof action !== 'object' || action.type === 'TIMEOUT') return;
    this.dispatch(pid, action, client);
  }

  private dispatch(actor: PlayerId | 'system', action: Action, client?: Client) {
    if (!this.game) return;
    const before = new Set(Object.values(this.game.players).filter((p) => !p.alive).map((p) => p.id));
    const r = reduce(this.game, { actor, action });
    if (!r.ok) {
      if (client) this.sendError(client, r.error);
      return;
    }
    this.game = r.state;
    for (const e of r.events) this.pushLog({ kind: 'event', channel: 'public', text: e.text, to: e.visibleTo });
    for (const p of Object.values(this.game.players)) {
      if (!p.alive && !before.has(p.id)) this.lastWords.set(p.id, LAST_WORDS);
    }
    this.afterStateChange();
  }

  private handleChat(client: Client, raw: string) {
    const pid = this.sessions.get(client.sessionId);
    if (!pid) return;
    const text = raw.trim().slice(0, 300);
    if (!text) return;
    const name = this.lobby.find((p) => p.id === pid)?.name ?? '?';
    const g = this.game;

    if (!g || g.phase.kind === 'game_over') {
      this.pushLog({ kind: 'chat', channel: 'public', from: name, text });
      return this.broadcastSnapshots();
    }

    const me = g.players[pid];
    if (!me) return;
    const ph = g.phase;
    const secretPhase = ph.kind === 'dawn' || (ph.kind === 'night' && ph.step !== 'confess');

    if (!me.alive) {
      const left = this.lastWords.get(pid) ?? 0;
      if (left > 0 && !secretPhase) {
        this.lastWords.set(pid, left - 1);
        this.pushLog({ kind: 'chat', channel: 'public', from: `${name}（遺言）`, text });
      } else {
        // After last words are used up, only other dead players can see
        const dead = Object.values(g.players).filter((p) => !p.alive).map((p) => p.id);
        this.pushLog({ kind: 'chat', channel: 'dead', from: name, text, to: dead });
      }
      return this.broadcastSnapshots();
    }

    if (secretPhase) {
      // Eyes closed: only witches can talk in the witch channel
      if (!me.everWitch) return this.sendError(client, '現在是閉眼時間，不能說話');
      const witches = Object.values(g.players).filter((p) => p.alive && p.everWitch).map((p) => p.id);
      this.pushLog({ kind: 'chat', channel: 'witch', from: name, text, to: witches });
      return this.broadcastSnapshots();
    }

    this.pushLog({ kind: 'chat', channel: 'public', from: name, text });
    this.broadcastSnapshots();
  }

  // ---------- Timers and broadcasting ----------

  private afterStateChange() {
    this.clearTimer();
    const secs = this.game ? phaseTimeoutSeconds(this.game) : null;
    if (secs != null) {
      this.deadline = Date.now() + secs * 1000;
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.dispatch('system', { type: 'TIMEOUT' });
      }, secs * 1000);
    }
    this.broadcastSnapshots();
  }

  private clearTimer() {
    this.timer?.clear();
    this.timer = null;
    this.deadline = null;
  }

  private pushLog(e: Omit<LogEntry, 'id'>) {
    this.log.push({ id: ++this.logSeq, ...e });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  private broadcastSnapshots() {
    for (const client of this.clients) this.sendSnapshot(client);
  }

  private sendSnapshot(client: Client) {
    const pid = this.sessions.get(client.sessionId);
    if (!pid) return;
    const snap: ClientSnapshot = {
      roomCode: this.roomId,
      me: pid,
      hostId: this.hostId,
      lobby: this.lobby,
      view: this.game ? projectFor(this.game, pid) : null,
      log: this.log.filter((e) => !e.to || e.to.includes(pid)),
      deadline: this.deadline,
      lastWordsLeft: this.game?.players[pid]?.alive === false ? (this.lastWords.get(pid) ?? 0) : null,
    };
    client.send('snapshot', snap);
  }

  private sendError(client: Client, message: string) {
    client.send('error', { message });
  }
}
