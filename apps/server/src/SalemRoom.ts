import { randomUUID } from 'node:crypto';
import { CloseCode, Room, type Client } from '@colyseus/core';
import {
  DEFAULT_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROLES,
  announceItems,
  botAction,
  candidateActions,
  createGame,
  phaseTimeoutSeconds,
  projectFor,
  reduce,
  waitingOn,
  type Action,
  type AnnounceItem,
  type Announcement,
  type Candidate,
  type GameOptions,
  type GameState,
  type PlayerId,
} from '@salem/engine';
import { CLOSE_REPLACED, RECONNECT_SECONDS } from './protocol';
import type { ClientMessages, ClientSnapshot, JoinOptions, LogEntry, Member, ReplayRecord } from './protocol';
import { saveReplay } from './replays';
import { verifyToken, type AuthUser } from './auth';
import { aiChoose, aiEnabled, type AiAnswer, type Play } from './aiBot';

export type { ClientSnapshot, LogEntry } from './protocol';

const LAST_WORDS = 3;
const LOG_LIMIT = 300;
const MAX_SPECTATORS = 20;
/** When everyone the phase waits on is disconnected, the timer acts for them after this many seconds */
const DISCONNECTED_SECONDS = 5;
/** An empty room survives this long so players can refresh or reconnect */
const EMPTY_ROOM_MS = { lobby: 30_000, game: 10 * 60_000 };
/** Seconds a computer player takes per move: the host can change it (this is the default and the allowed range) */
const BOT_SECONDS = { default: 4, min: 1, max: 10 } as const;
/** Computer players get friendly Chinese nicknames (a full table of 12 needs at least 11) */
const BOT_NAMES = ['小明', '小華', '小美', '阿強', '小芳', '阿德', '小玲', '阿志', '小傑', '阿珠', '小雯', '阿豪'];

function makeCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

/**
 * Replays are served publicly, so swap every player id (LINE user ids) for p1, p2… before saving.
 * Ids only need to stay consistent for the engine to replay the game; names are already public in the game itself.
 */
function anonymizeIds(r: ReplayRecord): ReplayRecord {
  const ids = [...new Set(r.seats.map((s) => s.id))].sort((a, b) => b.length - a.length);
  let json = JSON.stringify(r);
  ids.forEach((id) => {
    const alias = `p${r.seats.findIndex((s) => s.id === id) + 1}`;
    json = json.split(JSON.stringify(id)).join(JSON.stringify(alias));
  });
  return JSON.parse(json) as ReplayRecord;
}

export class SalemRoom extends Room {
  maxClients = MAX_PLAYERS + MAX_SPECTATORS;
  /** Disposal is managed by hand so a game survives everyone refreshing at once */
  autoDispose = false;

  private lobby: Member[] = [];
  private spectators: Member[] = [];
  private hostId: PlayerId | null = null;
  private options: GameOptions = { ...DEFAULT_OPTIONS };
  /** Seats chosen by the host; null = no fixed number */
  private seatCount: number | null = null;
  /** Seconds a computer player takes per move; the host can change it at any time, even mid-game */
  private botSeconds: number = BOT_SECONDS.default;
  /** sessionId → member id */
  private sessions = new Map<string, PlayerId>();
  private game: GameState | null = null;
  private record: ReplayRecord | null = null;
  private lastReplayId: string | null = null;
  /** Identifies the game in progress (same as its replay id) */
  private gameId: string | null = null;
  private log: LogEntry[] = [];
  private logSeq = 0;
  private deadline: number | null = null;
  private timer: { clear(): void } | null = null;
  /** The running timer was shortened because the players it waits on are disconnected */
  private hurried = false;
  private emptyTimer: { clear(): void } | null = null;
  private lastWords = new Map<PlayerId, number>();
  private botTimers = new Map<PlayerId, { clear(): void }>();
  /** Full-screen cards the table is looking at; until pauseUntil the game waits (timers, computer players, human actions) */
  private announce: { id: number; items: AnnounceItem[] } | null = null;
  private announceSeq = 0;
  private pauseUntil = 0;
  /** Bumped on every accepted action, so an AI answer that arrives after the game moved on is dropped */
  private version = 0;
  /** Latest AI request per computer player; an older answer for the same player is dropped */
  private aiTokens = new Map<PlayerId, number>();
  /** Cards played on someone this game (public), for the AI's stats */
  private plays: Play[] = [];

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
    on('seatCount', (client, msg) => this.handleSeatCount(client, msg?.count));
    on('botPace', (client, msg) => this.handleBotPace(client, msg?.seconds));
    on('seat', (client, msg) => this.handleSeat(client, !!msg?.spectate));
    on('addBots', (client, msg) => this.handleAddBots(client, msg?.count ?? 1));
    on('removeBot', (client, msg) => this.handleRemoveBot(client, String(msg?.id ?? '')));
    // Sent by the client once its handlers are registered, to fetch the current snapshot
    on('sync', (client) => this.sendSnapshot(client));
  }

  /** Must be logged in; the return value becomes client.auth */
  onAuth(_client: Client, options: JoinOptions): AuthUser {
    const user = verifyToken(options?.token);
    if (!user) throw new Error('請先用 LINE 登入');
    if (this.member(user.id)) return user;
    if (this.spectators.length >= MAX_SPECTATORS && (this.game || options.spectate || this.lobby.length >= this.capacity())) {
      throw new Error('房間已滿');
    }
    return user;
  }

  onJoin(client: Client, options: JoinOptions) {
    const user = client.auth as AuthUser;
    const playerId = user.id;
    const name = user.name;
    const picture = user.picture;
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
      if (!this.game) {
        existing.name = name;
        existing.picture = picture;
      }
      this.setConnected(playerId, true);
    } else if (this.game || options.spectate || this.lobby.length >= this.capacity()) {
      this.spectators.push({ id: playerId, name, picture, connected: true });
      this.pushLog({ kind: 'event', channel: 'system', text: `${name} 進來觀戰` });
    } else {
      this.lobby.push({ id: playerId, name, picture, connected: true });
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
    if (this.lobby.length >= this.capacity()) return this.sendError(client, '座位已滿');
    const n = this.seatBots(Math.max(1, Math.floor(Number(count) || 1)));
    this.pushLog({ kind: 'event', channel: 'system', text: `加入了 ${n} 位電腦玩家` });
    this.broadcastSnapshots();
  }

  /** How many players this game can seat: the host's number, or the table maximum */
  private capacity(): number {
    return this.seatCount ?? MAX_PLAYERS;
  }

  /** Seat up to `count` computer players (as many as fit); returns how many were seated */
  private seatBots(count: number): number {
    const n = Math.max(0, Math.min(count, this.capacity() - this.lobby.length));
    for (let i = 0; i < n; i++) {
      const used = new Set(this.lobby.map((p) => p.name));
      const name = BOT_NAMES.find((x) => !used.has(x)) ?? `電腦 ${this.lobby.length + 1}`;
      this.lobby.push({ id: `bot-${randomUUID()}`, name, connected: true, bot: true });
    }
    return n;
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

  /** Put the announcements from one action on screen and make the game wait for them */
  private showAnnouncements(list: Announcement[]) {
    if (list.length === 0) return;
    const items = announceItems(list);
    this.announce = { id: ++this.announceSeq, items };
    this.pauseUntil = Date.now() + items.reduce((n, i) => n + i.ms, 0) + (items.some((i) => i.ms > 0) ? 400 : 0);
  }

  /** What to send clients: while the game is waiting on it, or the winner's card for as long as the game is over */
  private visibleAnnounce() {
    if (!this.announce) return null;
    return Date.now() < this.pauseUntil || this.game?.phase.kind === 'game_over' ? this.announce : null;
  }

  /** How long the next computer move should take, from when the computer starts deciding */
  private botPace(): number {
    // A turn (cards played on someone) takes the full time; other steps a bit less; a little jitter keeps it human
    const base = this.botSeconds * 1000 * (this.game?.phase.kind === 'turn' ? 1 : 0.7);
    return base * (1 + Math.random() * 0.3);
  }

  /** After every change, let each computer player the game waits on act after a human-feeling pause */
  private scheduleBots() {
    for (const t of this.botTimers.values()) t.clear();
    this.botTimers.clear();
    const g = this.game;
    if (!g || g.phase.kind === 'game_over') return;
    for (const id of waitingOn(g)) {
      if (!this.lobby.find((p) => p.id === id)?.bot) continue;
      // With the model the pause is built into botThink (it overlaps with the model's thinking time)
      const delay = (aiEnabled() ? 300 : this.botPace()) + Math.max(0, this.pauseUntil - Date.now());
      this.botTimers.set(
        id,
        this.clock.setTimeout(() => {
          this.botTimers.delete(id);
          this.botAct(id);
        }, delay),
      );
    }
  }

  private botAct(id: PlayerId) {
    const game = this.game;
    if (!game) return;
    if (!aiEnabled()) return this.ruleAct(id);
    const menu = candidateActions(projectFor(game, id)).filter((c) => reduce(game, { actor: id, action: c.action }).ok);
    void this.botThink(id, menu, this.botPace());
  }

  /**
   * Let the model pick from the menu (when there is a real choice); if it can't in time, the rule bot plays instead.
   * Either way the move waits out the pace, so the model's thinking time counts toward the pause instead of adding to it.
   */
  private async botThink(id: PlayerId, menu: Candidate[], pace: number) {
    const version = this.version;
    const token = (this.aiTokens.get(id) ?? 0) + 1;
    this.aiTokens.set(id, token);
    const started = Date.now();
    let answer: AiAnswer | null = null;
    if (menu.length > 1) {
      const history = this.log.filter((e) => e.kind === 'event' && (!e.to || e.to.includes(id))).map((e) => e.text);
      answer = await aiChoose(projectFor(this.game!, id), history, this.plays, menu);
    }
    const rest = pace - (Date.now() - started);
    if (rest > 0) await new Promise<void>((resolve) => this.clock.setTimeout(resolve, rest));
    // The game moved on while we were thinking (timer, another action, game over), or a newer decision replaced this one
    if (!this.game || this.version !== version || this.aiTokens.get(id) !== token) return;
    if (answer && this.dispatch(id, menu[answer.choice]!.action)) return;
    this.ruleAct(id);
  }

  private ruleAct(id: PlayerId) {
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
    // The host fixed the number of seats: empty ones are filled with computer players
    const humans = this.lobby.length;
    const filled = this.seatCount === null ? 0 : this.seatBots(this.seatCount - humans);
    const n = this.lobby.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) return this.sendError(client, `需要 ${MIN_PLAYERS}–${MAX_PLAYERS} 名玩家（目前 ${n} 名）`);

    // Random seats
    const seats = [...this.lobby].sort(() => Math.random() - 0.5).map((p) => ({ id: p.id, name: p.name }));
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.game = createGame(seats, seed, this.options);
    this.gameId = randomUUID();
    this.record = {
      id: this.gameId,
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
    this.plays = [];
    this.announce = null;
    this.pauseUntil = 0;
    this.log = [];
    const intro = this.game.phase.kind === 'roles' ? '每個人先從兩位鎮公所角色中選一位。' : '黎明：女巫正在決定把黑貓交給誰…';
    this.pushLog({ kind: 'event', channel: 'system', text: `遊戲開始！共 ${n} 名玩家。${intro}` });
    if (filled > 0) this.pushLog({ kind: 'event', channel: 'system', text: `座位不足的部分由 ${filled} 位電腦玩家補滿。` });
    if (aiEnabled() && this.lobby.some((p) => p.bot)) {
      this.pushLog({ kind: 'event', channel: 'system', text: '電腦玩家由 AI 思考；AI 連不上時改用內建策略。' });
    }
    if (this.game.phase.kind === 'dawn' && this.options.roles) {
      this.pushLog({
        kind: 'event',
        channel: 'system',
        text: `角色公開：${seats.map((s) => `${s.name}＝${ROLES[this.game!.players[s.id]!.role!].title}`).join('、')}`,
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
    this.announce = null;
    this.pauseUntil = 0;
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

  private handleBotPace(client: Client, seconds: unknown) {
    if (this.sessions.get(client.sessionId) !== this.hostId) return this.sendError(client, '只有房主可以調整電腦的速度');
    const n = Number(seconds);
    if (!Number.isFinite(n)) return;
    this.botSeconds = Math.min(BOT_SECONDS.max, Math.max(BOT_SECONDS.min, Math.round(n * 2) / 2));
    this.broadcastSnapshots();
  }

  private handleSeatCount(client: Client, count: unknown) {
    const pid = this.sessions.get(client.sessionId);
    if (pid !== this.hostId) return this.sendError(client, '只有房主可以決定遊戲人數');
    if (this.game && this.game.phase.kind !== 'game_over') return this.sendError(client, '遊戲進行中不能調整人數');
    if (count === null) this.seatCount = null;
    else {
      const n = Number(count);
      if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) return this.sendError(client, `人數要在 ${MIN_PLAYERS}–${MAX_PLAYERS} 之間`);
      if (n < this.lobby.length) return this.sendError(client, `目前已有 ${this.lobby.length} 人入座，請先移除電腦玩家或請人改成觀戰`);
      this.seatCount = n;
    }
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
      if (this.lobby.length >= this.capacity()) return this.sendError(client, '座位已滿');
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
    if (Date.now() < this.pauseUntil) return this.sendError(client, '請稍候，正在公布結果');
    this.dispatch(pid, action, client);
  }

  /** Apply an action; returns whether the engine accepted it */
  private dispatch(actor: PlayerId | 'system', action: Action, client?: Client): boolean {
    if (!this.game) return false;
    const before = new Set(Object.values(this.game.players).filter((p) => !p.alive).map((p) => p.id));
    const played = action.type === 'PLAY_CARD' && actor !== 'system' ? this.game.players[actor]?.hand.find((c) => c.id === action.cardId) : undefined;
    const r = reduce(this.game, { actor, action });
    if (!r.ok) {
      if (client) this.sendError(client, r.error);
      return false;
    }
    this.game = r.state;
    this.version++;
    this.showAnnouncements(r.events.flatMap((e) => (e.announce ? [e.announce] : [])));
    if (played && action.type === 'PLAY_CARD' && actor !== 'system') {
      this.plays.push({ actor, type: played.type, target: action.target, second: action.secondTarget, asWitness: action.asWitness });
    }
    this.record?.actions.push({ actor, action, at: Date.now() - this.record.startedAt });
    for (const e of r.events) this.pushLog({ kind: 'event', channel: 'public', text: e.text, to: e.visibleTo, fx: e.fx });
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
    saveReplay(anonymizeIds(r));
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
    // The clock starts once the announcements on screen are done
    const now = Date.now();
    this.deadline = Math.max(now, this.pauseUntil) + secs * 1000;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.hurried = false;
      this.dispatch('system', { type: 'TIMEOUT' });
    }, this.deadline - now);
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
      seatCount: this.seatCount,
      botSeconds: this.botSeconds,
      view: this.game ? projectFor(this.game, pid) : null,
      log: this.log.filter((e) => !e.to || e.to.includes(pid)),
      deadline: this.deadline,
      lastWordsLeft: this.game?.players[pid]?.alive === false ? (this.lastWords.get(pid) ?? 0) : null,
      announce: this.visibleAnnounce(),
      lastReplayId: this.lastReplayId,
      gameId: this.game ? this.gameId : null,
    };
    client.send('snapshot', snap);
  }

  private sendError(client: Client, message: string) {
    client.send('error', { message });
  }
}
