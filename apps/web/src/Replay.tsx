import { useEffect, useMemo, useRef, useState } from 'react';
import { announceItems, createGame, eventsFor, projectFor, reduce, type AnnounceItem, type GameEvent, type GameState, type PlayerId } from '@salem/engine';
import type { ReplayRecord } from '../../server/src/protocol';
import { StaticTown, isDark, phaseText } from './Table';
import { Announcer, type Hit } from './Feedback';

const OMNISCIENT = '__all__';

interface Timeline {
  states: GameState[];
  /** Events produced by each step (index i = events of reaching states[i]) */
  events: GameEvent[][];
  /** Set when the record can't be replayed to the end (a different rules version, a damaged file) */
  brokenAt: number | null;
}

function buildTimeline(r: ReplayRecord): Timeline {
  let s = createGame(r.seats, r.seed, r.options);
  const states = [s];
  const events: GameEvent[][] = [[]];
  for (let i = 0; i < r.actions.length; i++) {
    const res = reduce(s, r.actions[i]!);
    if (!res.ok) return { states, events, brokenAt: i };
    s = res.state;
    states.push(s);
    events.push(res.events);
  }
  return { states, events, brokenAt: null };
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Replay({ record, onClose }: { record: ReplayRecord; onClose: () => void }) {
  const tl = useMemo(() => buildTimeline(record), [record]);
  const last = tl.states.length - 1;
  const [step, setStep] = useState(0);
  const [who, setWho] = useState<PlayerId>(OMNISCIENT);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  /** The full-screen cards for the step just played (the same ones the live game shows); the replay waits for them */
  const [announce, setAnnounce] = useState<{ id: string; items: AnnounceItem[] } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  /** Go to a step. Moving forward one step plays that step's announcements; any other jump just goes there */
  const goTo = (i: number) => {
    const next = Math.max(0, Math.min(last, i));
    if (next === step + 1) {
      const list = (tl.events[next] ?? []).flatMap((e) => (e.announce ? [e.announce] : []));
      const items = announceItems(list).map((it) => (it.ms ? { ...it, ms: Math.max(1200, Math.round(it.ms / speed)) } : it));
      setAnnounce(items.length ? { id: `${next}-${Date.now()}`, items } : null);
    } else setAnnounce(null);
    setStep(next);
  };

  // Autoplay: one step at a time; while a full-screen card is up it waits, then pauses a beat before the next step
  useEffect(() => {
    if (!playing || announce) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => goTo(step + 1), 1800 / speed);
    return () => clearTimeout(t);
  }, [playing, step, last, speed, announce]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [step]);

  const state = tl.states[step]!;
  const omniscient = who === OMNISCIENT;
  // The all-seeing view uses a viewer id that isn't seated; omniscient reveals every secret
  const view = projectFor(state, omniscient ? '__replay__' : who, omniscient);

  const lines = useMemo(() => {
    const out: { key: string; text: string; chat?: { from: string; channel: string } }[] = [];
    for (let i = 0; i <= step; i++) {
      const evs = omniscient ? tl.events[i]! : eventsFor(tl.events[i]!, who);
      for (const e of evs) {
        // In the all-seeing view, say whose secret a private line was (it reads "你…" in the live game)
        const whose = omniscient && e.visibleTo ? `［${e.visibleTo.map((id) => state.players[id]?.name ?? '?').join('、')}］` : '';
        out.push({ key: `e${e.seq}`, text: whose + e.text });
      }
      record.chat.forEach((c, j) => {
        if (c.after !== i) return;
        const visible = omniscient || c.channel === 'public' || (c.channel === 'witch' && state.players[who]?.everWitch);
        if (visible) out.push({ key: `c${j}`, text: c.text, chat: { from: c.from, channel: c.channel } });
      });
    }
    return out;
  }, [step, who, omniscient, tl, record.chat, state]);

  const action = step > 0 ? record.actions[step - 1] : null;

  // Whoever something just happened to lights up, like in the live game
  const hits = useMemo(() => {
    const out = new Map<PlayerId, Hit>();
    for (const e of tl.events[step] ?? []) {
      for (const f of e.fx ?? []) out.set(f.target, { label: out.has(f.target) ? `${out.get(f.target)!.label}・${f.label}` : f.label, key: step });
    }
    return out;
  }, [tl, step]);
  const recent = lines.filter((l) => !l.chat).slice(-2);

  const download = () => {
    const blob = new Blob([JSON.stringify(record)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `salem-${record.roomCode}-${new Date(record.startedAt).toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className={`game replay ${isDark(view) ? 'is-night' : ''}`}>
      <header className="bar">
        <h1 className="title small">
          重播<span className="year">1692</span>
        </h1>
        <span className="code-chip">{record.roomCode}</span>
        <span className="deck-chip">{new Date(record.startedAt).toLocaleString()}</span>
        <label className="perspective">
          視角
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value={OMNISCIENT}>全知（看得到所有祕密）</option>
            {record.seats.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost small" onClick={download}>
          下載紀錄
        </button>
        <button className="ghost small" onClick={onClose}>
          關閉
        </button>
      </header>

      <Announcer announce={announce} view={view} onDone={() => setAnnounce(null)} skippable />
      <p className="prompt" role="status">
        <span>
          第 {step} / {last} 步{action ? `（${fmtTime(action.at)}）` : ''}。牌堆 {view.deckCount}・棄牌 {view.discardCount}。{phaseText(view)}
        </span>
      </p>
      {recent.length > 0 && (
        <p className="ticker" aria-label="最新動態">
          {recent.length === 2 && <span className="ticker-old">{recent[0]!.text}</span>}
          <span key={recent.at(-1)!.key} className="ticker-new">
            {recent.at(-1)!.text}
          </span>
        </p>
      )}
      {tl.brokenAt !== null && (
        <p className="banner" role="alert">
          這份紀錄只能重播到第 {tl.brokenAt} 步（可能是用不同版本的規則記錄的）。
        </p>
      )}

      <div className="board">
        <StaticTown view={view} hits={hits} />
        <aside className="log">
          <div className="log-scroll" aria-live="polite" ref={logRef}>
            {lines.map((l) => (
              <p key={l.key} className={l.chat ? `entry-chat ch-${l.chat.channel}` : 'entry-event'}>
                {l.chat ? (
                  <>
                    <b>{l.chat.from}</b>：{l.text}
                  </>
                ) : (
                  l.text
                )}
              </p>
            ))}
          </div>
        </aside>
      </div>

      <footer className="hand-bar replay-controls">
        <button className="small" onClick={() => goTo(0)} disabled={step === 0} aria-label="回到開頭">
          ⏮
        </button>
        <button className="small" onClick={() => goTo(step - 1)} disabled={step === 0} aria-label="上一步">
          ◀
        </button>
        <button
          className="primary small"
          onClick={() => {
            // Playing again from the end starts over
            if (!playing && step >= last) goTo(0);
            setPlaying(!playing);
          }}
        >
          {playing ? '暫停' : '播放'}
        </button>
        <button className="small" onClick={() => goTo(step + 1)} disabled={step >= last} aria-label="下一步">
          ▶
        </button>
        <button className="small" onClick={() => goTo(last)} disabled={step >= last} aria-label="跳到結尾">
          ⏭
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={step}
          onChange={(e) => goTo(Number(e.target.value))}
          aria-label="重播進度"
          className="scrubber"
        />
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="播放速度">
          {[0.5, 1, 2, 4].map((x) => (
            <option key={x} value={x}>
              {x}x
            </option>
          ))}
        </select>
      </footer>
    </div>
  );
}
