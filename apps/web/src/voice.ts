import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerId } from '@salem/engine';
import type { RtcRelay } from '../../server/src/protocol';
import type { ClientSnapshot, Send } from './net';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Who may hear `speaker` right now. Mirrors the text-chat rules: eyes closed means only witches talk (to witches),
 * the dead and spectators only talk among themselves. Each client applies this to its own outgoing audio.
 */
export function canHear(snap: ClientSnapshot, speaker: PlayerId, listener: PlayerId): boolean {
  const v = snap.view;
  if (!v || v.phase.kind === 'game_over') return true;
  const sp = v.players[speaker];
  const li = v.players[listener];
  const watching = (p: typeof sp) => !p || !p.alive;
  if (watching(sp)) return watching(li);
  const ph = v.phase;
  const eyesClosed = ph.kind === 'dawn' || (ph.kind === 'night' && ph.step !== 'confess');
  if (!eyesClosed) return true;
  // Only a witch can see who the other witches are, which is exactly who she may talk to
  return speaker === v.me ? v.amWitch && !!li?.alive && li.isWitch === true : false;
}

interface Peer {
  pc: RTCPeerConnection;
  sender: RTCRtpSender | null;
  audio: HTMLAudioElement;
}

export function useVoice(snap: ClientSnapshot | null, send: Send, onRtc: (fn: (m: unknown) => void) => () => void) {
  const [enabled, setEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<PlayerId, Peer>());
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const me = snap?.me;

  const closePeer = useCallback((id: PlayerId) => {
    const p = peers.current.get(id);
    if (!p) return;
    p.pc.close();
    p.audio.srcObject = null;
    peers.current.delete(id);
  }, []);

  /** Send my microphone only to peers allowed to hear me */
  const applyPolicy = useCallback(() => {
    const s = snapRef.current;
    const track = streamRef.current?.getAudioTracks()[0] ?? null;
    if (!s || !track) return;
    for (const [id, p] of peers.current) {
      const want = canHear(s, s.me, id) ? track : null;
      if (p.sender && p.sender.track !== want) void p.sender.replaceTrack(want);
    }
  }, []);

  const getPeer = useCallback(
    (id: PlayerId): Peer => {
      const existing = peers.current.get(id);
      if (existing) return existing;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const audio = new Audio();
      audio.autoplay = true;
      const track = streamRef.current?.getAudioTracks()[0];
      const sender = track ? pc.addTrack(track, streamRef.current!) : null;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        void audio.play().catch(() => {});
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) send('rtc', { to: id, data: { candidate: e.candidate.toJSON() as Record<string, unknown> } });
      };
      const peer = { pc, sender, audio };
      peers.current.set(id, peer);
      applyPolicy();
      return peer;
    },
    [send, applyPolicy],
  );

  // Signaling from other members
  useEffect(() => {
    if (!enabled) return;
    return onRtc(async (raw) => {
      const { from, data } = raw as RtcRelay;
      try {
        if (data.sdp?.type === 'offer') {
          const { pc } = getPeer(from);
          await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
          await pc.setLocalDescription(await pc.createAnswer());
          send('rtc', { to: from, data: { sdp: pc.localDescription!.toJSON() as { type: 'answer'; sdp: string } } });
        } else if (data.sdp?.type === 'answer') {
          await peers.current.get(from)?.pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
        } else if (data.candidate) {
          await peers.current.get(from)?.pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
        }
      } catch (e) {
        console.warn('voice signaling failed', e);
      }
    });
  }, [enabled, onRtc, getPeer, send]);

  // Connect to everyone else with voice on; the member with the smaller id makes the offer
  const voiceKey = snap?.voice.join(',') ?? '';
  useEffect(() => {
    if (!enabled || !me) return;
    const others = new Set((snap?.voice ?? []).filter((id) => id !== me));
    for (const id of [...peers.current.keys()]) if (!others.has(id)) closePeer(id);
    for (const id of others) {
      if (peers.current.has(id) || me > id) continue;
      const { pc } = getPeer(id);
      void (async () => {
        await pc.setLocalDescription(await pc.createOffer());
        send('rtc', { to: id, data: { sdp: pc.localDescription!.toJSON() as { type: 'offer'; sdp: string } } });
      })();
    }
  }, [enabled, me, voiceKey, getPeer, closePeer, send]);

  // Phase changes (night falls, someone dies) change who may hear whom
  useEffect(() => applyPolicy(), [snap, applyPolicy]);

  useEffect(() => {
    const t = streamRef.current?.getAudioTracks()[0];
    if (t) t.enabled = !muted;
  }, [muted, enabled]);

  const stop = useCallback(() => {
    for (const id of [...peers.current.keys()]) closePeer(id);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setEnabled(false);
    send('voice', { on: false });
  }, [closePeer, send]);

  const start = useCallback(async () => {
    setError(null);
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      setEnabled(true);
      send('voice', { on: true });
    } catch {
      setError('無法使用麥克風（需要允許權限，且網址必須是 https 或 localhost）');
    }
  }, [send]);

  // Leaving the room ends voice
  const room = snap?.roomCode;
  useEffect(() => {
    if (!room && streamRef.current) stop();
  }, [room, stop]);

  useEffect(() => () => {
    for (const p of peers.current.values()) p.pc.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  return { enabled, muted, error, start, stop, setMuted, canSpeakNow: snap ? hearersOfMe(snap) : 0 };
}

/** How many voice members can currently hear me (0 means I'm effectively muted by the rules) */
function hearersOfMe(snap: ClientSnapshot) {
  return snap.voice.filter((id) => id !== snap.me && canHear(snap, snap.me, id)).length;
}

export type Voice = ReturnType<typeof useVoice>;
