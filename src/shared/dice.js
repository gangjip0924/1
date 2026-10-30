// 상황별 주사위 판정. 주사위 종류와 등급 규칙은 모드팩 데이터(dice)로 정의된다.
//
// 데이터 예:
// { "id":"d20", "name":"운명의 이십면체", "count":1, "sides":20, "mode":"over", "statMultiplier":1,
//   "tiers":[ {"tier":"crit_success","natural":"max"}, {"tier":"crit_fail","natural":"min"},
//             {"tier":"success","marginGte":0}, {"tier":"fail"} ] }
//
// mode "over"  : 합계 = 눈 + 능력치×배수 + 보너스, 차이 = 합계 − 난이도
// mode "under" : 목표 = 난이도 + 능력치×배수 + 보너스, 차이 = 목표 − 눈 (낮게 굴릴수록 좋음)
// 등급 규칙은 위에서부터 첫 번째로 모든 조건이 맞는 것이 선택된다. 마지막 규칙은 조건이 없어야 한다.

import { isObj } from './util.js';

export const TIERS = ['crit_success', 'success', 'partial', 'fail', 'crit_fail'];
export const TIER_LABELS = {
  crit_success: '대성공',
  success: '성공',
  partial: '부분 성공',
  fail: '실패',
  crit_fail: '대실패',
};
export const TIER_ICONS = {
  crit_success: '★',
  success: '◆',
  partial: '◐',
  fail: '✕',
  crit_fail: '☠',
};
const ALLOWED_SIDES = [4, 6, 8, 10, 12, 20, 100];
const RULE_KEYS = ['tier', 'natural', 'marginGte', 'rollLte', 'rollGte'];

export function checkParams(dieDef, statValue, bonus, dc) {
  const mult = dieDef.statMultiplier ?? 1;
  const mod = statValue * mult + bonus;
  return { mod, dc };
}

function tierFor(dieDef, faces, mod, dc) {
  const raw = faces.reduce((a, b) => a + b, 0);
  const total = dieDef.mode === 'under' ? raw : raw + mod;
  const margin = dieDef.mode === 'under' ? dc + mod - raw : total - dc;
  const allMax = faces.every((f) => f === dieDef.sides);
  const allMin = faces.every((f) => f === 1);
  for (const rule of dieDef.tiers) {
    if (rule.natural === 'max' && !allMax) continue;
    if (rule.natural === 'min' && !allMin) continue;
    if (rule.marginGte !== undefined && margin < rule.marginGte) continue;
    if (rule.rollLte !== undefined && raw > rule.rollLte) continue;
    if (rule.rollGte !== undefined && raw < rule.rollGte) continue;
    return { tier: rule.tier, raw, total, margin };
  }
  return { tier: 'fail', raw, total, margin };
}

export function roll(dieDef, statValue, bonus, dc, rng) {
  const { mod } = checkParams(dieDef, statValue, bonus, dc);
  const faces = [];
  for (let i = 0; i < dieDef.count; i++) faces.push(rng.int(1, dieDef.sides));
  const res = tierFor(dieDef, faces, mod, dc);
  const target = dieDef.mode === 'under' ? dc + mod : dc;
  return { dice: dieDef.id, faces, mod, dc, target, ...res };
}

// 모든 눈의 조합을 열거해 등급별 확률을 정확히 계산한다 (선택지에 성공 확률 표시용).
export function tierProbabilities(dieDef, statValue, bonus, dc) {
  const { mod } = checkParams(dieDef, statValue, bonus, dc);
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const faces = new Array(dieDef.count).fill(1);
  let total = 0;
  for (;;) {
    counts[tierFor(dieDef, faces, mod, dc).tier]++;
    total++;
    let i = 0;
    while (i < faces.length && faces[i] === dieDef.sides) faces[i++] = 1;
    if (i === faces.length) break;
    faces[i]++;
  }
  for (const t of TIERS) counts[t] /= total;
  return counts;
}

export function successChance(probs) {
  return probs.crit_success + probs.success + probs.partial;
}

export function validateDice(def, path, errors) {
  const err = (m) => errors.push(`${path}: ${m}`);
  if (!Number.isInteger(def.count) || def.count < 1 || def.count > 3) err('count는 1~3 정수');
  if (!ALLOWED_SIDES.includes(def.sides)) err(`sides는 ${ALLOWED_SIDES.join('/')} 중 하나`);
  if (def.count > 1 && def.sides > 20) err('주사위 2개 이상이면 sides는 20 이하');
  if (!['over', 'under'].includes(def.mode)) err('mode는 over 또는 under');
  if (def.statMultiplier !== undefined && typeof def.statMultiplier !== 'number') err('statMultiplier는 숫자');
  if (!Array.isArray(def.tiers) || def.tiers.length < 2) return err('tiers는 2개 이상의 규칙 배열');
  def.tiers.forEach((r, i) => {
    if (!isObj(r)) return err(`tiers[${i}] 객체가 아님`);
    const bad = Object.keys(r).filter((k) => !RULE_KEYS.includes(k));
    if (bad.length) err(`tiers[${i}] 허용되지 않는 키: ${bad.join(', ')}`);
    if (!TIERS.includes(r.tier)) err(`tiers[${i}].tier "${r.tier}"는 ${TIERS.join('/')} 중 하나`);
    if (r.natural !== undefined && !['max', 'min'].includes(r.natural)) err(`tiers[${i}].natural은 max/min`);
    for (const k of ['marginGte', 'rollLte', 'rollGte']) {
      if (r[k] !== undefined && typeof r[k] !== 'number') err(`tiers[${i}].${k}는 숫자`);
    }
  });
  const last = def.tiers[def.tiers.length - 1];
  if (last && Object.keys(last).length !== 1) err('마지막 등급 규칙은 조건 없는 기본값이어야 합니다');
}
