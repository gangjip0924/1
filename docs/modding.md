# 모드팩 만들기

`mods/core`가 그대로 예제다. 새 팩은 `mods/<팩 ID>/`에 만든다. 게임을 켠 상태라면 타이틀 → 모드팩 → "다시 읽기".
명령줄 검증: `npm run validate`.

## 폴더 구조

```
mods/my_pack/
  manifest.json
  data/*.json        # 데이터 파일 (manifest의 data 목록에 적은 것만 읽음)
  images/*.png|jpg|webp   # 선택: 고정 장면 이미지
```

허용 확장자: `json png jpg jpeg webp txt md`. **그 밖의 파일(.js, .exe, .dll, .bat …)이 하나라도 있으면 팩 전체가 거부된다.**

```json
{
  "id": "my_pack",
  "name": "내 모드",
  "version": "1.0.0",
  "author": "나",
  "description": "설명",
  "gameVersion": 1,
  "data": ["data/events.json", "data/scenes.json"]
}
```

`id`는 폴더 이름과 같아야 한다. 데이터 파일은 `{"type": 종류, "items": [...]}` 형식이고, `comment` 필드는 무시된다.

## 데이터 종류

| type | 핵심 필드 |
|---|---|
| `events` | `id, title, ages:[최소,최대], text, choices` / 선택: `weight(기본 10), weightMods, priority, once(기본 true), filler, conditions, years(기본 1), tags` |
| `scenes` | `id, title, caption, stage(child\|teen\|adult\|elder), emotion(passion\|calm\|gold), prompt` / 선택: `failure, rating(general\|adult), image, characters, tags` |
| `characters` | `id, name, age(20 이상), fictional(true), prompt` — 장면에 함께 그려지는 등장인물 |
| `traits` | `id, name, desc, cost(음수면 포인트 회수)` / 선택: `race(전용), exclusive, modifiers, tags` |
| `races` `statuses` `birthplaces` | 출생 변수. `modifiers`, `weight`(출생 확률) |
| `careers` | `id, name, desc, baseIncome, rankMult, stat, statIncome, rankTitles(6개)` |
| `dice` | 주사위 정의 (아래) |
| `achievements` | `id, name, desc, points(0~3)` / 선택: `condition`(생이 끝날 때 판정) |
| `style` `config` | 전체에서 하나만 (core가 정의) |
| `blocklist` | `{id, names:[…]}` 생성 프롬프트에서 거를 실존 인물 이름 |

ID 규칙: 소문자로 시작, `a-z 0-9 _`, 48자 이내. **다른 팩과 ID가 겹치면 거부된다**(팩 간 덮어쓰기는 아직 없음).
다른 팩(core 포함)의 ID는 참조할 수 있다.

## 이벤트

```json
{
  "id": "my_bandit", "title": "산적의 길목", "ages": [20, 45],
  "conditions": { "not": { "career": "merchant" } },
  "weightMods": [{ "if": { "trait": "coward" }, "mul": 2 }],
  "text": [
    { "text": "고갯길에서 산적들이 길을 막는다." },
    { "if": { "trait": "fearless" }, "text": " 당신은 오히려 반갑다." }
  ],
  "choices": [
    {
      "text": "칼을 뽑는다",
      "check": { "dice": "d20", "stat": "str", "dc": 13, "tags": ["danger"] },
      "outcomes": {
        "success": { "text": "산적들이 달아났다.", "effects": [{ "gold": 60 }] },
        "fail": { "text": "지갑을 털렸다.", "effects": [{ "goldPct": -20 }, { "scene": "s_ruin" }] }
      }
    },
    {
      "text": "통행료를 낸다 (30G)", "showLocked": true, "hint": "금화 30G 이상 필요",
      "conditions": { "cmp": ["gold", ">=", 30] },
      "outcome": { "text": "돈으로 길을 샀다.", "effects": [{ "gold": -30 }] }
    }
  ]
}
```

- 판정이 있는 선택지는 `outcomes`(등급별), 없는 선택지는 `outcome`. `success`와 `fail`은 필수.
  빠진 등급은 대체된다: 대성공→성공, 부분 성공→성공, 대실패→실패.
- 선택지 `conditions`가 거짓이면 숨겨진다. `showLocked: true`면 잠긴 채로 보인다.
- `priority`가 높은 사건이 먼저 나온다. `filler: true`는 다른 사건이 하나도 없을 때만 나온다.
- 치환자: `{name} {race} {status} {birthplace} {career} {gold} {age}`.
- 조건·효과 문법은 닫혀 있다 — [ADR-0002](adr/0002-condition-effect-grammar.md) 표 참조.
- 판정 `tags`는 특성 보너스와 연결된다(core 기준: `danger trade study social career magic disease craft gamble fate`).

## 주사위 정의

```json
{ "id": "d20", "name": "운명의 이십면체", "count": 1, "sides": 20, "mode": "over", "statMultiplier": 1,
  "tiers": [ {"tier":"crit_success","natural":"max"}, {"tier":"crit_fail","natural":"min"},
             {"tier":"success","marginGte":0}, {"tier":"fail"} ] }
```

- `mode: over` — 합계 = 눈 + 능력치×배수 + 보너스, 차이 = 합계 − 난이도.
- `mode: under` — 목표 = 난이도 + 능력치×배수 + 보너스, 차이 = 목표 − 눈.
- 등급 규칙은 위에서부터 첫 번째로 맞는 것. 조건: `natural(max|min)`, `marginGte`, `rollLte`, `rollGte`. 마지막 규칙은 조건 없는 기본값.
- `count` 1~3, `sides` 4/6/8/10/12/20/100.

## 수정치 (modifiers)

`{"type":"stat","stat":"int","value":1}` · `{"type":"health","value":2}` · `{"type":"check","value":2, "dice"?, "stat"?, "tag"?}` ·
`{"type":"livingCost","value":40}`(%) · `{"type":"income","value":10, "career"?}`(%) · `{"type":"gold","value":50}`(시작 금화)

## 장면과 이미지 — 스타일 락

- 해상도·비율은 스타일 락으로 고정된다: **768×576 (4:3)**. 고정 이미지(`image`)도 4:3으로 넣는다.
- 생성 프롬프트 앞에는 항상 스타일 락 접두사가 붙는다:
  `illuminated storybook illustration, hand-painted watercolor and ink, warm sepia parchment texture, thin gilded border, fantasy medieval world, soft painterly lighting`
- 장면의 `prompt`에는 상황·장소·자세만 영어 태그로 쓴다. 주인공의 종족·나이·외형은 게임이 붙인다.
- 감정 포인트 색: `passion`(붉은 계열, 열정·위험), `calm`(청록, 평온), `gold`(금색, 성취).
- `stage`는 장면 속 주인공의 인생 단계다. **child·teen 장면은 일반 등급만 가능하고, 성적·노출 표현이 들어가면 팩이 거부된다.**
- **등장인물(`characters`)은 모두 가상 인물이며 20세 이상이어야 한다.** 실존 인물을 묘사하는 프롬프트는 거부된다.
- NTR·"미시" 유형 태그와 표현은 어디에도 쓸 수 없다.
- 이미지 우선순위: 이번 캐릭터의 생성 이미지 → 팩의 고정 이미지 → 기본 삽화.
