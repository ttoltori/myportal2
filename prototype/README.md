# myportal 프로토타입

`docs/디자인컨셉.md`(신문 조판 · 텔렉스 · 교정펜 컨셉)을 따르는 정적 HTML 프로토타입이다.
백엔드 없이 화면 흐름과 정보 밀도를 검증하기 위한 목업이며, 데이터는 `assets/mock-data.js`에 정의된
가짜 데이터(AI/로봇/IT 뉴스, 정부·기관 사업공고)를 사용한다.

## 여는 방법

빌드나 서버 없이 `index.html`을 브라우저에서 더블클릭하면 바로 열린다 (`file://` 환경 지원).

- Tailwind CSS는 Play CDN(`cdn.tailwindcss.com`)을 사용하므로 첫 로드 시 인터넷 연결이 필요하다.
- Google Fonts(Noto Serif KR, IBM Plex Sans KR, IBM Plex Mono)도 CDN에서 불러온다.
- 순수 vanilla JS + classic `<script src>`만 사용하며 ES 모듈이나 로컬 `fetch()`는 쓰지 않는다
  (`file://`에서도 깨지지 않도록 하기 위함).

로컬 HTTP 서버로 열어서 확인하고 싶다면(선택 사항):

```bash
cd prototype
python -m http.server 4173
# http://localhost:4173/index.html
```

## 화면 목록

| 파일 | 화면 | 상태 |
|---|---|---|
| `login.html` | UI-01 로그인 (구독 신청서 콘셉트, 매직링크 안내) | 완료 |
| `index.html` | UI-02 메인 데스크 (3단 레이아웃, 키보드 조작, 키워드 강조, 이야기 묶음, 마감 임박) | 완료 |
| `add-source.html` | UI-03 소스 등록 (URL 입력, 분석 전보 로그, 추출 미리보기 편집, 상세 페이지 부모 후보 데모) | 완료 |
| `sources.html` | UI-04 소스 목록 (상태·수집 방식 필터, 다중 선택 일괄 작업) | 완료 |
| `source-detail.html` | UI-05 소스 상세 (필드 메타, 명세 버전 이력, 수집 로그, 지금 수집/재생성) | 완료 |
| `categories.html` | UI-06 카테고리·태그 정리 (트리 드래그 이동, 병합/삭제 대화상자, 태그 관리) | 완료 |
| `schema-map.html` | UI-07 구조 조망 | 완료 |
| `keywords.html` | UI-08 키워드 규칙 (규칙 목록/편집기, 최근 7일 매칭 미리보기) | 완료 |
| `digest.html` | UI-09 다이제스트 설정 (발송 설정, 신문 1면형 이메일 미리보기) | 완료 |

`assets/shell.js`의 상단 네비게이션은 위 7개 화면을 모두 가리킨다. 아직 만들어지지 않은 화면의
링크를 누르면 404가 뜨는 것이 정상이다 (다른 작업에서 해당 파일을 만들면 바로 연결된다).

## 공용 자산 (`assets/`)

| 파일 | 역할 |
|---|---|
| `tokens.css` | 색상 변수(라이트/다크), 폰트, 공통 컴포넌트 클래스(`.btn`, `.stamp`, `.dday`, `.kw-mark`, `.row-new` 등) |
| `tailwind-config.js` | Tailwind Play CDN 설정 (색상 토큰 → CSS 변수 매핑, 폰트, 반경 0) |
| `mock-data.js` | `window.MOCK` 목업 데이터 (카테고리, 태그, 소스, 항목, 키워드 규칙, 이야기 묶음) |
| `shell.js` | 공통 머리띠(마스트헤드) 렌더링, 테마 토글, 토스트/되돌리기 띠 |
| `resizable.js` | 다단(멀티 패널) 화면의 분할선(splitter) 드래그 리사이즈 유틸리티 (`window.MyPortalResizable`) |

### 패널 리사이즈

2~3단으로 나뉜 화면(`index.html`, `add-source.html`, `categories.html`, `keywords.html`,
`digest.html`)은 패널 사이 경계선을 드래그해 너비를 조절할 수 있다.

- 드래그: 경계선(분할선)을 좌우로 끌면 인접한 고정폭 패널의 너비가 바뀐다.
- 더블클릭: 분할선을 더블클릭하면 해당 패널이 기본 너비로 되돌아간다.
- 키보드: 분할선에 포커스를 준 뒤 `←`/`→` 로 16px 단위로 조절할 수 있다.
- 조절한 너비는 화면별로 `localStorage`에 저장되어 다음 방문 때도 유지된다.
- 화면이 좁아져 1단으로 접히거나(키워드/다이제스트) 우측 패널이 서랍으로
  바뀌는(메인 데스크) 구간에서는 분할선이 자동으로 숨는다.
- `assets/resizable.js`가 로드되지 않아도(예: 스크립트 차단) 각 화면은
  CSS 변수의 기본값으로 기존 정적 레이아웃과 동일하게 렌더링된다.

새 화면을 추가할 때는 다음 순서로 `<head>`/`<body>` 하단에 스크립트를 넣으면 된다.

```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="./assets/tailwind-config.js"></script>
<link rel="stylesheet" href="./assets/tokens.css" />
...
<body data-active-page="sources">
  <header id="masthead" style="height: 44px;"></header>
  ...
  <script src="./assets/mock-data.js"></script>
  <script src="./assets/shell.js"></script>
  <script> /* 화면 전용 로직 */ </script>
</body>
```

`data-active-page` 값은 `index | add-source | sources | categories | schema-map | keywords | digest` 중
하나를 써야 해당 nav 링크가 강조된다.

## 디자인 규칙 요약

- 모서리 반경 0, 그림자 없음, 카드 없음, 그라데이션 없음, 이모지 없음.
- 구획은 1px `--rule` 괘선으로, 섹션 머리 아래는 이중 괘선(`.rule-double`).
- 빨강(`--red`)은 새것, 호박색(`--amber`)은 키워드 강조, 파랑(`--blue`)은 현재 선택.
- 자세한 원칙은 `../docs/디자인컨셉.md`, `../DESIGN.md` 참고.
