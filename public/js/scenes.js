// 장면 이미지: 생성 이미지(캐시) → 모드팩 고정 이미지 → 기본 이미지(SVG) 순으로 고른다.
// 생성기가 없어도 게임은 끝까지 진행된다.

import { h, s } from './dom.js';
import { requestScene } from './api.js';
import { STAGES } from '/shared/safety.js';

export const EMOTION_COLORS = { passion: '#a8382c', calm: '#2f7f78', gold: '#b8902a' };
const STAGE_GLYPH = { child: '☾', teen: '✦', adult: '⚜', elder: '❦' };

export function placeholderSvg(scene, { locked = false } = {}) {
  const color = locked ? '#7d6a55' : EMOTION_COLORS[scene?.emotion] ?? '#8b6b4a';
  const svg = s('svg', { viewBox: '0 0 400 300', class: 'scene-placeholder', role: 'img', 'aria-label': locked ? '잠긴 장면' : scene?.title ?? '' },
    s('rect', { x: 0, y: 0, width: 400, height: 300, fill: '#efe3c6' }),
    s('rect', { x: 10, y: 10, width: 380, height: 280, fill: 'none', stroke: '#8b6b4a', 'stroke-width': 2 }),
    s('rect', { x: 18, y: 18, width: 364, height: 264, fill: 'none', stroke: color, 'stroke-width': 1, 'stroke-dasharray': '4 3' }),
    s('circle', { cx: 200, cy: 130, r: 62, fill: color, opacity: locked ? 0.25 : 0.18 }),
    s('circle', { cx: 200, cy: 130, r: 48, fill: 'none', stroke: color, 'stroke-width': 2 }),
    s('text', { x: 200, y: 150, 'text-anchor': 'middle', 'font-size': 56, fill: color, text: locked ? '?' : STAGE_GLYPH[scene?.stage] ?? '❖' }),
    s('text', { x: 200, y: 240, 'text-anchor': 'middle', 'font-size': 22, fill: '#3b2e22', class: 'ph-title', text: locked ? '아직 겪지 않은 장면' : scene?.title ?? '' }),
    s('text', { x: 200, y: 266, 'text-anchor': 'middle', 'font-size': 13, fill: '#7d6a55', text: locked ? '' : `${STAGES[scene?.stage]?.label ?? ''} · 기본 삽화` }),
  );
  return svg;
}

export function sceneFigure(content, sceneId, generated = {}, opts = {}) {
  const scene = content.scenes[sceneId];
  const src = generated[sceneId] ?? scene?.imageUrl ?? null;
  const frame = h('div', { class: `scene-frame emotion-${scene?.emotion ?? 'none'}` });
  if (src && !opts.locked) {
    const img = h('img', { src, alt: scene.title, class: 'scene-img', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(placeholderSvg(scene)));
    frame.appendChild(img);
  } else frame.appendChild(placeholderSvg(scene, opts));
  return frame;
}

// 판 시작 전 사전 생성 큐. 생성 순서: 유년 → 소년기 → 성년 → 노년.
export class Pregen {
  constructor(content, char, onUpdate) {
    this.content = content;
    this.char = char;
    this.onUpdate = onUpdate;
    this.images = {};
    this.refused = {};
    this.done = 0;
    this.total = 0;
    this.running = false;
    this.cancelled = false;
  }

  async peekAll() {
    for (const id of Object.keys(this.content.scenes)) {
      const r = await requestScene({ sceneId: id, char: this.char, peek: true });
      if (r.status === 'cached') this.images[id] = r.url;
    }
    this.onUpdate?.(this);
  }

  async run() {
    const order = ['child', 'teen', 'adult', 'elder'];
    const ids = Object.values(this.content.scenes)
      .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage))
      .map((x) => x.id);
    this.total = ids.length;
    this.done = 0;
    this.running = true;
    this.onUpdate?.(this);
    for (const id of ids) {
      if (this.cancelled) break;
      const r = await requestScene({ sceneId: id, char: this.char });
      if (r.status === 'cached' || r.status === 'generated') this.images[id] = r.url;
      else if (r.status === 'refused') this.refused[id] = r.reasons;
      else if (r.status === 'disabled') break;
      this.done++;
      this.onUpdate?.(this);
    }
    this.running = false;
    this.onUpdate?.(this);
  }
}
