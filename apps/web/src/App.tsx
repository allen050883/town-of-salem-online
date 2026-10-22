import { useEffect, useState } from 'react';
import { MAX_PLAYERS, MIN_PLAYERS, ROLE_CHOICE_MAX_PLAYERS } from '@salem/engine';
import type { ReplayRecord, ReplaySummary } from '../../server/src/protocol';
import { fetchReplay, fetchReplayList, loginUrl, useAuthConfig, useSalem, type ClientSnapshot, type Salem } from './net';
import { Avatar } from './Avatar';
import { BotPaceSetting } from './Feedback';
import { Game } from './Game';
import { LogPanel } from './LogPanel';
import { Replay } from './Replay';

/** Default table size for solo play: you and four computer players */
const SOLO_DEFAULT = 5;

export function App() {
  const replayId = new URLSearchParams(location.search).get('replay');
  const [replay, setReplay] = useState<ReplayRecord | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  useEffect(() => {
    if (replayId) fetchReplay(replayId).then(setReplay, (e: Error) => setReplayError(e.message));
  }, [replayId]);

  const closeReplay = () => {
    setReplay(null);
    if (replayId) history.replaceState(null, '', location.pathname);
  };

  if (replay) return <Replay record={replay} onClose={closeReplay} />;
  if (replayId && !replayError) return <p className="loading">載入重播中…</p>;
  return <Live onReplay={setReplay} replayError={replayError} />;
}

function Live({ onReplay, replayError }: { onReplay: (r: ReplayRecord) => void; replayError: string | null }) {
  const salem = useSalem();
  const { snap } = salem;

  if (!snap) return <Entry salem={salem} onReplay={onReplay} replayError={replayError} />;
  if (!snap.view) return <Lobby salem={salem} snap={snap} />;
  return (
    <Game
      snap={snap}
      view={snap.view}
      act={salem.act}
      send={salem.send}
      error={salem.error}
      connection={salem.connection}
      onLeave={salem.leave}
    />
  );
}

function Entry({ salem, onReplay, replayError }: { salem: Salem; onReplay: (r: ReplayRecord) => void; replayError: string | null }) {
  const { connect, busy, error, connection, me, logout } = salem;
  const config = useAuthConfig();
  const [code, setCode] = useState('');
  const [devName, setDevName] = useState('');
  const [spectate, setSpectate] = useState(false);
  const [soloTotal, setSoloTotal] = useState(SOLO_DEFAULT);

  return (
    <main className="entry">
      <h1 className="title">
        獵巫鎮<span className="year">1692</span>
      </h1>
      <p className="lede">麻薩諸塞州，塞勒姆。女巫就藏在你們之中。指控你懷疑的人，保護你信任的人。小心，到了夜晚，事情就不一樣了。</p>

      {connection === 'reconnecting' && <p className="banner">正在回到剛才的房間…</p>}

      {me ? (
        <form
          className="entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect(code.trim() ? 'join' : 'create', code, spectate);
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
              autoCapitalize="characters"
            />
          </label>
          {code.trim() && (
            <label className="check">
              <input type="checkbox" checked={spectate} onChange={(e) => setSpectate(e.target.checked)} />
              只觀戰，不入座（遊戲進行中加入一律是觀戰）
            </label>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '連線中…' : code.trim() ? (spectate ? '進去觀戰' : '加入房間') : '建立新房間'}
          </button>
          {!code.trim() && (
            <div className="solo">
              <button type="button" disabled={busy} onClick={() => void connect('create', undefined, false, soloTotal - 1)}>
                單人遊戲（和 {soloTotal - 1} 位電腦玩家）
              </button>
              <select value={soloTotal} onChange={(e) => setSoloTotal(Number(e.target.value))} aria-label="單人遊戲的總人數">
                {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((k) => (
                  <option key={k} value={k}>
                    共 {k} 人
                  </option>
                ))}
              </select>
            </div>
          )}
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

      <ReplayPicker onReplay={onReplay} replayError={replayError} />
    </main>
  );
}

function ReplayPicker({ onReplay, replayError }: { onReplay: (r: ReplayRecord) => void; replayError: string | null }) {
  const [list, setList] = useState<ReplaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(replayError);

  const open = (id: string) => fetchReplay(id).then(onReplay, (e: Error) => setError(e.message));

  return (
    <section className="replays">
      <h2>對戰紀錄</h2>
      <div className="turn-actions">
        <button className="small" onClick={() => fetchReplayList().then(setList, (e: Error) => setError(e.message))}>
          最近的對戰
        </button>
        <label className="button-link small">
          開啟紀錄檔…
          <input
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                onReplay(JSON.parse(await f.text()) as ReplayRecord);
              } catch {
                setError('這不是有效的對戰紀錄檔');
              }
            }}
          />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {list && list.length === 0 && <p className="muted">還沒有任何對戰紀錄。</p>}
      {list && list.length > 0 && (
        <ul className="replay-list">
          {list.map((r) => (
            <li key={r.id}>
              <button className="ghost" onClick={() => void open(r.id)}>
                {new Date(r.startedAt).toLocaleString()}・{r.players.length} 人・{r.winner === 'town' ? '鎮民勝' : r.winner === 'witches' ? '女巫勝' : '未完成'}
              </button>
              <span className="muted small-text">{r.players.join('、')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Lobby({ salem, snap }: { salem: Salem; snap: ClientSnapshot }) {
  const { send, leave, error, setOptions } = salem;
  const isHost = snap.hostId === snap.me;
  const n = snap.lobby.length;
  const seats = snap.seatCount ?? MAX_PLAYERS;
  const fillBots = snap.seatCount === null ? 0 : Math.max(0, snap.seatCount - n);
  // With a fixed number of seats the empty ones are filled with computer players at the start
  const canStart = snap.seatCount === null ? n >= MIN_PLAYERS && n <= MAX_PLAYERS : n >= 1 && n <= snap.seatCount;
  const spectating = snap.seat === 'spectator';

  return (
    <main className="lobby">
      <section className="lobby-main">
        <p className="muted">把房號告訴朋友，請他們在首頁輸入</p>
        <div className="room-code">{snap.roomCode}</div>

        <h2>
          鎮民名冊（{n} / {snap.seatCount ?? '不限'}）
        </h2>
        <ol className="roster">
          {snap.lobby.map((p) => (
            <li key={p.id}>
              <Avatar name={p.name} picture={p.picture} size={28} />
              {p.name}
              {p.bot && <span className="tag">電腦</span>}
              {p.id === snap.hostId && <span className="tag">房主</span>}
              {p.id === snap.me && <span className="tag">你</span>}
              {!p.connected && <span className="tag offline">離線</span>}
              {p.bot && isHost && (
                <button className="ghost small" onClick={() => send('removeBot', { id: p.id })} aria-label={`移除電腦玩家 ${p.name}`}>
                  移除
                </button>
              )}
            </li>
          ))}
        </ol>
        {isHost && (
          <div className="turn-actions">
            <button className="small" onClick={() => send('addBots', { count: 1 })} disabled={n >= seats}>
              加入電腦玩家
            </button>
            {snap.seatCount === null && n < MIN_PLAYERS && (
              <button className="small" onClick={() => send('addBots', { count: MIN_PLAYERS - n })}>
                用電腦補到 {MIN_PLAYERS} 人
              </button>
            )}
          </div>
        )}

        {snap.spectators.length > 0 && (
          <>
            <h2>觀戰席</h2>
            <ul className="roster">
              {snap.spectators.map((p) => (
                <li key={p.id}>
                  <Avatar name={p.name} picture={p.picture} size={28} />
                  {p.name}
                  {p.id === snap.me && <span className="tag">你</span>}
                </li>
              ))}
            </ul>
          </>
        )}

        <fieldset className="options" disabled={!isHost}>
          <legend>規則{isHost ? '' : '（由房主決定）'}</legend>
          <label className="check">
            遊戲人數
            <select value={snap.seatCount ?? ''} onChange={(e) => send('seatCount', { count: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">不固定（現場有幾人就幾人）</option>
              {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((k) => (
                <option key={k} value={k} disabled={k < n}>
                  {k} 人{k < n ? '（目前人數已超過）' : ''}
                </option>
              ))}
            </select>
          </label>
          <BotPaceSetting seconds={snap.botSeconds} send={send} />
          {snap.seatCount !== null && <p className="muted small-text">開始時，空著的座位會由電腦玩家補滿；坐滿後再進來的人會變成觀戰。</p>}
          <label className="check">
            <input type="checkbox" checked={snap.options.roles} onChange={(e) => setOptions({ roles: e.target.checked })} />
            鎮公所角色（{ROLE_CHOICE_MAX_PLAYERS} 人以下每人從 2 位中選 1 位）
          </label>
          <label className="check">
            <input type="checkbox" checked={snap.options.extraWitch} onChange={(e) => setOptions({ extraWitch: e.target.checked })} />
            進階：多一張女巫牌
          </label>
        </fieldset>

        {spectating ? (
          <button onClick={() => send('seat', { spectate: false })} disabled={n >= seats}>
            入座參加遊戲
          </button>
        ) : isHost ? (
          <button className="primary" disabled={!canStart} onClick={() => send('start')}>
            {canStart ? (fillBots > 0 ? `開始遊戲（電腦補 ${fillBots} 位）` : '開始遊戲') : `還需要 ${MIN_PLAYERS - n} 人才能開始`}
          </button>
        ) : (
          <p className="muted">等待房主開始遊戲…</p>
        )}
        {!spectating && (
          <button className="ghost small" onClick={() => send('seat', { spectate: true })}>
            改成觀戰
          </button>
        )}
        {error && <p className="error">{error}</p>}
        {snap.lastReplayId && (
          <a className="button-link" href={`?replay=${snap.lastReplayId}`} target="_blank" rel="noreferrer">
            觀看上一場的重播
          </a>
        )}
        <button className="ghost" onClick={leave}>
          離開房間
        </button>
      </section>
      <LogPanel snap={snap} send={send} />
    </main>
  );
}
