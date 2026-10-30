// 모드팩 검증 보고서를 출력한다: node tools/validate-mods.js [mods 폴더]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from '../src/shared/modloader.js';
import { fsReader } from '../src/fsreader.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modsDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'mods');
const { content, report, fatal } = await loadPacks(fsReader(modsDir));
let bad = false;
for (const r of report) {
  console.log(`\n[${r.status === 'loaded' ? '로드됨' : '거부됨'}] ${r.name} (${r.id}@${r.version})`);
  if (Object.keys(r.counts).length) console.log('  ' + Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', '));
  for (const e of r.errors) console.log(`  오류: ${e}`);
  for (const w of r.warnings) console.log(`  경고: ${w}`);
  if (r.status !== 'loaded') bad = true;
}
for (const f of fatal) console.log(`\n치명적: ${f}`);
console.log(`\n이벤트 ${Object.keys(content.events).length}개, 장면 ${Object.keys(content.scenes).length}개`);
process.exit(bad || fatal.length ? 1 : 0);
