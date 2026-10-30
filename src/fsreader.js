// Node(서버·도구)용 모드팩 reader. 모드 폴더 밖으로 나가는 경로는 거부한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PACK_ID_RE } from './shared/validate.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;

export function safeJoin(root, ...parts) {
  const p = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  if (p !== rootResolved && !p.startsWith(rootResolved + path.sep)) throw new Error('모드 폴더 밖 경로');
  return p;
}

async function walk(dir, base = '') {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) out.push(`${rel} (심볼릭 링크)`);
    else if (ent.isDirectory()) out.push(...(await walk(path.join(dir, ent.name), rel)));
    else out.push(rel);
  }
  return out;
}

export function fsReader(modsDir) {
  return {
    async listPacks() {
      const ents = await fs.readdir(modsDir, { withFileTypes: true });
      const packs = [];
      for (const e of ents) {
        if (!e.isDirectory() || !PACK_ID_RE.test(e.name)) continue;
        packs.push({ id: e.name, files: await walk(path.join(modsDir, e.name)) });
      }
      return packs;
    },
    async readJson(packId, rel) {
      const file = safeJoin(modsDir, packId, rel);
      const stat = await fs.stat(file);
      if (stat.size > MAX_JSON_BYTES) throw new Error('JSON 파일이 2MB를 넘습니다');
      return JSON.parse(await fs.readFile(file, 'utf8'));
    },
    imageUrl(packId, rel) {
      return `/mods/${packId}/${rel}`;
    },
  };
}
