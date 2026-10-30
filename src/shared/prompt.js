// 장면 이미지 생성 프롬프트 조립 (ADR-0005).
// 스타일 락(style) + 종족 + 인생 단계 + 외형 + 장면 태그 + 등장인물 → 생성 요청.
// 20세 미만 단계에서는 자유 서술 외형(extra)을 쓰지 않고, 어휘 목록에 있는 구조화된 외형만 쓴다.

import { STAGES, MINOR_NEGATIVE, BASE_NEGATIVE, checkGenerationRequest } from './safety.js';
import { hashString } from './util.js';

export const APPEARANCE_FIELDS = ['gender', 'hair', 'eyes', 'skin'];
export const EXTRA_MAX = 200;

export function defaultAppearance(style) {
  const a = {};
  for (const f of APPEARANCE_FIELDS) a[f] = style.appearance[f][0].id;
  a.extra = '';
  return a;
}

function vocabPrompt(style, field, id) {
  const entry = style.appearance[field].find((x) => x.id === id);
  return entry ? entry.prompt : null;
}

/**
 * @param content 병합된 콘텐츠
 * @param scene 장면 정의 (또는 기준 이미지용 가상 장면)
 * @param charSpec {race, appearance:{hair,eyes,skin,extra}, seed}
 * @param opts {allowAdult, blocklist}
 */
export function buildScenePrompt(content, scene, charSpec, opts = {}) {
  const style = content.style;
  const reasons = [];
  const race = content.races[charSpec.race];
  if (!race) reasons.push(`알 수 없는 종족 "${charSpec.race}"`);
  const stage = STAGES[scene.stage];
  if (!stage) reasons.push(`알 수 없는 인생 단계 "${scene.stage}"`);
  if (reasons.length) return { ok: false, reasons };

  const parts = [style.prefix];
  parts.push(`${race.prompt}, ${stage.prompt}`);
  const app = charSpec.appearance || {};
  for (const f of APPEARANCE_FIELDS) {
    const p = vocabPrompt(style, f, app[f]);
    if (p === null) reasons.push(`외형 ${f} 값 "${app[f]}"이 어휘 목록에 없음`);
    else parts.push(p);
  }
  if (!stage.minor && app.extra) {
    if (String(app.extra).length > EXTRA_MAX) reasons.push(`추가 외형 묘사는 ${EXTRA_MAX}자 이내`);
    else parts.push(String(app.extra));
  }
  const characters = [];
  for (const cid of scene.characters || []) {
    const c = content.characters[cid];
    if (!c) {
      reasons.push(`알 수 없는 등장인물 "${cid}"`);
      continue;
    }
    characters.push({ id: c.id, age: c.age, fictional: c.fictional });
    parts.push(c.prompt);
  }
  parts.push(scene.prompt);
  const prompt = parts.filter(Boolean).join(', ');
  const negative = [BASE_NEGATIVE, style.negative, stage.minor ? MINOR_NEGATIVE : ''].filter(Boolean).join(', ');
  const rating = scene.rating || 'general';

  const check = checkGenerationRequest({
    stage: scene.stage,
    rating,
    prompt,
    characters,
    blocklist: [...(content.blocklist || []), ...(opts.blocklist || [])],
    allowAdult: Boolean(opts.allowAdult),
  });
  reasons.push(...check.reasons);
  if (reasons.length) return { ok: false, reasons };

  return {
    ok: true,
    stage: scene.stage,
    rating,
    request: {
      prompt,
      negative_prompt: negative,
      // 인물 고정: 캐릭터 시드를 모든 장면에 공유하고, 장면별로 결정적인 변주만 더한다.
      seed: ((charSpec.seed >>> 0) + (scene.seedOffset ?? sceneSeedOffset(scene.id))) >>> 0,
      width: style.width,
      height: style.height,
      steps: style.steps,
      cfg_scale: style.cfg,
      sampler_name: style.sampler,
    },
    styleVersion: style.version,
  };
}

// 기준 이미지(얼굴·체형 기준). 성인 단계로만 만든다.
export function portraitScene(content) {
  return { id: '__portrait', stage: 'adult', rating: 'general', prompt: content.style.portrait, seedOffset: 0 };
}

export function sceneSeedOffset(sceneId) {
  return hashString(sceneId) % 1000;
}
