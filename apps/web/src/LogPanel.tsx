import { useEffect, useRef, useState } from 'react';
import type { ClientSnapshot, Send } from './net';

const CHANNEL_LABEL = { public: '', witch: '女巫', dead: '亡者', spectator: '觀戰', system: '' } as const;

export function LogPanel({ snap, send }: { snap: ClientSnapshot; send: Send }) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const last = snap.log.at(-1)?.id;

  useEffect(() => {
    // Scroll the log box itself; scrollIntoView would also scroll the page on phones
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  const v = snap.view;
  const meP = v?.players[v.me];
  let hint = '說點什麼…';
  if (v && !meP && v.phase.kind !== 'game_over') hint = '觀戰聊天（只有觀戰者和亡者看得到）';
  if (v && meP) {
    const ph = v.phase;
    const closed = ph.kind === 'dawn' || (ph.kind === 'night' && ph.step !== 'confess');
    if (!meP.alive) hint = snap.lastWordsLeft ? `遺言（剩 ${snap.lastWordsLeft} 句）` : '只有亡者看得到';
    else if (closed) hint = v.amWitch ? '女巫密談（只有女巫看得到）' : '閉眼中，不能說話';
  }

  return (
    <aside className="log">
      <div className="log-scroll" aria-live="polite" ref={scrollRef}>
        {snap.log.map((e) => (
          <p key={e.id} className={`entry-${e.kind} ch-${e.channel}`}>
            {e.kind === 'chat' ? (
              <>
                {CHANNEL_LABEL[e.channel] && <span className="ch">{CHANNEL_LABEL[e.channel]}</span>}
                <b>{e.from}</b>：{e.text}
              </>
            ) : (
              e.text
            )}
          </p>
        ))}
      </div>
      <form
        className="chat"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          send('chat', { text });
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={hint} maxLength={300} aria-label="聊天訊息" />
        <button type="submit">送出</button>
      </form>
    </aside>
  );
}
