import type { CardType, TryalKind } from '@salem/engine';
import { CardFace } from './CardFace';

/** Dev-only: every illustrated card in day and night themes (http://localhost:5173/?preview=cards) */

const GROUPS: { title: string; note: string; kinds: (CardType | TryalKind)[] }[] = [
  { title: '紅牌', note: '指控：累積 7 點就審判', kinds: ['accusation', 'evidence', 'witness'] },
  { title: '綠牌', note: '一次性效果，用完棄掉', kinds: ['alibi', 'arson', 'curse', 'robbery', 'scapegoat'] },
  { title: '藍牌', note: '持續效果，留在玩家面前', kinds: ['stocks', 'matchmaker', 'asylum', 'piety', 'black_cat'] },
  { title: '黑牌', note: '事件：抽到立即發動', kinds: ['night', 'conspiracy'] },
  { title: '審判牌', note: '決定身分（牌桌上以小張字卡呈現）', kinds: ['witch', 'constable', 'not_a_witch'] },
];

function Section({ night }: { night: boolean }) {
  return (
    <div className={`game gallery ${night ? 'is-night' : ''}`}>
      <h2 className="gallery-h">{night ? '夜晚' : '白天'}</h2>
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h3>
            {g.title}
            <span className="gallery-note">{g.note}</span>
          </h3>
          <div className="gallery-row">
            {g.kinds.map((k) => (
              <figure key={k}>
                <CardFace kind={k} />
                <figcaption>完整尺寸</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3>
          手牌尺寸
          <span className="gallery-note">手牌以半尺寸顯示，只保留插畫、卡名和點數</span>
        </h3>
        <div className="gallery-row">
          {GROUPS.slice(0, 4)
            .flatMap((g) => g.kinds)
            .map((k) => (
              <CardFace key={k} kind={k} scale={0.5} compact />
            ))}
        </div>
      </section>
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
