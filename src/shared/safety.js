// 콘텐츠 규칙과 이미지 생성 규칙 (컨셉 문서 "Content Rules", "Image Generation Rules").
// 이 규칙은 게임 코드가 강제한다. 모드팩 데이터나 프롬프트 안내로 끌 수 없다.
// 모드팩 로더(validate.js)와 이미지 생성 서버(server.js)가 같은 함수를 쓴다.

// 금지 태그: NTR, "미시" 유형. 비교 전 소문자화하고 공백·하이픈·밑줄을 지운다.
export const FORBIDDEN_TAGS = [
  'ntr', 'netorare', 'netori', 'netorase', 'cuckold', 'cuck', 'infidelity',
  '네토라레', '네토리', '네토라세', '네토', '엔티알', '불륜',
  'milf', 'misi', '미시', '유부녀', 'housewife', 'marriedwoman',
];

// 20세 미만 단계에 금지되는 성적·노출 표현 (프롬프트 전체에서 검사).
export const SEXUAL_TERMS = [
  'nsfw', 'nude', 'nudity', 'naked', 'topless', 'bottomless', 'sex', 'sexy', 'sexual', 'erotic', 'lewd',
  'hentai', 'ecchi', 'porn', 'lingerie', 'underwear', 'panties', 'bra', 'bikini', 'swimsuit', 'cleavage',
  'breasts', 'boobs', 'nipples', 'seductive', 'suggestive', 'provocative', 'fetish', 'bdsm', 'bondage',
  'bedroom eyes', 'aroused', 'kiss', 'kissing', 'romantic', 'lover', 'loli', 'shota', 'skimpy', 'revealing',
  '야한', '노출', '성적', '섹시', '알몸', '나체', '속옷', '수영복', '야릇', '선정', '에로', '유혹',
];

// 실존 인물 표지. 실존 인물 이름 목록은 완전할 수 없으므로 표지 단어와 사용자 차단 목록을 함께 쓴다.
export const REAL_PERSON_MARKERS = [
  'celebrity', 'famous person', 'actress', 'pop idol', 'k-pop', 'kpop', 'real person', 'real life person',
  'photo of', 'lookalike', 'look like', 'looks like', 'resembling', 'in the likeness of', 'politician',
  'youtuber', 'streamer', 'influencer', '실존', '연예인', '아이돌', '여배우', '배우', '닮은', '정치인', '유튜버',
];

export const STAGES = {
  child: { minor: true, label: '유년', prompt: 'small child, innocent, wholesome, modest everyday clothing, fully clothed' },
  teen: { minor: true, label: '소년기', prompt: 'young teenager around 15 years old, wholesome, modest clothing, fully clothed' },
  adult: { minor: false, label: '성년', prompt: 'adult in their thirties' },
  elder: { minor: false, label: '노년', prompt: 'elderly adult in their seventies, grey hair, wrinkles' },
};
export const ADULT_AGE = 20;

// 20세 미만 단계의 생성 요청에는 이 부정 프롬프트가 항상 붙는다.
export const MINOR_NEGATIVE =
  'nsfw, nude, naked, sexual, suggestive, revealing clothes, cleavage, lingerie, swimsuit, underwear, ' +
  'mature body, makeup, adult body, romantic, kissing';

export const BASE_NEGATIVE = 'photo, photorealistic, real person, celebrity, text, watermark, signature';

const norm = (s) => String(s).toLowerCase().replace(/[\s\-_]+/g, '');

export function isForbiddenTag(tag) {
  return FORBIDDEN_TAGS.includes(norm(tag));
}

const isLatin = (t) => /^[\x00-\x7f]+$/.test(t);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 자유 문장에서 용어 목록을 찾는다. 영문은 단어 경계, 한글은 부분 문자열.
export function findTerms(text, terms) {
  const lower = String(text).toLowerCase();
  const hits = [];
  for (const t of terms) {
    const term = t.toLowerCase();
    if (isLatin(term)) {
      if (new RegExp(`(^|[^a-z0-9])${escapeRe(term)}([^a-z0-9]|$)`).test(lower)) hits.push(t);
    } else if (lower.includes(term)) {
      hits.push(t);
    }
  }
  return hits;
}

// 프롬프트용 금지 태그 검사. 한글 "미시"·"네토"는 짧은 부분 문자열이라 오탐이 날 수 있지만
// 프롬프트에서는 안전 쪽으로 거른다.
export function findForbiddenInText(text) {
  return findTerms(text, FORBIDDEN_TAGS);
}

export function findRealPersonMarkers(text, blocklist = []) {
  return [...findTerms(text, REAL_PERSON_MARKERS), ...findTerms(text, blocklist.filter(Boolean))];
}

/**
 * 생성 요청 최종 검사. 통과하지 못하면 생성하지 않는다.
 * @param {{stage:string, rating:string, prompt:string, characters:Array<{age:number,fictional:boolean,id:string}>,
 *          blocklist?:string[], allowAdult?:boolean}} req
 */
export function checkGenerationRequest(req) {
  const reasons = [];
  const stage = STAGES[req.stage];
  if (!stage) reasons.push(`알 수 없는 인생 단계 "${req.stage}"`);
  const forbidden = findForbiddenInText(req.prompt);
  if (forbidden.length) reasons.push(`금지 태그 포함: ${forbidden.join(', ')}`);
  const real = findRealPersonMarkers(req.prompt, req.blocklist);
  if (real.length) reasons.push(`실존 인물 표지 포함: ${real.join(', ')}`);
  for (const c of req.characters || []) {
    if (c.fictional !== true) reasons.push(`등장인물 "${c.id}"가 가상 인물로 표시되지 않음`);
    if (!(typeof c.age === 'number' && c.age >= ADULT_AGE)) reasons.push(`등장인물 "${c.id}"의 나이가 ${ADULT_AGE}세 이상으로 명시되지 않음`);
  }
  if (req.rating !== 'general' && req.rating !== 'adult') reasons.push(`알 수 없는 등급 "${req.rating}"`);
  if (stage && stage.minor) {
    if (req.rating !== 'general') reasons.push('20세 미만 단계 장면은 일반 등급만 허용');
    const sexual = findTerms(req.prompt, SEXUAL_TERMS);
    if (sexual.length) reasons.push(`20세 미만 단계에 금지된 표현: ${sexual.join(', ')}`);
  }
  if (req.rating === 'adult' && !req.allowAdult) reasons.push('성인 등급 장면이 설정에서 꺼져 있음');
  return { ok: reasons.length === 0, reasons };
}
