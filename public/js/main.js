// 화면 흐름: 타이틀 → 출생 → 특성 빌드 → 플레이(사건·판정) → 생의 끝 → 다음 생.
import { h, mount, clear, signed } from './dom.js';
import { store, httpReader, reloadServerMods, generatorStatus } from './api.js';
import { sceneFigure, placeholderSvg, Pregen } from './scenes.js';
import { loadPacks } from '/shared/modloader.js';
import * as E from '/shared/engine.js';
import { TIER_LABELS, TIER_ICONS } from '/shared/dice.js';
import { serializeSave, loadSave, emptyMeta, normalizeMeta, bonusPoints, applyRunToMeta } from '/shared/save.js';
import { APPEARANCE_FIELDS, EXTRA_MAX, defaultAppearance } from '/shared/prompt.js';
import { Rng, randomSeed, formatGold } from '/shared/util.js';
import { STAGES } from '/shared/safety.js';

const app = document.getElementById('app');
const overlayRoot = document.getElementById('overlay-root');

const DEFAULT_SETTINGS = {
  timeLimitMin: 180,
  speed: 1,
  debug: false,
  compressChildhood: false,
  generator: { enabled: false, url: 'http://127.0.0.1:7860', allowAdult: false, useReference: false, cnModule: 'ip-adapter_clip_sd15', cnModel: '', cnWeight: 0.6 },
};
const SPEEDS = [1, 2, 3];
const TIME_OPTIONS = [60, 120, 180, 240, 300, 0];
const APPEARANCE_LABELS = { gender: '성별', hair: '머리', eyes: '눈', skin: '피부' };

const G = {
  content: null,
  report: [],
  fatal: [],
  meta: emptyMeta(),
  settings: structuredClone(DEFAULT_SETTINGS),
  state: null,
  event: null,
  pregen: null,
  images: {},
  clockTimer: null,
  paused: false,
  busy: false,
  screen: 'title',
};

// ---------- 공통 ----------

function stageOf(age) {
  if (age < 13) return 'child';
  if (age < E.ADULT_AGE) return 'teen';
  if (age < 55) return 'adult';
  return 'elder';
}

function fmtClock(min) {
  const m = Math.max(0, Math.ceil(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function rankTitle(state) {
  if (!state.career) return '무직 · 날품팔이';
  const c = G.content.careers[state.career];
  return `${c.name} · ${c.rankTitles[state.rank]}`;
}

function button(text, onClick, cls = '') {
  return h('button', { class: `btn ${cls}`, text, on: { click: onClick } });
}

function openOverlay(node, { onClose, dismissable = true } = {}) {
  const wrap = h('div', { class: 'overlay', on: { click: (e) => { if (dismissable && e.target === wrap) close(); } } }, node);
  function close() {
    wrap.remove();
    onClose?.();
  }
  overlayRoot.appendChild(wrap);
  return close;
}

async function saveSettings() {
  await store.set('settings', G.settings);
}
async function saveMeta() {
  await store.set('meta', G.meta);
}
async function autosave() {
  if (G.state && !G.state.ended) await store.set('autosave', serializeSave(G.content, G.state));
}

// ---------- 시작 ----------

async function boot() {
  const [settings, meta] = await Promise.all([store.get('settings'), store.get('meta')]);
  G.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(settings || {}), generator: { ...DEFAULT_SETTINGS.generator, ...(settings?.generator || {}) } };
  G.meta = normalizeMeta(meta);
  await loadContent();
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.screen === 'game') pauseGame(); });
  showTitle();
}

async function loadContent() {
  const res = await loadPacks(httpReader);
  G.content = res.content;
  G.report = res.report;
  G.fatal = res.fatal;
}

function onKey(e) {
  if (e.key === 'F9') {
    e.preventDefault();
    if (G.state && G.settings.debug) showDebug();
  }
  if (e.key === 'Escape' && G.screen === 'game' && !overlayRoot.firstChild) pauseGame();
}

// ---------- 타이틀 ----------

async function showTitle() {
  G.screen = 'title';
  stopClock();
  const auto = await store.get('autosave');
  const pts = G.content.config ? bonusPoints(G.content, G.meta) : 0;
  const broken = G.fatal.length > 0;
  mount(app, h('div', { class: 'title-screen' },
    h('div', { class: 'cover' },
      h('div', { class: 'cover-ornament', text: '❦' }),
      h('h1', { text: '태생 설계도' }),
      h('p', { class: 'subtitle', text: '마음대로 살아낸 생' }),
      h('p', { class: 'cover-pitch', text: '무작위로 태어나, 시작을 설계하고, 주사위로 한 생을 헤쳐 나가라. 남기는 것은 금화, 쌓이는 것은 장면.' }),
      broken
        ? h('div', { class: 'panel error-panel' }, h('strong', { text: '콘텐츠를 불러오지 못했습니다' }), ...G.fatal.map((f) => h('p', { text: f })), button('모드팩 보고서', showMods))
        : h('div', { class: 'menu' },
          button('새 생 시작', () => showBirth(), 'primary'),
          auto ? button('이어하기', () => continueSave(auto)) : null,
          button('장면 갤러리', showGallery),
          button('업적', showAchievements),
          button('모드팩', showMods),
          button('설정', showSettings),
        ),
      h('div', { class: 'cover-stats' },
        h('span', { text: `지나간 생 ${G.meta.lives}` }),
        h('span', { text: `최고 기록 ${G.meta.bestGold === null ? '—' : formatGold(G.meta.bestGold)}` }),
        h('span', { text: `이월 특성 포인트 +${pts}` }),
        h('span', { text: `장면 ${Object.keys(G.meta.gallery).length}/${Object.keys(G.content.scenes).length}` }),
      ),
    ),
  ));
}

async function continueSave(data) {
  const res = loadSave(G.content, data);
  if (!res.ok) {
    openOverlay(h('div', { class: 'panel dialog' }, h('h2', { text: '이어할 수 없습니다' }), ...res.errors.map((e) => h('p', { text: e })), button('닫기', () => overlayRoot.firstChild?.remove())));
    return;
  }
  G.state = res.state;
  startGenerator();
  if (res.warnings.length) {
    openOverlay(h('div', { class: 'panel dialog' }, h('h2', { text: '모드 구성이 바뀌었습니다' }), h('ul', {}, ...res.warnings.map((w) => h('li', { text: w }))), button('계속', () => { overlayRoot.firstChild?.remove(); showGame(); }, 'primary')), { dismissable: false });
  } else showGame();
}

// ---------- 출생 ----------

function showBirth() {
  G.screen = 'birth';
  const rng = new Rng(randomSeed());
  let birth = E.rollBirth(G.content, rng);
  let rerolls = 0;
  const cfg = G.content.config;
  const bonus = bonusPoints(G.content, G.meta);

  const render = () => {
    const c = G.content;
    const race = c.races[birth.race];
    const status = c.statuses[birth.status];
    const place = c.birthplaces[birth.birthplace];
    const budget = E.traitBudget(c, birth, bonus, rerolls);
    const card = (label, name, desc, cls = '') => h('div', { class: `birth-card ${cls}` }, h('div', { class: 'birth-label', text: label }), h('div', { class: 'birth-name', text: name }), h('p', { text: desc }));
    mount(app, h('div', { class: 'page-screen' },
      h('header', { class: 'screen-head' }, h('h2', { text: '출생의 주사위' }), h('p', { text: '어디서, 누구로 태어날지는 고를 수 없다. 단, 운명을 다시 굴릴 수는 있다 — 특성 포인트를 대가로.' })),
      h('div', { class: 'birth-grid' },
        card('종족', race.name, race.desc),
        card('신분', status.name, status.desc),
        card('출생지', place.name, place.desc),
        card('타고난 재능', `${E.STAT_LABELS[birth.talent]} +2`, '태어날 때부터 남달랐던 한 가지.'),
        card('마력 소질', E.APTITUDE_LABELS[birth.aptitude], `마력 +${birth.aptitude}. 마탑의 문은 소질을 본다.`),
      ),
      h('div', { class: 'birth-actions' },
        h('div', { class: 'points-line', text: `특성 포인트 ${budget} (기본 ${cfg.baseTraitPoints} · 종족/신분 ${(race.traitPoints ?? 0) + (status.traitPoints ?? 0)} · 업적 이월 +${bonus} · 다시 굴림 −${rerolls * cfg.rerollCost})` }),
        rerolls < cfg.maxRerolls
          ? button(`운명 다시 굴리기 (−${cfg.rerollCost}포인트, 남은 기회 ${cfg.maxRerolls - rerolls})`, () => { birth = E.rollBirth(c, rng); rerolls++; render(); })
          : h('span', { class: 'muted', text: '더는 다시 굴릴 수 없다.' }),
        button('이 생으로 태어난다', () => showBuild(birth, rerolls), 'primary'),
        button('돌아가기', showTitle, 'ghost'),
      ),
    ));
  };
  render();
}

// ---------- 특성 빌드 ----------

function showBuild(birth, rerolls) {
  G.screen = 'build';
  const c = G.content;
  const budget = E.traitBudget(c, birth, bonusPoints(c, G.meta), rerolls);
  const picked = new Set();
  const appearance = defaultAppearance(c.style);
  let name = '';
  let compress = G.settings.compressChildhood && G.meta.lives > 0;

  const traitsAll = Object.values(c.traits);
  const render = () => {
    const check = E.validateBuild(c, birth, [...picked], budget);
    const left = budget - check.spent;
    const preview = E.createLife(c, { birth, traits: [...picked].filter((t) => c.traits[t]), name, appearance });
    const traitCard = (t) => {
      const locked = t.race && t.race !== birth.race;
      const on = picked.has(t.id);
      const conflict = (t.exclusive || []).some((x) => picked.has(x));
      const tooExpensive = !on && t.cost > left;
      const disabled = locked || (!on && (conflict || tooExpensive));
      return h('button', {
        class: `trait-card ${on ? 'on' : ''} ${t.cost < 0 ? 'negative' : ''} ${locked ? 'locked' : ''}`,
        disabled,
        'aria-pressed': String(on),
        on: { click: () => { if (on) picked.delete(t.id); else picked.add(t.id); render(); } },
      },
      h('div', { class: 'trait-top' }, h('span', { class: 'trait-name', text: t.name }), h('span', { class: 'trait-cost', text: t.cost > 0 ? `−${t.cost}` : `+${-t.cost}` })),
      h('p', { text: t.desc }),
      locked ? h('div', { class: 'trait-note', text: `${c.races[t.race].name} 전용` }) : conflict && !on ? h('div', { class: 'trait-note', text: '함께 고를 수 없는 특성이 있음' }) : null);
    };
    const appearanceSelect = (field) => h('label', { class: 'field' }, h('span', { text: APPEARANCE_LABELS[field] }),
      h('select', { on: { change: (e) => { appearance[field] = e.target.value; } } },
        ...c.style.appearance[field].map((o) => h('option', { value: o.id, text: o.label, selected: appearance[field] === o.id }))));

    mount(app, h('div', { class: 'page-screen build-screen' },
      h('header', { class: 'screen-head' }, h('h2', { text: '시작 설계' }), h('p', { text: '고른 특성은 마흔의 사건에서도 반응한다.' })),
      h('div', { class: 'build-layout' },
        h('section', { class: 'panel' },
          h('div', { class: `points-big ${left < 0 ? 'over' : ''}`, text: `남은 특성 포인트 ${left} / ${budget}` }),
          h('div', { class: 'trait-grid' }, ...traitsAll.map(traitCard)),
          check.errors.length ? h('div', { class: 'error-text' }, ...check.errors.map((e) => h('p', { text: e }))) : null,
        ),
        h('aside', { class: 'panel side' },
          h('label', { class: 'field' }, h('span', { text: '이름' }), h('input', { type: 'text', maxLength: 16, value: name, placeholder: '이름 없는 자', on: { input: (e) => { name = e.target.value; } } })),
          h('h3', { text: '외형 (장면 그림에 쓰임)' }),
          ...APPEARANCE_FIELDS.map(appearanceSelect),
          h('label', { class: 'field' }, h('span', { text: `추가 묘사 (성년·노년 장면에만, ${EXTRA_MAX}자)` }),
            h('textarea', { maxLength: EXTRA_MAX, rows: 2, placeholder: '예: freckles, scar on left cheek', on: { input: (e) => { appearance.extra = e.target.value; } } }, appearance.extra)),
          G.meta.lives > 0
            ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: compress, on: { change: (e) => { compress = e.target.checked; } } }), h('span', { text: '유년기 압축 (1~19세 사건마다 시간이 두 배로 흐름)' }))
            : null,
          h('h3', { text: '시작 능력치' }),
          h('div', { class: 'stat-preview' }, ...Object.entries(E.STAT_LABELS).map(([k, l]) => h('div', { class: 'stat-pill' }, h('span', { text: l }), h('strong', { text: String(preview.stats[k]) })))),
          h('p', { class: 'muted', text: `건강 ${preview.health}/10 · 시작 금화 ${formatGold(preview.gold)}` }),
          h('div', { class: 'build-actions' },
            button('태어난다', async () => {
              if (!check.ok) return;
              G.state = E.createLife(c, { birth, traits: [...picked], name: name.trim(), appearance: { ...appearance }, options: { compressChildhood: compress }, timeLimitMin: G.settings.timeLimitMin });
              G.images = {};
              startGenerator();
              await autosave();
              showGame();
            }, 'primary'),
            button('출생으로', () => showBirth(), 'ghost'),
          ),
        ),
      ),
    ));
  };
  render();
}

// ---------- 이미지 사전 생성 ----------

async function startGenerator() {
  if (G.pregen) G.pregen.cancelled = true;
  const st = G.state;
  const char = { race: st.race, appearance: st.appearance, seed: st.charSeed };
  const pg = new Pregen(G.content, char, (p) => {
    G.images = p.images;
    updateGenBadge();
  });
  G.pregen = pg;
  await pg.peekAll();
  const status = await generatorStatus();
  pg.status = status;
  updateGenBadge();
  if (status.enabled && status.reachable) pg.run();
}

function updateGenBadge() {
  const el = document.getElementById('gen-badge');
  if (!el || !G.pregen) return;
  const p = G.pregen;
  if (p.running) el.textContent = `장면 그리는 중 ${p.done}/${p.total}`;
  else if (p.status?.enabled && !p.status.reachable) el.textContent = '생성기 연결 안 됨 · 기본 삽화';
  else if (!p.status?.enabled) el.textContent = Object.keys(p.images).length ? `캐시 장면 ${Object.keys(p.images).length}` : '기본 삽화';
  else el.textContent = `장면 준비 ${Object.keys(p.images).length}/${Object.keys(G.content.scenes).length}`;
  const left = document.querySelector('.left-page .scene-slot');
  if (left && left.dataset.scene && p.images[left.dataset.scene] && !left.querySelector('img')) {
    mount(left, sceneFigure(G.content, left.dataset.scene, G.images));
  }
}

// ---------- 플레이 ----------

function startClock() {
  stopClock();
  let last = performance.now();
  G.clockTimer = setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!G.state || G.state.ended || G.paused || G.screen !== 'game') return;
    G.state.clock.elapsedMin += (dt * G.settings.speed) / 60;
    updateClock();
    if (E.checkClock(G.content, G.state)) finishLife();
  }, 1000);
}

function stopClock() {
  if (G.clockTimer) clearInterval(G.clockTimer);
  G.clockTimer = null;
}

function updateClock() {
  const el = document.getElementById('clock');
  if (!el || !G.state) return;
  const c = G.state.clock;
  if (c.limitMin <= 0) {
    el.textContent = `⌛ 무제한 · ${fmtClock(c.elapsedMin)} 경과`;
    return;
  }
  const left = c.limitMin - c.elapsedMin;
  el.textContent = `⌛ ${fmtClock(left)}`;
  el.classList.toggle('low', left < c.limitMin * 0.15);
}

function topBar() {
  const st = G.state;
  const hearts = h('span', { class: 'hearts', title: `건강 ${st.health}/10`, 'aria-label': `건강 ${st.health}/10` }, ...Array.from({ length: 10 }, (_, i) => h('span', { class: i < st.health ? 'heart on' : 'heart', text: i < st.health ? '♥' : '♡' })));
  return h('header', { class: 'top-bar' },
    h('div', { class: 'who' }, h('strong', { text: st.name }), h('span', { text: ` · ${G.content.races[st.race].name} · ${G.content.statuses[st.status].name}` })),
    h('div', { class: 'stat-age', text: `${st.age}세` }),
    h('div', { class: 'stat-gold', text: formatGold(st.gold) }),
    hearts,
    h('div', { class: 'stat-rep', text: `평판 ${signed(st.rep)}` }),
    h('div', { class: 'stat-career', text: rankTitle(st) }),
    h('div', { class: 'clock', id: 'clock' }),
    h('div', { class: 'speed' }, ...SPEEDS.map((sp) => h('button', {
      class: `speed-btn ${G.settings.speed === sp ? 'on' : ''}`,
      text: `×${sp}`,
      title: G.state.clock.limitMin > 0 ? `실제 ${Math.round(G.state.clock.limitMin / sp)}분` : '',
      on: { click: async () => { G.settings.speed = sp; await saveSettings(); refreshTop(); } },
    }))),
    h('span', { class: 'gen-badge', id: 'gen-badge' }),
    button('☰', pauseGame, 'icon-btn'),
  );
}

function refreshTop() {
  const old = app.querySelector('.top-bar');
  if (old) {
    old.replaceWith(topBar());
    updateClock();
    updateGenBadge();
  }
}

function statsPanel() {
  const st = G.state;
  return h('div', { class: 'stats-mini' },
    ...Object.entries(E.STAT_LABELS).map(([k, l]) => h('span', { class: 'stat-pill small' }, h('span', { text: l }), h('strong', { text: String(st.stats[k]) }))),
    h('div', { class: 'trait-tags' }, ...st.traits.map((t) => h('span', { class: 'tag', text: G.content.traits[t]?.name ?? t, title: G.content.traits[t]?.desc ?? '' }))),
  );
}

function leftSceneId() {
  const st = G.state;
  return st.scenes[st.scenes.length - 1] ?? null;
}

function leftPage() {
  const id = leftSceneId();
  const scene = id ? G.content.scenes[id] : null;
  const slot = h('div', { class: 'scene-slot', dataset: { scene: id ?? '' } });
  if (id) slot.appendChild(sceneFigure(G.content, id, G.images));
  else slot.appendChild(h('div', { class: 'scene-frame chapter' }, placeholderSvg({ title: `${STAGES[stageOf(G.state.age)].label}의 장`, stage: stageOf(G.state.age), emotion: 'calm' })));
  return h('section', { class: 'page left-page' },
    slot,
    h('div', { class: 'caption panel-paper' },
      h('div', { class: 'caption-title', text: scene ? scene.title : '아직 해금한 장면이 없다' }),
      h('p', { text: scene ? scene.caption : '사건을 겪으면 장면이 하나씩 이 페이지에 남는다. 실패도 장면이 된다.' }),
    ),
    statsPanel(),
  );
}

function chronicle() {
  const items = G.state.log.slice(-6).reverse();
  return h('details', { class: 'chronicle' },
    h('summary', { text: `연대기 (${G.state.log.length})` }),
    h('ol', {}, ...items.map((e) => h('li', {}, h('span', { class: 'chron-age', text: `${e.age}세` }), h('strong', { text: e.title }), ' — ', h('span', { text: e.choice }), e.tier ? h('span', { class: `tier-tag tier-${e.tier}`, text: ` ${TIER_ICONS[e.tier]} ${TIER_LABELS[e.tier]}` }) : null))),
  );
}

function showGame() {
  G.screen = 'game';
  G.paused = false;
  startClock();
  nextTurn();
}

function renderSpread(rightContent) {
  mount(app, h('div', { class: 'game-screen' },
    topBar(),
    h('main', { class: 'book' }, leftPage(), h('section', { class: 'page right-page' }, rightContent)),
    chronicle(),
  ));
  updateClock();
  updateGenBadge();
}

async function nextTurn() {
  const st = G.state;
  if (st.ended) return finishLife();
  let ev = st.current ? G.content.events[st.current] : null;
  while (!ev) {
    ev = E.pickNextEvent(G.content, st);
    if (!ev) {
      E.passYears(G.content, st, 1);
      if (st.ended) return finishLife();
    }
  }
  st.current = ev.id;
  G.event = ev;
  await autosave();
  const view = E.presentEvent(G.content, st, ev);
  renderSpread(eventPanel(view));
}

function choiceButton(c) {
  const meta = [];
  if (c.check) {
    const k = c.check;
    const mod = k.mode === 'under' ? `목표 ${Math.min(100, k.dc + k.statValue * (G.content.dice[k.dice].statMultiplier ?? 1) + k.bonus)}` : `난이도 ${k.dc}`;
    meta.push(h('span', { class: 'dice-chip', title: G.content.dice[k.dice].desc ?? '' }, `${k.icon} ${k.diceName}`),
      h('span', { class: 'stat-chip', text: `${k.statLabel} ${k.statValue}${k.bonus ? ` ${signed(k.bonus)}` : ''}` }),
      h('span', { class: 'dc-chip', text: mod }),
      h('span', { class: `chance ${k.chance >= 0.66 ? 'hi' : k.chance >= 0.4 ? 'mid' : 'lo'}`, text: `성공 ${Math.round(k.chance * 100)}%` }));
  } else meta.push(h('span', { class: 'dice-chip plain', text: '판정 없음' }));
  return h('button', {
    class: `choice ${c.available ? '' : 'locked'}`,
    disabled: !c.available,
    on: { click: () => choose(c.index) },
  },
  h('span', { class: 'choice-text', text: c.text }),
  h('span', { class: 'choice-meta' }, ...meta),
  c.hint ? h('span', { class: 'choice-hint', text: c.available ? c.hint : `🔒 ${c.hint}` }) : null);
}

function eventPanel(view) {
  return h('div', { class: 'event panel-paper' },
    h('div', { class: 'event-age', text: `${G.state.age}세` }),
    h('h2', { class: 'event-title', text: view.title }),
    h('p', { class: 'event-text', text: view.text }),
    h('div', { class: 'choices' }, ...view.choices.map(choiceButton)),
  );
}

async function choose(index) {
  if (G.busy) return;
  G.busy = true;
  try {
    const st = G.state;
    const ev = G.event;
    const before = { scenes: st.scenes.length };
    const result = E.resolveChoice(G.content, st, ev, index);
    if (!st.ended) st.current = null;
    if (result.roll) await diceTray(result.roll, ev.choices[index].check);
    await autosave();
    renderSpread(outcomePanel(result, before));
  } finally {
    G.busy = false;
  }
}

function diceTray(roll, check) {
  return new Promise((resolve) => {
    const die = G.content.dice[roll.dice];
    const dur = 1100 / G.settings.speed;
    const faces = roll.faces.map(() => h('div', { class: `die d${die.sides}`, text: '?' }));
    const tier = h('div', { class: 'tray-result hidden' });
    const calc = h('div', { class: 'tray-calc hidden' });
    const cont = button('계속', () => { close(); resolve(); }, 'primary hidden');
    const box = h('div', { class: 'dice-tray' },
      h('div', { class: 'tray-title', text: `${die.icon ?? '🎲'} ${die.name}` }),
      h('div', { class: 'tray-dice' }, ...faces),
      calc, tier, cont);
    const close = openOverlay(box, { dismissable: false });
    const start = performance.now();
    const spin = () => {
      const t = performance.now() - start;
      if (t < dur) {
        faces.forEach((f) => { f.textContent = String(1 + Math.floor(Math.random() * die.sides)); });
        setTimeout(spin, 60);
        return;
      }
      faces.forEach((f, i) => { f.textContent = String(roll.faces[i]); f.classList.add('landed', `tier-${roll.tier}`); });
      const statName = E.STAT_LABELS[check.stat];
      if (die.mode === 'under') calc.textContent = `굴림 ${roll.raw} ${roll.raw <= roll.target ? '≤' : '>'} 목표 ${roll.target} (기준 ${roll.dc} ${signed(roll.mod)} ${statName}·보너스)`;
      else calc.textContent = `굴림 ${roll.raw} + ${statName}·보너스 ${signed(roll.mod)} = ${roll.total} ${roll.total >= roll.dc ? '≥' : '<'} 난이도 ${roll.dc}`;
      mount(tier, h('span', { class: 'tier-icon', text: TIER_ICONS[roll.tier] }), h('span', { text: TIER_LABELS[roll.tier] }));
      tier.className = `tray-result tier-${roll.tier}`;
      calc.classList.remove('hidden');
      cont.classList.remove('hidden');
      cont.focus();
    };
    spin();
  });
}

function changeChip(ch) {
  const c = G.content;
  switch (ch.kind) {
    case 'gold': return h('span', { class: `chip ${ch.delta >= 0 ? 'good' : 'bad'}`, text: `금화 ${signed(ch.delta)}` });
    case 'stat': return ch.delta ? h('span', { class: `chip ${ch.delta > 0 ? 'good' : 'bad'}`, text: `${E.STAT_LABELS[ch.stat]} ${signed(ch.delta)}` }) : null;
    case 'health': return ch.delta ? h('span', { class: `chip ${ch.delta > 0 ? 'good' : 'bad'}`, text: `건강 ${signed(ch.delta)}` }) : null;
    case 'rep': return ch.delta ? h('span', { class: `chip ${ch.delta > 0 ? 'good' : 'bad'}`, text: `평판 ${signed(ch.delta)}` }) : null;
    case 'rank': return h('span', { class: `chip ${ch.delta > 0 ? 'good' : 'bad'}`, text: `등급 ${ch.delta > 0 ? '▲' : '▼'} ${rankTitle(G.state)}` });
    case 'career': return h('span', { class: 'chip gold', text: `진로: ${ch.career ? c.careers[ch.career].name : '없음'}` });
    case 'trait': return h('span', { class: `chip ${ch.gained ? 'good' : 'bad'}`, text: `특성 ${ch.gained ? '획득' : '상실'}: ${c.traits[ch.trait].name}` });
    case 'scene': return h('span', { class: 'chip gold', text: `✦ 장면 해금: ${c.scenes[ch.scene].title}${c.scenes[ch.scene].failure ? ' (실패 장면)' : ''}` });
    case 'achievement': return h('span', { class: 'chip gold', text: `업적: ${c.achievements[ch.achievement].name}` });
    default: return null;
  }
}

function outcomePanel(result, before) {
  const st = G.state;
  const chips = result.changes.map(changeChip).filter(Boolean);
  const p = result.passage;
  let passage = null;
  if (p && p.years) {
    const econ = p.income || p.living ? ` · 수입 ${signed(p.income)} / 생활비 ${signed(-p.living)}` : '';
    passage = h('div', { class: 'passage', text: `${p.years}년이 흘렀다 → ${st.age}세${econ}` });
  }
  const newScene = st.scenes.length > before.scenes;
  return h('div', { class: 'event panel-paper outcome' },
    result.roll ? h('div', { class: `outcome-tier tier-${result.roll.tier}` }, h('span', { text: TIER_ICONS[result.roll.tier] }), ` ${TIER_LABELS[result.roll.tier]} · 굴림 ${result.roll.faces.join('+')}`) : null,
    h('h2', { class: 'event-title', text: G.event.title }),
    h('p', { class: 'event-text', text: result.text }),
    chips.length ? h('div', { class: 'chips' }, ...chips) : null,
    passage,
    newScene ? h('p', { class: 'scene-note', text: '왼쪽 페이지에 새 장면이 남았다.' }) : null,
    h('div', { class: 'choices' }, button(st.ended ? '생의 끝으로' : '다음 시기로', () => (st.ended ? finishLife() : nextTurn()), 'primary continue')),
  );
}

// ---------- 일시정지 ----------

function pauseGame() {
  if (G.screen !== 'game' || overlayRoot.firstChild) return;
  G.paused = true;
  const close = openOverlay(h('div', { class: 'panel dialog pause' },
    h('h2', { text: '잠시 멈춤' }),
    h('p', { class: 'muted', text: '모래시계도 멈춰 있다.' }),
    button('계속하기', () => close(), 'primary'),
    G.settings.debug ? button('디버그: 왜 이 사건이 안 떴나 (F9)', () => { close(); showDebug(); }) : null,
    button('저장하고 타이틀로', async () => { await autosave(); close(); showTitle(); }),
    button('이번 생을 여기서 끝낸다', () => { close(); E.endLife(G.content, G.state, 'death', `${G.state.age}세, 스스로 이야기를 덮었다`); finishLife(); }, 'danger'),
  ), { onClose: () => { G.paused = false; }, dismissable: true });
}

// ---------- 디버그 뷰 ----------

function showDebug() {
  G.paused = true;
  const rows = E.explainAll(G.content, G.state).sort((a, b) => Number(b.ok) - Number(a.ok) || a.ages[0] - b.ages[0]);
  let filter = '';
  const table = h('tbody');
  const fill = () => {
    clear(table);
    for (const r of rows.filter((x) => !filter || x.id.includes(filter) || x.title.includes(filter))) {
      table.appendChild(h('tr', { class: r.ok ? 'ok' : '' },
        h('td', { text: r.ok ? '가능' : '불가' }),
        h('td', { text: r.id }),
        h('td', { text: r.title }),
        h('td', { text: `${r.ages[0]}~${r.ages[1]}` }),
        h('td', { text: r.ok ? r.weight.toFixed(1) : '' }),
        h('td', { text: [r.priority ? `우선순위 ${r.priority}` : '', r.filler ? '공백기용' : '', r.queued ? '연쇄 대기' : '', r.seen ? `겪음 ${r.seen}` : ''].filter(Boolean).join(', ') }),
        h('td', { text: r.reasons.join(' / ') }),
      ));
    }
  };
  fill();
  const st = G.state;
  openOverlay(h('div', { class: 'panel dialog debug' },
    h('h2', { text: '디버그: 왜 이 사건이 안 떴나' }),
    h('p', { class: 'muted', text: `나이 ${st.age} · 금화 ${Math.round(st.gold)} · 건강 ${st.health} · 진로 ${st.career ?? '없음'}/${st.rank} · 플래그 ${Object.entries(st.flags).map(([k, v]) => `${k}=${v}`).join(', ') || '없음'} · 연쇄 대기 ${st.queue.map((q) => `${q.event}@${q.atAge}`).join(', ') || '없음'}` }),
    h('input', { type: 'search', placeholder: '사건 ID/제목 검색', on: { input: (e) => { filter = e.target.value.trim(); fill(); } } }),
    h('div', { class: 'debug-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...['상태', 'ID', '제목', '나이', '가중치', '표시', '이유'].map((t) => h('th', { text: t })))), table)),
  ), { onClose: () => { G.paused = false; } });
}

// ---------- 생의 끝 ----------

async function finishLife() {
  stopClock();
  const st = G.state;
  if (!st.ended) return;
  G.screen = 'end';
  if (G.pregen) G.pregen.cancelled = true;
  const summary = applyRunToMeta(G.content, G.meta, st, G.images);
  await saveMeta();
  await store.remove('autosave');
  const c = G.content;
  const official = st.clock.limitMin > 0;
  mount(app, h('div', { class: 'page-screen end-screen' },
    h('div', { class: 'panel-paper end-card' },
      h('div', { class: 'cover-ornament', text: '❦' }),
      h('h2', { text: `${st.name}의 생` }),
      h('p', { class: 'end-cause', text: `${E.END_REASONS[st.ended.reason]} — ${st.ended.cause}` }),
      h('div', { class: 'score' }, h('span', { text: '남긴 금화' }), h('strong', { text: formatGold(st.gold) })),
      summary.isBest ? h('p', { class: 'best', text: '★ 새 최고 기록' }) : null,
      official ? null : h('p', { class: 'muted', text: '시간 제한 없이 플레이한 생은 최고 기록에 들어가지 않습니다.' }),
      h('p', { class: 'muted', text: `${c.races[st.race].name} · ${c.statuses[st.status].name} · ${c.birthplaces[st.birthplace].name} · ${rankTitle(st)} · ${st.age}세 · 대성공 ${st.critSuccesses} · 대실패 ${st.critFails}` }),
      h('h3', { text: `이번 생의 장면 ${st.scenes.length}` }),
      h('div', { class: 'end-scenes' }, ...st.scenes.map((id) => h('figure', { class: summary.newScenes.includes(id) ? 'new' : '' }, sceneFigure(c, id, G.images), h('figcaption', { text: `${c.scenes[id].title}${summary.newScenes.includes(id) ? ' · 새 장면' : ''}` })))),
      h('h3', { text: '업적' }),
      st.achievements.length
        ? h('ul', { class: 'ach-list' }, ...st.achievements.map((id) => h('li', { class: summary.newAchievements.includes(id) ? 'new' : '' }, h('strong', { text: c.achievements[id].name }), ` — ${c.achievements[id].desc}`, summary.newAchievements.includes(id) ? h('span', { class: 'chip gold', text: `새 업적 · 특성 포인트 +${c.achievements[id].points}` }) : null)))
        : h('p', { class: 'muted', text: '이번 생에서 이룬 업적은 없다.' }),
      summary.pointsGained > 0 ? h('p', { class: 'best', text: `다음 생의 특성 포인트 +${summary.pointsGained} (누적 +${bonusPoints(c, G.meta)})` }) : null,
      h('div', { class: 'menu row' }, button('다음 생으로', () => showBirth(), 'primary'), button('장면 갤러리', showGallery), button('타이틀로', showTitle, 'ghost')),
    ),
  ));
  G.state = null;
}

// ---------- 갤러리·업적·모드·설정 ----------

function showGallery() {
  G.screen = 'gallery';
  const c = G.content;
  const scenes = Object.values(c.scenes);
  const stageOrder = ['child', 'teen', 'adult', 'elder'];
  scenes.sort((a, b) => stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage));
  const owned = G.meta.gallery;
  mount(app, h('div', { class: 'page-screen' },
    h('header', { class: 'screen-head' }, h('h2', { text: `장면 갤러리 ${Object.keys(owned).filter((k) => c.scenes[k]).length}/${scenes.length}` }), h('p', { text: '판을 넘어 영구히 쌓이는 장면. 실패 장면도 수집 대상이다.' })),
    h('div', { class: 'gallery-grid' }, ...scenes.map((sc) => {
      const got = owned[sc.id];
      const imgs = got?.image ? { [sc.id]: got.image } : {};
      return h('figure', { class: `gallery-item ${got ? '' : 'locked'}` },
        sceneFigure(c, sc.id, imgs, { locked: !got }),
        h('figcaption', {}, h('strong', { text: got ? sc.title : '???' }), got ? h('span', { text: sc.caption }) : null, sc.failure && got ? h('span', { class: 'chip bad', text: '실패 장면' }) : null, got?.lastRun ? h('span', { class: 'muted', text: `마지막: ${got.lastRun}` }) : null));
    })),
    h('div', { class: 'menu row' }, button('돌아가기', showTitle)),
  ));
}

function showAchievements() {
  G.screen = 'achievements';
  const c = G.content;
  mount(app, h('div', { class: 'page-screen' },
    h('header', { class: 'screen-head' }, h('h2', { text: '업적' }), h('p', { text: `업적 포인트는 다음 판 특성 포인트로 이월된다. 현재 +${bonusPoints(c, G.meta)} (상한 +${c.config.maxBonusPoints})` })),
    h('ul', { class: 'ach-list big' }, ...Object.values(c.achievements).map((a) => {
      const got = G.meta.achievements[a.id];
      return h('li', { class: got ? 'got' : '' }, h('span', { class: 'ach-mark', text: got ? '★' : '☆' }), h('strong', { text: a.name }), h('span', { text: ` — ${a.desc}` }), h('span', { class: 'chip', text: `+${a.points}` }));
    })),
    h('h3', { text: '최근 생' }),
    h('ol', { class: 'history' }, ...G.meta.history.slice(0, 10).map((r) => h('li', { text: `${r.name} · ${c.races[r.race]?.name ?? r.race} · ${r.career ? c.careers[r.career]?.name ?? r.career : '무직'} · ${r.age}세 · ${formatGold(r.gold)}${r.official ? '' : ' (무제한)'}` }))),
    h('div', { class: 'menu row' }, button('돌아가기', showTitle)),
  ));
}

function showMods() {
  G.screen = 'mods';
  mount(app, h('div', { class: 'page-screen' },
    h('header', { class: 'screen-head' }, h('h2', { text: '모드팩 검증 보고서' }), h('p', { text: 'mods 폴더의 팩을 읽어 검증한다. 오류가 있는 팩은 통째로 로드하지 않는다. 모드팩에는 JSON·이미지만 넣을 수 있다.' })),
    ...G.report.map((r) => h('section', { class: `panel mod-report ${r.status}` },
      h('h3', { text: `${r.status === 'loaded' ? '✔ 로드됨' : '✖ 거부됨'} — ${r.name} (${r.id}@${r.version})` }),
      Object.keys(r.counts || {}).length ? h('p', { class: 'muted', text: Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(' · ') }) : null,
      r.errors.length ? h('ul', { class: 'error-text' }, ...r.errors.slice(0, 50).map((e) => h('li', { text: e })), r.errors.length > 50 ? h('li', { text: `…외 ${r.errors.length - 50}개` }) : null) : null,
      r.warnings.length ? h('ul', { class: 'warn-text' }, ...r.warnings.map((w) => h('li', { text: w }))) : null,
    )),
    G.fatal.length ? h('section', { class: 'panel error-panel' }, ...G.fatal.map((f) => h('p', { text: f }))) : null,
    h('div', { class: 'menu row' },
      button('다시 읽기', async () => { await reloadServerMods(); await loadContent(); showMods(); }),
      button('돌아가기', showTitle),
    ),
  ));
}

function showSettings() {
  G.screen = 'settings';
  const s = G.settings;
  const gen = s.generator;
  const status = h('span', { class: 'muted', text: '' });
  const check = async () => {
    status.textContent = '확인 중…';
    await saveSettings();
    const st = await generatorStatus();
    status.textContent = !st.enabled ? '꺼져 있음' : st.reachable ? '연결됨' : `연결 안 됨${st.reason ? ` (${st.reason})` : ''}`;
  };
  const field = (label, input, note) => h('label', { class: 'field' }, h('span', { text: label }), input, note ? h('small', { class: 'muted', text: note }) : null);
  const chk = (label, obj, key, note) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(obj[key]), on: { change: (e) => { obj[key] = e.target.checked; saveSettings(); } } }), h('span', { text: label }), note ? h('small', { class: 'muted', text: ` ${note}` }) : null);

  mount(app, h('div', { class: 'page-screen settings' },
    h('header', { class: 'screen-head' }, h('h2', { text: '설정' })),
    h('section', { class: 'panel' },
      h('h3', { text: '한 생의 길이' }),
      field('시간 제한 (게임 시간)', h('select', { on: { change: (e) => { s.timeLimitMin = Number(e.target.value); saveSettings(); } } },
        ...TIME_OPTIONS.map((m) => h('option', { value: m, text: m ? `${m / 60}시간` : '무제한 (기록 비공식)', selected: s.timeLimitMin === m }))),
      '3시간이 정식 경험이다. 새 생부터 적용된다.'),
      field('기본 배속', h('select', { on: { change: (e) => { s.speed = Number(e.target.value); saveSettings(); } } },
        ...SPEEDS.map((sp) => h('option', { value: sp, text: `×${sp}${s.timeLimitMin ? ` (실제 ${Math.round(s.timeLimitMin / sp)}분)` : ''}`, selected: s.speed === sp }))),
      '배속은 모래시계와 주사위 연출 속도를 함께 바꾼다.'),
      chk('유년기 압축을 기본으로', s, 'compressChildhood', '두 번째 생부터 고를 수 있다.'),
    ),
    h('section', { class: 'panel' },
      h('h3', { text: '장면 이미지 생성 (로컬 전용)' }),
      h('p', { class: 'muted', text: 'AUTOMATIC1111 / Forge WebUI를 --api 옵션으로 켜 두면, 캐릭터를 만든 직후 장면을 미리 그려 캐시에 저장한다. 생성기가 없어도 게임은 끝까지 할 수 있다.' }),
      chk('생성 사용', gen, 'enabled'),
      field('생성기 주소', h('input', { type: 'text', value: gen.url, on: { change: (e) => { gen.url = e.target.value.trim(); saveSettings(); } } }), '이 컴퓨터(127.0.0.1/localhost) 주소만 허용된다.'),
      chk('성인 등급 장면 허용', gen, 'allowAdult', '모드팩의 성인 등급 장면에만 해당. 20세 미만 단계 장면은 이 설정과 무관하게 항상 일반 등급으로만 생성된다.'),
      chk('기준 이미지로 얼굴 고정 (실험적)', gen, 'useReference', 'ControlNet 확장과 IP-Adapter 모델이 필요하다. 성년·노년 장면에만 적용된다.'),
      field('ControlNet 모듈', h('input', { type: 'text', value: gen.cnModule, on: { change: (e) => { gen.cnModule = e.target.value.trim(); saveSettings(); } } })),
      field('ControlNet 모델', h('input', { type: 'text', value: gen.cnModel, placeholder: '예: ip-adapter_sd15 [6a3f6166]', on: { change: (e) => { gen.cnModel = e.target.value.trim(); saveSettings(); } } })),
      h('div', { class: 'row' }, button('연결 확인', check), status),
    ),
    h('section', { class: 'panel' },
      h('h3', { text: '개발' }),
      chk('디버그 뷰 켜기 (게임 중 F9: 왜 이 사건이 안 떴나)', s, 'debug'),
      button('영구 기록 초기화 (업적·갤러리·기록)', async () => {
        if (!confirm('업적, 이월 포인트, 장면 갤러리, 기록이 모두 지워집니다. 계속할까요?')) return;
        G.meta = emptyMeta();
        await saveMeta();
        showSettings();
      }, 'danger'),
    ),
    h('div', { class: 'menu row' }, button('돌아가기', showTitle)),
  ));
}

boot().catch((e) => {
  console.error(e);
  mount(app, h('div', { class: 'panel error-panel' }, h('h2', { text: '시작하지 못했습니다' }), h('p', { text: String(e?.message ?? e) })));
});

