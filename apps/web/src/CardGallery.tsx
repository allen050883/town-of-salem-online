import { ACCUSATION_THRESHOLD, CARD_COLOR, CARD_NAME, type CardType, type TryalKind } from '@salem/engine';
import { CARD_DESC, TRYAL_FULL, TRYAL_LABEL } from './text';

/** Dev-only: card gallery (http://localhost:5173/?preview=cards) */

const HAND: CardType[] = ['accusation', 'evidence', 'witness', 'alibi', 'arson', 'curse', 'robbery', 'scapegoat', 'stocks', 'matchmaker', 'asylum', 'piety', 'black_cat'];
const BLACK: CardType[] = ['night', 'conspiracy'];
const KINDS: TryalKind[] = ['witch', 'constable', 'not_a_witch'];

function Section({ night }: { night: boolean }) {
  return (
    <div className={`game gallery ${night ? 'is-night' : ''}`}>
      <h2 className="gallery-h">{night ? '夜晚' : '白天'}</h2>

      <h3>手牌</h3>
      <div className="gallery-grid">
        {HAND.map((t) => (
          <figure key={t}>
            <button className={`card c-${CARD_COLOR[t]}`}>{CARD_NAME[t]}</button>
            <figcaption>{CARD_DESC[t]}</figcaption>
          </figure>
        ))}
      </div>

      <h3>手牌狀態</h3>
      <div className="hand">
        <figure>
          <button className="card c-red">指控</button>
          <figcaption>一般</figcaption>
        </figure>
        <figure>
          <button className="card c-red is-selected">指控</button>
          <figcaption>已選取</figcaption>
        </figure>
        <figure>
          <button className="card c-red" disabled>
            指控
          </button>
          <figcaption>不能出牌時</figcaption>
        </figure>
      </div>

      <h3>黑牌（抽到立即發動，不會進手牌）</h3>
      <div className="hand">
        {BLACK.map((t) => (
          <figure key={t}>
            <button className={`card c-${CARD_COLOR[t]}`}>{CARD_NAME[t]}</button>
            <figcaption>{CARD_DESC[t]}</figcaption>
          </figure>
        ))}
      </div>

      <h3>審判牌</h3>
      <div className="gallery-row">
        <figure>
          <div className="tryals">
            <button className="tryal k-hidden" disabled />
          </div>
          <figcaption>別人的，未翻開</figcaption>
        </figure>
        {KINDS.map((k) => (
          <figure key={`mine-${k}`}>
            <div className="tryals">
              <button className={`tryal k-${k}`} disabled>
                {TRYAL_LABEL[k]}
              </button>
            </div>
            <figcaption>自己的{TRYAL_FULL[k]}（只有你看得到）</figcaption>
          </figure>
        ))}
        {KINDS.map((k) => (
          <figure key={`rev-${k}`}>
            <div className="tryals">
              <button className={`tryal is-revealed k-${k}`} disabled>
                {TRYAL_LABEL[k]}
              </button>
            </div>
            <figcaption>已翻開：{TRYAL_FULL[k]}</figcaption>
          </figure>
        ))}
        <figure>
          <div className="tryals">
            <button className="tryal k-hidden is-pickable" />
          </div>
          <figcaption>可以點選（審判／傳染時）</figcaption>
        </figure>
      </div>

      <h3>放在玩家面前的藍牌</h3>
      <div className="front">
        {(['stocks', 'matchmaker', 'asylum', 'piety', 'black_cat'] as CardType[]).map((t) => (
          <button key={t} className={`chip c-${CARD_COLOR[t]}`} disabled>
            {CARD_NAME[t]}
          </button>
        ))}
        <button className="chip c-blue is-pickable">詛咒可選取</button>
      </div>

      <h3>指控點數</h3>
      <div className="gallery-row">
        {[0, 3, 6, 7].map((n) => (
          <figure key={n}>
            <div className="accuse">
              {Array.from({ length: ACCUSATION_THRESHOLD }, (_, i) => (
                <span key={i} className={i < n ? 'pip on' : 'pip'} />
              ))}
            </div>
            <figcaption>{n} 點</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

export function CardGallery() {
  return (
    <main>
      <Section night={false} />
      <Section night />
    </main>
  );
}
