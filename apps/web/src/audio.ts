import { useEffect, useState } from 'react';

/** Sound effects are synthesised in the browser (no audio files); the background music is a quiet looping pad. Both can be muted and are remembered per device. */
export type Sfx = 'turn' | 'night' | 'protect' | 'confess' | 'target' | 'survive' | 'peace' | 'death' | 'victory' | 'conspiracy' | 'conspiracyPass';

interface Prefs {
  sfx: boolean;
  music: boolean;
}

const KEY = 'salem.audio';
let prefs: Prefs = { sfx: true, music: false };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) prefs = { ...prefs, ...JSON.parse(raw) };
} catch {
  /* storage can be blocked; the defaults do */
}
const listeners = new Set<() => void>();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  listeners.forEach((f) => f());
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One note: a short envelope on an oscillator */
function note(c: AudioContext, out: AudioNode, freq: number, start: number, len: number, type: OscillatorType = 'sine', vol = 0.18) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + len);
  o.connect(g).connect(out);
  o.start(start);
  o.stop(start + len + 0.05);
}

const N = { A2: 110, C3: 130.8, D3: 146.8, E3: 164.8, F3: 174.6, G3: 196, A3: 220, C4: 261.6, D4: 293.7, E4: 329.6, F4: 349.2, G4: 392, A4: 440, B4: 493.9, C5: 523.3, E5: 659.3, G5: 784 };

const SOUNDS: Record<Sfx, (c: AudioContext, t: number, out: AudioNode) => void> = {
  turn: (c, t, o) => {
    note(c, o, N.E5, t, 0.18);
    note(c, o, N.G5, t + 0.12, 0.28);
  },
  night: (c, t, o) => {
    note(c, o, N.A3, t, 0.9, 'triangle', 0.2);
    note(c, o, N.E3, t + 0.25, 1.1, 'triangle', 0.2);
  },
  protect: (c, t, o) => {
    note(c, o, N.C5, t, 0.3);
    note(c, o, N.E5, t + 0.1, 0.5);
  },
  confess: (c, t, o) => {
    note(c, o, N.D4, t, 0.25, 'triangle');
    note(c, o, N.F4, t + 0.2, 0.25, 'triangle');
    note(c, o, N.A4, t + 0.4, 0.5, 'triangle');
  },
  target: (c, t, o) => {
    note(c, o, N.A2, t, 0.5, 'sawtooth', 0.12);
    note(c, o, N.A2 * 1.06, t + 0.15, 0.6, 'sawtooth', 0.1);
  },
  survive: (c, t, o) => {
    note(c, o, N.G4, t, 0.2);
    note(c, o, N.C5, t + 0.15, 0.5);
  },
  peace: (c, t, o) => {
    note(c, o, N.C4, t, 0.5);
    note(c, o, N.G4, t + 0.25, 0.8);
  },
  death: (c, t, o) => {
    note(c, o, N.A3, t, 0.4, 'sawtooth', 0.14);
    note(c, o, N.F3, t + 0.3, 0.5, 'sawtooth', 0.14);
    note(c, o, N.D3, t + 0.65, 1.0, 'sawtooth', 0.14);
  },
  victory: (c, t, o) => {
    [N.C4, N.E4, N.G4, N.C5, N.E5].forEach((f, i) => note(c, o, f, t + i * 0.14, 0.6, 'triangle', 0.2));
  },
  conspiracy: (c, t, o) => {
    note(c, o, N.A2, t, 1.2, 'sawtooth', 0.12);
    note(c, o, N.A2 * 1.5, t + 0.1, 1.2, 'sawtooth', 0.08);
    note(c, o, N.A2 * 1.414, t + 0.2, 1.2, 'sawtooth', 0.08);
  },
  conspiracyPass: (c, t, o) => {
    note(c, o, N.E4, t, 0.2, 'triangle');
    note(c, o, N.C4, t + 0.18, 0.4, 'triangle');
  },
};

export function play(name: string) {
  if (!prefs.sfx) return;
  const fn = SOUNDS[name as Sfx];
  const c = audio();
  if (!fn || !c) return;
  fn(c, c.currentTime + 0.02, c.destination);
}

// ----- Background music: a slow minor chord loop, a few soft notes at a time -----
let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicBus: GainNode | null = null;
const CHORDS = [
  [N.A2, N.E3, N.A3, N.C4],
  [N.F3, N.C4, N.F4, N.A3],
  [N.C3, N.G3, N.C4, N.E4],
  [N.G3, N.D4, N.G4, N.B4],
];
let chordIndex = 0;

function chord(c: AudioContext) {
  if (!musicBus) return;
  const t = c.currentTime + 0.05;
  CHORDS[chordIndex++ % CHORDS.length]!.forEach((f, i) => note(c, musicBus!, f, t + i * 0.5, 5.5, 'sine', 0.05));
}

export function stopMusic() {
  if (musicTimer) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
  musicBus?.disconnect();
  musicBus = null;
}

function syncMusic() {
  if (prefs.music && !musicTimer) {
    const c = audio();
    if (!c) return;
    musicBus = c.createGain();
    musicBus.connect(c.destination);
    chord(c);
    musicTimer = setInterval(() => chord(c), 6000);
  } else if (!prefs.music) {
    stopMusic();
  }
}

export function setPrefs(p: Partial<Prefs>) {
  prefs = { ...prefs, ...p };
  save();
  syncMusic();
}

/** Browsers only allow sound after a tap: start the music, if it was left on, on the first one */
if (typeof window !== 'undefined') {
  const unlock = () => {
    syncMusic();
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
}

export function useAudioPrefs(): Prefs {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  return prefs;
}
