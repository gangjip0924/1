import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './helpers.js';
import { evalCondition, validateCondition } from '../src/shared/conditions.js';
import { applyEffects, validateEffect } from '../src/shared/effects.js';
import { tierProbabilities, roll } from '../src/shared/dice.js';
import * as E from '../src/shared/engine.js';
import { serializeSave, loadSave, emptyMeta, applyRunToMeta, bonusPoints } from '../src/shared/save.js';
import { defaultAppearance } from '../src/shared/prompt.js';
import { Rng } from '../src/shared/util.js';

const { content } = await loadCore();

function freshLife(overrides = {}) {
  const birth = { race: 'human', status: 'commoner', birthplace: 'port', aptitude: 1, talent: 'cha', seed: 42, ...overrides.birth };
  return E.createLife(content, { birth, traits: overrides.traits ?? [], name: '테스트', appearance: defaultAppearance(content.style), timeLimitMin: 180 });
}

test('core 콘텐츠가 MVP 범위를 채운다', () => {
  const normal = Object.values(content.events).filter((e) => !e.filler);
  assert.equal(Object.keys(content.races).length, 3);
  assert.equal(Object.keys(content.statuses).length, 2);
  assert.equal(Object.keys(content.birthplaces).length, 3);
  assert.equal(Object.keys(content.traits).length, 12);
  assert.ok(Object.values(content.traits).some((t) => t.race), '종족 전용 특성 포함');
  assert.equal(Object.keys(content.careers).length, 3);
  assert.equal(Object.keys(content.dice).length, 3);
  assert.equal(normal.length, 60);
  assert.equal(Object.keys(content.scenes).length, 20);
});

test('조건 문법: 비교·특성·일치·플래그·and/or/not', () => {
  const st = freshLife({ traits: ['lucky'] });
  st.flags.rival = true;
  st.flags.debt = 2;
  assert.ok(evalCondition({ all: [{ trait: 'lucky' }, { race: ['human', 'elf'] }, { flag: 'rival' }] }, st));
  assert.ok(evalCondition({ any: [{ status: 'noble' }, { flag: 'debt', op: '>=', value: 2 }] }, st));
  assert.ok(evalCondition({ not: { career: 'merchant' } }, st));
  assert.ok(evalCondition({ career: 'none' }, st));
  assert.ok(evalCondition({ cmp: ['cha', '>=', 4] }, st));
  assert.equal(evalCondition({ cmp: ['gold', '>', 999999] }, st), false);
});

test('조건 문법은 닫혀 있다: 모르는 연산자·변수·키는 오류', () => {
  for (const bad of [{ eval: 'x' }, { cmp: ['__proto__', '>', 1] }, { cmp: ['gold', '=~', 1] }, { trait: 'x', extra: 1 }, { all: [] }]) {
    const errors = [];
    validateCondition(bad, 'c', errors, null);
    assert.ok(errors.length, JSON.stringify(bad));
  }
  let deep = { flag: 'a' };
  for (let i = 0; i < 10; i++) deep = { not: deep };
  const errors = [];
  validateCondition(deep, 'c', errors, null);
  assert.ok(errors.some((e) => e.includes('깊습니다')));
});

test('효과 문법도 닫혀 있다', () => {
  const errors = [];
  validateEffect({ script: 'alert(1)' }, 'e', errors, null);
  validateEffect({ gold: 5, extra: 1 }, 'e', errors, null);
  validateEffect({ flag: 'x', set: true, add: 1 }, 'e', errors, null);
  assert.equal(errors.length, 3);
  const st = freshLife();
  const g = st.gold;
  const changes = applyEffects([{ gold: 50 }, { stat: 'str', add: 1 }, { health: -20 }, { scene: 's_cradle' }, { trait: 'lucky', gain: true }], st, content);
  assert.equal(st.gold, g + 50);
  assert.equal(st.health, 0);
  assert.ok(st.scenes.includes('s_cradle'));
  assert.ok(st.traits.includes('lucky'));
  assert.ok(changes.some((c) => c.kind === 'scene'));
});

test('주사위 등급 확률은 합이 1이고, 능력치가 오르면 성공률도 오른다', () => {
  for (const die of Object.values(content.dice)) {
    const p = tierProbabilities(die, 3, 0, die.mode === 'under' ? 40 : 10);
    const sum = Object.values(p).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, die.id);
    const lo = tierProbabilities(die, 1, 0, die.mode === 'under' ? 40 : 12);
    const hi = tierProbabilities(die, 6, 0, die.mode === 'under' ? 40 : 12);
    assert.ok(hi.success + hi.crit_success > lo.success + lo.crit_success, die.id);
  }
  const d20 = content.dice.d20;
  assert.ok(Math.abs(tierProbabilities(d20, 0, 0, 30).crit_success - 0.05) < 1e-9, '20은 언제나 대성공');
  const bones = content.dice.d6x2;
  assert.ok(tierProbabilities(bones, 2, 0, 10).partial > 0, '2d6에는 부분 성공이 있다');
  const r = roll(d20, 3, 1, 12, new Rng(7));
  assert.equal(r.total, r.raw + 4);
});

test('특성 빌드: 포인트 제한, 종족 전용, 상호 배타', () => {
  const birth = { race: 'human', status: 'commoner', birthplace: 'port', aptitude: 0, talent: 'str', seed: 1 };
  const budget = E.traitBudget(content, birth, 0, 0);
  assert.equal(budget, 6 + 1 + 1);
  assert.ok(!E.validateBuild(content, birth, ['starborn'], budget).ok, '엘프 전용 특성');
  assert.ok(!E.validateBuild(content, birth, ['fearless', 'coward'], budget).ok, '상호 배타');
  assert.ok(!E.validateBuild(content, birth, ['lucky', 'haggler', 'silver_tongue'], budget).ok, '포인트 초과');
  assert.ok(E.validateBuild(content, birth, ['lucky', 'haggler', 'silver_tongue', 'sickly'], budget).ok, '부정 특성으로 포인트 회수');
  assert.equal(E.traitBudget(content, birth, 99, 2), budget + content.config.maxBonusPoints - 2);
});

test('특성은 평생 반응한다: 특성 전용 선택지가 성인기에도 나타난다', () => {
  const st = freshLife({ traits: ['spendthrift'] });
  st.age = 30;
  const view = E.presentEvent(content, st, content.events.x_luxury);
  assert.ok(view.choices.some((c) => c.text.includes('외상')));
  const plain = freshLife();
  plain.age = 30;
  assert.ok(!E.presentEvent(content, plain, content.events.x_luxury).choices.some((c) => c.text.includes('외상')));
  assert.ok(E.eventWeight(content.events.x_luxury, st) > E.eventWeight(content.events.x_luxury, plain));
});

test('디버그 뷰가 사건이 안 뜬 이유를 설명한다', () => {
  const st = freshLife();
  const rows = E.explainAll(content, st);
  const dragon = rows.find((r) => r.id === 'a_dragon');
  assert.equal(dragon.ok, false);
  assert.ok(dragon.reasons.some((r) => r.includes('나이 범위 밖')));
  assert.ok(dragon.reasons.some((r) => r.includes('조건 불충족')));
  assert.ok(rows.find((r) => r.id === 'e_cradle').ok);
});

test('사건 연쇄 대기열은 나이 범위를 무시하고 먼저 나온다', () => {
  const st = freshLife();
  st.age = 30;
  st.career = 'merchant';
  st.flags.rival = true;
  st.queue.push({ event: 'm_rival_firm', atAge: 30 });
  assert.equal(E.pickNextEvent(content, st).id, 'm_rival_firm');
});

test('시간 제한이 다하면 생이 끝난다', () => {
  const st = freshLife();
  st.clock.elapsedMin = 181;
  assert.ok(E.checkClock(content, st));
  assert.equal(st.ended.reason, 'time');
  assert.ok(st.achievements.includes('a_first_life'));
});

test('세이브: 사라진 콘텐츠는 경고와 함께 떨군다, 종족이 사라지면 거부', () => {
  const st = freshLife({ traits: ['lucky'] });
  st.scenes.push('s_cradle');
  const data = serializeSave(content, st);
  data.state.traits.push('ghost_trait');
  data.state.scenes.push('s_ghost');
  data.state.queue.push({ event: 'e_ghost', atAge: 3 });
  data.packs.push({ id: 'removed_pack', version: '1.0.0' });
  const res = loadSave(content, data);
  assert.ok(res.ok);
  assert.deepEqual(res.state.traits, ['lucky']);
  assert.deepEqual(res.state.scenes, ['s_cradle']);
  assert.equal(res.state.queue.length, 0);
  assert.ok(res.warnings.some((w) => w.includes('removed_pack')));
  data.state.race = 'orc';
  assert.equal(loadSave(content, data).ok, false);
});

test('업적은 다음 판 특성 포인트로 이월되고, 갤러리는 판을 넘어 남는다', () => {
  const meta = emptyMeta();
  const st = freshLife();
  st.scenes.push('s_cradle', 's_fever');
  st.gold = 1200;
  E.endLife(content, st, 'age', 'test');
  const r = applyRunToMeta(content, meta, st, { s_cradle: '/cache/x.png' });
  assert.ok(r.newAchievements.includes('a_gold_1000'));
  assert.ok(r.pointsGained >= 2);
  assert.equal(meta.gallery.s_cradle.image, '/cache/x.png');
  assert.ok(bonusPoints(content, meta) <= content.config.maxBonusPoints);
  const again = applyRunToMeta(content, meta, st);
  assert.equal(again.pointsGained, 0, '같은 업적은 두 번 보상하지 않는다');
});

test('자동 플레이 300판: 오류 없이 끝나고, 모든 사건과 장면에 도달 가능', async () => {
  const { playLife } = await import('../tools/simulate.js');
  const fired = new Set();
  const scenes = new Set();
  for (let i = 0; i < 300; i++) {
    const { state } = playLife(content, 5000 + i, 'random');
    assert.ok(state.ended);
    Object.keys(state.seen).forEach((k) => fired.add(k));
    state.scenes.forEach((s) => scenes.add(s));
  }
  const never = Object.keys(content.events).filter((k) => !fired.has(k));
  assert.deepEqual(never, []);
  assert.equal(scenes.size, Object.keys(content.scenes).length);
});
