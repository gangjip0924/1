// 이벤트 조건 문법 (ADR-0002). 닫힌 집합만 허용한다 — 새 연산자를 추가하려면
// 이 파일과 validateCondition을 함께 고쳐야 하며, 모드팩이 확장할 수는 없다.
//
//   {"all":[...]}  {"any":[...]}  {"not":{...}}
//   {"cmp":["gold", ">=", 100]}        변수 비교 (변수는 VARS 목록만)
//   {"trait":"lucky"}                  특성 보유
//   {"race":"elf"} / {"race":["elf","dwarf"]}
//   {"status":"noble"} {"birthplace":"port"} {"career":"merchant"|"none"}
//   {"flag":"rival"}                   플래그가 참(0, false, 없음이 아님)
//   {"flag":"debt","op":">=","value":2}
//   {"seen":"e_birth"}                 이번 생에서 이벤트를 겪었는가
//   {"scene":"s_cradle"}               이번 생에서 장면을 해금했는가

import { isObj } from './util.js';

export const STAT_IDS = ['str', 'dex', 'int', 'cha', 'mag'];
export const VARS = ['age', 'gold', 'health', 'rep', 'rank', 'aptitude', 'critFails', 'critSuccesses', 'sceneCount', ...STAT_IDS];
export const OPS = ['==', '!=', '>', '>=', '<', '<='];
const MATCH_KEYS = ['race', 'status', 'birthplace', 'career'];
export const MAX_DEPTH = 6;
export const MAX_NODES = 40;

export function readVar(state, name) {
  if (STAT_IDS.includes(name)) return state.stats[name] ?? 0;
  if (name === 'sceneCount') return state.scenes.length;
  const v = state[name];
  return typeof v === 'number' ? v : 0;
}

function compare(a, op, b) {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    default: return false;
  }
}

function flagValue(state, name) {
  const v = state.flags[name];
  if (v === undefined || v === null || v === false) return 0;
  if (v === true) return 1;
  return v;
}

export function evalCondition(cond, state) {
  if (cond === undefined || cond === null) return true;
  if (cond.all) return cond.all.every((c) => evalCondition(c, state));
  if (cond.any) return cond.any.some((c) => evalCondition(c, state));
  if (cond.not) return !evalCondition(cond.not, state);
  if (cond.cmp) {
    const [name, op, value] = cond.cmp;
    return compare(readVar(state, name), op, value);
  }
  if (cond.trait !== undefined) return state.traits.includes(cond.trait);
  for (const key of MATCH_KEYS) {
    if (cond[key] !== undefined) {
      const actual = state[key] ?? 'none';
      return Array.isArray(cond[key]) ? cond[key].includes(actual) : cond[key] === actual;
    }
  }
  if (cond.flag !== undefined) {
    const v = flagValue(state, cond.flag);
    if (cond.op) return compare(v, cond.op, cond.value);
    return v !== 0;
  }
  if (cond.seen !== undefined) return Boolean(state.seen[cond.seen]);
  if (cond.scene !== undefined) return state.scenes.includes(cond.scene);
  return false;
}

// 디버그 뷰용: 조건이 왜 거짓인지 사람이 읽을 수 있는 문장으로.
export function explainCondition(cond, state) {
  if (evalCondition(cond, state)) return null;
  if (cond.all) {
    const failed = cond.all.map((c) => explainCondition(c, state)).filter(Boolean);
    return failed.join(' 그리고 ');
  }
  if (cond.any) return `다음 중 하나도 충족 안 됨: [${cond.any.map(describeCondition).join(' / ')}]`;
  if (cond.not) return `제외 조건에 걸림: ${describeCondition(cond.not)}`;
  if (cond.cmp) {
    const [name, op, value] = cond.cmp;
    return `${name} ${op} ${value} 필요 (현재 ${readVar(state, name)})`;
  }
  return `${describeCondition(cond)} 필요`;
}

export function describeCondition(cond) {
  if (!cond) return '없음';
  if (cond.all) return cond.all.map(describeCondition).join(' 그리고 ');
  if (cond.any) return `(${cond.any.map(describeCondition).join(' 또는 ')})`;
  if (cond.not) return `아님(${describeCondition(cond.not)})`;
  if (cond.cmp) return cond.cmp.join(' ');
  if (cond.trait !== undefined) return `특성:${cond.trait}`;
  for (const key of MATCH_KEYS) {
    if (cond[key] !== undefined) return `${key}=${[].concat(cond[key]).join('|')}`;
  }
  if (cond.flag !== undefined) return cond.op ? `플래그:${cond.flag} ${cond.op} ${cond.value}` : `플래그:${cond.flag}`;
  if (cond.seen !== undefined) return `겪음:${cond.seen}`;
  if (cond.scene !== undefined) return `장면:${cond.scene}`;
  return '?';
}

// 구조 검증. refs는 {traits, races, statuses, birthplaces, careers, events, scenes}의 Set.
// 참조 검증은 refs가 주어졌을 때만 한다.
export function validateCondition(cond, path, errors, refs, depth = 0, counter = { n: 0 }) {
  const err = (msg) => errors.push(`${path}: ${msg}`);
  if (!isObj(cond)) return err('조건은 객체여야 합니다');
  if (depth > MAX_DEPTH) return err(`조건 중첩이 너무 깊습니다 (최대 ${MAX_DEPTH})`);
  if (++counter.n > MAX_NODES) return err(`조건 노드가 너무 많습니다 (최대 ${MAX_NODES})`);
  const keys = Object.keys(cond);
  const head = keys.find((k) => k !== 'op' && k !== 'value');
  const allowedExtra = head === 'flag' ? ['op', 'value'] : [];
  const extra = keys.filter((k) => k !== head && !allowedExtra.includes(k));
  if (!head) return err('빈 조건');
  if (extra.length) return err(`허용되지 않는 키: ${extra.join(', ')}`);

  const checkRef = (kind, id) => {
    if (refs && refs[kind] && !refs[kind].has(id)) err(`알 수 없는 ${kind} ID "${id}"`);
  };

  switch (head) {
    case 'all':
    case 'any':
      if (!Array.isArray(cond[head]) || cond[head].length === 0) return err(`${head}는 비어 있지 않은 배열이어야 합니다`);
      cond[head].forEach((c, i) => validateCondition(c, `${path}.${head}[${i}]`, errors, refs, depth + 1, counter));
      return;
    case 'not':
      return validateCondition(cond.not, `${path}.not`, errors, refs, depth + 1, counter);
    case 'cmp': {
      const c = cond.cmp;
      if (!Array.isArray(c) || c.length !== 3) return err('cmp는 [변수, 연산자, 숫자] 형식입니다');
      if (!VARS.includes(c[0])) err(`알 수 없는 변수 "${c[0]}" (허용: ${VARS.join(', ')})`);
      if (!OPS.includes(c[1])) err(`알 수 없는 연산자 "${c[1]}"`);
      if (typeof c[2] !== 'number') err('비교 값은 숫자여야 합니다');
      return;
    }
    case 'trait':
      if (typeof cond.trait !== 'string') return err('trait는 문자열 ID입니다');
      return checkRef('traits', cond.trait);
    case 'race':
    case 'status':
    case 'birthplace':
    case 'career': {
      const ids = [].concat(cond[head]);
      if (!ids.length || ids.some((x) => typeof x !== 'string')) return err(`${head}는 ID 문자열 또는 배열입니다`);
      const kind = { race: 'races', status: 'statuses', birthplace: 'birthplaces', career: 'careers' }[head];
      ids.forEach((id) => { if (!(head === 'career' && id === 'none')) checkRef(kind, id); });
      return;
    }
    case 'flag':
      if (typeof cond.flag !== 'string' || !/^[a-z0-9_]{1,40}$/.test(cond.flag)) return err('flag 이름은 소문자/숫자/_ 40자 이내');
      if (cond.op !== undefined && !OPS.includes(cond.op)) err(`알 수 없는 연산자 "${cond.op}"`);
      if (cond.op !== undefined && typeof cond.value !== 'number') err('flag 비교 값은 숫자여야 합니다');
      if (cond.op === undefined && cond.value !== undefined) err('value는 op와 함께 써야 합니다');
      return;
    case 'seen':
      if (typeof cond.seen !== 'string') return err('seen은 이벤트 ID입니다');
      return checkRef('events', cond.seen);
    case 'scene':
      if (typeof cond.scene !== 'string') return err('scene은 장면 ID입니다');
      return checkRef('scenes', cond.scene);
    default:
      return err(`알 수 없는 조건 "${head}" (닫힌 문법 밖)`);
  }
}
