// 자동 플레이 시뮬레이터: node tools/simulate.js [판 수] [전략: random|greedy]
// 콘텐츠 밸런스(돈 분포, 사건 도달률, 장면 해금률)와 엔진 오류를 확인한다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/shared/modloader.js';
import { fsReader } from '../src/fsreader.js';
import * as E from '../src/shared/engine.js';
import { Rng } from '../src/shared/util.js';
import { defaultAppearance } from '../src/shared/prompt.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runs = Number(process.argv[2] ?? 500);
const strategy = process.argv[3] ?? 'random';
const { content, fatal } = await loadPacks(fsReader(path.join(root, 'mods')));
if (fatal.length) throw new Error(fatal.join('\n'));

export function playLife(content, seed, strategy) {
  const rng = new Rng(seed);
  const birth = E.rollBirth(content, rng);
  const budget = E.traitBudget(content, birth, 0, 0);
  const traits = [];
  let spent = 0;
  for (const t of E.availableTraits(content, birth).sort(() => rng.next() - 0.5)) {
    const next = [...traits, t.id];
    if (E.validateBuild(content, birth, next, budget).ok && spent + t.cost <= budget) {
      traits.push(t.id);
      spent += t.cost;
    }
  }
  const state = E.createLife(content, { birth, traits, name: '시뮬', appearance: defaultAppearance(content.style), timeLimitMin: 0 });
  let steps = 0;
  while (!state.ended && steps < 500) {
    const ev = E.pickNextEvent(content, state);
    if (!ev) {
      E.passYears(content, state, 1);
      continue;
    }
    const view = E.presentEvent(content, state, ev);
    const avail = view.choices.filter((c) => c.available);
    if (!avail.length) throw new Error(`선택 가능한 선택지 없음: ${ev.id}`);
    let choice;
    if (strategy === 'greedy') {
      choice = avail.reduce((best, c) => ((c.check?.chance ?? 0.75) > (best.check?.chance ?? 0.75) ? c : best), avail[0]);
    } else choice = avail[Math.floor(rng.next() * avail.length)];
    E.resolveChoice(content, state, ev, choice.index);
    steps++;
  }
  if (!state.ended) throw new Error('500턴 안에 끝나지 않음');
  return { state, steps };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fired = Object.fromEntries(Object.keys(content.events).map((k) => [k, 0]));
  const sceneHits = Object.fromEntries(Object.keys(content.scenes).map((k) => [k, 0]));
  const reasons = {};
  const golds = [];
  const ages = [];
  const stepsArr = [];
  const byCareer = {};
  for (let i = 0; i < runs; i++) {
    const { state, steps } = playLife(content, 1000 + i, strategy);
    for (const k of Object.keys(state.seen)) fired[k] += 1;
    for (const s of state.scenes) sceneHits[s] += 1;
    reasons[state.ended.reason] = (reasons[state.ended.reason] ?? 0) + 1;
    golds.push(state.gold);
    ages.push(state.age);
    stepsArr.push(steps);
    const c = state.career ?? 'none';
    (byCareer[c] ??= []).push(state.gold);
  }
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
  console.log(`전략 ${strategy}, ${runs}판`);
  console.log(`결정 수: 평균 ${avg(stepsArr).toFixed(1)} (최소 ${Math.min(...stepsArr)}, 최대 ${Math.max(...stepsArr)})`);
  console.log(`종료 나이: 평균 ${avg(ages).toFixed(1)}, 종료 사유 ${JSON.stringify(reasons)}`);
  console.log(`최종 금화: 평균 ${avg(golds).toFixed(0)}, 중앙 ${pct(golds, 0.5)}, 10% ${pct(golds, 0.1)}, 90% ${pct(golds, 0.9)}, 최대 ${Math.max(...golds)}`);
  for (const [c, g] of Object.entries(byCareer)) console.log(`  ${c}: ${g.length}판, 평균 ${avg(g).toFixed(0)}, 중앙 ${pct(g, 0.5)}`);
  const rare = Object.entries(fired).filter(([, n]) => n / runs < 0.05).map(([k, n]) => `${k}(${n})`);
  console.log(`5% 미만으로 등장한 사건: ${rare.join(', ') || '없음'}`);
  console.log(`장면 해금률: ${Object.entries(sceneHits).map(([k, n]) => `${k} ${((n / runs) * 100).toFixed(0)}%`).join(', ')}`);
}
