import { useEffect, useMemo, useRef, useState } from 'react';
import { createGame, eventsFor, projectFor, reduce, type GameEvent, type GameState, type PlayerId } from '@salem/engine';
import type { ReplayRecord } from '../../server/src/protocol';
import { StaticTown, isDark, phaseText } from './Table';

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
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!playing) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, last)), 900);
    return () => clearTimeout(t);
  }, [playing, step, last]);

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

      <p className="prompt" role="status">
        <span>
          第 {step} / {last} 步{action ? `（${fmtTime(action.at)}）` : ''}。{phaseText(view)}
        </span>
      </p>
      {tl.brokenAt !== null && (
        <p className="banner" role="alert">
          這份紀錄只能重播到第 {tl.brokenAt} 步（可能是用不同版本的規則記錄的）。
        </p>
      )}

      <div className="board">
        <StaticTown view={view} />
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
        <button className="small" onClick={() => setStep(0)} disabled={step === 0} aria-label="回到開頭">
          ⏮
        </button>
        <button className="small" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} aria-label="上一步">
          ◀
        </button>
        <button className="primary small" onClick={() => setPlaying(!playing)} disabled={step >= last && !playing}>
          {playing ? '暫停' : '播放'}
        </button>
        <button className="small" onClick={() => setStep(Math.min(last, step + 1))} disabled={step >= last} aria-label="下一步">
          ▶
        </button>
        <button className="small" onClick={() => setStep(last)} disabled={step >= last} aria-label="跳到結尾">
          ⏭
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={step}
          onChange={(e) => setStep(Number(e.target.value))}
          aria-label="重播進度"
          className="scrubber"
        />
      </footer>
    </div>
  );
}
