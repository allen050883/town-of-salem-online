import type { Voice } from './voice';

export function VoiceControls({ voice }: { voice: Voice }) {
  if (!voice.enabled) {
    return (
      <span className="voice">
        <button className="small" onClick={() => void voice.start()} title="用麥克風和大家說話">
          開啟語音
        </button>
        {voice.error && <span className="error small-text">{voice.error}</span>}
      </span>
    );
  }
  return (
    <span className="voice">
      <button className={`small ${voice.muted ? '' : 'primary'}`} onClick={() => voice.setMuted(!voice.muted)} aria-pressed={!voice.muted}>
        {voice.muted ? '麥克風關' : '麥克風開'}
      </button>
      {!voice.muted && voice.canSpeakNow === 0 && (
        <span className="muted small-text" title="依照目前階段（閉眼、死亡、觀戰），沒有人聽得到你">
          （現在沒人聽得到你）
        </span>
      )}
      <button className="ghost small" onClick={voice.stop}>
        關閉語音
      </button>
    </span>
  );
}
