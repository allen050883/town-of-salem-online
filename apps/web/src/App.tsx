import { useState } from 'react';
import { MAX_PLAYERS, MIN_PLAYERS } from '@salem/engine';
import { useSalem, type ClientSnapshot } from './net';
import { Game } from './Game';
import { LogPanel } from './LogPanel';

export function App() {
  const salem = useSalem();
  const { snap } = salem;

  if (!snap) return <Entry {...salem} />;
  if (!snap.view) return <Lobby {...salem} snap={snap} />;
  return <Game snap={snap} view={snap.view} act={salem.act} send={salem.send} error={salem.error} onLeave={salem.leave} />;
}

function Entry({ connect, busy, error, savedName }: ReturnType<typeof useSalem>) {
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState('');
  const ready = name.trim().length > 0;

  return (
    <main className="entry">
      <h1 className="title">
        獵巫鎮<span className="year">1692</span>
      </h1>
      <p className="lede">麻薩諸塞州，塞勒姆。女巫就藏在你們之中。指控你懷疑的人，保護你信任的人。小心，到了夜晚，事情就不一樣了。</p>

      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void connect(code.trim() ? 'join' : 'create', name.trim(), code);
        }}
      >
        <label>
          你的名字
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="例如：約翰．普羅克特" autoFocus />
        </label>
        <label>
          房號（要加入朋友的房間才需要填）
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={5}
            placeholder="ABCDE"
            className="code-input"
          />
        </label>
        <button type="submit" className="primary" disabled={!ready || busy}>
          {busy ? '連線中…' : code.trim() ? '加入房間' : '建立新房間'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}

function Lobby({ snap, send, leave, error }: { snap: ClientSnapshot } & ReturnType<typeof useSalem>) {
  const isHost = snap.hostId === snap.me;
  const n = snap.lobby.length;
  const canStart = n >= MIN_PLAYERS && n <= MAX_PLAYERS;

  return (
    <main className="lobby">
      <section className="lobby-main">
        <p className="muted">把房號告訴朋友，請他們在首頁輸入</p>
        <div className="room-code">{snap.roomCode}</div>

        <h2>鎮民名冊（{n} / {MAX_PLAYERS}）</h2>
        <ol className="roster">
          {snap.lobby.map((p) => (
            <li key={p.id}>
              {p.name}
              {p.id === snap.hostId && <span className="tag">房主</span>}
              {p.id === snap.me && <span className="tag">你</span>}
            </li>
          ))}
        </ol>

        {isHost ? (
          <button className="primary" disabled={!canStart} onClick={() => send('start')}>
            {canStart ? '開始遊戲' : `還需要 ${MIN_PLAYERS - n} 人才能開始`}
          </button>
        ) : (
          <p className="muted">等待房主開始遊戲…</p>
        )}
        {error && <p className="error">{error}</p>}
        <button className="ghost" onClick={leave}>
          離開房間
        </button>
      </section>
      <LogPanel snap={snap} send={send} />
    </main>
  );
}
