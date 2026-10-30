# ADR-0001: 엔진 선택과 모드 데이터의 신뢰 경계

- 상태: 채택 (2026-10-30)
- 관련: 컨셉 문서 Technical Considerations, Content Rules

## 맥락

엔진은 "모드 로딩 안전성"과 "한글 처리"를 기준으로 고르기로 했다. 모드팩은 외부에서 받은 데이터이며,
"실행 코드 금지"가 구현 중에 조용히 무너질 위험이 있다(Technical Risks).

## 결정

1. **HTML5/JavaScript(ES 모듈) + 의존성 없는 로컬 Node 서버**로 만든다.
   - 한글: 브라우저 텍스트 렌더링과 입력기(IME)를 그대로 쓴다. 폰트는 Windows 기본(맑은 고딕·바탕) 스택.
   - 엔진 로직(`src/shared/`)은 브라우저와 Node 양쪽에서 같은 코드를 돌려 테스트·시뮬레이터·서버 검증이 화면과 어긋나지 않는다.
   - Windows 단독 실행은 지금은 `start.bat`(Node + 기본 브라우저). 단일 .exe 패키징(Electron/Tauri)은 후속 과제다.
2. **모드 데이터는 JSON.parse로만 읽는다.** `eval`, `Function`, 동적 `import()`, `<script>` 주입, 엔진의 리소스 로더/에셋 번들 계열 기능으로 모드 파일을 읽지 않는다.
3. **모드 텍스트는 DOM에 `textContent`로만 넣는다.** `innerHTML`을 쓰지 않는다(`public/js/dom.js`).
4. 모드 폴더에는 `json png jpg jpeg webp txt md`만 허용한다. 다른 확장자가 하나라도 있으면 팩 전체를 거부한다.
   서버는 모드 폴더에서 `json png jpg jpeg webp`만 제공하고, 경로는 모드 폴더 밖으로 나갈 수 없다(`safeJoin`).
5. 페이지 CSP: `script-src 'self'` — 모드 폴더에서 스크립트가 로드될 경로 자체가 없다.
6. 서버는 127.0.0.1에만 바인딩하고, 다른 Origin의 요청은 거부한다.

## 결과

- 장점: 설치할 것이 Node 하나, 빌드 단계 없음, 한글 문제 없음, 모드 경로에 코드 실행 경로가 구조적으로 없음.
- 단점: 단일 .exe가 아니다. 브라우저 탭으로 실행된다.
- 검증: `tests/modpack-safety.test.js`(실행 파일 포함 팩 거부, 경로 탈출 거부), `tests/server.test.js`(확장자·경로·Origin 차단).
