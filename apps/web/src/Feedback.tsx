import { useEffect, useRef, useState } from 'react';
import type { PlayerId, PlayerView } from '@salem/engine';
import type { LogEntry } from '../../server/src/protocol';

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
    goal: '你和鎮民同一陣營，要揪出所有女巫。每天夜晚可以把法槌交給一位玩家保護他（不能給自己）。',
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
