// 모드팩 검증 (ADR-0001, ADR-0002). 모드팩은 데이터(JSON)·이미지·생성 프롬프트만 담는다.
// 검증을 통과하지 못한 팩은 통째로 로드하지 않는다.

import { validateCondition, STAT_IDS } from './conditions.js';
import { validateEffect } from './effects.js';
import { validateDice, TIERS } from './dice.js';
import { isForbiddenTag, findTerms, FORBIDDEN_TAGS, STAGES, ADULT_AGE, SEXUAL_TERMS } from './safety.js';
import { APPEARANCE_FIELDS } from './prompt.js';
import { isObj } from './util.js';

export const GAME_DATA_VERSION = 1;
export const DATA_TYPES = [
  'config', 'style', 'blocklist', 'dice', 'races', 'statuses', 'birthplaces', 'traits',
  'careers', 'scenes', 'characters', 'achievements', 'events',
];
export const ALLOWED_FILE_EXT = ['json', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md'];
export const IMAGE_PATH_RE = /^images\/[A-Za-z0-9_\-/]{1,120}\.(png|jpg|jpeg|webp)$/;
export const DATA_PATH_RE = /^data\/[A-Za-z0-9_\-/]{1,120}\.json$/;
export const ID_RE = /^[a-z][a-z0-9_]{0,47}$/;
export const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const PLACEHOLDERS = ['name', 'race', 'status', 'birthplace', 'career', 'gold', 'age'];
const MAX_STRING = 2000;
const EMOTIONS = ['passion', 'calm', 'gold'];
const RATINGS = ['general', 'adult'];
const MODIFIER_TYPES = ['stat', 'health', 'check', 'livingCost', 'income', 'gold'];
// 본문 텍스트 검사용: 짧은 한글 부분 문자열("미시", "네토")은 일반 단어와 겹치므로 제외한다.
const TEXT_FORBIDDEN = FORBIDDEN_TAGS.filter((t) => !['미시', '네토', 'cuck', 'misi'].includes(t));

// ---- 작은 스키마 도우미 ----
function checkFields(obj, schema, path, errors) {
  if (!isObj(obj)) {
    errors.push(`${path}: 객체여야 합니다`);
    return false;
  }
  for (const k of Object.keys(obj)) {
    if (!(k in schema)) errors.push(`${path}: 알 수 없는 필드 "${k}"`);
  }
  for (const [k, spec] of Object.entries(schema)) {
    const optional = spec.endsWith('?');
    const type = spec.replace('?', '');
    const v = obj[k];
    if (v === undefined) {
      if (!optional) errors.push(`${path}: 필수 필드 "${k}" 없음`);
      continue;
    }
    const bad = (m) => errors.push(`${path}.${k}: ${m}`);
    switch (type) {
      case 'id': if (typeof v !== 'string' || !ID_RE.test(v)) bad('ID는 소문자로 시작하는 a-z0-9_ 48자 이내'); break;
      case 'string': if (typeof v !== 'string') bad('문자열'); else if (v.length > MAX_STRING) bad(`${MAX_STRING}자 이내`); break;
      case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) bad('숫자'); break;
      case 'int': if (!Number.isInteger(v)) bad('정수'); break;
      case 'bool': if (typeof v !== 'boolean') bad('true/false'); break;
      case 'array': if (!Array.isArray(v)) bad('배열'); break;
      case 'object': if (!isObj(v)) bad('객체'); break;
      case 'text': if (typeof v !== 'string' && !Array.isArray(v)) bad('문장 또는 [{text, if?}] 배열'); break;
      case 'any': break;
      default: bad(`스키마 오류 ${type}`);
    }
  }
  return true;
}

function validateText(v, path, errors, refs) {
  if (typeof v === 'string') return checkString(v, path, errors);
  if (!Array.isArray(v) || v.length === 0) return errors.push(`${path}: 문장 또는 [{text, if?}] 배열`);
  v.forEach((seg, i) => {
    if (!isObj(seg) || typeof seg.text !== 'string') return errors.push(`${path}[${i}]: {text, if?} 형식`);
    const bad = Object.keys(seg).filter((k) => k !== 'text' && k !== 'if');
    if (bad.length) errors.push(`${path}[${i}]: 알 수 없는 필드 ${bad.join(', ')}`);
    checkString(seg.text, `${path}[${i}].text`, errors);
    if (seg.if !== undefined) validateCondition(seg.if, `${path}[${i}].if`, errors, refs);
  });
}

function checkString(s, path, errors) {
  if (s.length > MAX_STRING) errors.push(`${path}: ${MAX_STRING}자 이내`);
  const hits = findTerms(s, TEXT_FORBIDDEN);
  if (hits.length) errors.push(`${path}: 금지 표현 포함 (${hits.join(', ')})`);
  for (const m of s.matchAll(/\{([^}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(m[1])) errors.push(`${path}: 알 수 없는 치환자 {${m[1]}} (허용: ${PLACEHOLDERS.join(', ')})`);
  }
}

function checkTags(tags, path, errors) {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) return errors.push(`${path}: tags는 배열`);
  tags.forEach((t, i) => {
    if (typeof t !== 'string') return errors.push(`${path}[${i}]: 태그는 문자열`);
    if (isForbiddenTag(t)) errors.push(`${path}[${i}]: 금지 태그 "${t}"`);
  });
}

function checkPrompt(p, path, errors) {
  if (typeof p !== 'string') return;
  const hits = findTerms(p, FORBIDDEN_TAGS);
  if (hits.length) errors.push(`${path}: 프롬프트에 금지 태그 (${hits.join(', ')})`);
}

function checkModifiers(mods, path, errors, refs) {
  if (mods === undefined) return;
  if (!Array.isArray(mods)) return errors.push(`${path}: modifiers는 배열`);
  mods.forEach((m, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(m) || !MODIFIER_TYPES.includes(m.type)) return errors.push(`${p}: type은 ${MODIFIER_TYPES.join('/')} 중 하나`);
    if (typeof m.value !== 'number') errors.push(`${p}: value는 숫자`);
    const allowed = { stat: ['stat'], health: [], check: ['dice', 'stat', 'tag'], livingCost: [], income: ['career'], gold: [] }[m.type];
    const bad = Object.keys(m).filter((k) => k !== 'type' && k !== 'value' && !allowed.includes(k));
    if (bad.length) errors.push(`${p}: 허용되지 않는 키 ${bad.join(', ')}`);
    if (m.stat !== undefined && !STAT_IDS.includes(m.stat)) errors.push(`${p}: 알 수 없는 능력치 ${m.stat}`);
    if (m.type === 'stat' && m.stat === undefined) errors.push(`${p}: stat 필요`);
    if (refs && m.dice !== undefined && !refs.dice.has(m.dice)) errors.push(`${p}: 알 수 없는 주사위 ${m.dice}`);
    if (refs && m.career !== undefined && !refs.careers.has(m.career)) errors.push(`${p}: 알 수 없는 진로 ${m.career}`);
  });
}

// ---- 타입별 스키마 ----
const SCHEMAS = {
  config: { id: 'id', baseTraitPoints: 'int', maxBonusPoints: 'int', maxRerolls: 'int', rerollCost: 'int', oddJobIncome: 'number', maxAge: 'int', startHealth: 'int', startStat: 'int', mortalityPerYear: 'number' },
  style: { id: 'id', version: 'string', prefix: 'string', negative: 'string', portrait: 'string', width: 'int', height: 'int', steps: 'int', cfg: 'number', sampler: 'string', appearance: 'object' },
  blocklist: { id: 'id', names: 'array' },
  dice: { id: 'id', name: 'string', desc: 'string?', icon: 'string?', count: 'int', sides: 'int', mode: 'string', statMultiplier: 'number?', tiers: 'array' },
  races: { id: 'id', name: 'string', desc: 'string', weight: 'number?', prompt: 'string', modifiers: 'array?', traitPoints: 'int?', frailAge: 'int', tags: 'array?' },
  statuses: { id: 'id', name: 'string', desc: 'string', weight: 'number?', startGold: 'number', livingCost: 'number', modifiers: 'array?', traitPoints: 'int?', tags: 'array?' },
  birthplaces: { id: 'id', name: 'string', desc: 'string', weight: 'number?', modifiers: 'array?', tags: 'array?' },
  traits: { id: 'id', name: 'string', desc: 'string', cost: 'int', race: 'string?', modifiers: 'array?', exclusive: 'array?', tags: 'array?' },
  careers: { id: 'id', name: 'string', desc: 'string', baseIncome: 'number', rankMult: 'number', stat: 'string', statIncome: 'number', rankTitles: 'array', tags: 'array?' },
  scenes: { id: 'id', title: 'string', caption: 'string', stage: 'string', emotion: 'string', failure: 'bool?', rating: 'string?', image: 'string?', prompt: 'string', characters: 'array?', tags: 'array?' },
  characters: { id: 'id', name: 'string', age: 'int', fictional: 'bool', prompt: 'string', tags: 'array?' },
  achievements: { id: 'id', name: 'string', desc: 'string', points: 'int', condition: 'object?', hidden: 'bool?' },
  events: { id: 'id', title: 'string', ages: 'array', weight: 'number?', priority: 'int?', once: 'bool?', filler: 'bool?', conditions: 'object?', weightMods: 'array?', years: 'int?', text: 'text', choices: 'array', tags: 'array?' },
};
const CHOICE_SCHEMA = { text: 'string', hint: 'string?', conditions: 'object?', showLocked: 'bool?', check: 'object?', outcome: 'object?', outcomes: 'object?' };
const CHECK_SCHEMA = { dice: 'string', stat: 'string', dc: 'number', tags: 'array?' };
const OUTCOME_SCHEMA = { text: 'text', effects: 'array?', years: 'int?' };

function validateOutcome(o, path, errors, refs) {
  if (!checkFields(o, OUTCOME_SCHEMA, path, errors)) return;
  validateText(o.text, `${path}.text`, errors, refs);
  (o.effects || []).forEach((e, i) => validateEffect(e, `${path}.effects[${i}]`, errors, refs));
  if (o.years !== undefined && (o.years < 0 || o.years > 10)) errors.push(`${path}.years: 0~10`);
}

function validateEvent(ev, path, errors, refs, dice) {
  if (!Array.isArray(ev.ages) || ev.ages.length !== 2 || !ev.ages.every(Number.isInteger) || ev.ages[0] > ev.ages[1]) {
    errors.push(`${path}.ages: [최소나이, 최대나이] 정수 쌍`);
  }
  if (ev.conditions) validateCondition(ev.conditions, `${path}.conditions`, errors, refs);
  validateText(ev.text, `${path}.text`, errors, refs);
  if (ev.years !== undefined && (ev.years < 0 || ev.years > 10)) errors.push(`${path}.years: 0~10`);
  (ev.weightMods || []).forEach((w, i) => {
    const p = `${path}.weightMods[${i}]`;
    if (!checkFields(w, { if: 'object', add: 'number?', mul: 'number?' }, p, errors)) return;
    validateCondition(w.if, `${p}.if`, errors, refs);
    if (w.add === undefined && w.mul === undefined) errors.push(`${p}: add 또는 mul 필요`);
  });
  if (ev.choices.length < 1 || ev.choices.length > 6) errors.push(`${path}.choices: 1~6개`);
  ev.choices.forEach((c, i) => {
    const p = `${path}.choices[${i}]`;
    if (!checkFields(c, CHOICE_SCHEMA, p, errors)) return;
    checkString(c.text, `${p}.text`, errors);
    if (c.conditions) validateCondition(c.conditions, `${p}.conditions`, errors, refs);
    if (c.check) {
      if (checkFields(c.check, CHECK_SCHEMA, `${p}.check`, errors)) {
        if (!dice.has(c.check.dice)) errors.push(`${p}.check.dice: 알 수 없는 주사위 "${c.check.dice}"`);
        if (!STAT_IDS.includes(c.check.stat)) errors.push(`${p}.check.stat: ${STAT_IDS.join('/')} 중 하나`);
        checkTags(c.check.tags, `${p}.check.tags`, errors);
      }
      if (!isObj(c.outcomes)) errors.push(`${p}: 판정이 있으면 outcomes 필요`);
      else {
        for (const [tier, o] of Object.entries(c.outcomes)) {
          if (!TIERS.includes(tier)) errors.push(`${p}.outcomes: 알 수 없는 등급 "${tier}"`);
          else validateOutcome(o, `${p}.outcomes.${tier}`, errors, refs);
        }
        if (!c.outcomes.success) errors.push(`${p}.outcomes: success 필요`);
        if (!c.outcomes.fail) errors.push(`${p}.outcomes: fail 필요`);
      }
      if (c.outcome) errors.push(`${p}: 판정이 있으면 outcome 대신 outcomes를 씁니다`);
    } else {
      if (!c.outcome) errors.push(`${p}: 판정이 없으면 outcome 필요`);
      else validateOutcome(c.outcome, `${p}.outcome`, errors, refs);
      if (c.outcomes) errors.push(`${p}: 판정이 없으면 outcomes를 쓸 수 없습니다`);
    }
  });
}

function validateStyle(s, path, errors) {
  checkPrompt(s.prefix, `${path}.prefix`, errors);
  checkPrompt(s.portrait, `${path}.portrait`, errors);
  if (s.width % 64 !== 0 || s.height % 64 !== 0) errors.push(`${path}: width/height는 64의 배수`);
  for (const f of APPEARANCE_FIELDS) {
    const list = s.appearance?.[f];
    if (!Array.isArray(list) || !list.length) {
      errors.push(`${path}.appearance.${f}: [{id,label,prompt}] 배열 필요`);
      continue;
    }
    list.forEach((x, i) => {
      if (!checkFields(x, { id: 'id', label: 'string', prompt: 'string' }, `${path}.appearance.${f}[${i}]`, errors)) return;
      checkPrompt(x.prompt, `${path}.appearance.${f}[${i}].prompt`, errors);
      const sexual = findTerms(x.prompt, SEXUAL_TERMS);
      if (sexual.length) errors.push(`${path}.appearance.${f}[${i}]: 외형 어휘에 금지된 표현 (${sexual.join(', ')})`);
    });
  }
}

export function validateManifest(m, folderId) {
  const errors = [];
  checkFields(m, { id: 'string', name: 'string', version: 'string', author: 'string?', description: 'string?', gameVersion: 'int', data: 'array' }, 'manifest', errors);
  if (typeof m?.id === 'string') {
    if (!PACK_ID_RE.test(m.id)) errors.push('manifest.id: 소문자/숫자/_/- 32자 이내');
    if (folderId && m.id !== folderId) errors.push(`manifest.id "${m.id}"가 폴더 이름 "${folderId}"와 다름`);
  }
  if (m?.gameVersion !== undefined && m.gameVersion !== GAME_DATA_VERSION) errors.push(`manifest.gameVersion은 ${GAME_DATA_VERSION}이어야 합니다`);
  (Array.isArray(m?.data) ? m.data : []).forEach((p, i) => {
    if (typeof p !== 'string' || !DATA_PATH_RE.test(p) || p.includes('..')) errors.push(`manifest.data[${i}]: data/ 아래 .json 상대 경로만 허용`);
  });
  return errors;
}

// 팩 폴더의 파일 목록 검사 (실행 코드 금지). 서버에서만 목록을 얻을 수 있다.
export function validateFileList(files) {
  const errors = [];
  for (const f of files) {
    const ext = f.includes('.') ? f.split('.').pop().toLowerCase() : '';
    if (!ALLOWED_FILE_EXT.includes(ext)) errors.push(`허용되지 않는 파일 "${f}" (허용 확장자: ${ALLOWED_FILE_EXT.join(', ')}) — 모드팩에는 실행 코드를 넣을 수 없습니다`);
  }
  return errors;
}

/**
 * 팩 하나를 검증한다.
 * @param pack {id, files: [{path, json}]}
 * @param base 이미 로드된 콘텐츠 레지스트리 (참조 해석·중복 검사용)
 * @returns {errors, warnings, items: {type: [item]}}
 */
export function validatePack(pack, base) {
  const errors = [];
  const warnings = [];
  const items = Object.fromEntries(DATA_TYPES.map((t) => [t, []]));

  for (const f of pack.files) {
    const j = f.json;
    if (!isObj(j) || !DATA_TYPES.includes(j.type) || !Array.isArray(j.items)) {
      errors.push(`${f.path}: {"type": (${DATA_TYPES.join('|')}), "items": [...]} 형식이어야 합니다`);
      continue;
    }
    const extra = Object.keys(j).filter((k) => k !== 'type' && k !== 'items' && k !== 'comment');
    if (extra.length) errors.push(`${f.path}: 알 수 없는 최상위 필드 ${extra.join(', ')}`);
    j.items.forEach((it, i) => {
      const p = `${f.path}#${it?.id ?? i}`;
      if (checkFields(it, SCHEMAS[j.type], p, errors)) items[j.type].push({ item: it, path: p });
    });
  }

  // 참조 집합 = 기존 레지스트리 + 이 팩
  const refs = {};
  const idsOf = (type, regKey) => new Set([...Object.keys(base[regKey] || {}), ...items[type].map((x) => x.item.id)]);
  refs.traits = idsOf('traits', 'traits');
  refs.races = idsOf('races', 'races');
  refs.statuses = idsOf('statuses', 'statuses');
  refs.birthplaces = idsOf('birthplaces', 'birthplaces');
  refs.careers = idsOf('careers', 'careers');
  refs.events = idsOf('events', 'events');
  refs.scenes = idsOf('scenes', 'scenes');
  refs.achievements = idsOf('achievements', 'achievements');
  refs.characters = idsOf('characters', 'characters');
  refs.dice = idsOf('dice', 'dice');

  // 중복 ID (팩 내부 + 기존 팩). 다수 팩 충돌 해결은 MVP 범위 밖이므로 오류로 처리한다.
  for (const type of DATA_TYPES) {
    const seen = new Set();
    const regKey = type;
    for (const { item, path } of items[type]) {
      if (seen.has(item.id)) errors.push(`${path}: 팩 안에서 ID 중복`);
      seen.add(item.id);
      if (base[regKey] && Object.prototype.hasOwnProperty.call(base[regKey], item.id)) {
        errors.push(`${path}: 이미 다른 팩이 쓰는 ID (팩 간 덮어쓰기는 아직 지원하지 않음)`);
      }
    }
  }
  if (items.style.length + (base.style ? 1 : 0) > 1) errors.push('style(스타일 락)은 전체에서 하나만 정의할 수 있습니다');
  if (items.config.length + (base.config ? 1 : 0) > 1) errors.push('config는 전체에서 하나만 정의할 수 있습니다');

  for (const { item, path } of items.style) validateStyle(item, path, errors);
  for (const { item, path } of items.blocklist) {
    if (!item.names.every((n) => typeof n === 'string')) errors.push(`${path}.names: 문자열 배열`);
  }
  for (const { item, path } of items.dice) validateDice(item, path, errors);
  for (const type of ['races', 'statuses', 'birthplaces', 'traits']) {
    for (const { item, path } of items[type]) {
      checkModifiers(item.modifiers, `${path}.modifiers`, errors, refs);
      checkTags(item.tags, `${path}.tags`, errors);
      checkString(item.desc, `${path}.desc`, errors);
    }
  }
  for (const { item, path } of items.races) checkPrompt(item.prompt, `${path}.prompt`, errors);
  for (const { item, path } of items.traits) {
    if (item.race !== undefined && !refs.races.has(item.race)) errors.push(`${path}.race: 알 수 없는 종족 "${item.race}"`);
    (item.exclusive || []).forEach((t) => { if (!refs.traits.has(t)) errors.push(`${path}.exclusive: 알 수 없는 특성 "${t}"`); });
  }
  for (const { item, path } of items.careers) {
    if (!STAT_IDS.includes(item.stat)) errors.push(`${path}.stat: ${STAT_IDS.join('/')} 중 하나`);
    if (item.rankTitles.length !== 6) errors.push(`${path}.rankTitles: 0~5 등급 칭호 6개`);
    checkTags(item.tags, `${path}.tags`, errors);
  }
  for (const { item, path } of items.characters) {
    if (item.fictional !== true) errors.push(`${path}.fictional: 가상 인물만 허용 (true 필요)`);
    if (item.age < ADULT_AGE) errors.push(`${path}.age: 생성 대상 등장인물은 ${ADULT_AGE}세 이상만 허용`);
    checkPrompt(item.prompt, `${path}.prompt`, errors);
    checkTags(item.tags, `${path}.tags`, errors);
  }
  for (const { item, path } of items.scenes) {
    if (!STAGES[item.stage]) errors.push(`${path}.stage: ${Object.keys(STAGES).join('/')} 중 하나`);
    if (!EMOTIONS.includes(item.emotion)) errors.push(`${path}.emotion: ${EMOTIONS.join('/')} 중 하나`);
    if (item.rating !== undefined && !RATINGS.includes(item.rating)) errors.push(`${path}.rating: ${RATINGS.join('/')} 중 하나`);
    if (item.rating === 'adult' && STAGES[item.stage]?.minor) errors.push(`${path}: 20세 미만 단계 장면은 성인 등급일 수 없습니다`);
    if (item.image !== undefined && (!IMAGE_PATH_RE.test(item.image) || item.image.includes('..'))) errors.push(`${path}.image: images/ 아래 png/jpg/webp 상대 경로만 허용`);
    checkPrompt(item.prompt, `${path}.prompt`, errors);
    checkTags(item.tags, `${path}.tags`, errors);
    if (STAGES[item.stage]?.minor) {
      const sexual = findTerms(item.prompt, SEXUAL_TERMS);
      if (sexual.length) errors.push(`${path}.prompt: 20세 미만 단계에 금지된 표현 (${sexual.join(', ')})`);
    }
    (item.characters || []).forEach((c) => { if (!refs.characters.has(c)) errors.push(`${path}.characters: 알 수 없는 등장인물 "${c}"`); });
    checkString(item.caption, `${path}.caption`, errors);
  }
  for (const { item, path } of items.achievements) {
    if (item.points < 0 || item.points > 3) errors.push(`${path}.points: 0~3`);
    if (item.condition) validateCondition(item.condition, `${path}.condition`, errors, refs);
  }
  for (const { item, path } of items.events) {
    validateEvent(item, path, errors, refs, refs.dice);
    checkTags(item.tags, `${path}.tags`, errors);
  }

  // 경고: 해금 경로가 없는 장면
  const unlockable = new Set();
  const scan = (effects) => (effects || []).forEach((e) => { if (e.scene) unlockable.add(e.scene); });
  for (const { item } of items.events) {
    for (const c of item.choices || []) {
      scan(c.outcome?.effects);
      Object.values(c.outcomes || {}).forEach((o) => scan(o?.effects));
    }
  }
  for (const { item, path } of items.scenes) {
    if (!unlockable.has(item.id)) warnings.push(`${path}: 이 팩의 어떤 이벤트도 이 장면을 해금하지 않습니다`);
  }

  return { errors, warnings, items };
}
