// 서버 API 래퍼. 서버 없이 정적 파일로 열었을 때는 localStorage로 대체한다.

let serverOk = null;

async function probe() {
  if (serverOk !== null) return serverOk;
  try {
    const r = await fetch('/api/store/__probe');
    serverOk = r.ok;
  } catch {
    serverOk = false;
  }
  return serverOk;
}

export const store = {
  async get(key) {
    if (await probe()) {
      const r = await fetch(`/api/store/${key}`);
      return (await r.json()).value;
    }
    try {
      const raw = localStorage.getItem(`taesaeng:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    if (await probe()) {
      await fetch(`/api/store/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
      return;
    }
    try {
      localStorage.setItem(`taesaeng:${key}`, JSON.stringify(value));
    } catch {
      /* 저장 불가 환경: 무시 */
    }
  },
  async remove(key) {
    if (await probe()) {
      await fetch(`/api/store/${key}`, { method: 'DELETE' });
      return;
    }
    try {
      localStorage.removeItem(`taesaeng:${key}`);
    } catch {
      /* 무시 */
    }
  },
};

// 브라우저용 모드팩 reader: JSON은 text → JSON.parse로만 읽는다.
export const httpReader = {
  async listPacks() {
    try {
      const r = await fetch('/api/mods/list');
      if (r.ok) return await r.json();
    } catch {
      /* 정적 호스팅 */
    }
    return [{ id: 'core' }];
  },
  async readJson(packId, rel) {
    const r = await fetch(`/mods/${encodeURIComponent(packId)}/${rel.split('/').map(encodeURIComponent).join('/')}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return JSON.parse(await r.text());
  },
  imageUrl(packId, rel) {
    return `/mods/${encodeURIComponent(packId)}/${rel}`;
  },
};

export async function reloadServerMods() {
  try {
    await fetch('/api/mods/reload', { method: 'POST' });
  } catch {
    /* 무시 */
  }
}

export async function generatorStatus() {
  try {
    const r = await fetch('/api/gen/status');
    return await r.json();
  } catch {
    return { enabled: false, reachable: false };
  }
}

export async function requestScene(body) {
  try {
    const r = await fetch('/api/gen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) {
    return { status: 'error', reasons: [e.message] };
  }
}
