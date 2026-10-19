import { useState } from 'react';
import { MAX_PLAYERS, MIN_PLAYERS } from '@salem/engine';
import { loginUrl, useAuthConfig, useSalem, type ClientSnapshot } from './net';
import { Game } from './Game';
import { Avatar } from './Avatar';
import { LogPanel } from './LogPanel';

export function App() {
  const salem = useSalem();
  const { snap } = salem;

  if (!snap) return <Entry {...salem} />;
  if (!snap.view) return <Lobby {...salem} snap={snap} />;
  return <Game snap={snap} view={snap.view} act={salem.act} send={salem.send} error={salem.error} onLeave={salem.leave} />;
}

function Entry({ connect, busy, error, me, logout }: ReturnType<typeof useSalem>) {
  const [code, setCode] = useState('');
  const [devName, setDevName] = useState('');
  const config = useAuthConfig();

  return (
    <main className="entry">
      <h1 className="title">
        獵巫鎮<span className="year">1692</span>
      </h1>
      <p className="lede">麻薩諸塞州，塞勒姆。女巫就藏在你們之中。指控你懷疑的人，保護你信任的人。小心，到了夜晚，事情就不一樣了。</p>

      {me ? (
        <form
          className="entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect(code.trim() ? 'join' : 'create', code);
          }}
        >
          <div className="whoami">
            <Avatar name={me.name} picture={me.picture} />
            <span className="whoami-name">{me.name}</span>
            <button type="button" className="ghost small" onClick={logout}>
              登出
            </button>
          </div>
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
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '連線中…' : code.trim() ? '加入房間' : '建立新房間'}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      ) : (
        <div className="entry-form">
          {config?.line !== false ? (
            <a className="line-login" href={loginUrl('line')} aria-disabled={!config}>
              用 LINE 登入
            </a>
          ) : (
            <p className="error">伺服器還沒設定 LINE 登入（缺少 LINE_CHANNEL_ID / LINE_CHANNEL_SECRET）。</p>
          )}
          <p className="muted small-print">登入後會使用你的 LINE 名稱和頭像，讓朋友認得你。</p>
          {config?.dev && (
            <form
              className="dev-login"
              onSubmit={(e) => {
                e.preventDefault();
                if (devName.trim()) location.href = loginUrl('dev', devName.trim());
              }}
            >
              <label>
                開發用測試登入（只在本機開啟）
                <input value={devName} onChange={(e) => setDevName(e.target.value)} maxLength={16} placeholder="輸入任意名字" />
              </label>
              <button type="submit" disabled={!devName.trim()}>
                測試登入
              </button>
            </form>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
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
              <Avatar name={p.name} picture={p.picture} size={28} />
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
