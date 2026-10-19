import type { CardType, TryalKind } from '@salem/engine';
import { CARD_ART } from './art/cards';

/** The illustrated card's native size, matching the Claude Design canvas */
export const CARD_W = 240;
export const CARD_H = 336;

interface Props {
  kind: CardType | TryalKind;
  /** Display scale: 1 = full size (with effect text); smaller values are used for the hand */
  scale?: number;
  /** Hide the effect text (the hand uses a reduced size where the text would be too small to read) */
  compact?: boolean;
}

/**
 * Illustrated card face: laid out at 240×336 then scaled as a whole, so every size is the same composition.
 * The outer box takes the scaled size so the surrounding layout gets the right footprint.
 */
export function CardFace({ kind, scale = 1, compact = false }: Props) {
  const art = CARD_ART[kind];
  const darkInk = art.ink === '#1d2633';
  const line = darkInk ? 'rgba(29, 38, 51, 0.35)' : 'rgba(243, 241, 236, 0.35)';

  return (
    <span className="cardface-box" style={{ width: CARD_W * scale, height: CARD_H * scale }}>
      <span
        className={`cardface ${compact ? 'is-compact' : ''}`}
        style={{
          transform: scale === 1 ? undefined : `scale(${scale})`,
          color: art.ink,
          backgroundColor: art.bg,
          backgroundImage: art.pattern,
        }}
      >
        <svg
          className="cardface-art"
          viewBox="0 0 200 160"
          role="img"
          aria-label={art.label}
          style={{ borderColor: art.border }}
          dangerouslySetInnerHTML={{ __html: art.svg }}
        />
        <span className="cardface-band" style={{ background: art.band, borderColor: line }}>
          <span className="cardface-name">{art.name}</span>
          <span className="cardface-rule" style={{ background: line }} />
          {!compact && <span className="cardface-text">{art.text}</span>}
          {art.pips != null ? (
            <span className="cardface-pips" role="img" aria-label={`${art.pips} 點`}>
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i} className={i < art.pips! ? 'on' : ''} />
              ))}
            </span>
          ) : (
            <span className="cardface-foot">{art.footer}</span>
          )}
        </span>
      </span>
    </span>
  );
}
