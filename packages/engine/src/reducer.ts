import { ACCUSATION_THRESHOLD, ACCUSATION_VALUE, CARD_NAME, isBlue, isDisabledInEndgame, isRed } from './cards';
import { Rng } from './rng';
import type {
  Action,
  ActionEnvelope,
  Card,
  GameEvent,
  GameState,
  Phase,
  Player,
  PlayerId,
  ReduceResult,
  Tryal,
} from './types';

const TRYAL_NAME: Record<Tryal['kind'], string> = {
  witch: '女巫',
  constable: '警長',
  not_a_witch: '平民',
};

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

export function accusationTotal(p: Player): number {
  return p.front.reduce((sum, c) => sum + (ACCUSATION_VALUE[c.type] ?? 0), 0);
}

export function unrevealed(p: Player): Tryal[] {
  return p.tryals.filter((t) => !t.revealed);
}

/** Matchmaker partner: exactly two different players each have a matchmaker in front of them */
export function matchmakerPartner(s: GameState, pid: PlayerId): PlayerId | undefined {
  const holders = alivePlayers(s).filter((p) => p.front.some((c) => c.type === 'matchmaker'));
  if (holders.length !== 2) return undefined;
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

/** Seconds allowed for each phase; the server schedules a TIMEOUT from this */
export function phaseTimeoutSeconds(s: GameState): number | null {
  const p = s.phase;
  switch (p.kind) {
    case 'dawn':
      return 30;
    case 'turn':
      return 90;
    case 'reveal':
      return 20;
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
      case 'DAWN_GIVE_CAT':
        return this.dawnGiveCat(me, a.target);
      case 'DRAW':
        return this.draw(me);
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
    }
  }

  timeout(): string | undefined {
    const ph = this.s.phase;
    switch (ph.kind) {
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
    this.s.discard.push(...pl.hand, ...pl.front);
    pl.hand = [];
    pl.front = [];
    this.log(`${pl.name} 死亡（${cause}）。曾經是女巫：${pl.everWitch ? '是' : '否'}`);
    // Rulebook: a matched partner dies a split-second later, so decide the win first
    if (this.checkWin()) return;
    if (partner) this.kill(partner, '情侶殉情');
    if (this.over) return;
    if (alivePlayers(this.s).length === 2) this.enterEndgame();
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
    this.s.turn = { player: cur, mode: 'idle', drawsLeft: 0 };
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
    while (turn.drawsLeft > 0) {
      turn.drawsLeft--;
      const card = this.drawOne();
      if (!card) break;
      if (card.type === 'night' || card.type === 'conspiracy') {
        this.handleBlack(card);
        return;
      }
      this.p(turn.player).hand.push(card);
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

  draw(me: Player): string | undefined {
    if (this.s.phase.kind !== 'turn') return '現在不能抽牌';
    if (this.s.turn.player !== me.id) return '還沒輪到你';
    if (this.s.turn.mode !== 'idle') return '這回合已經出過牌，不能抽牌';
    this.s.turn.mode = 'drawing';
    this.s.turn.drawsLeft = 2;
    this.log(`${me.name} 選擇抽兩張牌`);
    this.continueTurn();
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

    let second: Player | undefined;
    if (card.type === 'robbery' || card.type === 'scapegoat') {
      second = a.secondTarget ? this.s.players[a.secondTarget] : undefined;
      if (!second?.alive) return '需要指定第二位目標';
      if (second.id === me.id) return '不能把牌轉給自己';
      if (second.id === target.id) return '兩位目標必須不同';
    }

    // Validate effect preconditions before removing the card from the hand
    if (isRed(card.type) && target.front.some((c) => c.type === 'piety')) return '信徒不能被打紅牌';
    let curseTarget: Card | undefined;
    if (card.type === 'curse') {
      curseTarget = target.front.find((c) => c.id === a.targetCardId && isBlue(c.type));
      if (!curseTarget) return '請指定目標面前的一張藍牌';
    }
    if (card.type === 'alibi' && !target.front.some((c) => c.type === 'accusation' || c.type === 'evidence')) {
      return '目標身上沒有可移除的指控';
    }

    me.hand.splice(idx, 1);
    this.s.turn.mode = 'playing';
    const label = `${me.name} 對 ${target.name} 打出「${CARD_NAME[card.type]}」`;

    if (isRed(card.type)) {
      target.front.push(card);
      this.log(`${label}（累計 ${accusationTotal(target)} 點）`);
      this.checkAccusations(target, me.id);
      return;
    }
    if (isBlue(card.type)) {
      target.front.push(card);
      this.log(label);
      this.dedupeMatchmaker(target);
      return;
    }

    this.s.discard.push(card);
    switch (card.type) {
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
        this.log(`${label}，移除部分指控（剩 ${accusationTotal(target)} 點）`);
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
    if (accusationTotal(target) >= ACCUSATION_THRESHOLD && unrevealed(target).length > 0) {
      this.log(`${target.name} 累積 ${ACCUSATION_THRESHOLD} 點指控，${this.name(accuser)} 要選一張審判牌翻開`);
      this.setPhase({ kind: 'reveal', chooser: accuser, target: target.id, then: 'resume' });
    }
  }

  chooseReveal(me: Player, tryalId: string): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'reveal') return '現在不需要選審判牌';
    if (ph.chooser !== me.id) return '不是由你選擇';
    const target = this.p(ph.target);
    if (!target.tryals.some((t) => t.id === tryalId && !t.revealed)) return '請選一張未翻開的審判牌';

    if (ph.then === 'resume') {
      // After an accusation reveal, discard all red cards; overflow does not carry over
      const reds = target.front.filter((c) => isRed(c.type));
      target.front = target.front.filter((c) => !isRed(c.type));
      this.s.discard.push(...reds);
    }
    const then = ph.then;
    this.revealTryal(target.id, tryalId, then === 'resume' ? '審判' : '黑貓');
    if (this.over) return;
    if (then === 'conspiracy_pass') this.startConspiracyPass();
    else this.continueTurn();
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
    if (cat && unrevealed(cat).length > 0) {
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

  confess(me: Player, tryalId: string): string | undefined {
    const ph = this.s.phase;
    if (ph.kind !== 'night' || ph.step !== 'confess') return '現在不能自首';
    if (ph.passed.includes(me.id)) return '你已經做過決定了';
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
