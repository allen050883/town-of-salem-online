import { ACCUSATION_THRESHOLD, ACCUSATION_VALUE, CARD_COLOR, CARD_NAME, isBlue, isDisabledInEndgame, isRed } from './cards';
import { ABILITY_LIMIT, ROLES } from './roles';
import { Rng } from './rng';
import type {
  Action,
  ActionEnvelope,
  Card,
  CardType,
  GameEvent,
  GameState,
  LimitedAbility,
  Phase,
  Player,
  PlayerId,
  ReduceResult,
  RoleId,
  Tryal,
} from './types';

const TRYAL_NAME: Record<Tryal['kind'], string> = {
  witch: '女巫',
  constable: '警長',
  not_a_witch: '非女巫',
};

/** Max cards John Proctor may keep */
export const SALVAGE_MAX = 3;
/** Max cards Samuel Parris may take from the discard pile */
export const PARRIS_MAX = 2;

// ---------- Pure query helpers (also used by projection and server) ----------

export function alivePlayers(s: GameState): Player[] {
  return s.seats.map((id) => s.players[id]!).filter((p) => p.alive);
}

/** The next living player clockwise (that is also "the player on the left") */
export function nextAlive(s: GameState, from: PlayerId): PlayerId {
  const n = s.seats.length;
  const start = s.seats.indexOf(from);
  for (let i = 1; i <= n; i++) {
    const id = s.seats[(start + i) % n]!;
    if (s.players[id]!.alive) return id;
  }
  return from;
}

/** The next living player counter-clockwise ("the player on the right") */
export function prevAlive(s: GameState, from: PlayerId): PlayerId {
  const n = s.seats.length;
  const start = s.seats.indexOf(from);
  for (let i = 1; i <= n; i++) {
    const id = s.seats[(start - i + n) % n]!;
    if (s.players[id]!.alive) return id;
  }
  return from;
}

/** The ability a player actually has: Martha Corey copies the first living player on her right */
export function effectiveRole(s: GameState, pid: PlayerId): RoleId | null {
  const role = s.players[pid]?.role ?? null;
  if (role !== 'martha') return role;
  const right = prevAlive(s, pid);
  if (right === pid) return null;
  const copied = s.players[right]!.role;
  return copied === 'martha' ? null : copied;
}

export function hasRole(s: GameState, pid: PlayerId, role: RoleId): boolean {
  return !!s.players[pid]?.alive && effectiveRole(s, pid) === role;
}

export function usesLeft(s: GameState, pid: PlayerId, ability: LimitedAbility): number {
  if (!hasRole(s, pid, ability)) return 0;
  return ABILITY_LIMIT[ability] - (s.players[pid]!.uses[ability] ?? 0);
}

export function aliveWitches(s: GameState): Player[] {
  return alivePlayers(s).filter((p) => p.everWitch);
}

/** The current constable: a living player holding an unrevealed Constable card */
export function currentConstable(s: GameState): Player | undefined {
  return alivePlayers(s).find((p) => p.tryals.some((t) => t.kind === 'constable' && !t.revealed));
}

export function blackCatHolder(s: GameState): Player | undefined {
  return alivePlayers(s).find((p) => p.front.some((c) => c.type === 'black_cat'));
}

/** The type a card counts as (Will Griggs' Alibi counts as a Witness) */
export function effectiveType(c: Card): CardType {
  return c.as ?? c.type;
}

/** Accusation points in front of a player; pass the state to apply Cotton Mather */
export function accusationTotal(p: Player, s?: GameState): number {
  const cotton = !!s && hasRole(s, p.id, 'cotton');
  return p.front.reduce((sum, c) => {
    const t = effectiveType(c);
    return sum + (cotton && t === 'evidence' ? 1 : (ACCUSATION_VALUE[t] ?? 0));
  }, 0);
}

/** Points needed to put `target` on trial when `accuser` places the latest card */
export function accusationThreshold(s: GameState, target: PlayerId, accuser?: PlayerId): number {
  let n = ACCUSATION_THRESHOLD;
  if (hasRole(s, target, 'george')) n++;
  if (accuser && hasRole(s, accuser, 'danforth')) n--;
  return n;
}

export function unrevealed(p: Player): Tryal[] {
  return p.tryals.filter((t) => !t.revealed);
}

/** Matchmaker partner: exactly two different players each have a matchmaker in front of them (Mary Warren is immune) */
export function matchmakerPartner(s: GameState, pid: PlayerId): PlayerId | undefined {
  const holders = alivePlayers(s).filter((p) => p.front.some((c) => c.type === 'matchmaker'));
  if (holders.length !== 2) return undefined;
  if (holders.some((h) => hasRole(s, h.id, 'mary'))) return undefined;
  if (holders[0]!.id === pid) return holders[1]!.id;
  if (holders[1]!.id === pid) return holders[0]!.id;
  return undefined;
}

/** Players who must pick during the conspiracy pass: their left neighbor still has unrevealed tryals */
export function conspiracyPickers(s: GameState): PlayerId[] {
  return alivePlayers(s)
    .filter((p) => unrevealed(s.players[nextAlive(s, p.id)]!).length > 0 && nextAlive(s, p.id) !== p.id)
    .map((p) => p.id);
}

/** Players the current phase is waiting on (used by the server to shorten timers for disconnected players) */
export function waitingOn(s: GameState): PlayerId[] {
  const ph = s.phase;
  const alive = alivePlayers(s).map((p) => p.id);
  switch (ph.kind) {
    case 'roles':
      return alive.filter((id) => !ph.picks[id]);
    case 'dawn':
      return aliveWitches(s).filter((p) => !ph.votes[p.id]).map((p) => p.id);
    case 'turn':
      return [s.turn.player];
    case 'reveal':
      return [ph.chooser];
    case 'arrange':
      return [ph.player];
    case 'salvage':
      return s.salvage[0] ? [s.salvage[0].chooser] : [];
    case 'night':
      if (ph.step === 'witches') return aliveWitches(s).filter((p) => !ph.votes[p.id]).map((p) => p.id);
      if (ph.step === 'constable') return currentConstable(s) ? [currentConstable(s)!.id] : [];
      return alive.filter((id) => !ph.passed.includes(id));
    case 'conspiracy':
      return conspiracyPickers(s).filter((id) => !ph.picks[id]);
    case 'game_over':
      return [];
  }
}

/** Seconds allowed for each phase; the server schedules a TIMEOUT from this */
export function phaseTimeoutSeconds(s: GameState): number | null {
  const p = s.phase;
  switch (p.kind) {
    case 'roles':
      return 45;
    case 'dawn':
      return 30;
    case 'turn':
      return 90;
    case 'reveal':
      return 20;
    case 'arrange':
      return 60;
    case 'salvage':
      return 30;
    case 'night':
      return p.step === 'witches' ? 45 : p.step === 'constable' ? 20 : 15;
    case 'conspiracy':
      return 30;
    case 'game_over':
      return null;
  }
}

// ---------- Reducer ----------

export function reduce(state: GameState, env: ActionEnvelope): ReduceResult {
  if (state.phase.kind === 'game_over') return { ok: false, error: '遊戲已結束' };
  const g = new Game(structuredClone(state));
  const error = g.apply(env.actor, env.action);
  if (error) return { ok: false, error };
  g.startSalvage();
  // A Will Griggs Alibi is only a Witness while in front of a player; the deck is rebuilt from the discard pile
  for (const c of g.s.discard) delete c.as;
  g.s.rng = g.rng.seed;
  return { ok: true, state: g.s, events: g.events };
}

class Game {
  rng: Rng;
  events: GameEvent[] = [];
  endgameAnnounced = false;

  constructor(public s: GameState) {
    this.rng = new Rng(s.rng);
  }

  // ----- Basic tools -----

  log(text: string, visibleTo?: PlayerId[]) {
    this.events.push({ seq: ++this.s.seq, text, ...(visibleTo ? { visibleTo } : {}) });
  }

  p(id: PlayerId): Player {
    const pl = this.s.players[id];
    if (!pl) throw new Error(`no player ${id}`);
    return pl;
  }

  name(id: PlayerId) {
    return this.p(id).name;
  }

  has(id: PlayerId, role: RoleId) {
    return hasRole(this.s, id, role);
  }

  /** "Name（角色）" for log lines about abilities */
  roleLabel(id: PlayerId, role: RoleId) {
    return `${this.name(id)}（${ROLES[role].name}）`;
  }

  useAbility(pl: Player, ability: LimitedAbility) {
    pl.uses[ability] = (pl.uses[ability] ?? 0) + 1;
  }

  get over() {
    return this.s.phase.kind === 'game_over';
  }

  setPhase(phase: Phase) {
    this.s.phase = phase;
  }

  // ----- Dispatch -----

  apply(actor: PlayerId | 'system', a: Action): string | undefined {
    if (a.type === 'TIMEOUT') {
      if (actor !== 'system') return '只有伺服器可以送出逾時';
      return this.timeout();
    }
    if (actor === 'system') return '系統不能代替玩家行動';
    const me = this.s.players[actor];
    if (!me) return '你不在這場遊戲中';
    if (!me.alive) return '死者不能行動';

    switch (a.type) {
      case 'PICK_ROLE':
        return this.pickRole(me, a.role);
      case 'DAWN_GIVE_CAT':
        return this.dawnGiveCat(me, a.target);
      case 'DRAW':
        return this.draw(me);
      case 'DRAW_DISCARD':
        return this.drawDiscard(me, a.cardIds);
      case 'ARRANGE_START':
        return this.arrangeStart(me);
      case 'ARRANGE_DECK':
        return this.arrangeDeck(me, a.order);
      case 'SALVAGE':
        return this.salvagePick(me, a.cardIds);
      case 'PLAY_CARD':
        return this.playCard(me, a);
      case 'END_TURN':
        return this.endTurnAction(me);
      case 'CHOOSE_REVEAL':
        return this.chooseReveal(me, a.tryalId);
      case 'WITCH_VOTE':
        return this.witchVote(me, a.target);
      case 'CONSTABLE_GAVEL':
        return this.constableGavel(me, a.target);
      case 'CONFESS':
        return this.confess(me, a.tryalId);
      case 'NIGHT_PASS':
        return this.nightPass(me);
      case 'CONSPIRACY_PICK':
        return this.conspiracyPick(me, a.tryalId);
      default:
        return '未知的動作';
    }
  }

  timeout(): string | undefined {
    const ph = this.s.phase;
    switch (ph.kind) {
      case 'roles':
        for (const pid of Object.keys(ph.offers)) ph.picks[pid] ??= ph.offers[pid]![0]!;
        this.finishRoles();
        return;
      case 'dawn':
        this.resolveDawn();
        return;
      case 'turn':
        if (this.s.turn.mode === 'idle') {
          this.log(`${this.name(this.s.turn.player)} 時間到，自動抽牌`);
          return this.draw(this.p(this.s.turn.player));
        }
        this.endTurn();
        return;
      case 'reveal': {
        const t = this.rng.pick(unrevealed(this.p(ph.target)));
        return this.chooseReveal(this.p(ph.chooser), t.id);
      }
      case 'arrange':
        // Keep the current order and draw
        return this.arrangeDeck(this.p(ph.player), this.s.deck.filter((c) => c.type !== 'night').map((c) => c.id));
      case 'salvage': {
        const cur = this.s.salvage[0]!;
        return this.salvagePick(this.p(cur.chooser), cur.cards.slice(0, SALVAGE_MAX).map((c) => c.id));
      }
      case 'night':
        if (ph.step === 'witches') this.finishWitchStep();
        else if (ph.step === 'constable') this.enterConfess();
        else this.resolveNight();
        return;
      case 'conspiracy':
        for (const pid of conspiracyPickers(this.s)) {
          if (!ph.picks[pid]) ph.picks[pid] = this.rng.pick(unrevealed(this.p(nextAlive(this.s, pid)))).id;
        }
        this.resolveConspiracy();
        return;
      case 'game_over':
        return;
    }
  }

  // ----- Town Hall characters -----

  pickRole(me: Player, role: RoleId): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'roles') return '現在不是選角色的時間';
    if (!ph.offers[me.id]?.includes(role)) return '請從發給你的角色中選一位';
    ph.picks[me.id] = role;
    if (Object.keys(ph.offers).every((pid) => ph.picks[pid])) this.finishRoles();
  }

  finishRoles() {
    const ph = this.s.phase;
    if (ph.kind !== 'roles') return;
    for (const [pid, role] of Object.entries(ph.picks)) this.p(pid).role = role;
    this.log(
      `角色公開：${this.s.seats.map((id) => `${this.name(id)}＝${ROLES[this.p(id).role!].name}`).join('、')}`,
    );
    this.setPhase({ kind: 'dawn', votes: {} });
  }

  /** Called after each action: if John Proctor has a pending pick, interrupt whatever phase we are in */
  startSalvage() {
    if (this.over) {
      // Cards still waiting for Proctor go to the discard pile so the card count stays whole
      for (const sv of this.s.salvage.splice(0)) this.s.discard.push(...sv.cards);
      return;
    }
    if (this.s.phase.kind === 'salvage') return;
    while (this.s.salvage.length) {
      const sv = this.s.salvage[0]!;
      if (this.p(sv.chooser).alive && sv.cards.length) {
        this.setPhase({ kind: 'salvage', resume: this.s.phase });
        this.log(`${this.roleLabel(sv.chooser, 'proctor')} 正在挑選 ${this.name(sv.from)} 留下的手牌`);
        return;
      }
      this.s.discard.push(...sv.cards);
      this.s.salvage.shift();
    }
  }

  salvagePick(me: Player, cardIds: string[]): string | undefined {
    const ph = this.s.phase;
    const sv = this.s.salvage[0];
    if (ph.kind !== 'salvage' || !sv) return '現在不能挑牌';
    if (sv.chooser !== me.id) return '不是由你挑牌';
    const ids = new Set(cardIds);
    if (ids.size > SALVAGE_MAX) return `最多只能拿 ${SALVAGE_MAX} 張`;
    if ([...ids].some((id) => !sv.cards.some((c) => c.id === id))) return '只能挑死者留下的牌';
    const kept = sv.cards.filter((c) => ids.has(c.id));
    me.hand.push(...kept);
    this.s.discard.push(...sv.cards.filter((c) => !ids.has(c.id)));
    this.s.salvage.shift();
    this.log(`${me.name} 從 ${this.name(sv.from)} 的遺物中拿了 ${kept.length} 張牌`);
    this.setPhase(ph.resume);
    // startSalvage (run after every action) opens the next pending pick, if any
  }

  // ----- Win and death -----

  checkWin(): boolean {
    const allTryals = Object.values(this.s.players).flatMap((p) => p.tryals);
    if (allTryals.filter((t) => t.kind === 'witch').every((t) => t.revealed)) {
      this.setPhase({ kind: 'game_over', winner: 'town' });
      this.log('所有女巫牌都已揭露，鎮民獲勝！');
      return true;
    }
    const alive = alivePlayers(this.s);
    if (alive.every((p) => p.everWitch)) {
      this.setPhase({ kind: 'game_over', winner: 'witches' });
      this.log('存活者全都是女巫，女巫獲勝！');
      return true;
    }
    return false;
  }

  kill(pid: PlayerId, cause: string) {
    const pl = this.p(pid);
    if (!pl.alive) return;
    const partner = matchmakerPartner(this.s, pid);
    pl.alive = false;
    for (const t of pl.tryals) t.revealed = true;
    this.s.discard.push(...pl.front);
    // John Proctor (the first one clockwise from the dead player) gets to pick from the dead player's hand
    const proctor = pl.hand.length ? this.findClockwise(pid, (id) => this.has(id, 'proctor')) : undefined;
    if (proctor) this.s.salvage.push({ chooser: proctor, from: pid, cards: pl.hand });
    else this.s.discard.push(...pl.hand);
    pl.hand = [];
    pl.front = [];
    this.log(`${pl.name} 死亡（${cause}）。曾經是女巫：${pl.everWitch ? '是' : '否'}`);
    // Rulebook: a matched partner dies a split-second later, so decide the win first
    if (this.checkWin()) return;
    if (partner) this.kill(partner, '情侶殉情');
    if (this.over) return;
    if (alivePlayers(this.s).length === 2) this.enterEndgame();
  }

  findClockwise(from: PlayerId, pred: (id: PlayerId) => boolean): PlayerId | undefined {
    const n = this.s.seats.length;
    const start = this.s.seats.indexOf(from);
    for (let i = 1; i < n; i++) {
      const id = this.s.seats[(start + i) % n]!;
      if (this.p(id).alive && pred(id)) return id;
    }
    return undefined;
  }

  /** With 2 players left, all blue cards are removed from the game */
  enterEndgame() {
    if (this.endgameAnnounced) return;
    this.endgameAnnounced = true;
    for (const pl of alivePlayers(this.s)) {
      const blues = pl.front.filter((c) => isBlue(c.type));
      if (blues.length === 0) continue;
      pl.front = pl.front.filter((c) => !isBlue(c.type));
      this.s.removed.push(...blues);
    }
    this.log('只剩兩名玩家：所有藍牌移出遊戲，嫁禍與搶劫無法使用');
  }

  revealTryal(pid: PlayerId, tryalId: string, reason: string) {
    const pl = this.p(pid);
    const t = pl.tryals.find((x) => x.id === tryalId);
    if (!t || t.revealed) return;
    t.revealed = true;
    this.log(`${pl.name} 的審判牌被翻開（${reason}）：${TRYAL_NAME[t.kind]}`);
    if (t.kind === 'witch') this.kill(pid, '揭露女巫牌');
    else if (unrevealed(pl).length === 0) this.kill(pid, '審判牌全部翻開');
    else this.checkWin();
  }

  // ----- Dawn -----

  dawnGiveCat(me: Player, target: PlayerId): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'dawn') return '現在不是黎明';
    if (!me.everWitch) return '只有女巫能放黑貓';
    if (!this.s.players[target]?.alive) return '目標無效';
    ph.votes[me.id] = target;
    this.log(`${me.name} 想把黑貓給 ${this.name(target)}`, aliveWitches(this.s).map((p) => p.id));
    if (aliveWitches(this.s).every((w) => ph.votes[w.id])) this.resolveDawn();
  }

  resolveDawn() {
    const ph = this.s.phase;
    if (ph.kind !== 'dawn') return;
    const target = this.majority(ph.votes, alivePlayers(this.s).map((p) => p.id));
    const catIdx = this.s.removed.findIndex((c) => c.type === 'black_cat');
    const [cat] = this.s.removed.splice(catIdx, 1);
    this.p(target).front.push(cat!);
    this.log(`黎明：黑貓出現在 ${this.name(target)} 面前`);
    this.startTurn(target);
  }

  // ----- Turns -----

  startTurn(pid: PlayerId) {
    let cur = pid;
    // Stocks: skip the turn and discard one stocks card; each skip removes one card, so this always terminates
    for (;;) {
      const pl = this.p(cur);
      const i = pl.front.findIndex((c) => c.type === 'stocks');
      if (i < 0) break;
      const [stocks] = pl.front.splice(i, 1);
      this.s.discard.push(stocks!);
      this.log(`${pl.name} 被拘留，跳過這回合`);
      cur = nextAlive(this.s, cur);
    }
    this.s.turn = { player: cur, mode: 'idle', drawsLeft: 0, accusationsDrawn: 0, bonusDrawn: false };
    this.setPhase({ kind: 'turn' });
  }

  endTurn() {
    this.startTurn(nextAlive(this.s, this.s.turn.player));
  }

  /** Called after any interrupt (night, conspiracy, reveal) finishes, to continue the current turn */
  continueTurn() {
    if (this.over) return;
    const turn = this.s.turn;
    if (!this.p(turn.player).alive) {
      this.endTurn();
      return;
    }
    if (turn.mode !== 'drawing') {
      this.setPhase({ kind: 'turn' });
      return;
    }
    for (;;) {
      while (turn.drawsLeft > 0) {
        turn.drawsLeft--;
        const card = this.drawOne();
        if (!card) break;
        if (card.type === 'night' || card.type === 'conspiracy') {
          this.handleBlack(card);
          return;
        }
        if (card.type === 'accusation') turn.accusationsDrawn++;
        this.p(turn.player).hand.push(card);
      }
      // Giles Corey: two accusations in one draw are shown and he draws one more
      if (turn.accusationsDrawn >= 2 && !turn.bonusDrawn && this.has(turn.player, 'giles')) {
        turn.bonusDrawn = true;
        turn.drawsLeft = 1;
        this.log(`${this.roleLabel(turn.player, 'giles')} 抽到兩張指控，展示後再抽一張`);
        continue;
      }
      break;
    }
    this.endTurn();
  }

  drawOne(): Card | undefined {
    for (;;) {
      if (this.s.deck.length === 0) {
        if (this.s.discard.length === 0) return undefined;
        this.s.deck = this.rng.shuffle(this.s.discard);
        this.s.discard = [];
      }
      // Extreme case: right after a night, the deck is only the night card again; stop drawing to avoid back-to-back nights
      if (this.s.deck.length === 1 && this.s.deck[0]!.type === 'night' && this.s.phase.kind === 'night') return undefined;
      const c = this.s.deck.shift()!;
      if (alivePlayers(this.s).length === 2 && isDisabledInEndgame(c.type)) {
        this.s.removed.push(c);
        continue;
      }
      return c;
    }
  }

  /** Draw for an ability (Ann Putnam, Rebecca Nurse): black cards go back into the deck and are not resolved */
  drawForAbility(pl: Player, count: number) {
    let got = 0;
    const setAside: Card[] = [];
    while (got < count) {
      const c = this.drawOne();
      if (!c) break;
      if (CARD_COLOR[c.type] === 'black') {
        setAside.push(c);
        continue;
      }
      pl.hand.push(c);
      got++;
    }
    for (const c of setAside) {
      if (c.type === 'night') this.s.deck.push(c);
      else this.s.deck.splice(this.rng.int(this.deckTopLength() + 1), 0, c);
    }
    return got;
  }

  /** Length of the deck above a night card sitting at the bottom */
  deckTopLength() {
    const d = this.s.deck;
    return d.length && d[d.length - 1]!.type === 'night' ? d.length - 1 : d.length;
  }

  draw(me: Player): string | undefined {
    if (this.s.phase.kind !== 'turn') return '現在不能抽牌';
    if (this.s.turn.player !== me.id) return '還沒輪到你';
    if (this.s.turn.mode !== 'idle') return '這回合已經出過牌，不能抽牌';
    this.s.turn.mode = 'drawing';
    this.s.turn.drawsLeft = 2;
    this.log(`${me.name} 選擇抽兩張牌`);
    this.continueTurn();
  }

  drawDiscard(me: Player, cardIds: string[]): string | undefined {
    if (this.s.phase.kind !== 'turn') return '現在不能抽牌';
    if (this.s.turn.player !== me.id) return '還沒輪到你';
    if (this.s.turn.mode !== 'idle') return '這回合已經出過牌，不能抽牌';
    if (usesLeft(this.s, me.id, 'parris') <= 0) return '你不能使用這個能力';
    const ids = [...new Set(cardIds)];
    if (ids.length === 0 || ids.length > PARRIS_MAX) return `請從棄牌堆選 1–${PARRIS_MAX} 張牌`;
    const picked = ids.map((id) => this.s.discard.find((c) => c.id === id));
    if (picked.some((c) => !c || CARD_COLOR[c.type] === 'black')) return '只能選棄牌堆裡的非黑牌';
    if (alivePlayers(this.s).length === 2 && picked.some((c) => isDisabledInEndgame(c!.type))) return '只剩兩人時不能拿這張牌';
    this.s.discard = this.s.discard.filter((c) => !ids.includes(c.id));
    me.hand.push(...(picked as Card[]));
    this.useAbility(me, 'parris');
    this.s.turn.mode = 'drawing';
    this.log(`${this.roleLabel(me.id, 'parris')} 從棄牌堆拿了 ${picked.map((c) => `「${CARD_NAME[c!.type]}」`).join('')}`);
    this.endTurn();
  }

  arrangeStart(me: Player): string | undefined {
    if (this.s.phase.kind !== 'turn') return '現在不能這樣做';
    if (this.s.turn.player !== me.id) return '還沒輪到你';
    if (this.s.turn.mode !== 'idle') return '這回合已經出過牌';
    if (usesLeft(this.s, me.id, 'tituba') <= 0) return '你不能使用這個能力';
    this.useAbility(me, 'tituba');
    this.log(`${this.roleLabel(me.id, 'tituba')} 查看並重排牌堆`);
    this.setPhase({ kind: 'arrange', player: me.id });
  }

  arrangeDeck(me: Player, order: string[]): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'arrange' || ph.player !== me.id) return '現在不能重排牌堆';
    const movable = this.s.deck.filter((c) => c.type !== 'night');
    const byId = new Map(movable.map((c) => [c.id, c]));
    if (order.length !== movable.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
      return '請排列牌堆裡的每一張牌（夜晚固定在最底）';
    }
    const nights = this.s.deck.filter((c) => c.type === 'night');
    this.s.deck = [...order.map((id) => byId.get(id)!), ...nights];
    this.setPhase({ kind: 'turn' });
    return this.draw(me);
  }

  endTurnAction(me: Player): string | undefined {
    if (this.s.phase.kind !== 'turn') return '現在不能結束回合';
    if (this.s.turn.player !== me.id) return '還沒輪到你';
    if (this.s.turn.mode !== 'playing') return '至少要出一張牌，或選擇抽牌';
    this.endTurn();
  }

  // ----- Playing cards -----

  playCard(me: Player, a: Extract<Action, { type: 'PLAY_CARD' }>): string | undefined {
    if (this.s.phase.kind !== 'turn') return '現在不能出牌';
    if (this.s.turn.player !== me.id) return '還沒輪到你';
    if (this.s.turn.mode === 'drawing') return '這回合已經選擇抽牌';
    const idx = me.hand.findIndex((c) => c.id === a.cardId);
    if (idx < 0) return '手上沒有這張牌';
    const card = me.hand[idx]!;
    const target = this.s.players[a.target];
    if (!target?.alive) return '目標無效';
    if (target.id === me.id) return '不能對自己出牌';
    if (alivePlayers(this.s).length === 2 && isDisabledInEndgame(card.type)) return '只剩兩人時不能使用這張牌';

    // Will Griggs plays an Alibi as a Witness (a rejected play discards the cloned state, so marking early is safe)
    if (a.asWitness) {
      if (card.type !== 'alibi' || !this.has(me.id, 'griggs')) return '只有 Will Griggs 能把辯護當作目擊';
      card.as = 'witness';
    }
    const type = effectiveType(card);

    if ((type === 'arson' || type === 'robbery') && this.has(target.id, 'sarah')) {
      return `搶劫、縱火對 ${this.roleLabel(target.id, 'sarah')} 無效`;
    }

    let second: Player | undefined;
    if (type === 'robbery' || type === 'scapegoat') {
      second = a.secondTarget ? this.s.players[a.secondTarget] : undefined;
      if (!second?.alive) return '需要指定第二位目標';
      if (second.id === me.id) return '不能把牌轉給自己';
      if (second.id === target.id) return '兩位目標必須不同';
    }

    // Validate effect preconditions before removing the card from the hand
    if (isRed(type) && target.front.some((c) => c.type === 'piety')) return '信徒不能被打紅牌';
    let curseTarget: Card | undefined;
    if (type === 'curse') {
      curseTarget = target.front.find((c) => c.id === a.targetCardId && isBlue(c.type));
      if (!curseTarget) return '請指定目標面前的一張藍牌';
    }
    if (type === 'alibi' && !target.front.some((c) => c.type === 'accusation' || c.type === 'evidence')) {
      return '目標身上沒有可移除的指控';
    }

    me.hand.splice(idx, 1);
    this.s.turn.mode = 'playing';
    const label = `${me.name} 對 ${target.name} 打出「${CARD_NAME[card.type]}」${card.as ? `當作「${CARD_NAME[card.as]}」` : ''}`;

    if (isRed(type)) {
      target.front.push(card);
      this.log(`${label}（累計 ${accusationTotal(target, this.s)} 點）`);
      this.checkAccusations(target, me.id);
      return;
    }
    if (isBlue(type)) {
      target.front.push(card);
      this.log(label);
      this.dedupeMatchmaker(target);
      return;
    }

    this.s.discard.push(card);
    switch (type) {
      case 'alibi': {
        let removed = 0;
        target.front = target.front.filter((c) => {
          if (removed < 3 && c.type === 'accusation') {
            removed++;
            this.s.discard.push(c);
            return false;
          }
          return true;
        });
        if (removed === 0) {
          const i = target.front.findIndex((c) => c.type === 'evidence');
          this.s.discard.push(...target.front.splice(i, 1));
        }
        this.log(`${label}，移除部分指控（剩 ${accusationTotal(target, this.s)} 點）`);
        break;
      }
      case 'arson':
        this.s.discard.push(...target.hand);
        this.log(`${label}，燒掉 ${target.hand.length} 張手牌`);
        target.hand = [];
        break;
      case 'curse':
        target.front = target.front.filter((c) => c !== curseTarget);
        this.s.discard.push(curseTarget!);
        this.log(`${label}，棄掉「${CARD_NAME[curseTarget!.type]}」`);
        break;
      case 'robbery':
        this.log(`${label}，${target.hand.length} 張手牌全部交給 ${second!.name}`);
        second!.hand.push(...target.hand);
        target.hand = [];
        break;
      case 'scapegoat': {
        const moved = target.front;
        target.front = [];
        second!.front.push(...moved);
        this.log(`${label}，面前 ${moved.length} 張牌全部轉移給 ${second!.name}`);
        this.dedupeMatchmaker(second!);
        this.checkAccusations(second!, me.id);
        break;
      }
    }
  }

  /** Two matchmakers on the same player are both discarded */
  dedupeMatchmaker(pl: Player) {
    const mm = pl.front.filter((c) => c.type === 'matchmaker');
    if (mm.length < 2) return;
    pl.front = pl.front.filter((c) => c.type !== 'matchmaker');
    this.s.discard.push(...mm);
    this.log(`${pl.name} 身上有兩張情侶，全部棄掉`);
  }

  checkAccusations(target: Player, accuser: PlayerId) {
    const threshold = accusationThreshold(this.s, target.id, accuser);
    if (accusationTotal(target, this.s) >= threshold && unrevealed(target).length > 0) {
      this.log(`${target.name} 累積 ${threshold} 點指控，${this.name(accuser)} 要選一張審判牌翻開`);
      this.setPhase({ kind: 'reveal', chooser: accuser, target: target.id, then: 'resume' });
      // Ann Putnam: draws 2 as soon as she starts a trial
      if (this.has(accuser, 'ann')) {
        const n = this.drawForAbility(this.p(accuser), 2);
        this.log(`${this.roleLabel(accuser, 'ann')} 發起審判，抽了 ${n} 張牌`);
      }
    }
  }

  chooseReveal(me: Player, tryalId: string): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'reveal') return '現在不需要選審判牌';
    if (ph.chooser !== me.id) return '不是由你選擇';
    const target = this.p(ph.target);
    if (!target.tryals.some((t) => t.id === tryalId && !t.revealed)) return '請選一張未翻開的審判牌';

    const trial = ph.then === 'resume';
    if (trial) {
      // After an accusation reveal, discard all red cards; overflow does not carry over
      const reds = target.front.filter((c) => isRed(effectiveType(c)));
      target.front = target.front.filter((c) => !isRed(effectiveType(c)));
      this.s.discard.push(...reds);
    }
    const then = ph.then;
    this.revealTryal(target.id, tryalId, trial ? '審判' : '黑貓');
    if (this.over) return;
    if (trial) this.afterTrial(me.id, target.id);
    if (then === 'conspiracy_pass') this.startConspiracyPass();
    else this.continueTurn();
  }

  afterTrial(chooser: PlayerId, target: PlayerId) {
    // Abigail Williams: her own red cards are discarded after a trial she started
    if (this.has(chooser, 'abigail')) {
      const pl = this.p(chooser);
      const reds = pl.front.filter((c) => isRed(effectiveType(c)));
      if (reds.length) {
        pl.front = pl.front.filter((c) => !isRed(effectiveType(c)));
        this.s.discard.push(...reds);
        this.log(`${this.roleLabel(chooser, 'abigail')} 丟棄自己面前的 ${reds.length} 張紅牌`);
      }
    }
    // Rebecca Nurse: draws 1 whenever someone else's tryal is revealed by a trial
    for (const id of this.s.seats) {
      if (id === target || !this.has(id, 'rebecca')) continue;
      const n = this.drawForAbility(this.p(id), 1);
      if (n) this.log(`${this.roleLabel(id, 'rebecca')} 抽了 1 張牌`);
    }
  }

  // ----- Black cards -----

  handleBlack(card: Card) {
    if (card.type === 'night') {
      this.log('夜晚降臨，所有人閉上眼睛…');
      this.s.removed.push(card);
      this.setPhase({ kind: 'night', step: 'witches', votes: {}, victim: null, gavel: null, confessed: [], passed: [] });
      return;
    }
    this.s.discard.push(card);
    this.log(`${this.name(this.s.turn.player)} 抽到「傳染」！`);
    const cat = blackCatHolder(this.s);
    if (cat && this.has(cat.id, 'mary')) {
      this.log(`黑貓對 ${this.roleLabel(cat.id, 'mary')} 無效`);
      this.startConspiracyPass();
    } else if (cat && unrevealed(cat).length > 0) {
      this.setPhase({ kind: 'reveal', chooser: this.s.turn.player, target: cat.id, then: 'conspiracy_pass' });
    } else {
      this.startConspiracyPass();
    }
  }

  // ----- Conspiracy -----

  startConspiracyPass() {
    this.setPhase({ kind: 'conspiracy', picks: {} });
    this.log('傳染：每個人從左手邊玩家拿走一張蓋著的審判牌');
    if (conspiracyPickers(this.s).length === 0) this.resolveConspiracy();
  }

  conspiracyPick(me: Player, tryalId: string): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'conspiracy') return '現在不是傳染階段';
    if (!conspiracyPickers(this.s).includes(me.id)) return '你這次不需要拿牌';
    const left = this.p(nextAlive(this.s, me.id));
    if (!left.tryals.some((t) => t.id === tryalId && !t.revealed)) return '請選左手邊玩家一張未翻開的審判牌';
    ph.picks[me.id] = tryalId;
    if (conspiracyPickers(this.s).every((pid) => ph.picks[pid])) this.resolveConspiracy();
  }

  resolveConspiracy() {
    const ph = this.s.phase;
    if (ph.kind !== 'conspiracy') return;
    // Take simultaneously: remove every picked card first, then hand them out
    const moves = Object.entries(ph.picks).map(([picker, tryalId]) => {
      const from = this.p(nextAlive(this.s, picker));
      const i = from.tryals.findIndex((t) => t.id === tryalId);
      const [tryal] = from.tryals.splice(i, 1);
      return { picker, tryal: tryal! };
    });
    for (const { picker, tryal } of moves) {
      const pl = this.p(picker);
      pl.tryals.push(tryal);
      if (tryal.kind === 'witch' && !pl.everWitch) pl.everWitch = true;
      this.log(`你拿到的審判牌是：${TRYAL_NAME[tryal.kind]}`, [picker]);
    }
    // A player who lost a card without gaining one could be left with no unrevealed tryals
    for (const pl of alivePlayers(this.s)) {
      if (unrevealed(pl).length === 0) this.kill(pl.id, '審判牌全部翻開');
      if (this.over) return;
    }
    if (this.checkWin()) return;
    this.continueTurn();
  }

  // ----- Night -----

  witchVote(me: Player, target: PlayerId): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'night' || ph.step !== 'witches') return '現在不是女巫行動的時間';
    if (!me.everWitch) return '只有女巫能投票';
    if (!this.s.players[target]?.alive) return '目標無效';
    ph.votes[me.id] = target;
    this.log(`${me.name} 投票殺 ${this.name(target)}`, aliveWitches(this.s).map((p) => p.id));
    if (aliveWitches(this.s).every((w) => ph.votes[w.id])) this.finishWitchStep();
  }

  finishWitchStep() {
    const ph = this.s.phase;
    if (ph.kind !== 'night') return;
    const nonWitches = alivePlayers(this.s).filter((p) => !p.everWitch).map((p) => p.id);
    ph.victim = this.majority(ph.votes, nonWitches.length ? nonWitches : alivePlayers(this.s).map((p) => p.id));
    this.log(`女巫決定今晚的目標：${this.name(ph.victim)}`, aliveWitches(this.s).map((p) => p.id));
    if (currentConstable(this.s)) ph.step = 'constable';
    else this.enterConfess();
  }

  constableGavel(me: Player, target: PlayerId): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'night' || ph.step !== 'constable') return '現在不是警長行動的時間';
    if (currentConstable(this.s)?.id !== me.id) return '你不是警長';
    if (target === me.id) return '警長不能保護自己';
    if (!this.s.players[target]?.alive) return '目標無效';
    ph.gavel = target;
    this.log(`你把法槌交給了 ${this.name(target)}`, [me.id]);
    this.enterConfess();
  }

  enterConfess() {
    const ph = this.s.phase;
    if (ph.kind !== 'night') return;
    ph.step = 'confess';
    this.log('天亮了。在公布死者前，任何人都可以自首（翻開自己一張審判牌，換取今晚免死）');
  }

  confess(me: Player, tryalId: string | undefined): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'night' || ph.step !== 'confess') return '現在不能自首';
    if (ph.passed.includes(me.id)) return '你已經做過決定了';
    if (tryalId === undefined) {
      // William Phips: confess without revealing
      if (usesLeft(this.s, me.id, 'phips') <= 0) return '請選自己一張未翻開的審判牌';
      this.useAbility(me, 'phips');
      ph.confessed.push(me.id);
      ph.passed.push(me.id);
      this.log(`${this.roleLabel(me.id, 'phips')} 選擇自首，不必翻牌`);
      this.maybeResolveNight();
      return;
    }
    if (!me.tryals.some((t) => t.id === tryalId && !t.revealed)) return '請選自己一張未翻開的審判牌';
    ph.confessed.push(me.id);
    ph.passed.push(me.id);
    this.log(`${me.name} 選擇自首`);
    this.revealTryal(me.id, tryalId, '自首');
    if (this.over) return;
    this.maybeResolveNight();
  }

  nightPass(me: Player): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'night' || ph.step !== 'confess') return '現在不能這樣做';
    if (ph.passed.includes(me.id)) return '你已經做過決定了';
    ph.passed.push(me.id);
    this.maybeResolveNight();
  }

  maybeResolveNight() {
    const ph = this.s.phase;
    if (ph.kind !== 'night') return;
    if (alivePlayers(this.s).every((p) => ph.passed.includes(p.id))) this.resolveNight();
  }

  resolveNight() {
    const ph = this.s.phase;
    if (ph.kind !== 'night') return;
    if (ph.gavel) this.log(`法槌放在 ${this.name(ph.gavel)} 面前`);
    const victim = ph.victim ? this.p(ph.victim) : undefined;
    if (victim?.alive) {
      const saved =
        ph.gavel === victim.id
          ? '法槌保護'
          : ph.confessed.includes(victim.id)
            ? '自首'
            : victim.front.some((c) => c.type === 'asylum')
              ? '避難'
              : null;
      if (saved) this.log(`女巫的目標是 ${victim.name}，但因為${saved}而存活`);
      else this.kill(victim.id, '夜晚被女巫殺害');
    } else {
      this.log('今晚沒有人死亡');
    }
    if (this.over) return;

    // Shuffle the discard pile into a new deck, night back at the bottom
    const ni = this.s.removed.findIndex((c) => c.type === 'night');
    const [night] = this.s.removed.splice(ni, 1);
    this.s.deck = this.rng.shuffle([...this.s.deck, ...this.s.discard]);
    this.s.discard = [];
    this.s.deck.push(night!);
    this.continueTurn();
  }

  // ----- Utilities -----

  /** Majority of votes; ties are broken randomly; with no votes, pick randomly from the fallback */
  majority(votes: Record<PlayerId, PlayerId>, fallback: PlayerId[]): PlayerId {
    const counts = new Map<PlayerId, number>();
    for (const t of Object.values(votes)) {
      if (this.s.players[t]?.alive) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    if (counts.size === 0) return this.rng.pick(fallback);
    const max = Math.max(...counts.values());
    return this.rng.pick([...counts].filter(([, c]) => c === max).map(([id]) => id));
  }
}
