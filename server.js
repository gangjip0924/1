// 태생 설계도 로컬 서버 (외부 의존성 없음, Node 18+).
// - 게임 파일과 모드팩 데이터(화이트리스트 확장자만)를 127.0.0.1에서만 제공한다.
// - 세이브·설정을 userdata/에 저장한다.
// - 장면 이미지를 로컬 생성기(AUTOMATIC1111/Forge 호환 API)로 만들고 캐시한다.
//   생성 요청의 프롬프트는 서버가 모드 데이터로 직접 조립하고 안전 규칙을 다시 검사한다.

import http from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPacks } from './src/shared/modloader.js';
import { buildScenePrompt, portraitScene } from './src/shared/prompt.js';
import { fsReader, safeJoin } from './src/fsreader.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 41234);
const HOST = '127.0.0.1';
const DIRS = {
  public: path.join(ROOT, 'public'),
  shared: path.join(ROOT, 'src', 'shared'),
  mods: path.join(ROOT, 'mods'),
  userdata: process.env.TAESAENG_USERDATA ? path.resolve(process.env.TAESAENG_USERDATA) : path.join(ROOT, 'userdata'),
};
DIRS.store = path.join(DIRS.userdata, 'store');
DIRS.cache = path.join(DIRS.userdata, 'cache');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const MOD_SERVE_EXT = ['.json', '.png', '.jpg', '.jpeg', '.webp'];
const STORE_KEY_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_BODY = 256 * 1024;
const CSP = "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

let content = null;
let activePort = PORT;
let modReport = [];

async function reloadContent() {
  const res = await loadPacks(fsReader(DIRS.mods));
  content = res.content;
  modReport = res.report;
  if (res.fatal.length) console.warn('[mods] 치명적 문제:', res.fatal.join(' / '));
  for (const r of res.report) console.log(`[mods] ${r.status === 'loaded' ? '로드' : '거부'} ${r.id}@${r.version}${r.errors.length ? ` (오류 ${r.errors.length})` : ''}`);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });

async function sendFile(res, file) {
  try {
    const data = await fs.readFile(file);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  } catch {
    send(res, 404, 'not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('요청이 너무 큽니다'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readStore(key) {
  try {
    return JSON.parse(await fs.readFile(path.join(DIRS.store, `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function writeStore(key, value) {
  await fs.mkdir(DIRS.store, { recursive: true });
  const file = path.join(DIRS.store, `${key}.json`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
  await fs.rename(`${file}.tmp`, file);
}

// ---------- 이미지 생성 ----------

const DEFAULT_GEN = { enabled: false, url: 'http://127.0.0.1:7860', allowAdult: false, useReference: false, cnModule: 'ip-adapter_clip_sd15', cnModel: '', cnWeight: 0.6 };

async function genSettings() {
  const s = (await readStore('settings')) ?? {};
  return { ...DEFAULT_GEN, ...(s.generator ?? {}) };
}

// "생성은 로컬에서만" — 생성기 주소는 이 컴퓨터(루프백)만 허용한다.
export function isLoopbackUrl(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

let genChain = Promise.resolve();
function enqueue(task) {
  const p = genChain.then(task, task);
  genChain = p.catch(() => {});
  return p;
}

async function callGenerator(settings, request, timeoutMs = 10 * 60 * 1000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(new URL('/sdapi/v1/txt2img', settings.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`생성기 응답 ${r.status}`);
    const j = await r.json();
    const b64 = j.images?.[0];
    if (typeof b64 !== 'string') throw new Error('생성기 응답에 이미지가 없습니다');
    const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG가 아닌 응답');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function cacheKey(built) {
  return crypto.createHash('sha256').update(JSON.stringify({ r: built.request, v: built.styleVersion })).digest('hex').slice(0, 40);
}

async function generate(body) {
  if (!content?.style) return { status: 'error', reasons: ['콘텐츠가 로드되지 않았습니다'] };
  const settings = await genSettings();
  const char = body.char ?? {};
  const charSpec = { race: String(char.race ?? ''), appearance: char.appearance ?? {}, seed: Number(char.seed) >>> 0 };
  let scene;
  if (body.portrait) scene = portraitScene(content);
  else {
    scene = content.scenes[body.sceneId];
    if (!scene) return { status: 'error', reasons: [`알 수 없는 장면 ${body.sceneId}`] };
  }
  const built = buildScenePrompt(content, scene, charSpec, { allowAdult: settings.allowAdult });
  if (!built.ok) return { status: 'refused', reasons: built.reasons };
  const key = cacheKey(built);
  const file = path.join(DIRS.cache, `${key}.png`);
  const url = `/cache/${key}.png`;
  if (fssync.existsSync(file)) return { status: 'cached', url };
  if (body.peek) return { status: 'missing' };
  if (!settings.enabled) return { status: 'disabled' };
  if (!isLoopbackUrl(settings.url)) return { status: 'refused', reasons: ['생성기 주소는 이 컴퓨터(127.0.0.1/localhost)만 허용됩니다'] };

  return enqueue(async () => {
    if (fssync.existsSync(file)) return { status: 'cached', url };
    const request = { ...built.request };
    // 기준 이미지(얼굴 고정): 성인·노년 단계에서만, 설정에서 켰을 때만. ControlNet 확장 필요(실험적).
    if (settings.useReference && !body.portrait && (built.stage === 'adult' || built.stage === 'elder') && settings.cnModel) {
      const ref = await generate({ portrait: true, char });
      if (ref.status === 'cached' || ref.status === 'generated') {
        const img = await fs.readFile(path.join(DIRS.cache, path.basename(ref.url)));
        request.alwayson_scripts = {
          controlnet: { args: [{ image: img.toString('base64'), module: settings.cnModule, model: settings.cnModel, weight: settings.cnWeight }] },
        };
      }
    }
    try {
      const png = await callGenerator(settings, request);
      await fs.mkdir(DIRS.cache, { recursive: true });
      await fs.writeFile(file, png);
      return { status: 'generated', url };
    } catch (e) {
      return { status: 'error', reasons: [e.name === 'AbortError' ? '생성 시간 초과' : e.message] };
    }
  });
}

async function generatorStatus() {
  const s = await genSettings();
  if (!s.enabled) return { enabled: false, reachable: false };
  if (!isLoopbackUrl(s.url)) return { enabled: true, reachable: false, reason: '루프백 주소가 아님' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(new URL('/sdapi/v1/options', s.url), { signal: ctrl.signal });
    clearTimeout(t);
    return { enabled: true, reachable: r.ok };
  } catch (e) {
    return { enabled: true, reachable: false, reason: e.message };
  }
}

// ---------- 라우팅 ----------

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = decodeURIComponent(url.pathname);
  // 다른 사이트가 브라우저를 통해 로컬 API를 부르지 못하게 Origin을 확인한다.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${activePort}` && origin !== `http://localhost:${activePort}`) return send(res, 403, 'forbidden origin');

  if (p === '/api/mods/list' && req.method === 'GET') {
    const packs = await fsReader(DIRS.mods).listPacks();
    return sendJson(res, 200, packs);
  }
  if (p === '/api/mods/reload' && req.method === 'POST') {
    await reloadContent();
    return sendJson(res, 200, { report: modReport });
  }
  if (p.startsWith('/api/store/')) {
    const key = p.slice('/api/store/'.length);
    if (!STORE_KEY_RE.test(key)) return sendJson(res, 400, { error: 'bad key' });
    if (req.method === 'GET') return sendJson(res, 200, { value: await readStore(key) });
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      await writeStore(key, body.value ?? null);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      await fs.rm(path.join(DIRS.store, `${key}.json`), { force: true });
      return sendJson(res, 200, { ok: true });
    }
  }
  if (p === '/api/gen/status' && req.method === 'GET') return sendJson(res, 200, await generatorStatus());
  if (p === '/api/gen' && req.method === 'POST') return sendJson(res, 200, await generate(JSON.parse(await readBody(req))));

  if (req.method !== 'GET') return send(res, 405, 'method not allowed');
  if (p.startsWith('/cache/')) {
    const name = p.slice('/cache/'.length);
    if (!/^[0-9a-f]{40}\.png$/.test(name)) return send(res, 404, 'not found');
    return sendFile(res, path.join(DIRS.cache, name));
  }
  if (p.startsWith('/mods/')) {
    if (!MOD_SERVE_EXT.includes(path.extname(p).toLowerCase())) return send(res, 403, 'forbidden type');
    try {
      return sendFile(res, safeJoin(DIRS.mods, p.slice('/mods/'.length)));
    } catch {
      return send(res, 403, 'forbidden path');
    }
  }
  if (p.startsWith('/shared/')) {
    try {
      return sendFile(res, safeJoin(DIRS.shared, p.slice('/shared/'.length)));
    } catch {
      return send(res, 403, 'forbidden path');
    }
  }
  try {
    return sendFile(res, safeJoin(DIRS.public, p === '/' ? 'index.html' : p.slice(1)));
  } catch {
    return send(res, 403, 'forbidden path');
  }
}

export async function startServer(port = PORT) {
  activePort = port;
  await reloadContent();
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  });
  await new Promise((resolve) => server.listen(port, HOST, resolve));
  activePort = server.address().port;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log(`\n태생 설계도 — http://${HOST}:${PORT} 에서 실행 중 (종료: Ctrl+C)`);
}
