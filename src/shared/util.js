// 브라우저와 Node 양쪽에서 쓰는 작은 유틸리티. 외부 의존성 없음.

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// 세이브에 상태를 저장할 수 있는 시드 RNG (mulberry32).
export class Rng {
  constructor(seed) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  weighted(items, weightOf) {
    const total = items.reduce((s, it) => s + Math.max(0, weightOf(it)), 0);
    if (total <= 0) return null;
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, weightOf(it));
      if (r < 0) return it;
    }
    return items[items.length - 1];
  }
}

export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

// 캐시 키·시드 파생용 문자열 해시 (FNV-1a 32bit). 보안 용도 아님.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function formatGold(n) {
  const v = Math.round(n);
  return `${v.toLocaleString('ko-KR')} G`;
}
