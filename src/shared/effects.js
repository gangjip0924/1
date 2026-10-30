// 이벤트 효과 문법 (ADR-0002). 조건과 마찬가지로 닫힌 집합이다.
//
//   {"gold": 50}  {"goldPct": -20}         금화 증감 / 보유 금화의 비율 증감
//   {"stat":"str","add":1}                 능력치
//   {"health": -1}  {"rep": 2}             건강(0~10), 평판(-10~10)
//   {"flag":"x","set":true|숫자} {"flag":"x","add":1} {"flag":"x","clear":true}
//   {"career":"merchant"|"none"} {"rank": 1}
//   {"trait":"lucky","gain":true} {"trait":"lucky","lose":true}
//   {"scene":"s_id"}  {"achievement":"a_id"}
//   {"queue":"e_id","inYears":2}           사건 연쇄: 지정한 나이 이후 우선 발생
//   {"years": 1}                           추가로 흐르는 시간
//   {"death":"사유"}                       생의 종료

import { STAT_IDS } from './conditions.js';
import { clamp, isObj } from './util.js';

export const HEALTH_MAX = 10;
export const REP_RANGE = [-10, 10];
export const STAT_MAX = 12;
export const RANK_MAX = 5;

const SHAPES = {
  gold: { gold: 'number' },
  goldPct: { goldPct: 'number' },
  stat: { stat: 'stat', add: 'number' },
  health: { health: 'number' },
  rep: { rep: 'number' },
  flag: { flag: 'flagname', set: 'flagvalue?', add: 'number?', clear: 'true?' },
  career: { career: 'string' },
  rank: { rank: 'number' },
  trait: { trait: 'string', gain: 'true?', lose: 'true?' },
  scene: { scene: 'string' },
  achievement: { achievement: 'string' },
  queue: { queue: 'string', inYears: 'number?' },
  years: { years: 'number' },
  death: { death: 'string' },
};

export function effectKind(e) {
  if (!isObj(e)) return undefined;
  const heads = Object.keys(e).filter((k) => k in SHAPES);
  return heads.length === 1 ? heads[0] : undefined;
}

export function validateEffect(e, path, errors, refs) {
  const err = (m) => errors.push(`${path}: ${m}`);
  if (!isObj(e)) return err('효과는 객체여야 합니다');
  const kind = effectKind(e);
  if (!kind) return err(`알 수 없는 효과 "${Object.keys(e)[0]}" (닫힌 문법 밖)`);
  const shape = SHAPES[kind];
  for (const k of Object.keys(e)) {
    if (!(k in shape)) err(`허용되지 않는 키 "${k}"`);
  }
  for (const [k, type] of Object.entries(shape)) {
    const optional = type.endsWith('?');
    const t = type.replace('?', '');
    const v = e[k];
    if (v === undefined) {
      if (!optional) err(`"${k}" 필요`);
      continue;
    }
    if (t === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) err(`"${k}"는 숫자`);
    if (t === 'string' && typeof v !== 'string') err(`"${k}"는 문자열`);
    if (t === 'true' && v !== true) err(`"${k}"는 true만 허용`);
    if (t === 'stat' && !STAT_IDS.includes(v)) err(`능력치 "${v}"는 ${STAT_IDS.join('/')} 중 하나`);
    if (t === 'flagname' && (typeof v !== 'string' || !/^[a-z0-9_]{1,40}$/.test(v))) err('flag 이름은 소문자/숫자/_ 40자 이내');
    if (t === 'flagvalue' && typeof v !== 'number' && typeof v !== 'boolean') err('set 값은 숫자 또는 불리언');
  }
  if (kind === 'flag') {
    const modes = ['set', 'add', 'clear'].filter((k) => e[k] !== undefined);
    if (modes.length !== 1) err('flag 효과는 set/add/clear 중 정확히 하나');
  }
  if (kind === 'trait' && Boolean(e.gain) === Boolean(e.lose)) err('trait 효과는 gain 또는 lose 중 하나');
  if (kind === 'death' && e.death.length > 80) err('사망 사유는 80자 이내');
  if (refs) {
    const chk = (set, id, label) => { if (set && !set.has(id)) err(`알 수 없는 ${label} ID "${id}"`); };
    if (kind === 'career' && e.career !== 'none') chk(refs.careers, e.career, 'career');
    if (kind === 'trait') chk(refs.traits, e.trait, 'trait');
    if (kind === 'scene') chk(refs.scenes, e.scene, 'scene');
    if (kind === 'achievement') chk(refs.achievements, e.achievement, 'achievement');
    if (kind === 'queue') chk(refs.events, e.queue, 'event');
  }
}

// 특성/종족 등 고정 수정치를 상태에 반영 (sign=+1 획득, -1 상실).
export function applyStaticModifiers(state, modifiers, sign = 1) {
  for (const m of modifiers || []) {
    if (m.type === 'stat') state.stats[m.stat] = clamp((state.stats[m.stat] ?? 0) + m.value * sign, 0, STAT_MAX);
    if (m.type === 'health') state.health = clamp(state.health + m.value * sign, 0, HEALTH_MAX);
  }
}

// 효과 목록을 적용하고, 화면에 보여 줄 변화 목록을 돌려준다.
export function applyEffects(effects, state, content, ctx = {}) {
  const changes = [];
  for (const e of effects || []) {
    const kind = effectKind(e);
    switch (kind) {
      case 'gold': {
        state.gold += e.gold;
        changes.push({ kind: 'gold', delta: e.gold });
        break;
      }
      case 'goldPct': {
        const delta = Math.round((Math.max(0, state.gold) * e.goldPct) / 100);
        state.gold += delta;
        changes.push({ kind: 'gold', delta });
        break;
      }
      case 'stat': {
        const before = state.stats[e.stat];
        state.stats[e.stat] = clamp(before + e.add, 0, STAT_MAX);
        changes.push({ kind: 'stat', stat: e.stat, delta: state.stats[e.stat] - before });
        break;
      }
      case 'health': {
        const before = state.health;
        state.health = clamp(before + e.health, 0, HEALTH_MAX);
        changes.push({ kind: 'health', delta: state.health - before });
        break;
      }
      case 'rep': {
        const before = state.rep;
        state.rep = clamp(before + e.rep, REP_RANGE[0], REP_RANGE[1]);
        changes.push({ kind: 'rep', delta: state.rep - before });
        break;
      }
      case 'flag': {
        if (e.clear) delete state.flags[e.flag];
        else if (e.add !== undefined) state.flags[e.flag] = (Number(state.flags[e.flag]) || 0) + e.add;
        else state.flags[e.flag] = e.set;
        break;
      }
      case 'career': {
        state.career = e.career === 'none' ? null : e.career;
        state.rank = 0;
        changes.push({ kind: 'career', career: state.career });
        break;
      }
      case 'rank': {
        const before = state.rank;
        state.rank = clamp(before + e.rank, 0, RANK_MAX);
        if (state.rank !== before) changes.push({ kind: 'rank', delta: state.rank - before });
        break;
      }
      case 'trait': {
        const trait = content.traits[e.trait];
        const has = state.traits.includes(e.trait);
        if (e.gain && !has) {
          state.traits.push(e.trait);
          applyStaticModifiers(state, trait.modifiers, 1);
          changes.push({ kind: 'trait', trait: e.trait, gained: true });
        } else if (e.lose && has) {
          state.traits = state.traits.filter((t) => t !== e.trait);
          applyStaticModifiers(state, trait.modifiers, -1);
          changes.push({ kind: 'trait', trait: e.trait, gained: false });
        }
        break;
      }
      case 'scene': {
        if (!state.scenes.includes(e.scene)) {
          state.scenes.push(e.scene);
          changes.push({ kind: 'scene', scene: e.scene });
        }
        break;
      }
      case 'achievement': {
        if (!state.achievements.includes(e.achievement)) {
          state.achievements.push(e.achievement);
          changes.push({ kind: 'achievement', achievement: e.achievement });
        }
        break;
      }
      case 'queue': {
        state.queue.push({ event: e.queue, atAge: state.age + (e.inYears ?? 0) });
        break;
      }
      case 'years': {
        ctx.extraYears = (ctx.extraYears ?? 0) + e.years;
        break;
      }
      case 'death': {
        ctx.death = e.death;
        break;
      }
      default:
        break;
    }
  }
  return changes;
}
