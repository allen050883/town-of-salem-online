import { useEffect, useRef, useState } from 'react';
import type { ClientSnapshot } from './net';

const CHANNEL_LABEL = { public: '', witch: '女巫', dead: '亡者', system: '' } as const;

export function LogPanel({ snap, send }: { snap: ClientSnapshot; send: (t: 'chat', p: { text: string }) => void }) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const last = snap.log.at(-1)?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [last]);

  const v = snap.view;
  const meP = v?.players[v.me];
  let hint = '說點什麼…';
  if (v && meP) {
    const ph = v.phase;
    const closed = ph.kind === 'dawn' || (ph.kind === 'night' && ph.step !== 'confess');
    if (!meP.alive) hint = snap.lastWordsLeft ? `遺言（剩 ${snap.lastWordsLeft} 句）` : '只有亡者看得到';
    else if (closed) hint = v.amWitch ? '女巫密談（只有女巫看得到）' : '閉眼中，不能說話';
  }

  return (
    <aside className="log">
      <div className="log-scroll" aria-live="polite">
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
        <div ref={endRef} />
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
