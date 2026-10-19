import { useEffect, useState } from 'react';
import { ACCUSATION_THRESHOLD, CARD_COLOR, CARD_NAME, type Action, type Card, type PlayerId, type PlayerView, type PublicPlayer } from '@salem/engine';
import type { ClientSnapshot } from './net';
import { LogPanel } from './LogPanel';
import { Avatar } from './Avatar';
import { CARD_DESC, TRYAL_FULL, TRYAL_LABEL } from './text';

interface Props {
  snap: ClientSnapshot;
  view: PlayerView;
  act: (a: Action) => void;
  send: (type: 'start' | 'backToLobby' | 'chat', payload?: { text: string }) => void;
  error: string | null;
  onLeave: () => void;
}

interface Selection {
  card: Card | null;
  first: PlayerId | null;
}

const NONE: Selection = { card: null, first: null };

export function Game({ snap, view, act, send, error, onLeave }: Props) {
  const [sel, setSel] = useState<Selection>(NONE);
  const ph = view.phase;
  const me = view.players[view.me]!;
  const myTurn = ph.kind === 'turn' && view.turn.player === view.me && me.alive;
  const dark = ph.kind === 'dawn' || (ph.kind === 'night' && ph.step !== 'confess');

  // Clear the selection when the phase or turn changes
  useEffect(() => setSel(NONE), [ph.kind, view.turn.player]);

  // Drop the selection if the selected card is gone (already played)
  useEffect(() => {
    if (sel.card && !view.myHand.some((c) => c.id === sel.card!.id)) setSel(NONE);
  }, [view.myHand, sel.card]);

  const alive = (id: PlayerId) => view.players[id]!.alive;

  // ----- Which players / cards can be clicked right now -----
  function canTargetPlayer(id: PlayerId): boolean {
    if (!alive(id) || !me.alive) return false;
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
    if (!me.alive) return false;
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
    if (card.type === 'robbery' || card.type === 'scapegoat') {
      if (!sel.first) return setSel({ card, first: id });
      act({ type: 'PLAY_CARD', cardId: card.id, target: sel.first, secondTarget: id });
      return setSel(NONE);
    }
    act({ type: 'PLAY_CARD', cardId: card.id, target: id });
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

  return (
    <div className={`game ${dark ? 'is-night' : ''}`}>
      <header className="bar">
        <h1 className="title small">
          獵巫鎮<span className="year">1692</span>
        </h1>
        <span className="code-chip" title="房號">
          {snap.roomCode}
        </span>
        <span className="deck-chip">牌堆 {view.deckCount}</span>
        <Countdown deadline={snap.deadline} />
        <button className="ghost small" onClick={onLeave}>
          離開
        </button>
      </header>

      <Prompt view={view} sel={sel} myTurn={myTurn} />

      <div className="board">
        <section className="town" aria-label="鎮民">
          {view.seats.map((id) => (
            <PlayerRow
              key={id}
              p={view.players[id]!}
              picture={snap.lobby.find((l) => l.id === id)?.picture}
              view={view}
              targetable={canTargetPlayer(id)}
              selectedFirst={sel.first === id}
              tryalPickable={canPickTryal(id)}
              frontPickable={(c) => canPickFront(id, c)}
              onPlayer={() => onPlayer(id)}
              onTryal={(t) => onTryal(id, t)}
              onFront={(c) => onFront(id, c)}
            />
          ))}
        </section>
        <LogPanel snap={snap} send={send} />
      </div>

      <footer className="hand-bar">
        {error && <p className="error">{error}</p>}
        {ph.kind === 'game_over' ? (
          <GameOver view={view} isHost={snap.hostId === view.me} onBack={() => send('backToLobby')} />
        ) : (
          <>
            <div className="hand" role="list" aria-label="你的手牌">
              {view.myHand.length === 0 && <p className="muted">沒有手牌</p>}
              {view.myHand.map((c) => (
                <button
                  key={c.id}
                  role="listitem"
                  className={`card c-${CARD_COLOR[c.type]} ${sel.card?.id === c.id ? 'is-selected' : ''}`}
                  disabled={!myTurn || view.turn.mode === 'drawing'}
                  onClick={() => setSel(sel.card?.id === c.id ? NONE : { card: c, first: null })}
                  title={CARD_DESC[c.type]}
                >
                  {CARD_NAME[c.type]}
                </button>
              ))}
            </div>
            <div className="turn-actions">
              {myTurn && view.turn.mode === 'idle' && (
                <button className="primary" onClick={() => act({ type: 'DRAW' })}>
                  抽兩張牌
                </button>
              )}
              {myTurn && view.turn.mode === 'playing' && (
                <button className="primary" onClick={() => act({ type: 'END_TURN' })}>
                  結束回合
                </button>
              )}
              {ph.kind === 'night' && ph.step === 'confess' && ph.mustAct && (
                <button className="primary" onClick={() => act({ type: 'NIGHT_PASS' })}>
                  不自首
                </button>
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
    </div>
  );
}

function PlayerRow(props: {
  p: PublicPlayer;
  picture?: string;
  view: PlayerView;
  targetable: boolean;
  selectedFirst: boolean;
  tryalPickable: boolean;
  frontPickable: (c: Card) => boolean;
  onPlayer: () => void;
  onTryal: (id: string) => void;
  onFront: (c: Card) => void;
}) {
  const { p, view, targetable } = props;
  const isTurn = view.phase.kind === 'turn' && view.turn.player === p.id;
  const isMe = p.id === view.me;
  const filled = Math.min(p.accusations, ACCUSATION_THRESHOLD);

  return (
    <article
      className={[
        'pew',
        !p.alive && 'is-dead',
        isTurn && 'is-turn',
        isMe && 'is-me',
        targetable && 'is-targetable',
        props.selectedFirst && 'is-first',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button className="pew-name" onClick={props.onPlayer} disabled={!targetable} aria-label={`選擇 ${p.name}`}>
        <Avatar name={p.name} picture={props.picture} size={28} />
        <span className="name">{p.name}</span>
        {isMe && <span className="tag">你</span>}
        {p.isWitch && p.alive && !isMe && <span className="tag witch">女巫同伴</span>}
        {!p.alive && <span className="tag">{p.isWitch ? '已死・女巫' : '已死'}</span>}
        <span className="hand-count" title="手牌數">
          手牌 {p.handCount}
        </span>
      </button>

      <div className="tryals" aria-label="審判牌">
        {p.tryals.map((t) => (
          <button
            key={t.id}
            className={`tryal ${t.revealed ? 'is-revealed' : ''} ${t.kind ? `k-${t.kind}` : 'k-hidden'} ${props.tryalPickable && !t.revealed ? 'is-pickable' : ''}`}
            disabled={!props.tryalPickable || t.revealed}
            onClick={() => props.onTryal(t.id)}
            title={t.kind ? `${TRYAL_FULL[t.kind]}${t.revealed ? '（已翻開）' : '（只有你看得到）'}` : '未翻開的審判牌'}
          >
            {t.kind ? TRYAL_LABEL[t.kind] : ''}
          </button>
        ))}
      </div>

      <div className="accuse" title={`指控 ${p.accusations} / ${ACCUSATION_THRESHOLD}`} aria-label={`指控 ${p.accusations} 點`}>
        {Array.from({ length: ACCUSATION_THRESHOLD }, (_, i) => (
          <span key={i} className={i < filled ? 'pip on' : 'pip'} />
        ))}
      </div>

      {p.front.length > 0 && (
        <div className="front">
          {p.front
            .filter((c) => CARD_COLOR[c.type] !== 'red')
            .map((c) => (
              <button
                key={c.id}
                className={`chip c-${CARD_COLOR[c.type]} ${props.frontPickable(c) ? 'is-pickable' : ''}`}
                disabled={!props.frontPickable(c)}
                onClick={() => props.onFront(c)}
                title={CARD_DESC[c.type]}
              >
                {CARD_NAME[c.type]}
              </button>
            ))}
        </div>
      )}
    </article>
  );
}

function Prompt({ view, sel, myTurn }: { view: PlayerView; sel: Selection; myTurn: boolean }) {
  const ph = view.phase;
  const name = (id: PlayerId) => view.players[id]?.name ?? '?';
  const me = view.players[view.me]!;
  let text: string;

  if (!me.alive && ph.kind !== 'game_over') text = '你已經死亡，可以繼續觀戰。';
  else
    switch (ph.kind) {
      case 'dawn':
        text = ph.mustAct ? '黎明。你是女巫：點一位玩家，把黑貓放到他面前（可以是你自己）。' : '黎明。所有人閉上眼睛，女巫正在放黑貓…';
        break;
      case 'turn':
        if (!myTurn) text = `輪到 ${name(view.turn.player)}。`;
        else if (sel.card?.type === 'curse') text = `詛咒：點一張別人面前的藍牌把它棄掉。`;
        else if (sel.card && (sel.card.type === 'robbery' || sel.card.type === 'scapegoat'))
          text = sel.first ? `${CARD_NAME[sel.card.type]}：要轉給誰？` : `${CARD_NAME[sel.card.type]}：先點要拿走誰的牌。`;
        else if (sel.card) text = `${CARD_NAME[sel.card.type]}：點一位玩家的名字。${CARD_DESC[sel.card.type]}`;
        else if (view.turn.mode === 'playing') text = '繼續出牌，或結束回合。';
        else text = '輪到你了：抽兩張牌，或選一張手牌打給別人。';
        break;
      case 'reveal':
        text =
          ph.chooser === view.me
            ? `審判 ${name(ph.target)}：點他的一張審判牌翻開。`
            : `${name(ph.chooser)} 正在翻開 ${name(ph.target)} 的一張審判牌…`;
        break;
      case 'night':
        if (ph.step === 'witches')
          text = ph.mustAct ? '夜晚。你是女巫：點一位玩家，決定今晚要殺誰。' : view.amWitch ? `女巫正在投票（目前目標：${ph.victim ? name(ph.victim) : '未定'}）` : '夜晚。所有人閉上眼睛…';
        else if (ph.step === 'constable') text = ph.mustAct ? '你是警長：點一位玩家，把法槌交給他保護他（不能選自己）。' : '夜晚。警長正在行動…';
        else text = ph.mustAct ? '天亮前：要自首嗎？點你自己的一張審判牌翻開，換取今晚免死；或按「不自首」。' : '等待其他人決定是否自首…';
        break;
      case 'conspiracy':
        text = ph.mustPick ? `傳染！點 ${name(ph.leftOf)}（你左手邊）的一張審判牌拿走。` : ph.picked ? '等待其他人拿牌…' : '傳染進行中…';
        break;
      case 'game_over':
        text = ph.winner === 'town' ? '鎮民獲勝。所有女巫都被揪出來了。' : '女巫獲勝。塞勒姆已經被黑暗吞沒。';
        break;
    }

  const urgent =
    (ph.kind === 'dawn' && ph.mustAct) ||
    (ph.kind === 'night' && ph.mustAct) ||
    (ph.kind === 'reveal' && ph.chooser === view.me) ||
    (ph.kind === 'conspiracy' && ph.mustPick) ||
    myTurn;

  return (
    <p className={`prompt ${urgent ? 'is-urgent' : ''}`} role="status">
      {view.amWitch && me.alive && ph.kind !== 'game_over' && <span className="role-badge witch">女巫</span>}
      {view.amConstable && me.alive && ph.kind !== 'game_over' && <span className="role-badge">警長</span>}
      {text}
    </p>
  );
}

function GameOver({ view, isHost, onBack }: { view: PlayerView; isHost: boolean; onBack: () => void }) {
  const witches = view.seats.filter((id) => view.players[id]!.isWitch).map((id) => view.players[id]!.name);
  return (
    <div className="game-over">
      <p>女巫是：{witches.join('、') || '（無）'}</p>
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

function Countdown({ deadline }: { deadline: number | null }) {
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
