import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const prompts = [];
let mock;
let server;
let base;
let userdata;

before(async () => {
  userdata = await fs.mkdtemp(path.join(os.tmpdir(), 'taesaeng-ud-'));
  process.env.TAESAENG_USERDATA = userdata;
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/sdapi/v1/txt2img') {
        prompts.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ images: [PNG_B64] }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const { startServer } = await import('../server.js');
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  mock?.close();
  await fs.rm(userdata, { recursive: true, force: true });
});

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const put = (key, value) => fetch(`${base}/api/store/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
const char = { race: 'dwarf', appearance: { gender: 'female', hair: 'red', eyes: 'green', skin: 'tan', extra: 'braided hair, scar' }, seed: 1234 };

test('정적 파일·모드 제공: 화이트리스트 밖 확장자와 경로 탈출 차단', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/shared/engine.js`)).status, 200);
  assert.equal((await fetch(`${base}/mods/core/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/mods/..%2f..%2fserver.js`)).status, 403);
  assert.notEqual((await fetch(`${base}/mods/core/%2e%2e/%2e%2e/package.json`)).status, 200);
  assert.equal((await fetch(`${base}/mods/core/data/..%2f..%2f..%2fpackage.json`)).status, 403);
  assert.equal((await fetch(`${base}/api/store/..%2fx`)).status, 400);
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.ok(csp.includes("script-src 'self'"));
});

test('다른 출처(Origin)의 API 호출은 거부', async () => {
  const r = await fetch(`${base}/api/store/meta`, { method: 'PUT', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{"value":1}' });
  assert.equal(r.status, 403);
});

test('생성기가 꺼져 있으면 disabled, 루프백이 아닌 주소는 거부', async () => {
  assert.equal((await post('/api/gen', { sceneId: 's_first_shop', char })).status, 'disabled');
  await put('settings', { generator: { enabled: true, url: 'http://192.168.0.10:7860' } });
  const r = await post('/api/gen', { sceneId: 's_first_shop', char });
  assert.equal(r.status, 'refused');
});

test('사전 생성: 생성 → 캐시 재사용, 20세 미만 장면은 자유 서술 제외·안전 부정 프롬프트', async () => {
  await put('settings', { generator: { enabled: true, url: `http://127.0.0.1:${mock.address().port}` } });
  const status = await (await fetch(`${base}/api/gen/status`)).json();
  assert.equal(status.reachable, true);

  const a = await post('/api/gen', { sceneId: 's_first_shop', char });
  assert.equal(a.status, 'generated');
  const b = await post('/api/gen', { sceneId: 's_first_shop', char });
  assert.equal(b.status, 'cached');
  assert.equal(a.url, b.url);
  assert.equal(prompts.length, 1, '같은 장면은 다시 만들지 않는다');
  const img = await fetch(base + a.url);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok(prompts[0].prompt.includes('braided hair'));

  const c = await post('/api/gen', { sceneId: 's_old_mine', char });
  assert.equal(c.status, 'generated');
  const teen = prompts[1];
  assert.ok(!teen.prompt.includes('braided hair'), '20세 미만 단계에는 자유 서술 외형을 쓰지 않는다');
  assert.ok(teen.negative_prompt.includes('nsfw'));
  assert.equal(teen.width, 768);
  assert.equal(teen.height, 576);
});

test('서버가 프롬프트를 직접 조립하므로 클라이언트가 위험한 외형을 보내도 거부된다', async () => {
  const r = await post('/api/gen', { sceneId: 's_first_shop', char: { ...char, appearance: { ...char.appearance, extra: 'NTR scene' } } });
  assert.equal(r.status, 'refused');
  const r2 = await post('/api/gen', { sceneId: 's_cradle', char: { ...char, appearance: { ...char.appearance, hair: 'lingerie' } } });
  assert.equal(r2.status, 'refused');
});
