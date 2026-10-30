# ADR-0002: 이벤트 조건·효과 문법은 닫힌 집합이다

- 상태: 채택 (2026-10-30)

## 맥락

조건 문법이 점점 스크립트 언어로 변질될 위험이 있다(Technical Risks). 동시에 시작 빌드가 평생 반응해야 하므로(Pillar 1)
특성·신분·플래그에 반응하는 조건은 충분히 표현력이 있어야 한다.

## 결정

조건(`src/shared/conditions.js`):

| 형태 | 의미 |
|---|---|
| `{"all":[…]}` `{"any":[…]}` `{"not":{…}}` | and / or / not |
| `{"cmp":["gold", ">=", 100]}` | 변수 비교. 변수는 `age gold health rep rank aptitude critFails critSuccesses sceneCount str dex int cha mag`만 |
| `{"trait":"lucky"}` | 특성 보유 |
| `{"race":"elf"}` `{"status":…}` `{"birthplace":…}` `{"career":…\|"none"}` | 일치 (문자열 또는 배열) |
| `{"flag":"rival"}` `{"flag":"debt","op":">=","value":2}` | 플래그 |
| `{"seen":"e_id"}` `{"scene":"s_id"}` | 이번 생에서 겪은 사건 / 해금한 장면 |

효과(`src/shared/effects.js`): `gold goldPct stat health rep flag career rank trait scene achievement queue years death` 14종.

- 모르는 키·연산자·변수는 **검증 오류**다. 모드팩은 문법을 확장할 수 없다.
- 크기 제한: 중첩 깊이 6, 조건 노드 40개. 산술식·변수 대입·반복·함수 호출은 없다.
- 조건부 서술은 문장 조각 `[{"text":…, "if":조건}]`과 조건부 선택지로 처리한다 → 조합 × 특성 반응의 이벤트 작성량 폭발을 공통 이벤트 안에서 흡수한다.
- 무작위성은 조건에 넣지 않는다(디버그 뷰가 결정적으로 설명할 수 있도록). 확률은 이벤트 가중치(`weight`, `weightMods`)와 주사위로만 다룬다.

## 문법을 넓혀야 할 때

새 형태가 필요하면 이 ADR을 고치고, `evalCondition`·`validateCondition`·`explainCondition`(또는 효과 쪽 3곳)과 테스트를 함께 고친다.
"작은 식 언어"를 넣자는 제안은 이 ADR을 대체하는 새 ADR로만 받는다.
