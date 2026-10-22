import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PlayerId, PlayerView } from '@salem/engine';
import type { AnnounceItem, LogEntry } from '../../server/src/protocol';
import { Avatar } from './Avatar';
import type { Send } from './net';

/** How long a player row stays lit after something happens to it */
const HIT_MS = 2500;

export interface Hit {
  label: string;
  /** Changes on every new hit, so the animation restarts even for the same label */
  key: number;
}

/**
 * Players something just happened to ("+1 指控", "死亡"…), from the log entries that arrived since the last snapshot.
 * The first snapshot after mounting (a refresh or rejoin) only sets the baseline, so old events don't all light up at once.
 */
export function useHits(log: LogEntry[]): Map<PlayerId, Hit> {
  const seen = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hits, setHits] = useState<Map<PlayerId, Hit>>(new Map());

  useEffect(() => {
    const last = log.at(-1)?.id ?? 0;
    const prev = seen.current;
    seen.current = last;
    if (prev === null) return;
    const labels = new Map<PlayerId, string[]>();
    for (const e of log) {
      if (e.id <= prev || !e.fx) continue;
      for (const f of e.fx) labels.set(f.target, [...(labels.get(f.target) ?? []), f.label]);
    }
    if (labels.size === 0) return;
    setHits(new Map([...labels].map(([id, l]) => [id, { label: l.join('・'), key: last }])));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHits(new Map()), HIT_MS);
  }, [log]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return hits;
}

/** The latest game events, always on screen (the full log is a tab away on phones) */
export function EventTicker({ log, onOpen }: { log: LogEntry[]; onOpen: () => void }) {
  const events = log.filter((e) => e.kind === 'event' && e.channel !== 'system').slice(-2);
  if (events.length === 0) return null;
  const [older, latest] = events.length === 2 ? events : [null, events[0]!];
  return (
    <button type="button" className="ticker" onClick={onOpen} aria-label="最新動態，點一下看完整紀錄">
      {older && <span className="ticker-old">{older.text}</span>}
      <span key={latest!.id} className="ticker-new">
        {latest!.text}
      </span>
    </button>
  );
}

function sessionFlag(key: string, set?: boolean): boolean {
  try {
    if (set) sessionStorage.setItem(key, '1');
    return sessionStorage.getItem(key) === '1';
  } catch {
    // Private browsing etc.: show it every time rather than never
    return !!set;
  }
}

const GOALS = {
  witch: {
    name: '女巫',
    goal: '讓存活的人全都是女巫。你看得到其他女巫（標著「女巫同伴」）；夜晚和同伴一起決定殺誰，白天別露出馬腳。',
  },
  constable: {
    name: '警長',
    goal: '你和鎮民同一陣營，要揪出所有女巫。每天夜晚可以選一位玩家保護他，讓他不會被女巫殺死（不能選自己）。',
  },
  town: {
    name: '平民',
    goal: '揪出所有女巫：對可疑的人打指控，累積到門檻就會翻開他一張審判牌，翻到女巫牌他就出局。',
  },
} as const;

/** Shown once at the start of each game: who you are and how a turn works */
export function IntroSheet({ gameId, view }: { gameId: string; view: PlayerView }) {
  const key = `salem.intro.${gameId}`;
  const [open, setOpen] = useState(() => !sessionFlag(key));
  if (!open) return null;
  const close = () => {
    sessionFlag(key, true);
    setOpen(false);
  };
  const g = view.amWitch ? GOALS.witch : view.amConstable ? GOALS.constable : GOALS.town;
  return (
    <div className="sheet-backdrop" onClick={close}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="intro-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="intro-title">
          你的身分：<span className={`role-badge ${view.amWitch ? 'witch' : ''}`}>{g.name}</span>
        </h2>
        <p>{g.goal}</p>
        <ul>
          <li>輪到你時：抽兩張牌，或打一張手牌給別人。</li>
          <li>紅牌是指控，點數累積到門檻（通常 7 點）就翻開對方一張審判牌。</li>
          <li>夜晚女巫選一人殺害，警長保護一人；天亮前可以自首翻開自己一張審判牌，換取當晚免死。</li>
          <li>虛線框的審判牌只有你看得到。上方的動態列會告訴你誰對誰做了什麼，點它看完整紀錄。</li>
        </ul>
        <button className="primary" onClick={close} autoFocus>
          知道了
        </button>
      </section>
    </div>
  );
}

const TRYAL_NAME = { witch: '女巫', constable: '警長', not_a_witch: '平民' } as const;

/**
 * Full-screen cards for the moments everyone must see, one after another: who the Constable protects, who confessed,
 * whom the Witches went for, who died or lived, and the winner. The server holds the game for as long as they last,
 * so the screen is covered only while nothing else is happening.
 */
export function Announcer({
  announce: a,
  view,
  pictures,
  onDone,
  skippable,
}: {
  /** A new id starts a new batch from its first card */
  announce: { id: number | string; items: AnnounceItem[] } | null;
  view: PlayerView;
  pictures?: Map<PlayerId, string | undefined>;
  /** Called when the last card has gone (the replay waits for it before moving on) */
  onDone?: () => void;
  /** Tap a card to move on to the next one (the replay; in a live game the table has to wait) */
  skippable?: boolean;
}) {
  const seen = useRef<number | string | null>(null);
  const [shown, setShown] = useState<{ id: number | string; index: number } | null>(null);

  // A new batch starts from its first card
  useEffect(() => {
    if (!a || seen.current === a.id) return;
    seen.current = a.id;
    setShown({ id: a.id, index: 0 });
  }, [a]);

  // Each card steps on after its own time; a card with no time (the winner) waits to be closed
  useEffect(() => {
    if (!shown || !a || a.id !== shown.id) return;
    const item = a.items[shown.index];
    if (!item) {
      setShown(null);
      return onDone?.();
    }
    if (item.ms === 0) return;
    const t = setTimeout(() => setShown({ id: shown.id, index: shown.index + 1 }), item.ms);
    return () => clearTimeout(t);
  }, [shown, a]);

  if (!shown || !a || a.id !== shown.id) return null;
  const item = a.items[shown.index];
  if (!item) return null;
  const name = (id: string) => view.players[id]?.name ?? '?';
  const who = (id: string, size = 88) => (
    <span className="announce-who">
      <Avatar name={name(id)} picture={pictures?.get(id)} size={size} />
      <b>{name(id)}</b>
    </span>
  );
  const close = () => setShown({ id: shown.id, index: shown.index + 1 });
  const content = describe(item, name, who);

  return (
    <div
      className={`announce tone-${content.tone} ${skippable ? 'is-skippable' : ''}`}
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label={content.title}
      onClick={skippable && item.ms > 0 ? close : undefined}
    >
      <div key={`${shown.id}-${shown.index}`} className="announce-card">
        <p className="announce-kicker">{content.kicker}</p>
        <h2 className="announce-title">{content.title}</h2>
        {content.body}
        {item.ms === 0 ? (
          <button className="primary announce-close" onClick={close} autoFocus>
            關閉
          </button>
        ) : (
          <span className="announce-bar" style={{ animationDuration: `${item.ms}ms` }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function describe(item: AnnounceItem, name: (id: string) => string, who: (id: string, size?: number) => ReactElement) {
  switch (item.kind) {
    case 'protect':
      return {
        tone: 'light',
        kicker: '天亮了',
        title: item.player ? '警長保護了' : '今晚沒有人受到警長保護',
        body: (
          <>
            {item.player && who(item.player)}
            <p className="announce-note">接下來開始自首：翻開自己一張審判牌，換取今晚免死</p>
          </>
        ),
      };
    case 'confess':
      return {
        tone: 'light',
        kicker: '自首',
        title: item.players.length ? `${item.players.length} 人自首` : '沒有人自首',
        body: item.players.length ? (
          <ul className="announce-list">
            {item.players.map((p) => (
              <li key={p.id}>
                <b>{name(p.id)}</b>
                <span>{p.revealed ? `翻開了「${TRYAL_NAME[p.revealed]}」` : '自首（不必翻牌）'}</span>
              </li>
            ))}
          </ul>
        ) : null,
      };
    case 'target':
      return { tone: 'dark', kicker: '女巫出手', title: '女巫今晚的目標是', body: who(item.player) };
    case 'survive':
      return {
        tone: 'safe',
        kicker: '倖存',
        title: `${name(item.player)} 存活`,
        body: (
          <>
            {who(item.player)}
            <p className="announce-note">因為{item.reason}</p>
          </>
        ),
      };
    case 'peace':
      return { tone: 'safe', kicker: '今晚', title: '平安無事', body: <p className="announce-note">沒有人死亡</p> };
    case 'death':
      return {
        tone: 'dark',
        kicker: '死亡',
        title: `${name(item.player)} 死亡`,
        body: (
          <>
            {who(item.player)}
            <p className="announce-note">
              原因：{item.cause}
              <br />
              曾經是女巫：{item.wasWitch ? '是' : '否'}
            </p>
          </>
        ),
      };
    case 'victory':
      return {
        tone: item.winner === 'town' ? 'town' : 'witch',
        kicker: '遊戲結束',
        title: item.winner === 'town' ? '鎮民獲勝' : '女巫獲勝',
        body: <p className="announce-note">女巫是：{item.witches.map((id) => name(id)).join('、') || '（無）'}</p>,
      };
  }
}

/** How long a computer player waits before each move; the host can change it at any time, even mid-game */
export function BotPaceSetting({ seconds, send, disabled }: { seconds: number; send: Send; disabled?: boolean }) {
  const [local, setLocal] = useState(seconds);
  // Follow changes made elsewhere (another host tab, a new snapshot)
  useEffect(() => setLocal(seconds), [seconds]);
  const commit = () => local !== seconds && send('botPace', { seconds: local });
  return (
    <label className="check pace">
      <span>電腦動作間隔</span>
      <input
        type="range"
        min={1}
        max={10}
        step={0.5}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-valuetext={`${local} 秒`}
      />
      <b className="pace-value">{local} 秒</b>
    </label>
  );
}
