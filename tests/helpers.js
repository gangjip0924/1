import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/shared/modloader.js';
import { fsReader } from '../src/fsreader.js';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function loadCore() {
  const res = await loadPacks(fsReader(path.join(ROOT, 'mods')));
  if (res.fatal.length) throw new Error(res.fatal.join('\n'));
  return res;
}

// core 팩을 임시 mods 폴더에 복사하고, 추가 팩을 만든다.
export async function tempMods(extraPacks = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taesaeng-mods-'));
  await fs.cp(path.join(ROOT, 'mods', 'core'), path.join(dir, 'core'), { recursive: true });
  for (const [id, files] of Object.entries(extraPacks)) {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, id, rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
  return dir;
}

export function packManifest(id, data) {
  return { id, name: id, version: '1.0.0', gameVersion: 1, data };
}
