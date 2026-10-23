import { useEffect, useRef, useState } from 'react';
import { CARD_COLOR, CARD_NAME, PARRIS_MAX, ROLES, SALVAGE_MAX, candidateActions, type Action, type Card, type CardType, type PlayerId, type PlayerView } from '@salem/engine';
import type { ClientSnapshot, Connection, Send } from './net';
import { LogPanel } from './LogPanel';
import { CardList, PlayerRow, RoleChip, isDark, phaseText } from './Table';
import { CARD_W, CardFace } from './CardFace';
import { CARD_DESC } from './text';
import { Announcer, BotModeSetting, BotPaceSetting, EventTicker, IntroSheet, useHits } from './Feedback';

interface Props {
  snap: ClientSnapshot;
  view: PlayerView;
  act: (a: Action) => void;
  send: Send;
  error: string | null;
  connection: Connection;
  onLeave: () => void;
}

interface Selection {
  card: Card | null;
  first: PlayerId | null;
  /** Will Griggs: play the selected Alibi as a Witness */
  asWitness: boolean;
}

const NONE: Selection = { card: null, first: null, asWitness: false };

/** Hand card scale: half size on desktop, smaller on phones */
const HAND_SCALE = 0.5;
const HAND_SCALE_NARROW = 0.34;
const HAND_GAP = 8;

function useHandScale() {
  const query = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow ? HAND_SCALE_NARROW : HAND_SCALE;
}

/** When the hand doesn't fit on one row, compute how much each card should overlap the previous one (negative px); 0 when it fits */
function useHandOverlap(count: number, cardWidth: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [count > 0]);
  if (count < 2 || width === 0) return { ref, overlap: 0 };
  const need = count * cardWidth + (count - 1) * HAND_GAP;
  if (need <= width) return { ref, overlap: 0 };
  // Overlap at most 30% of a card, so the (centered) card name stays readable; beyond that the hand scrolls sideways
  const step = Math.max((width - cardWidth) / (count - 1), cardWidth * 0.7);
  return { ref, overlap: step - cardWidth - HAND_GAP };
}

/** The next living player in seat order (clockwise), matching the engine's nextAlive: the player on your left */
function leftOf(view: PlayerView): PlayerId | null {
  const n = view.seats.length;
  const start = view.seats.indexOf(view.me);
  if (start < 0) return null;
  for (let i = 1; i < n; i++) {
    const id = view.seats[(start + i) % n]!;
    if (view.players[id]!.alive) return id;
  }
  return null;
}

export function Game({ snap, view, act, send, error, connection, onLeave }: Props) {
  const [sel, setSel] = useState<Selection>(NONE);
  const [panel, setPanel] = useState<'none' | 'discard' | 'parris' | 'settings'>('none');
  /** A card whose description is on screen (tap any card, even when it isn't your turn) */
  const [info, setInfo] = useState<CardType | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const handScale = useHandScale();
  const hand = useHandOverlap(view.myHand.length, CARD_W * handScale);
  const ph = view.phase;
  const me = view.players[view.me];
  const spectator = view.spectator || !me;
  const alive = !!me?.alive;
  // Conspiracy: everyone takes a card from the player on their left, so label that player (from the reveal step on)
  const left = leftOf(view);
  const showLeft = alive && (ph.kind === 'conspiracy' || (ph.kind === 'reveal' && ph.then === 'conspiracy_pass'));
  const myTurn = ph.kind === 'turn' && view.turn.player === view.me && alive;
  const myRole = me ? me.effectiveRole : null;

  // Clear the selection when the phase or turn changes
  useEffect(() => {
    setSel(NONE);
    setPanel((p) => (p === 'parris' ? 'none' : p));
  }, [ph.kind, view.turn.player]);

  // Drop the selection if the selected card is gone (already played)
  useEffect(() => {
    if (sel.card && !view.myHand.some((c) => c.id === sel.card!.id)) setSel(NONE);
  }, [view.myHand, sel.card]);

  const isAlive = (id: PlayerId) => view.players[id]!.alive;
  const offline = new Set(snap.lobby.filter((p) => !p.connected).map((p) => p.id));
  const bots = new Set(snap.lobby.filter((p) => p.bot).map((p) => p.id));
  const pictures = new Map(snap.lobby.map((p) => [p.id, p.picture]));
  const hits = useHits(snap.log);

  // ----- Which players / cards can be clicked right now -----
  function canTargetPlayer(id: PlayerId): boolean {
    if (!isAlive(id) || !alive) return false;
    if (ph.kind === 'dawn') return ph.mustAct;
    if (ph.kind === 'night') {
      if (!ph.mustAct) return false;
      if (ph.step === 'witches') return true;
      if (ph.step === 'constable') return id !== view.me;
      return false;
    }
    if (myTurn && sel.card && id !== view.me) {
      if (sel.card.type === 'curse') return false;
      if (sel.first && id === sel.first) return false;
      return true;
    }
    return false;
  }

  function canPickTryal(owner: PlayerId): boolean {
    if (!alive) return false;
    if (ph.kind === 'reveal') return ph.chooser === view.me && owner === ph.target;
    if (ph.kind === 'conspiracy') return ph.mustPick && owner === ph.leftOf;
    if (ph.kind === 'night') return ph.step === 'confess' && ph.mustAct && owner === view.me;
    return false;
  }

  function canPickFront(owner: PlayerId, c: Card): boolean {
    return myTurn && sel.card?.type === 'curse' && owner !== view.me && CARD_COLOR[c.type] === 'blue';
  }

  // ----- Click handling -----
  function onPlayer(id: PlayerId) {
    if (!canTargetPlayer(id)) return;
    if (ph.kind === 'dawn') return act({ type: 'DAWN_GIVE_CAT', target: id });
    if (ph.kind === 'night') {
      return act(ph.step === 'witches' ? { type: 'WITCH_VOTE', target: id } : { type: 'CONSTABLE_GAVEL', target: id });
    }
    const card = sel.card!;
    const extra = sel.asWitness ? { asWitness: true } : {};
    if (!sel.asWitness && (card.type === 'robbery' || card.type === 'scapegoat')) {
      if (!sel.first) return setSel({ ...sel, first: id });
      act({ type: 'PLAY_CARD', cardId: card.id, target: sel.first, secondTarget: id });
      return setSel(NONE);
    }
    act({ type: 'PLAY_CARD', cardId: card.id, target: id, ...extra });
    setSel(NONE);
  }

  function onTryal(owner: PlayerId, tryalId: string) {
    if (!canPickTryal(owner)) return;
    if (ph.kind === 'reveal') return act({ type: 'CHOOSE_REVEAL', tryalId });
    if (ph.kind === 'conspiracy') return act({ type: 'CONSPIRACY_PICK', tryalId });
    if (window.confirm('確定要自首嗎？這張審判牌會翻開給所有人看，換取今晚免死。')) act({ type: 'CONFESS', tryalId });
  }

  function onFront(owner: PlayerId, c: Card) {
    if (!canPickFront(owner, c)) return;
    act({ type: 'PLAY_CARD', cardId: sel.card!.id, target: owner, targetCardId: c.id });
    setSel(NONE);
  }

  const canTriggerAbility = myTurn && view.turn.mode === 'idle';

  // Nudge the button that is the next thing to do when there is nothing else worth doing, or when the turn has gone quiet
  const autoOn = snap.autoPlayers.includes(view.me);
  const hasAction = myTurn && candidateActions(view).some((c) => c.action.type !== 'DRAW' && c.action.type !== 'END_TURN');
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    setQuiet(false);
    if (!(myTurn && view.turn.mode === 'playing')) return;
    const t = setTimeout(() => setQuiet(true), 8000);
    return () => clearTimeout(t);
  }, [myTurn, view.turn.mode, view.myHand.length, sel.card?.id]);
  const nudgeDraw = canTriggerAbility && !hasAction && !autoOn;
  const nudgeEnd = myTurn && view.turn.mode === 'playing' && (!hasAction || quiet) && !sel.card && !autoOn;

  return (
    <div className={`game ${isDark(view) ? 'is-night' : ''}`}>
      <header className="bar">
        <h1 className="title small">
          獵巫鎮<span className="year">1692</span>
        </h1>
        <span className="code-chip" title="房號">
          {snap.roomCode}
        </span>
        <button
          className="ghost small"
          onClick={() => setPanel(panel === 'discard' ? 'none' : 'discard')}
          aria-expanded={panel === 'discard'}
          title="點一下看棄牌堆"
        >
          牌堆 {view.deckCount}・棄牌 {view.discardCount}
        </button>
        <Countdown deadline={snap.deadline} />
        {snap.hostId === view.me && (
          <button className="ghost small" onClick={() => setPanel(panel === 'settings' ? 'none' : 'settings')} aria-expanded={panel === 'settings'} aria-label="房主設定" title="房主設定">
            ⚙
          </button>
        )}
        <button className="ghost small log-toggle" onClick={() => setLogOpen(!logOpen)} aria-expanded={logOpen}>
          {logOpen ? '牌桌' : '紀錄'}
        </button>
        <button className="ghost small" onClick={onLeave}>
          離開
        </button>
      </header>

      {connection !== 'online' && (
        <p className="banner" role="alert">
          {connection === 'reconnecting' ? '連線中斷，正在重新連線…' : '已離線'}
        </p>
      )}

      <Announcer announce={snap.announce} view={view} pictures={pictures} />
      <Prompt view={view} sel={sel} myTurn={myTurn} spectator={spectator} />
      <EventTicker log={snap.log} onOpen={() => setLogOpen(true)} />
      {!spectator && snap.gameId && ph.kind !== 'game_over' && <IntroSheet key={snap.gameId} gameId={snap.gameId} view={view} />}

      {panel === 'settings' && snap.hostId === view.me && (
        <section className="panel" aria-label="房主設定">
          <h2>房主設定（隨時生效）</h2>
          <BotPaceSetting seconds={snap.botSeconds} send={send} />
          <BotModeSetting mode={snap.botMode} available={snap.aiAvailable} send={send} />
          <p className="muted small-text">電腦每一步動作之間的等待時間；拉長比較看得清楚，縮短遊戲比較快。</p>
        </section>
      )}

      {panel === 'discard' && (
        <section className="panel" aria-label="棄牌堆">
          <h2>棄牌堆（正面朝上，所有人都看得到）</h2>
          <CardList cards={view.discard} />
        </section>
      )}

      {ph.kind === 'roles' && !spectator && <RolePicker view={view} act={act} />}
      {ph.kind === 'arrange' && ph.deck && <Arranger key={ph.deck.map((c) => c.id).join()} deck={ph.deck} act={act} />}
      {ph.kind === 'salvage' && ph.cards && <Salvager cards={ph.cards} from={view.players[ph.from]!.name} act={act} />}
      {panel === 'parris' && canTriggerAbility && (
        <ParrisPicker discard={view.discard} act={act} onCancel={() => setPanel('none')} />
      )}

      <div className={`board ${logOpen ? 'show-log' : ''}`}>
        <section className="town" aria-label="鎮民">
          {view.seats.map((id) => (
            <PlayerRow
              key={id}
              p={view.players[id]!}
              view={view}
              targetable={canTargetPlayer(id)}
              selectedFirst={sel.first === id}
              tryalPickable={canPickTryal(id)}
              frontPickable={(c) => canPickFront(id, c)}
              onPlayer={() => onPlayer(id)}
              onTryal={(t) => onTryal(id, t)}
              onFront={(c) => onFront(id, c)}
              offline={offline.has(id)}
              bot={bots.has(id)}
              auto={snap.autoPlayers.includes(id)}
              picture={pictures.get(id)}
              isLeft={showLeft && id === left}
              hit={hits.get(id)}
              onInfo={(t) => setInfo(info === t ? null : t)}
            />
          ))}
        </section>
        <LogPanel snap={snap} send={send} />
      </div>

      <footer className="hand-bar">
        {error && <p className="error">{error}</p>}
        {info && (
          <p className="card-info" role="note">
            <span>
              <b>{CARD_NAME[info]}</b>
              {CARD_DESC[info]}
            </span>
            <button className="ghost small" onClick={() => setInfo(null)}>
              關閉
            </button>
          </p>
        )}
        {ph.kind === 'game_over' ? (
          <GameOver view={view} snap={snap} isHost={snap.hostId === view.me} onBack={() => send('backToLobby')} />
        ) : spectator ? (
          <p className="muted">你正在觀戰。遊戲結束後可以在大廳入座。</p>
        ) : (
          <>
            <div className="hand" role="list" aria-label="你的手牌" ref={hand.ref} style={{ ['--overlap' as string]: `${hand.overlap}px` }}>
              {view.myHand.length === 0 && <p className="muted">沒有手牌</p>}
              {view.myHand.map((c) => (
                <button
                  key={c.id}
                  role="listitem"
                  className={`hand-card ${sel.card?.id === c.id ? 'is-selected' : ''} ${!myTurn || view.turn.mode === 'drawing' ? 'is-locked' : ''}`}
                  onClick={() => {
                    // Not your turn: you can still read what the card does
                    if (!myTurn || view.turn.mode === 'drawing') return setInfo(info === c.type ? null : c.type);
                    setInfo(null);
                    setSel(sel.card?.id === c.id ? NONE : { card: c, first: null, asWitness: false });
                  }}
                  title={`${CARD_NAME[c.type]}：${CARD_DESC[c.type]}`}
                  aria-label={`${CARD_NAME[c.type]}：${CARD_DESC[c.type]}`}
                >
                  <CardFace kind={c.type} scale={handScale} compact />
                </button>
              ))}
            </div>
            <div className="turn-actions">
              {sel.card?.type === 'alibi' && myRole === 'griggs' && (
                <button className={sel.asWitness ? 'primary' : ''} onClick={() => setSel({ ...sel, first: null, asWitness: !sel.asWitness })} aria-pressed={sel.asWitness}>
                  當作目擊（7 點）
                </button>
              )}
              {canTriggerAbility && (
                <button className={`primary ${nudgeDraw ? 'nudge' : ''}`} onClick={() => act({ type: 'DRAW' })}>
                  抽兩張牌
                </button>
              )}
              {canTriggerAbility && view.myAbilities.parris && (
                <button onClick={() => setPanel('parris')}>從棄牌堆拿牌（剩 {view.myAbilities.parris} 次）</button>
              )}
              {canTriggerAbility && view.myAbilities.tituba && <button onClick={() => act({ type: 'ARRANGE_START' })}>查看並重排牌堆</button>}
              {myTurn && view.turn.mode === 'playing' && (
                <button className={`primary ${nudgeEnd ? 'nudge' : ''}`} onClick={() => act({ type: 'END_TURN' })}>
                  結束回合
                </button>
              )}
              {alive && (
                <button
                  className={`small ${autoOn ? 'primary' : ''}`}
                  onClick={() => send('autoplay', { on: !autoOn })}
                  aria-pressed={autoOn}
                  title="讓 AI 幫你出牌、做決定；隨時可以取消，自己接手"
                >
                  {autoOn ? 'AI 代打中（點此取消）' : 'AI 代打'}
                </button>
              )}
              {ph.kind === 'night' && ph.step === 'confess' && ph.mustAct && (
                <>
                  {view.myAbilities.phips && (
                    <button
                      onClick={() => {
                        if (window.confirm(`使用${ROLES.phips.title}的能力：自首但不翻牌（全場一次）？`)) act({ type: 'CONFESS' });
                      }}
                    >
                      自首（不翻牌）
                    </button>
                  )}
                  <button className="primary" onClick={() => act({ type: 'NIGHT_PASS' })}>
                    不自首
                  </button>
                </>
              )}
              {sel.card && (
                <button className="ghost" onClick={() => setSel(NONE)}>
                  取消
                </button>
              )}
            </div>
          </>
        )}
      </footer>

      {sel.card && (
        <aside className="card-detail" aria-hidden="true">
          <CardFace kind={sel.card.type} scale={handScale === HAND_SCALE ? 1 : 0.8} />
        </aside>
      )}
    </div>
  );
}

function Prompt({ view, sel, myTurn, spectator }: { view: PlayerView; sel: Selection; myTurn: boolean; spectator: boolean }) {
  const ph = view.phase;
  const name = (id: PlayerId) => view.players[id]?.name ?? '?';
  const me = view.players[view.me];
  let text: string;

  if (spectator) text = `觀戰中。${phaseText(view)}`;
  else if (!me!.alive && ph.kind !== 'game_over') text = '你已經死亡，可以繼續觀戰。';
  else
    switch (ph.kind) {
      case 'roles':
        text = ph.picked ? `你選了 ${ROLES[ph.picked].title}。${phaseText(view)}` : '選一位鎮公所角色。角色會公開給所有人。';
        break;
      case 'dawn':
        text = ph.mustAct ? '黎明。你是女巫：點一位玩家，把黑貓放到他面前（可以是你自己）。' : '黎明。所有人閉上眼睛，女巫正在放黑貓…';
        break;
      case 'turn':
        if (!myTurn) text = `輪到 ${name(view.turn.player)}。`;
        else if (sel.asWitness) text = '辯護當作目擊（7 點）：點一位玩家的名字。';
        else if (sel.card?.type === 'curse') text = '詛咒：點一張別人面前的藍牌把它棄掉。';
        else if (sel.card && (sel.card.type === 'robbery' || sel.card.type === 'scapegoat'))
          text = sel.first ? `${CARD_NAME[sel.card.type]}：要轉給誰？` : `${CARD_NAME[sel.card.type]}：先點要拿走誰的牌。`;
        else if (sel.card) text = `${CARD_NAME[sel.card.type]}：點一位玩家的名字。${CARD_DESC[sel.card.type]}`;
        else if (view.turn.mode === 'playing') text = '繼續出牌，或結束回合。';
        else text = '輪到你了：抽兩張牌，或選一張手牌打給別人。';
        break;
      case 'reveal':
        if (ph.then === 'conspiracy_pass')
          text = ph.chooser === view.me ? '傳染！黑貓在你面前：點你自己的一張審判牌翻開。' : phaseText(view);
        else text = ph.chooser === view.me ? `審判 ${name(ph.target)}：點他的一張審判牌翻開。` : phaseText(view);
        break;
      case 'arrange':
        text = ph.deck ? '你查看了牌堆：用上下按鈕排好順序（最上面先抽），完成後會抽兩張牌。' : phaseText(view);
        break;
      case 'salvage':
        text = ph.cards ? `${ROLES.proctor.title}：從${name(ph.from)} 留下的手牌中挑最多 ${SALVAGE_MAX} 張收下。` : phaseText(view);
        break;
      case 'night':
        if (ph.step === 'witches')
          text = ph.mustAct ? '夜晚。你是女巫：點一位玩家，決定今晚要殺誰。' : phaseText(view);
        else if (ph.step === 'constable') text = ph.mustAct ? '你是警長：點一位玩家保護他，今晚他不會被女巫殺死（不能選自己）。' : '夜晚。警長正在行動…';
        else text = ph.mustAct ? '天亮前：要自首嗎？點你自己的一張審判牌翻開，換取今晚免死；或按「不自首」。' : '等待其他人決定是否自首…';
        break;
      case 'conspiracy':
        text = ph.mustPick ? `傳染！點 ${name(ph.leftOf)}（你左手邊）的一張審判牌拿走。` : ph.picked ? '等待其他人拿牌…' : phaseText(view);
        break;
      case 'game_over':
        text = phaseText(view);
        break;
    }

  const urgent =
    !spectator &&
    ((ph.kind === 'roles' && !ph.picked) ||
      (ph.kind === 'dawn' && ph.mustAct) ||
      (ph.kind === 'night' && ph.mustAct) ||
      (ph.kind === 'reveal' && ph.chooser === view.me) ||
      (ph.kind === 'conspiracy' && ph.mustPick) ||
      (ph.kind === 'arrange' && !!ph.deck) ||
      (ph.kind === 'salvage' && !!ph.cards) ||
      myTurn);
  const showRoles = !spectator && me?.alive && ph.kind !== 'game_over';
  // When a black card fires, show its illustrated card beside the prompt
  const event = ph.kind === 'night' ? 'night' : ph.kind === 'conspiracy' || (ph.kind === 'reveal' && ph.then === 'conspiracy_pass') ? 'conspiracy' : null;

  return (
    <p className={`prompt ${urgent ? 'is-urgent' : ''} ${event ? 'has-event' : ''}`} role="status">
      {event && (
        <span className="event-card">
          <CardFace kind={event} scale={0.3} compact />
        </span>
      )}
      {showRoles && view.amWitch && <span className="role-badge witch">女巫</span>}
      {showRoles && view.amConstable && <span className="role-badge">警長</span>}
      {showRoles && me?.role && <RoleChip role={me.role} copying={me.effectiveRole} mine />}
      <span>{text}</span>
    </p>
  );
}

function RolePicker({ view, act }: { view: PlayerView; act: (a: Action) => void }) {
  const ph = view.phase;
  if (ph.kind !== 'roles' || ph.picked) return null;
  return (
    <section className="panel" aria-label="選擇角色">
      <h2>選一位角色</h2>
      <div className="role-offers">
        {ph.offers.map((r) => (
          <button key={r} className="role-card" onClick={() => act({ type: 'PICK_ROLE', role: r })}>
            <b>{ROLES[r].title}</b>
            <span>{ROLES[r].desc}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Tituba: reorder the deck with up/down buttons (works the same with a mouse, a finger or a keyboard) */
function Arranger({ deck, act }: { deck: Card[]; act: (a: Action) => void }) {
  const [order, setOrder] = useState(deck);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };
  return (
    <section className="panel" aria-label="重排牌堆">
      <h2>重排牌堆（最上面先抽；夜晚固定在最底）</h2>
      <ol className="arrange">
        {order.map((c, i) => (
          <li key={c.id}>
            <span className={`chip c-${CARD_COLOR[c.type]}`}>{CARD_NAME[c.type]}</span>
            <button className="small" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`把第 ${i + 1} 張往上移`}>
              ↑
            </button>
            <button className="small" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label={`把第 ${i + 1} 張往下移`}>
              ↓
            </button>
          </li>
        ))}
      </ol>
      <button className="primary" onClick={() => act({ type: 'ARRANGE_DECK', order: order.map((c) => c.id) })}>
        完成並抽兩張牌
      </button>
    </section>
  );
}

function Salvager({ cards, from, act }: { cards: Card[]; from: string; act: (a: Action) => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (c: Card) => {
    const next = new Set(picked);
    if (next.has(c.id)) next.delete(c.id);
    else if (next.size < SALVAGE_MAX) next.add(c.id);
    setPicked(next);
  };
  return (
    <section className="panel" aria-label="挑選遺物">
      <h2>
        {from} 留下的手牌（已選 {picked.size} / {SALVAGE_MAX}）
      </h2>
      <CardList cards={cards} picked={picked} onToggle={toggle} />
      <button className="primary" onClick={() => act({ type: 'SALVAGE', cardIds: [...picked] })}>
        收下選好的牌，其餘丟棄
      </button>
    </section>
  );
}

function ParrisPicker({ discard, act, onCancel }: { discard: Card[]; act: (a: Action) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const usable = discard.filter((c) => CARD_COLOR[c.type] !== 'black');
  const toggle = (c: Card) => {
    const next = new Set(picked);
    if (next.has(c.id)) next.delete(c.id);
    else if (next.size < PARRIS_MAX) next.add(c.id);
    setPicked(next);
  };
  return (
    <section className="panel" aria-label="從棄牌堆拿牌">
      <h2>
        {ROLES.parris.title}：從棄牌堆選最多 {PARRIS_MAX} 張（取代這回合抽牌）
      </h2>
      <CardList cards={usable} picked={picked} onToggle={toggle} />
      <div className="turn-actions">
        <button className="primary" disabled={picked.size === 0} onClick={() => act({ type: 'DRAW_DISCARD', cardIds: [...picked] })}>
          拿走這些牌
        </button>
        <button className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  );
}

function GameOver({ view, snap, isHost, onBack }: { view: PlayerView; snap: ClientSnapshot; isHost: boolean; onBack: () => void }) {
  const witches = view.seats.filter((id) => view.players[id]!.isWitch).map((id) => view.players[id]!.name);
  return (
    <div className="game-over">
      <p>女巫是：{witches.join('、') || '（無）'}</p>
      {snap.lastReplayId && (
        <a className="button-link" href={`?replay=${snap.lastReplayId}`} target="_blank" rel="noreferrer">
          觀看重播
        </a>
      )}
      {isHost ? (
        <button className="primary" onClick={onBack}>
          回到大廳再玩一場
        </button>
      ) : (
        <p className="muted">等房主回到大廳…</p>
      )}
    </div>
  );
}

export function Countdown({ deadline }: { deadline: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!deadline) return null;
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <span className={`timer ${s <= 10 ? 'is-low' : ''}`} title="剩餘時間">
      {s} 秒
    </span>
  );
}
