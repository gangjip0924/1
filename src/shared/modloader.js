// 모드팩 로더 v1 (ADR-0001). 자체 콘텐츠(core)도 모드팩으로 로드한다.
// 모드 데이터는 JSON.parse로만 읽는다 — eval, import(), 스크립트 태그, 리소스 로더를 쓰지 않는다.
//
// reader 인터페이스 (브라우저: fetch, 서버: fs):
//   listPacks(): Promise<Array<{id, files?: string[]}>>   files는 서버만 제공 (실행 코드 검사용)
//   readJson(packId, relPath): Promise<any>
//   imageUrl(packId, relPath): string

import { validateManifest, validatePack, validateFileList, DATA_TYPES } from './validate.js';

export function emptyContent() {
  const c = { packs: [], config: null, style: null, blocklist: [] };
  for (const t of DATA_TYPES) if (!['config', 'style', 'blocklist'].includes(t)) c[t] = {};
  return c;
}

function mergeInto(content, packId, items, reader) {
  for (const type of DATA_TYPES) {
    for (const { item } of items[type]) {
      const it = { ...item, pack: packId };
      if (type === 'config') content.config = it;
      else if (type === 'style') content.style = it;
      else if (type === 'blocklist') content.blocklist.push(...item.names);
      else {
        if (type === 'scenes' && it.image) it.imageUrl = reader.imageUrl(packId, it.image);
        content[type][it.id] = it;
      }
    }
  }
}

export async function loadPacks(reader) {
  const content = emptyContent();
  const report = [];
  let list;
  try {
    list = await reader.listPacks();
  } catch (e) {
    return { content, report: [{ id: '?', status: 'rejected', errors: [`모드 목록을 읽지 못했습니다: ${e.message}`], warnings: [] }] };
  }
  // 로드 순서: core 먼저, 나머지는 이름순. (다수 팩 로드 순서 조정은 MVP 범위 밖)
  list.sort((a, b) => (a.id === 'core' ? -1 : b.id === 'core' ? 1 : a.id.localeCompare(b.id)));

  for (const entry of list) {
    const r = { id: entry.id, name: entry.id, version: '?', status: 'rejected', errors: [], warnings: [], counts: {} };
    report.push(r);
    if (entry.files) r.errors.push(...validateFileList(entry.files));
    let manifest;
    try {
      manifest = await reader.readJson(entry.id, 'manifest.json');
    } catch (e) {
      r.errors.push(`manifest.json을 읽지 못했습니다: ${e.message}`);
      continue;
    }
    r.errors.push(...validateManifest(manifest, entry.id));
    if (typeof manifest?.name === 'string') r.name = manifest.name;
    if (typeof manifest?.version === 'string') r.version = manifest.version;
    if (r.errors.length) continue;

    const files = [];
    for (const path of manifest.data) {
      try {
        files.push({ path, json: await reader.readJson(entry.id, path) });
      } catch (e) {
        r.errors.push(`${path}: 읽기/JSON 파싱 실패 (${e.message})`);
      }
    }
    if (r.errors.length) continue;

    const res = validatePack({ id: entry.id, files }, content);
    r.errors.push(...res.errors);
    r.warnings.push(...res.warnings);
    for (const t of DATA_TYPES) if (res.items[t].length) r.counts[t] = res.items[t].length;
    if (r.errors.length) continue;

    mergeInto(content, entry.id, res.items, reader);
    content.packs.push({ id: entry.id, version: manifest.version, name: manifest.name });
    r.status = 'loaded';
  }

  const fatal = [];
  if (!content.config) fatal.push('config가 정의되지 않았습니다 (core 팩 확인)');
  if (!content.style) fatal.push('style(스타일 락)이 정의되지 않았습니다 (core 팩 확인)');
  if (!Object.keys(content.races).length) fatal.push('종족이 하나도 없습니다');
  if (!Object.keys(content.statuses).length) fatal.push('신분이 하나도 없습니다');
  if (!Object.keys(content.birthplaces).length) fatal.push('출생지가 하나도 없습니다');
  return { content, report, fatal };
}

// 세이브 호환성 확인용 콘텐츠 지문: 팩 ID@버전 목록.
export function contentSignature(content) {
  return content.packs.map((p) => `${p.id}@${p.version}`).join(',');
}
