import { useState } from 'react';
import { CARD_COLOR, CARD_NAME, ROLES, type Card, type PlayerId, type PlayerView, type PublicPlayer, type RoleId } from '@salem/engine';
import { CARD_DESC, TRYAL_FULL, TRYAL_LABEL } from './text';
import { Avatar } from './Avatar';
import { CardFace } from './CardFace';
import type { Hit } from './Feedback';

/** A character name that reveals its ability on hover or tap (tap matters on phones, where title tooltips don't exist) */
export function RoleChip({ role, copying, mine }: { role: RoleId; copying?: RoleId | null; mine?: boolean }) {
  const [open, setOpen] = useState(false);
  const r = ROLES[role];
  const copied = role === 'martha' && copying ? ROLES[copying] : null;
  return (
    <span className="role-wrap">
      <button
        type="button"
        className={`role-chip ${mine ? 'is-mine' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        aria-expanded={open}
        title={`${r.title}：${r.desc}${copied ? `\n目前複製：${copied.title}（${copied.desc}）` : ''}`}
      >
        {r.title}
        {copied && <span className="copying">→ {copied.title}</span>}
      </button>
      {open && (
        <span className="role-pop" role="note">
          <b>{r.title}</b>
          {r.desc}
          {copied && (
            <>
              <br />
              目前複製 {copied.title}：{copied.desc}
            </>
          )}
        </span>
      )}
    </span>
  );
}

export interface RowProps {
  p: PublicPlayer;
  view: PlayerView;
  targetable: boolean;
  selectedFirst: boolean;
  tryalPickable: boolean;
  frontPickable: (c: Card) => boolean;
  onPlayer: () => void;
  onTryal: (id: string) => void;
  onFront: (c: Card) => void;
  offline?: boolean;
  bot?: boolean;
  /** LINE profile picture */
  picture?: string;
  /** During a conspiracy: this is the player on the viewer's left */
  isLeft?: boolean;
  /** Something just happened to this player: light the row and float the label */
  hit?: Hit;
}

export function PlayerRow(props: RowProps) {
  const { p, view, targetable } = props;
  const isTurn = view.phase.kind === 'turn' && view.turn.player === p.id;
  const isMe = p.id === view.me;
  // Whoever the game is waiting on right now: the current turn, or the players who must act in other phases
  const acting = p.alive && (isTurn || view.waiting.includes(p.id));
  const filled = Math.min(p.accusations, p.threshold) / p.threshold;

  return (
    <article
      className={[
        'pew',
        !p.alive && 'is-dead',
        isTurn && 'is-turn',
        acting && 'is-acting',
        isMe && 'is-me',
        targetable && 'is-targetable',
        props.selectedFirst && 'is-first',
        props.isLeft && 'is-left',
        props.hit && 'is-hit',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="pew-head">
        <button className="pew-name" onClick={props.onPlayer} disabled={!targetable} aria-label={`選擇 ${p.name}`}>
          <Avatar name={p.name} picture={props.picture} size={24} />
          <span className="name">{p.name}</span>
        </button>
        <span className="pew-tags">
          {isMe && <span className="tag">你</span>}
          {p.isWitch && p.alive && !isMe && <span className="tag witch">{view.amWitch ? '女巫同伴' : '女巫'}</span>}
          {!p.alive && <span className="tag">{p.isWitch ? '已死・女巫' : '已死'}</span>}
          {props.offline && <span className="tag offline">離線</span>}
          {props.bot && <span className="tag">電腦</span>}
          {props.isLeft && <span className="tag left">你的左手邊</span>}
          {acting && <span className="tag acting">{isMe ? '輪到你' : '行動中'}</span>}
        </span>
        {p.role && <RoleChip role={p.role} copying={p.effectiveRole} mine={isMe} />}
        <span className="hand-count" title="手牌數" aria-label={`手牌 ${p.handCount} 張`}>
          手牌 <b>{p.handCount}</b>
        </span>
      </div>

      <div className="tryals" aria-label="審判牌">
        {p.tryals.map((t) => (
          <button
            key={t.id}
            className={`tryal ${t.revealed ? 'is-revealed' : ''} ${t.kind ? `k-${t.kind}` : 'k-hidden'} ${props.tryalPickable && !t.revealed ? 'is-pickable' : ''}`}
            disabled={!props.tryalPickable || t.revealed}
            onClick={() => props.onTryal(t.id)}
            title={t.kind ? `${TRYAL_FULL[t.kind]}${t.revealed ? '（已翻開）' : isMe ? '（只有你看得到）' : ''}` : '未翻開的審判牌'}
            aria-label={t.kind ? TRYAL_FULL[t.kind] : '未翻開的審判牌'}
          >
            {t.kind ? TRYAL_LABEL[t.kind] : ''}
          </button>
        ))}
      </div>

      <div className="accuse" title={`指控 ${p.accusations} / ${p.threshold}`} aria-label={`指控 ${p.accusations} / ${p.threshold} 點`}>
        <span className="accuse-label">指控</span>
        <span className="accuse-bar">
          <span style={{ width: `${filled * 100}%` }} />
        </span>
        <span className="accuse-num">
          {p.accusations}/{p.threshold}
        </span>
      </div>

      {p.front.some((c) => CARD_COLOR[c.type] !== 'red') && (
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

      {props.hit && (
        <>
          <span key={`glow-${props.hit.key}`} className="hit-glow" aria-hidden="true" />
          <span key={props.hit.key} className="hit-float" aria-hidden="true">
            {props.hit.label}
          </span>
        </>
      )}
    </article>
  );
}

/** Read-only rows (replays, spectators before interaction is wired) */
export function StaticTown({ view, offline }: { view: PlayerView; offline?: Set<PlayerId> }) {
  return (
    <section className="town" aria-label="鎮民">
      {view.seats.map((id) => (
        <PlayerRow
          key={id}
          p={view.players[id]!}
          view={view}
          targetable={false}
          selectedFirst={false}
          tryalPickable={false}
          frontPickable={() => false}
          onPlayer={() => {}}
          onTryal={() => {}}
          onFront={() => {}}
          offline={offline?.has(id)}
        />
      ))}
    </section>
  );
}

/** One line describing the phase from a viewer's point of view; `you` is false for spectators and replays */
export function phaseText(view: PlayerView): string {
  const ph = view.phase;
  const name = (id: PlayerId) => view.players[id]?.name ?? '?';
  switch (ph.kind) {
    case 'roles':
      return `選角色：還有 ${ph.waiting.length} 人在選…`;
    case 'dawn':
      return '黎明。所有人閉上眼睛，女巫正在放黑貓…';
    case 'turn':
      return `輪到 ${name(view.turn.player)}。`;
    case 'reveal':
      if (ph.then === 'conspiracy_pass') return `傳染！黑貓在 ${name(ph.target)} 面前，他正在選一張自己的審判牌翻開…`;
      return `${name(ph.chooser)} 正在翻開 ${name(ph.target)} 的一張審判牌…`;
    case 'arrange':
      return `${name(ph.player)}（${ROLES.tituba.title}）正在查看並重排牌堆…`;
    case 'salvage':
      return `${name(ph.chooser)}（${ROLES.proctor.title}）正在挑選 ${name(ph.from)} 留下的 ${ph.count} 張手牌…`;
    case 'night':
      if (ph.step === 'witches') return ph.victim || ph.votes ? `女巫正在投票（目前目標：${ph.victim ? name(ph.victim) : '未定'}）` : '夜晚。所有人閉上眼睛…';
      if (ph.step === 'constable') return ph.gavel !== null ? `警長把法槌交給 ${name(ph.gavel)}` : '夜晚。警長正在行動…';
      return '天亮前：大家正在決定要不要自首…';
    case 'conspiracy':
      return '傳染：每個人從左手邊玩家拿走一張審判牌…';
    case 'game_over':
      return ph.winner === 'town' ? '鎮民獲勝。所有女巫都被揪出來了。' : '女巫獲勝。塞勒姆已經被黑暗吞沒。';
  }
}

export function isDark(view: PlayerView) {
  const ph = view.phase;
  return ph.kind === 'dawn' || (ph.kind === 'night' && ph.step !== 'confess');
}

export function CardList({ cards, picked, onToggle }: { cards: Card[]; picked?: Set<string>; onToggle?: (c: Card) => void }) {
  if (cards.length === 0) return <p className="muted">（沒有牌）</p>;
  return (
    <div className="card-list">
      {cards.map((c) => (
        <button
          key={c.id}
          className={`hand-card ${picked?.has(c.id) ? 'is-selected' : ''}`}
          disabled={!onToggle}
          onClick={() => onToggle?.(c)}
          title={`${CARD_NAME[c.type]}：${CARD_DESC[c.type]}`}
          aria-label={`${CARD_NAME[c.type]}：${CARD_DESC[c.type]}`}
          aria-pressed={picked ? picked.has(c.id) : undefined}
        >
          <CardFace kind={c.type} scale={0.4} compact />
        </button>
      ))}
    </div>
  );
}
