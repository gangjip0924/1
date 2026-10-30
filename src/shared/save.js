// 세이브 형식과 버전 관리 (ADR-0003).
// 세이브에는 팩 ID@버전과 콘텐츠 ID만 기록한다. 모드 구성이 바뀌어도 가능한 한 이어서 하고,
// 사라진 콘텐츠는 떨궈 내며 무엇을 떨궜는지 경고로 알린다.

import { SAVE_VERSION } from './engine.js';
import { contentSignature } from './modloader.js';
import { deepClone } from './util.js';

export const META_VERSION = 1;

export function serializeSave(content, state) {
  return {
    saveVersion: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    packs: content.packs.map((p) => ({ id: p.id, version: p.version })),
    signature: contentSignature(content),
    state: deepClone(state),
  };
}

export function loadSave(content, data) {
  const warnings = [];
  if (!data || typeof data !== 'object' || !data.state) return { ok: false, errors: ['세이브 데이터가 비어 있거나 손상됨'] };
  if (data.saveVersion > SAVE_VERSION) return { ok: false, errors: [`더 새로운 버전의 세이브입니다 (v${data.saveVersion})`] };
  const s = deepClone(data.state);
  const errors = [];
  if (!content.races[s.race]) errors.push(`세이브의 종족 "${s.race}"이(가) 현재 모드 구성에 없습니다`);
  if (!content.statuses[s.status]) errors.push(`세이브의 신분 "${s.status}"이(가) 현재 모드 구성에 없습니다`);
  if (!content.birthplaces[s.birthplace]) errors.push(`세이브의 출생지 "${s.birthplace}"이(가) 현재 모드 구성에 없습니다`);
  if (errors.length) return { ok: false, errors };

  const now = new Map(content.packs.map((p) => [p.id, p.version]));
  for (const p of data.packs || []) {
    if (!now.has(p.id)) warnings.push(`세이브에 쓰인 모드팩 "${p.id}"이(가) 지금은 로드되지 않았습니다`);
    else if (now.get(p.id) !== p.version) warnings.push(`모드팩 "${p.id}" 버전이 바뀌었습니다 (${p.version} → ${now.get(p.id)})`);
  }
  const drop = (label, list, exists) => {
    const kept = list.filter(exists);
    const lost = list.filter((x) => !exists(x));
    if (lost.length) warnings.push(`사라진 ${label} 제거: ${lost.join(', ')}`);
    return kept;
  };
  s.traits = drop('특성', s.traits, (t) => content.traits[t]);
  s.scenes = drop('장면', s.scenes, (t) => content.scenes[t]);
  s.achievements = drop('업적', s.achievements, (t) => content.achievements[t]);
  const q = s.queue.filter((x) => content.events[x.event]);
  if (q.length !== s.queue.length) warnings.push('사라진 연쇄 사건을 대기열에서 제거');
  s.queue = q;
  if (s.career && !content.careers[s.career]) {
    warnings.push(`사라진 진로 "${s.career}" — 무직으로 전환`);
    s.career = null;
    s.rank = 0;
  }
  if (s.current && !content.events[s.current]) {
    warnings.push('진행 중이던 사건이 사라져 다음 사건으로 넘어갑니다');
    s.current = null;
  }
  return { ok: true, state: s, warnings };
}

export function emptyMeta() {
  return { metaVersion: META_VERSION, lives: 0, bestGold: null, achievements: {}, gallery: {}, history: [] };
}

export function normalizeMeta(m) {
  const base = emptyMeta();
  if (!m || typeof m !== 'object') return base;
  return { ...base, ...m, achievements: { ...(m.achievements || {}) }, gallery: { ...(m.gallery || {}) }, history: [...(m.history || [])] };
}

// 업적 → 다음 판 특성 포인트. 현재 로드된 콘텐츠에 있는 업적만 센다.
export function bonusPoints(content, meta) {
  const sum = Object.keys(meta.achievements).reduce((s, id) => s + (content.achievements[id]?.points ?? 0), 0);
  return Math.min(sum, content.config.maxBonusPoints);
}

// 생이 끝났을 때 영구 기록에 반영한다. images: {sceneId: url} (이번 생의 생성 이미지).
export function applyRunToMeta(content, meta, state, images = {}) {
  const before = bonusPoints(content, meta);
  const at = new Date().toISOString();
  const newAchievements = state.achievements.filter((id) => !meta.achievements[id]);
  for (const id of newAchievements) meta.achievements[id] = { at };
  const newScenes = [];
  for (const id of state.scenes) {
    const prev = meta.gallery[id];
    if (!prev) newScenes.push(id);
    meta.gallery[id] = { at: prev?.at ?? at, image: images[id] ?? prev?.image ?? null, lastRun: state.name };
  }
  meta.lives += 1;
  const gold = Math.round(state.gold);
  const official = state.clock.limitMin > 0;
  const isBest = official && (meta.bestGold === null || gold > meta.bestGold);
  if (isBest) meta.bestGold = gold;
  meta.history.unshift({
    at,
    name: state.name,
    race: state.race,
    status: state.status,
    career: state.career,
    age: state.age,
    gold,
    reason: state.ended?.reason,
    official,
  });
  meta.history = meta.history.slice(0, 30);
  return { newAchievements, newScenes, pointsGained: bonusPoints(content, meta) - before, isBest };
}
