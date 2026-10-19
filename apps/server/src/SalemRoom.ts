import { randomUUID } from 'node:crypto';
import { CloseCode, Room, type Client } from '@colyseus/core';
import {
  DEFAULT_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROLES,
  botAction,
  createGame,
  phaseTimeoutSeconds,
  projectFor,
  reduce,
  waitingOn,
  type Action,
  type GameOptions,
  type GameState,
  type PlayerId,
} from '@salem/engine';
import { CLOSE_REPLACED, RECONNECT_SECONDS } from './protocol';
import type { ClientMessages, ClientSnapshot, JoinOptions, LogEntry, Member, ReplayRecord, RtcRelay } from './protocol';
import { saveReplay } from './replays';

export type { ClientSnapshot, LogEntry } from './protocol';

const LAST_WORDS = 3;
const LOG_LIMIT = 300;
const MAX_SPECTATORS = 20;
/** When everyone the phase waits on is disconnected, the timer acts for them after this many seconds */
const DISCONNECTED_SECONDS = 5;
/** An empty room survives this long so players can refresh or reconnect */
const EMPTY_ROOM_MS = { lobby: 30_000, game: 10 * 60_000 };
/** Computer players are named after people accused in 1692 (none of them is a Town Hall character) */
const BOT_NAMES = ['Bridget', 'Susannah', 'Elizabeth', 'Margaret', 'Wilmot', 'Lydia', 'Dorcas', 'Alice', 'Mary', 'Samuel', 'Roger', 'Ann'];

function makeCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

export class SalemRoom extends Room {
  maxClients = MAX_PLAYERS + MAX_SPECTATORS;
  /** Disposal is managed by hand so a game survives everyone refreshing at once */
  autoDispose = false;

  private lobby: Member[] = [];
  private spectators: Member[] = [];
  private hostId: PlayerId | null = null;
  private options: GameOptions = { ...DEFAULT_OPTIONS };
  /** sessionId → member id */
  private sessions = new Map<string, PlayerId>();
  private game: GameState | null = null;
  private record: ReplayRecord | null = null;
  private lastReplayId: string | null = null;
  private log: LogEntry[] = [];
  private logSeq = 0;
  private deadline: number | null = null;
  private timer: { clear(): void } | null = null;
  /** The running timer was shortened because the players it waits on are disconnected */
  private hurried = false;
  private emptyTimer: { clear(): void } | null = null;
  private lastWords = new Map<PlayerId, number>();
  private voice = new Set<PlayerId>();
  private botTimers = new Map<PlayerId, { clear(): void }>();

  onCreate() {
    this.roomId = makeCode();
    this.setMetadata({ code: this.roomId });

    const on = <K extends keyof ClientMessages>(type: K, fn: (client: Client, msg: ClientMessages[K]) => void) =>
      this.onMessage(type, (client, msg) => {
        try {
          fn(client, msg as ClientMessages[K]);
        } catch (e) {
          console.error(`message ${type} failed`, e);
          this.sendError(client, '伺服器發生錯誤');
        }
      });
    on('start', (client) => this.handleStart(client));
    on('action', (client, action) => this.handleAction(client, action));
    on('chat', (client, msg) => this.handleChat(client, typeof msg?.text === 'string' ? msg.text : ''));
    on('backToLobby', (client) => this.handleBackToLobby(client));
    on('options', (client, msg) => this.handleOptions(client, msg));
    on('seat', (client, msg) => this.handleSeat(client, !!msg?.spectate));
    on('addBots', (client, msg) => this.handleAddBots(client, msg?.count ?? 1));
    on('removeBot', (client, msg) => this.handleRemoveBot(client, String(msg?.id ?? '')));
    on('voice', (client, msg) => this.handleVoice(client, !!msg?.on));
    on('rtc', (client, msg) => this.handleRtc(client, msg));
    // Sent by the client once its handlers are registered, to fetch the current snapshot
    on('sync', (client) => this.sendSnapshot(client));
  }

  onAuth(_client: Client, options: JoinOptions) {
    const playerId = options?.playerId;
    if (!playerId || typeof playerId !== 'string' || playerId.length > 64) throw new Error('缺少玩家識別碼');
    if (this.member(playerId)) return true;
    if (this.spectators.length >= MAX_SPECTATORS && (this.game || options.spectate || this.lobby.length >= MAX_PLAYERS)) {
      throw new Error('房間已滿');
    }
    return true;
  }

  onJoin(client: Client, options: JoinOptions) {
    const playerId = options.playerId!;
    const name = (options.name ?? '').trim().slice(0, 16) || '無名氏';
    this.emptyTimer?.clear();
    this.emptyTimer = null;
    // The same member reconnecting (refresh / dropped connection): kick the old session
    for (const [sid, pid] of this.sessions) {
      if (pid === playerId && sid !== client.sessionId) {
        this.sessions.delete(sid);
        this.clients.find((c) => c.sessionId === sid)?.leave(CLOSE_REPLACED);
      }
    }
    this.sessions.set(client.sessionId, playerId);

    const existing = this.member(playerId);
    if (existing) {
      if (!this.game) existing.name = name;
      this.setConnected(playerId, true);
    } else if (this.game || options.spectate || this.lobby.length >= MAX_PLAYERS) {
      this.spectators.push({ id: playerId, name, connected: true });
      this.pushLog({ kind: 'event', channel: 'system', text: `${name} 進來觀戰` });
    } else {
      this.lobby.push({ id: playerId, name, connected: true });
      this.pushLog({ kind: 'event', channel: 'system', text: `${name} 加入了房間` });
    }
    this.ensureHost();
    this.broadcastSnapshots();
  }

  async onLeave(client: Client, code?: number) {
    const pid = this.sessions.get(client.sessionId);
    if (pid && code !== CloseCode.CONSENTED && code !== CLOSE_REPLACED) {
      // Dropped connection: hold the session open so the client SDK can resume it
      this.setConnected(pid, false);
      try {
        await this.allowReconnection(client, RECONNECT_SECONDS);
        if (this.sessions.get(client.sessionId) === pid) this.setConnected(pid, true);
        return;
      } catch {
        // Not resumed in time; if the member came back through a fresh join meanwhile, that session owns the seat
        if (this.sessions.get(client.sessionId) !== pid) return;
      }
    }
    this.sessions.delete(client.sessionId);
    if (this.sessions.size === 0) this.scheduleEmptyDispose();
    if (!pid) return;
    // If the member still has another live session (reconnected), skip this
    if ([...this.sessions.values()].includes(pid)) return;
    this.voice.delete(pid);

    const spectator = this.spectators.find((x) => x.id === pid);
    if (spectator) {
      this.spectators = this.spectators.filter((x) => x.id !== pid);
      this.pushLog({ kind: 'event', channel: 'system', text: `${spectator.name} 離開觀戰` });
    } else {
      const p = this.lobby.find((x) => x.id === pid);
      if (!p) return;
      if (this.game) {
        // During a game, keep the seat; the timer acts on their behalf
        if (p.connected) {
          p.connected = false;
          this.pushLog({ kind: 'event', channel: 'system', text: `${p.name} 離線了` });
        }
        this.hurryIfAbandoned();
      } else {
        this.lobby = this.lobby.filter((x) => x.id !== pid);
        this.pushLog({ kind: 'event', channel: 'system', text: `${p.name} 離開了房間` });
      }
    }
    this.ensureHost();
    this.broadcastSnapshots();
  }

  /** Show a member as online/offline while their session may still resume */
  private setConnected(pid: PlayerId, connected: boolean) {
    const m = this.member(pid);
    if (!m || m.connected === connected) return;
    m.connected = connected;
    if (connected) {
      if (this.game && this.isPlayer(pid)) this.pushLog({ kind: 'event', channel: 'system', text: `${m.name} 回來了` });
      if (this.game && this.hurried && waitingOn(this.game).includes(pid)) this.restartTimer();
    } else {
      if (this.game && this.isPlayer(pid)) this.pushLog({ kind: 'event', channel: 'system', text: `${m.name} 斷線了，等待重新連線…` });
      this.hurryIfAbandoned();
    }
    this.ensureHost();
    this.broadcastSnapshots();
  }

  onDispose() {
    this.timer?.clear();
    this.emptyTimer?.clear();
    for (const t of this.botTimers.values()) t.clear();
  }

  // ---------- Members ----------

  private member(id: PlayerId): Member | undefined {
    return this.lobby.find((p) => p.id === id) ?? this.spectators.find((p) => p.id === id);
  }

  private isPlayer(id: PlayerId) {
    return this.lobby.some((p) => p.id === id);
  }

  /** The host is a connected seated player; pass it on when the host leaves or drops */
  private ensureHost() {
    const host = this.lobby.find((p) => p.id === this.hostId);
    if (host?.connected && !host.bot) return;
    this.hostId = this.lobby.find((p) => p.connected && !p.bot)?.id ?? (host && !host.bot ? host.id : null);
  }

  // ---------- Computer players ----------

  private handleAddBots(client: Client, count: number) {
    if (this.sessions.get(client.sessionId) !== this.hostId) return this.sendError(client, '只有房主可以加入電腦玩家');
    if (this.game && this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲進行中不能加入電腦玩家');
    const n = Math.max(1, Math.min(Math.floor(Number(count) || 1), MAX_PLAYERS - this.lobby.length));
    if (this.lobby.length >= MAX_PLAYERS) return this.sendError(client, '座位已滿');
    for (let i = 0; i < n; i++) {
      const used = new Set(this.lobby.map((p) => p.name));
      const name = BOT_NAMES.find((x) => !used.has(x)) ?? `電腦 ${this.lobby.length + 1}`;
      this.lobby.push({ id: `bot-${randomUUID()}`, name, connected: true, bot: true });
    }
    this.pushLog({ kind: 'event', channel: 'system', text: `加入了 ${n} 位電腦玩家` });
    this.broadcastSnapshots();
  }

  private handleRemoveBot(client: Client, id: PlayerId) {
    if (this.sessions.get(client.sessionId) !== this.hostId) return this.sendError(client, '只有房主可以移除電腦玩家');
    if (this.game && this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲進行中不能移除電腦玩家');
    const bot = this.lobby.find((p) => p.id === id && p.bot);
    if (!bot) return;
    this.lobby = this.lobby.filter((p) => p !== bot);
    this.pushLog({ kind: 'event', channel: 'system', text: `${bot.name}（電腦）離開了房間` });
    this.broadcastSnapshots();
  }

  /** After every change, let each computer player the game waits on act after a short, human-feeling pause */
  private scheduleBots() {
    for (const t of this.botTimers.values()) t.clear();
    this.botTimers.clear();
    const g = this.game;
    if (!g || g.phase.kind === 'game_over') return;
    for (const id of waitingOn(g)) {
      if (!this.lobby.find((p) => p.id === id)?.bot) continue;
      const base = g.phase.kind === 'turn' ? 1300 : 800;
      this.botTimers.set(
        id,
        this.clock.setTimeout(() => {
          this.botTimers.delete(id);
          this.botAct(id);
        }, base + Math.random() * 1000),
      );
    }
  }

  private botAct(id: PlayerId) {
    if (!this.game) return;
    const action = botAction(projectFor(this.game, id));
    if (action && this.dispatch(id, action)) return;
    // The bot's choice was rejected: fall back to something always safe, or leave it to the phase timer
    for (const a of [{ type: 'END_TURN' }, { type: 'DRAW' }, { type: 'NIGHT_PASS' }] as Action[]) {
      if (this.dispatch(id, a)) return;
    }
  }

  private scheduleEmptyDispose() {
    this.emptyTimer?.clear();
    const ms = this.game && this.game.phase.kind !== 'game_over' ? EMPTY_ROOM_MS.game : EMPTY_ROOM_MS.lobby;
    this.emptyTimer = this.clock.setTimeout(() => {
      if (this.sessions.size === 0) void this.disconnect();
    }, ms);
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
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.game = createGame(seats, seed, this.options);
    this.record = {
      id: randomUUID(),
      version: 1,
      roomCode: this.roomId,
      startedAt: Date.now(),
      endedAt: null,
      seats,
      seed,
      options: { ...this.options },
      actions: [],
      chat: [],
      winner: null,
    };
    this.lastWords.clear();
    this.log = [];
    const intro = this.game.phase.kind === 'roles' ? '每個人先從兩位鎮公所角色中選一位。' : '黎明：女巫正在決定把黑貓交給誰…';
    this.pushLog({ kind: 'event', channel: 'system', text: `遊戲開始！共 ${n} 名玩家。${intro}` });
    if (this.game.phase.kind === 'dawn' && this.options.roles) {
      this.pushLog({
        kind: 'event',
        channel: 'system',
        text: `角色公開：${seats.map((s) => `${s.name}＝${ROLES[this.game!.players[s.id]!.role!].name}`).join('、')}`,
      });
    }
    this.afterStateChange();
  }

  private handleBackToLobby(client: Client) {
    const pid = this.sessions.get(client.sessionId);
    if (pid !== this.hostId) return this.sendError(client, '只有房主可以回到大廳');
    if (!this.game || this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲尚未結束');
    this.game = null;
    this.record = null;
    this.clearTimer();
    // Remove players who disconnected
    this.lobby = this.lobby.filter((p) => p.connected);
    this.ensureHost();
    this.broadcastSnapshots();
  }

  private handleOptions(client: Client, patch: Partial<GameOptions>) {
    const pid = this.sessions.get(client.sessionId);
    if (pid !== this.hostId) return this.sendError(client, '只有房主可以調整規則');
    if (this.game && this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲進行中不能調整規則');
    if (typeof patch?.roles === 'boolean') this.options.roles = patch.roles;
    if (typeof patch?.extraWitch === 'boolean') this.options.extraWitch = patch.extraWitch;
    this.broadcastSnapshots();
  }

  private handleSeat(client: Client, spectate: boolean) {
    const pid = this.sessions.get(client.sessionId);
    if (!pid) return;
    if (this.game && this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲進行中不能換位置');
    if (this.game) return this.sendError(client, '請等房主回到大廳再換位置');
    const m = this.member(pid)!;
    if (spectate && this.isPlayer(pid)) {
      this.lobby = this.lobby.filter((p) => p.id !== pid);
      this.spectators.push(m);
    } else if (!spectate && !this.isPlayer(pid)) {
      if (this.lobby.length >= MAX_PLAYERS) return this.sendError(client, '座位已滿');
      this.spectators = this.spectators.filter((p) => p.id !== pid);
      this.lobby.push(m);
    }
    this.ensureHost();
    this.broadcastSnapshots();
  }

  private handleAction(client: Client, action: Action) {
    const pid = this.sessions.get(client.sessionId);
    if (!pid || !this.game || !this.isPlayer(pid)) return;
    if (!action || typeof action !== 'object' || action.type === 'TIMEOUT') return;
    this.dispatch(pid, action, client);
  }

  /** Apply an action; returns whether the engine accepted it */
  private dispatch(actor: PlayerId | 'system', action: Action, client?: Client): boolean {
    if (!this.game) return false;
    const before = new Set(Object.values(this.game.players).filter((p) => !p.alive).map((p) => p.id));
    const r = reduce(this.game, { actor, action });
    if (!r.ok) {
      if (client) this.sendError(client, r.error);
      return false;
    }
    this.game = r.state;
    this.record?.actions.push({ actor, action, at: Date.now() - this.record.startedAt });
    for (const e of r.events) this.pushLog({ kind: 'event', channel: 'public', text: e.text, to: e.visibleTo });
    for (const p of Object.values(this.game.players)) {
      if (!p.alive && !before.has(p.id)) this.lastWords.set(p.id, LAST_WORDS);
    }
    if (this.game.phase.kind === 'game_over') this.finishRecord();
    this.afterStateChange();
    return true;
  }

  private finishRecord() {
    const r = this.record;
    const ph = this.game?.phase;
    if (!r || ph?.kind !== 'game_over') return;
    r.endedAt = Date.now();
    r.winner = ph.winner;
    saveReplay(r);
    this.lastReplayId = r.id;
    this.record = null;
    this.pushLog({ kind: 'event', channel: 'system', text: '這場對戰已經存檔，可以觀看重播。' });
  }

  private handleChat(client: Client, raw: string) {
    const pid = this.sessions.get(client.sessionId);
    if (!pid) return;
    const text = raw.trim().slice(0, 300);
    if (!text) return;
    const name = this.member(pid)?.name ?? '?';
    const g = this.game;

    if (!g || g.phase.kind === 'game_over') {
      this.pushLog({ kind: 'chat', channel: 'public', from: name, text });
      return this.broadcastSnapshots();
    }

    const dead = Object.values(g.players).filter((p) => !p.alive).map((p) => p.id);
    const watchers = [...dead, ...this.spectators.map((s) => s.id)];
    const me = g.players[pid];
    if (!me) {
      // Spectators talk among themselves and with the dead
      this.chat({ channel: 'spectator', from: name, text, to: watchers });
      return this.broadcastSnapshots();
    }

    const ph = g.phase;
    const secretPhase = ph.kind === 'dawn' || (ph.kind === 'night' && ph.step !== 'confess');

    if (!me.alive) {
      const left = this.lastWords.get(pid) ?? 0;
      if (left > 0 && !secretPhase) {
        this.lastWords.set(pid, left - 1);
        this.chat({ channel: 'public', from: `${name}（遺言）`, text });
      } else {
        // After last words are used up, only the dead and spectators can see
        this.chat({ channel: 'dead', from: name, text, to: watchers });
      }
      return this.broadcastSnapshots();
    }

    if (secretPhase) {
      // Eyes closed: only witches can talk in the witch channel
      if (!me.everWitch) return this.sendError(client, '現在是閉眼時間，不能說話');
      const witches = Object.values(g.players).filter((p) => p.alive && p.everWitch).map((p) => p.id);
      this.chat({ channel: 'witch', from: name, text, to: witches });
      return this.broadcastSnapshots();
    }

    this.chat({ channel: 'public', from: name, text });
    this.broadcastSnapshots();
  }

  /** Log a chat line and keep it in the game record */
  private chat(e: { channel: LogEntry['channel']; from: string; text: string; to?: PlayerId[] }) {
    this.pushLog({ kind: 'chat', ...e });
    const r = this.record;
    if (r) r.chat.push({ after: r.actions.length, at: Date.now() - r.startedAt, channel: e.channel, from: e.from, text: e.text });
  }

  // ---------- Voice (WebRTC signaling relay) ----------

  private handleVoice(client: Client, on: boolean) {
    const pid = this.sessions.get(client.sessionId);
    if (!pid) return;
    if (on) this.voice.add(pid);
    else this.voice.delete(pid);
    this.broadcastSnapshots();
  }

  private handleRtc(client: Client, msg: ClientMessages['rtc']) {
    const from = this.sessions.get(client.sessionId);
    if (!from || !msg || typeof msg.to !== 'string' || !msg.data || typeof msg.data !== 'object') return;
    if (!this.voice.has(from) || !this.voice.has(msg.to)) return;
    const relay: RtcRelay = { from, data: msg.data };
    for (const c of this.clients) {
      if (this.sessions.get(c.sessionId) === msg.to) c.send('rtc', relay);
    }
  }

  // ---------- Timers and broadcasting ----------

  private afterStateChange() {
    this.restartTimer();
    this.scheduleBots();
    this.broadcastSnapshots();
  }

  private restartTimer() {
    this.clearTimer();
    const secs = this.game ? phaseTimeoutSeconds(this.game) : null;
    if (secs == null) return;
    this.schedule(secs);
    this.hurryIfAbandoned();
  }

  private schedule(secs: number) {
    this.timer?.clear();
    this.deadline = Date.now() + secs * 1000;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.hurried = false;
      this.dispatch('system', { type: 'TIMEOUT' });
    }, secs * 1000);
  }

  /** If every player the phase waits on is disconnected, don't make the table wait the full time */
  private hurryIfAbandoned() {
    if (!this.game || !this.timer || this.deadline == null) return;
    const waiting = waitingOn(this.game);
    if (waiting.length === 0) return;
    const allGone = waiting.every((id) => !this.lobby.find((p) => p.id === id)?.connected);
    if (!allGone || this.deadline - Date.now() <= DISCONNECTED_SECONDS * 1000) return;
    this.schedule(DISCONNECTED_SECONDS);
    this.hurried = true;
  }

  private clearTimer() {
    this.timer?.clear();
    this.timer = null;
    this.deadline = null;
    this.hurried = false;
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
      seat: this.isPlayer(pid) ? 'player' : 'spectator',
      hostId: this.hostId,
      lobby: this.lobby,
      spectators: this.spectators,
      options: this.options,
      view: this.game ? projectFor(this.game, pid) : null,
      log: this.log.filter((e) => !e.to || e.to.includes(pid)),
      deadline: this.deadline,
      lastWordsLeft: this.game?.players[pid]?.alive === false ? (this.lastWords.get(pid) ?? 0) : null,
      voice: [...this.voice],
      lastReplayId: this.lastReplayId,
    };
    client.send('snapshot', snap);
  }

  private sendError(client: Client, message: string) {
    client.send('error', { message });
  }
}
