import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tempMods, packManifest, loadCore } from './helpers.js';
import { loadPacks } from '../src/shared/modloader.js';
import { fsReader } from '../src/fsreader.js';
import { buildScenePrompt, defaultAppearance } from '../src/shared/prompt.js';
import { checkGenerationRequest, isForbiddenTag } from '../src/shared/safety.js';

const { content } = await loadCore();

const goodEvent = {
  id: 'mod_evt', title: '모드 사건', ages: [20, 40], text: '모드가 만든 사건.',
  choices: [{ text: '좋다', outcome: { text: '좋았다.', effects: [{ gold: 10 }] } }],
};

async function report(extra) {
  const dir = await tempMods(extra);
  try {
    return await loadPacks(fsReader(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('정상 모드팩은 core 위에 로드되고 core의 ID를 참조할 수 있다', async () => {
  const ev = { ...goodEvent, conditions: { trait: 'lucky' }, choices: [{ text: '굴린다', check: { dice: 'd20', stat: 'str', dc: 10 }, outcomes: { success: { text: '성공', effects: [{ scene: 's_cradle' }] }, fail: { text: '실패' } } }] };
  const res = await report({ good: { 'manifest.json': packManifest('good', ['data/ev.json']), 'data/ev.json': { type: 'events', items: [ev] } } });
  const r = res.report.find((x) => x.id === 'good');
  assert.equal(r.status, 'loaded', r.errors.join('\n'));
  assert.ok(res.content.events.mod_evt);
});

test('실행 코드 파일이 든 모드팩은 거부된다', async () => {
  const res = await report({ evil: { 'manifest.json': packManifest('evil', ['data/ev.json']), 'data/ev.json': { type: 'events', items: [goodEvent] }, 'payload.js': 'alert(1)', 'tool.exe': 'MZ' } });
  const r = res.report.find((x) => x.id === 'evil');
  assert.equal(r.status, 'rejected');
  assert.ok(r.errors.some((e) => e.includes('payload.js')));
  assert.ok(!res.content.events.mod_evt);
});

test('금지 태그(NTR·미시 유형)는 태그·프롬프트 어디서든 거부된다', async () => {
  for (const tag of ['NTR', 'net-orare', '네토라레', 'MILF', '미시', '유부녀']) assert.ok(isForbiddenTag(tag), tag);
  const res = await report({
    tagged: { 'manifest.json': packManifest('tagged', ['data/ev.json']), 'data/ev.json': { type: 'events', items: [{ ...goodEvent, tags: ['NTR'] }] } },
    prompted: { 'manifest.json': packManifest('prompted', ['data/sc.json']), 'data/sc.json': { type: 'scenes', items: [{ id: 'mod_sc', title: 't', caption: 'c', stage: 'adult', emotion: 'calm', prompt: 'milf, tavern' }] } },
  });
  assert.equal(res.report.find((x) => x.id === 'tagged').status, 'rejected');
  assert.equal(res.report.find((x) => x.id === 'prompted').status, 'rejected');
});

test('20세 미만 단계 장면에 성인 등급·성적 표현을 넣은 팩은 거부된다', async () => {
  const res = await report({
    minor: { 'manifest.json': packManifest('minor', ['data/sc.json']), 'data/sc.json': { type: 'scenes', items: [{ id: 'mod_sc1', title: 't', caption: 'c', stage: 'teen', emotion: 'calm', rating: 'adult', prompt: 'river' }, { id: 'mod_sc2', title: 't', caption: 'c', stage: 'child', emotion: 'calm', prompt: 'swimsuit at the beach' }] } },
  });
  const r = res.report.find((x) => x.id === 'minor');
  assert.equal(r.status, 'rejected');
  assert.ok(r.errors.some((e) => e.includes('성인 등급')));
  assert.ok(r.errors.some((e) => e.includes('swimsuit')));
});

test('등장인물은 가상 인물이며 20세 이상이어야 한다', async () => {
  const res = await report({ npc: { 'manifest.json': packManifest('npc', ['data/c.json']), 'data/c.json': { type: 'characters', items: [{ id: 'c_x', name: 'x', age: 17, fictional: false, prompt: 'a knight' }] } } });
  const r = res.report.find((x) => x.id === 'npc');
  assert.equal(r.status, 'rejected');
  assert.ok(r.errors.some((e) => e.includes('가상 인물')));
  assert.ok(r.errors.some((e) => e.includes('20세 이상')));
});

test('닫힌 문법 밖의 조건·효과, 잘못된 참조, 경로 탈출, ID 충돌은 거부된다', async () => {
  const bad = {
    ...goodEvent,
    conditions: { javascript: 'process.exit()' },
    choices: [{ text: 'x', outcome: { text: 'y', effects: [{ eval: '1' }, { scene: 's_nope' }] } }],
  };
  const res = await report({
    badgrammar: { 'manifest.json': packManifest('badgrammar', ['data/ev.json']), 'data/ev.json': { type: 'events', items: [bad] } },
    escape: { 'manifest.json': packManifest('escape', ['data/../../core/data/config.json']) },
    clash: { 'manifest.json': packManifest('clash', ['data/ev.json']), 'data/ev.json': { type: 'events', items: [{ ...goodEvent, id: 'e_cradle' }] } },
    badimg: { 'manifest.json': packManifest('badimg', ['data/sc.json']), 'data/sc.json': { type: 'scenes', items: [{ id: 'mod_img', title: 't', caption: 'c', stage: 'adult', emotion: 'calm', prompt: 'x', image: '../../../etc/passwd.png' }] } },
  });
  const by = (id) => res.report.find((x) => x.id === id);
  assert.ok(by('badgrammar').errors.some((e) => e.includes('닫힌 문법 밖')));
  assert.ok(by('badgrammar').errors.some((e) => e.includes('s_nope')));
  assert.equal(by('escape').status, 'rejected');
  assert.ok(by('clash').errors.some((e) => e.includes('이미 다른 팩')));
  assert.equal(by('badimg').status, 'rejected');
  assert.equal(res.content.events.e_cradle.pack, 'core');
});

test('생성 프롬프트: 20세 미만 장면에는 자유 서술 외형이 들어가지 않고 안전 부정 프롬프트가 붙는다', () => {
  const appearance = { ...defaultAppearance(content.style), extra: 'scarred jaw, tall' };
  const child = buildScenePrompt(content, content.scenes.s_wolf_fence, { race: 'elf', appearance, seed: 1 });
  assert.ok(child.ok, child.reasons?.join());
  assert.ok(!child.request.prompt.includes('scarred jaw'));
  assert.ok(child.request.negative_prompt.includes('nsfw'));
  assert.ok(child.request.prompt.includes('fully clothed'));
  const adult = buildScenePrompt(content, content.scenes.s_first_shop, { race: 'elf', appearance, seed: 1 });
  assert.ok(adult.request.prompt.includes('scarred jaw'));
  assert.equal(adult.request.width, content.style.width, '스타일 락 해상도');
  assert.ok(adult.request.prompt.startsWith(content.style.prefix), '스타일 락 접두사');
});

test('생성 프롬프트: 외형 어휘 밖의 값, 실존 인물 표지, 성인 등급 미허용은 거부', () => {
  const app = defaultAppearance(content.style);
  assert.equal(buildScenePrompt(content, content.scenes.s_first_shop, { race: 'human', appearance: { ...app, hair: 'nude' }, seed: 1 }).ok, false);
  assert.equal(buildScenePrompt(content, content.scenes.s_first_shop, { race: 'human', appearance: { ...app, extra: 'looks like a famous actress' }, seed: 1 }).ok, false);
  const adultScene = { ...content.scenes.s_first_shop, rating: 'adult' };
  assert.equal(buildScenePrompt(content, adultScene, { race: 'human', appearance: app, seed: 1 }).ok, false);
  assert.equal(buildScenePrompt(content, adultScene, { race: 'human', appearance: app, seed: 1 }, { allowAdult: true }).ok, true);
  const teenAdult = { ...content.scenes.s_old_mine, rating: 'adult' };
  assert.equal(buildScenePrompt(content, teenAdult, { race: 'human', appearance: app, seed: 1 }, { allowAdult: true }).ok, false, '설정으로도 못 켬');
  assert.equal(checkGenerationRequest({ stage: 'teen', rating: 'general', prompt: 'teen at a festival, kissing', characters: [] }).ok, false);
});

test('core의 모든 장면은 모든 종족에 대해 안전 검사를 통과한다', () => {
  for (const race of Object.keys(content.races)) {
    for (const sc of Object.values(content.scenes)) {
      const r = buildScenePrompt(content, sc, { race, appearance: defaultAppearance(content.style), seed: 9 });
      assert.ok(r.ok, `${race}/${sc.id}: ${r.reasons?.join()}`);
    }
  }
});
