// 한 생애의 진행 규칙: 출생 → 특성 빌드 → (이벤트 → 판정 → 효과 → 세월) 반복 → 종료.
// UI와 무관한 순수 로직이라 Node 테스트·시뮬레이터에서도 그대로 쓴다.

import { evalCondition, explainCondition, STAT_IDS } from './conditions.js';
import { applyEffects, applyStaticModifiers, HEALTH_MAX } from './effects.js';
import { roll, tierProbabilities, successChance } from './dice.js';
import { Rng, clamp, randomSeed, formatGold } from './util.js';

export const SAVE_VERSION = 1;
export const ADULT_AGE = 20;
export const STAT_LABELS = { str: '힘', dex: '재주', int: '지혜', cha: '매력', mag: '마력' };
export const APTITUDE_LABELS = ['마력 소질 없음', '마력 소질 약함', '마력 소질 보통', '마력 소질 강함'];
const APTITUDE_WEIGHTS = [3, 4, 2, 1];
const TIER_FALLBACK = {
  crit_success: ['crit_success', 'success'],
  success: ['success'],
  partial: ['partial', 'success'],
  fail: ['fail'],
  crit_fail: ['crit_fail', 'fail'],
};
export const END_REASONS = { death: '사망', time: '모래시계가 다함', age: '천수를 누림' };

// ---------- 출생과 빌드 ----------

export function rollBirth(content, rng = new Rng(randomSeed())) {
  const pick = (map) => rng.weighted(Object.values(map), (x) => x.weight ?? 1).id;
  const aptitude = rng.weighted([0, 1, 2, 3], (i) => APTITUDE_WEIGHTS[i]);
  return {
    race: pick(content.races),
    status: pick(content.statuses),
    birthplace: pick(content.birthplaces),
    aptitude,
    talent: rng.pick(STAT_IDS),
    seed: rng.int(1, 0x7fffffff),
  };
}

export function traitBudget(content, birth, bonusPoints = 0, rerolls = 0) {
  const cfg = content.config;
  return (
    cfg.baseTraitPoints +
    (content.races[birth.race]?.traitPoints ?? 0) +
    (content.statuses[birth.status]?.traitPoints ?? 0) +
    Math.min(bonusPoints, cfg.maxBonusPoints) -
    rerolls * cfg.rerollCost
  );
}

export function availableTraits(content, birth) {
  return Object.values(content.traits).filter((t) => !t.race || t.race === birth.race);
}

export function validateBuild(content, birth, traitIds, budget) {
  const errors = [];
  const set = new Set(traitIds);
  if (set.size !== traitIds.length) errors.push('같은 특성을 두 번 고를 수 없습니다');
  let spent = 0;
  for (const id of traitIds) {
    const t = content.traits[id];
    if (!t) {
      errors.push(`알 수 없는 특성 ${id}`);
      continue;
    }
    if (t.race && t.race !== birth.race) errors.push(`${t.name}: ${content.races[t.race].name} 전용 특성`);
    for (const ex of t.exclusive || []) {
      if (set.has(ex)) errors.push(`${t.name}과(와) ${content.traits[ex]?.name ?? ex}은(는) 함께 고를 수 없습니다`);
    }
    spent += t.cost;
  }
  if (spent > budget) errors.push(`특성 포인트 초과 (${spent}/${budget})`);
  return { ok: errors.length === 0, spent, errors };
}

function sourcesOf(content, state) {
  return [
    content.races[state.race],
    content.statuses[state.status],
    content.birthplaces[state.birthplace],
    ...state.traits.map((t) => content.traits[t]),
  ].filter(Boolean);
}

export function allModifiers(content, state, type) {
  return sourcesOf(content, state).flatMap((s) => (s.modifiers || []).filter((m) => m.type === type));
}

export function createLife(content, { birth, traits, name, appearance, options = {}, timeLimitMin = 180 }) {
  const cfg = content.config;
  const state = {
    saveVersion: SAVE_VERSION,
    name: name || '이름 없는 자',
    race: birth.race,
    status: birth.status,
    birthplace: birth.birthplace,
    aptitude: birth.aptitude,
    talent: birth.talent,
    charSeed: birth.seed,
    appearance,
    traits: [],
    stats: Object.fromEntries(STAT_IDS.map((s) => [s, cfg.startStat])),
    gold: 0,
    health: cfg.startHealth,
    rep: 0,
    career: null,
    rank: 0,
    age: 1,
    flags: {},
    seen: {},
    queue: [],
    scenes: [],
    achievements: [],
    critFails: 0,
    critSuccesses: 0,
    log: [],
    current: null,
    rngState: (birth.seed ^ 0x5bd1e995) >>> 0,
    clock: { elapsedMin: 0, limitMin: timeLimitMin },
    options: { compressChildhood: Boolean(options.compressChildhood) },
    ended: null,
  };
  state.stats[birth.talent] += 2;
  state.stats.mag += birth.aptitude;
  for (const src of [content.races[birth.race], content.statuses[birth.status], content.birthplaces[birth.birthplace]]) {
    applyStaticModifiers(state, src.modifiers, 1);
  }
  for (const id of traits) {
    state.traits.push(id);
    applyStaticModifiers(state, content.traits[id].modifiers, 1);
  }
  state.gold = content.statuses[birth.status].startGold + allModifiers(content, state, 'gold').reduce((s, m) => s + m.value, 0);
  state.health = clamp(state.health, 1, HEALTH_MAX);
  return state;
}

// ---------- 경제 ----------

export function annualIncome(content, state) {
  if (state.age < ADULT_AGE) return 0;
  const career = state.career ? content.careers[state.career] : null;
  let base = career
    ? career.baseIncome * (1 + state.rank * career.rankMult) + state.stats[career.stat] * career.statIncome
    : content.config.oddJobIncome;
  const pct = allModifiers(content, state, 'income')
    .filter((m) => !m.career || m.career === state.career)
    .reduce((s, m) => s + m.value, 0);
  base *= 1 + pct / 100;
  return Math.round(base);
}

export function annualLivingCost(content, state) {
  if (state.age < ADULT_AGE) return 0;
  const pct = allModifiers(content, state, 'livingCost').reduce((s, m) => s + m.value, 0);
  return Math.round(content.statuses[state.status].livingCost * (1 + pct / 100));
}

// ---------- 텍스트 ----------

export function resolveText(content, state, text) {
  const raw = typeof text === 'string' ? text : text.filter((seg) => !seg.if || evalCondition(seg.if, state)).map((s) => s.text).join('');
  const vars = {
    name: state.name,
    race: content.races[state.race]?.name ?? '',
    status: content.statuses[state.status]?.name ?? '',
    birthplace: content.birthplaces[state.birthplace]?.name ?? '',
    career: state.career ? content.careers[state.career]?.name ?? '' : '무직',
    gold: formatGold(state.gold),
    age: String(state.age),
  };
  return raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ---------- 이벤트 선택 ----------

export function eventWeight(ev, state) {
  let w = ev.weight ?? 10;
  for (const m of ev.weightMods || []) {
    if (evalCondition(m.if, state)) {
      if (m.add !== undefined) w += m.add;
      if (m.mul !== undefined) w *= m.mul;
    }
  }
  return Math.max(0, w);
}

export function eligibility(ev, state) {
  const reasons = [];
  if (state.age < ev.ages[0] || state.age > ev.ages[1]) reasons.push(`나이 범위 밖 (${ev.ages[0]}~${ev.ages[1]}세, 현재 ${state.age}세)`);
  if ((ev.once ?? true) && state.seen[ev.id]) reasons.push('이미 겪은 일회성 사건');
  if (ev.conditions) {
    const why = explainCondition(ev.conditions, state);
    if (why) reasons.push(`조건 불충족: ${why}`);
  }
  const w = eventWeight(ev, state);
  if (w <= 0) reasons.push('가중치 0');
  return { ok: reasons.length === 0, reasons, weight: w };
}

// 디버그 뷰: "왜 이 이벤트가 안 떴나"
export function explainAll(content, state) {
  const queued = new Set(state.queue.map((q) => q.event));
  return Object.values(content.events).map((ev) => {
    const el = eligibility(ev, state);
    return {
      id: ev.id,
      title: ev.title,
      pack: ev.pack,
      ages: ev.ages,
      ok: el.ok,
      weight: el.weight,
      priority: ev.priority ?? 0,
      filler: Boolean(ev.filler),
      queued: queued.has(ev.id),
      seen: state.seen[ev.id] ?? 0,
      reasons: el.reasons,
    };
  });
}

export function pickNextEvent(content, state) {
  const rng = new Rng(state.rngState);
  try {
    // 1) 사건 연쇄: 때가 된 대기열 사건 (나이 범위는 무시, 조건·일회성은 지킴)
    state.queue.sort((a, b) => a.atAge - b.atAge);
    for (let i = 0; i < state.queue.length; i++) {
      const q = state.queue[i];
      if (q.atAge > state.age) break;
      const ev = content.events[q.event];
      state.queue.splice(i--, 1);
      if (!ev) continue;
      if ((ev.once ?? true) && state.seen[ev.id]) continue;
      if (ev.conditions && !evalCondition(ev.conditions, state)) continue;
      return ev;
    }
    const eligible = Object.values(content.events).filter((ev) => eligibility(ev, state).ok);
    const normal = eligible.filter((e) => !e.filler);
    const pool = normal.length ? normal : eligible;
    if (!pool.length) return null;
    const top = Math.max(...pool.map((e) => e.priority ?? 0));
    const best = pool.filter((e) => (e.priority ?? 0) === top);
    return rng.weighted(best, (e) => eventWeight(e, state)) ?? best[0];
  } finally {
    state.rngState = rng.state;
  }
}

export function checkBonus(content, state, check) {
  return allModifiers(content, state, 'check')
    .filter((m) => (!m.dice || m.dice === check.dice) && (!m.stat || m.stat === check.stat) && (!m.tag || (check.tags || []).includes(m.tag)))
    .reduce((s, m) => s + m.value, 0);
}

export function presentEvent(content, state, ev) {
  const choices = ev.choices.map((c, index) => {
    const available = !c.conditions || evalCondition(c.conditions, state);
    const view = { index, text: resolveText(content, state, c.text), hint: c.hint ?? null, available, visible: available || Boolean(c.showLocked) };
    if (c.check) {
      const die = content.dice[c.check.dice];
      const bonus = checkBonus(content, state, c.check);
      const statValue = state.stats[c.check.stat];
      const probs = tierProbabilities(die, statValue, bonus, c.check.dc);
      view.check = {
        dice: die.id,
        diceName: die.name,
        icon: die.icon ?? '🎲',
        stat: c.check.stat,
        statLabel: STAT_LABELS[c.check.stat],
        statValue,
        bonus,
        dc: c.check.dc,
        mode: die.mode,
        probs,
        chance: successChance(probs),
      };
    }
    return view;
  });
  return { id: ev.id, title: ev.title, text: resolveText(content, state, ev.text), choices: choices.filter((c) => c.visible) };
}

// ---------- 판정과 세월 ----------

export function resolveChoice(content, state, ev, choiceIndex) {
  const c = ev.choices[choiceIndex];
  if (!c) throw new Error(`선택지 ${choiceIndex} 없음`);
  if (c.conditions && !evalCondition(c.conditions, state)) throw new Error('조건을 충족하지 않는 선택지');
  const rng = new Rng(state.rngState);
  let rollResult = null;
  let outcome;
  if (c.check) {
    const die = content.dice[c.check.dice];
    rollResult = roll(die, state.stats[c.check.stat], checkBonus(content, state, c.check), c.check.dc, rng);
    const key = TIER_FALLBACK[rollResult.tier].find((k) => c.outcomes[k]);
    outcome = c.outcomes[key];
    if (rollResult.tier === 'crit_fail') state.critFails++;
    if (rollResult.tier === 'crit_success') state.critSuccesses++;
  } else {
    outcome = c.outcome;
  }
  state.rngState = rng.state;
  state.seen[ev.id] = (state.seen[ev.id] ?? 0) + 1;

  const ctx = {};
  const text = resolveText(content, state, outcome.text);
  const changes = applyEffects(outcome.effects, state, content, ctx);
  let years = (outcome.years ?? ev.years ?? 1) + (ctx.extraYears ?? 0);
  if (state.options.compressChildhood && state.age < ADULT_AGE) years *= 2;

  const entry = {
    age: state.age,
    event: ev.id,
    title: ev.title,
    choice: resolveText(content, state, c.text),
    tier: rollResult?.tier ?? null,
    text,
  };
  state.log.push(entry);
  if (state.log.length > 400) state.log.shift();

  let passage = null;
  if (ctx.death) endLife(content, state, 'death', ctx.death);
  else if (state.health <= 0) endLife(content, state, 'death', '몸이 더는 버티지 못했다');
  else passage = passYears(content, state, years);
  return { roll: rollResult, text, changes, years, passage, ended: state.ended };
}

export function passYears(content, state, years) {
  const cfg = content.config;
  const race = content.races[state.race];
  const rng = new Rng(state.rngState);
  const summary = { years: 0, income: 0, living: 0, startAge: state.age };
  try {
    for (let i = 0; i < years && !state.ended; i++) {
      state.age++;
      summary.years++;
      const inc = annualIncome(content, state);
      const cost = annualLivingCost(content, state);
      state.gold += inc - cost;
      summary.income += inc;
      summary.living += cost;
      if (state.age >= cfg.maxAge) {
        endLife(content, state, 'age', `${state.age}세, 천수를 누리고 눈을 감았다`);
        break;
      }
      if (state.age > race.frailAge) {
        const frailty = 1 + Math.max(0, 5 - state.health) * 0.25;
        const p = cfg.mortalityPerYear * (state.age - race.frailAge) * frailty;
        if (rng.next() < p) endLife(content, state, 'death', `${state.age}세, 세월을 이기지 못했다`);
      }
    }
  } finally {
    state.rngState = rng.state;
  }
  summary.net = summary.income - summary.living;
  return summary;
}

export function checkClock(content, state) {
  const c = state.clock;
  if (!state.ended && c.limitMin > 0 && c.elapsedMin >= c.limitMin) {
    endLife(content, state, 'time', `${state.age}세, 운명의 모래시계가 멈췄다`);
    return true;
  }
  return false;
}

export function endLife(content, state, reason, cause) {
  if (state.ended) return state.ended;
  state.flags[`end_${reason}`] = true;
  for (const a of Object.values(content.achievements)) {
    if (a.condition && !state.achievements.includes(a.id) && evalCondition(a.condition, state)) state.achievements.push(a.id);
  }
  state.ended = { reason, cause, age: state.age, gold: Math.round(state.gold) };
  state.current = null;
  return state.ended;
}
