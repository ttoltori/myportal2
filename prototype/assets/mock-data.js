/*
  myportal 프로토타입 — 목업 데이터
  file:// 환경에서 동작해야 하므로 fetch/모듈을 쓰지 않고 전역 window.MOCK 에 데이터를 싣는다.
  실제 서비스에서는 이 데이터가 DB(myportal 스키마)에서 API로 내려온다 (docs/요건정의서.md §7 참고).

  이 파일이 정의하는 것: 카테고리 트리, 태그, 소스, 항목(뉴스/공고), 키워드 규칙, 이야기 묶음, 기준 시각.
  "안읽음 수 합산", "지난 방문 이후 필터링" 같은 계산은 이 파일에 넣지 않는다 (각 화면 스크립트에서 items를
  기준으로 매번 계산한다 — 실제 앱처럼 상태가 바뀌면 숫자도 같이 바뀌게 하기 위함이다).
*/

(function () {
  'use strict';

  // ---------- 기준 시각 ----------
  // "지금"은 항상 이 시각으로 고정한다 (오늘 아침 수집 직후 시점).
  var NOW = '2026-09-18T07:12:00+09:00';
  // 사용자가 마지막으로 데스크를 떠난 시각. 이 이후 수집된 항목이 "새 글"이다.
  var LAST_VISIT = '2026-09-17T22:10:00+09:00';

  // ---------- 상태/방식 라벨 ----------
  var STATUS_LABEL = { ok: '정상', warn: '주의', fail: '실패', pause: '정지', link: '링크' };
  var STATUS_STAMP_CLASS = { ok: 'stamp-ok', warn: 'stamp-warn', fail: 'stamp-fail', pause: 'stamp-pause', link: 'stamp-link' };
  var FETCH_LABEL = { rss: 'RSS', structured: '구조화', html: '정적 HTML', rendered: '렌더링', link: '링크 전용' };
  var FIELD_TYPE_LABEL = { text: '텍스트', url: 'URL', date: '날짜', datetime: '일시', date_range: '기간', number: '숫자', image: '이미지', tag_list: '태그목록' };
  var RULE_ACTION_LABEL = { emphasize: '강조', alert: '알림', mute: '뮤트' };

  // ---------- 카테고리 트리 ----------
  var categories = [
    { id: 'cat-news', name: '뉴스', parentId: null },
    { id: 'cat-news-ai', name: 'AI 기업', parentId: 'cat-news' },
    { id: 'cat-news-robot', name: '로봇 산업', parentId: 'cat-news' },
    { id: 'cat-news-it', name: '국내 IT', parentId: 'cat-news' },
    { id: 'cat-grant', name: '공고', parentId: null },
    { id: 'cat-grant-rnd', name: '정부 R&D', parentId: 'cat-grant' },
    { id: 'cat-grant-startup', name: '창업지원', parentId: 'cat-grant' },
    { id: 'cat-blog', name: '기술 블로그', parentId: null },
    { id: 'cat-uncat', name: '미분류', parentId: null }
  ];

  // ---------- 태그 ----------
  var tags = [
    { id: 'tag-ai', name: 'AI' },
    { id: 'tag-robot', name: '로봇' },
    { id: 'tag-llm', name: 'LLM' },
    { id: 'tag-rnd', name: 'R&D' },
    { id: 'tag-startup', name: '창업' },
    { id: 'tag-humanoid', name: '휴머노이드' }
  ];

  // ---------- 소스 ----------
  var sources = [
    { id: 's1', name: 'IITP 사업공고', url: 'https://www.iitp.kr/kr/1/notice/list.it', categoryId: 'cat-grant-rnd', tags: ['tag-ai', 'tag-rnd'], fetchStrategy: 'structured', status: 'ok', lastSuccess: '2026-09-18T06:40:00+09:00', new7d: 6, interval: 60,
      fields: [
        { key: 'announce_no', label: '공고번호', type: 'text', role: null },
        { key: 'period', label: '접수기간', type: 'date_range', role: 'deadline' },
        { key: 'dept', label: '담당부서', type: 'text', role: null }
      ] },
    { id: 's2', name: 'K-Startup 공고', url: 'https://www.k-startup.go.kr/notice/list', categoryId: 'cat-grant-startup', tags: ['tag-startup'], fetchStrategy: 'html', status: 'ok', lastSuccess: '2026-09-18T06:10:00+09:00', new7d: 9, interval: 60,
      fields: [
        { key: 'announce_no', label: '공고번호', type: 'text', role: null },
        { key: 'period', label: '접수기간', type: 'date_range', role: 'deadline' },
        { key: 'dept', label: '담당부서', type: 'text', role: null }
      ] },
    { id: 's3', name: '로봇신문', url: 'https://www.irobotnews.com', categoryId: 'cat-news-robot', tags: ['tag-robot'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T07:00:00+09:00', new7d: 14, interval: 30,
      fields: [
        { key: 'reporter', label: '기자', type: 'text', role: null },
        { key: 'section', label: '분야', type: 'text', role: null }
      ] },
    { id: 's4', name: 'AI타임스', url: 'https://www.aitimes.com', categoryId: 'cat-news-ai', tags: ['tag-ai'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T07:05:00+09:00', new7d: 21, interval: 30,
      fields: [
        { key: 'reporter', label: '기자', type: 'text', role: null },
        { key: 'section', label: '분야', type: 'text', role: null }
      ] },
    { id: 's5', name: 'GeekNews', url: 'https://news.hada.io', categoryId: 'cat-news-it', tags: ['tag-ai', 'tag-llm'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T07:08:00+09:00', new7d: 30, interval: 20,
      fields: [
        { key: 'section', label: '분야', type: 'text', role: null },
        { key: 'votes', label: '추천수', type: 'number', role: null }
      ] },
    { id: 's6', name: 'Hugging Face Blog', url: 'https://huggingface.co/blog', categoryId: 'cat-blog', tags: ['tag-ai', 'tag-llm'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T05:30:00+09:00', new7d: 5, interval: 120,
      fields: [
        { key: 'author', label: '저자', type: 'text', role: null },
        { key: 'tags', label: '태그', type: 'tag_list', role: null }
      ] },
    { id: 's7', name: 'The Robot Report', url: 'https://www.therobotreport.com', categoryId: 'cat-news-robot', tags: ['tag-robot', 'tag-humanoid'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T06:50:00+09:00', new7d: 10, interval: 60,
      fields: [
        { key: 'reporter', label: '기자', type: 'text', role: null },
        { key: 'section', label: '분야', type: 'text', role: null }
      ] },
    { id: 's8', name: 'IEEE Spectrum Robotics', url: 'https://spectrum.ieee.org/robotics', categoryId: 'cat-news-robot', tags: ['tag-robot', 'tag-humanoid'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T06:55:00+09:00', new7d: 7, interval: 60,
      fields: [
        { key: 'reporter', label: '기자', type: 'text', role: null },
        { key: 'section', label: '분야', type: 'text', role: null }
      ] },
    { id: 's9', name: 'OpenAI Blog', url: 'https://openai.com/blog', categoryId: 'cat-news-ai', tags: ['tag-ai', 'tag-llm'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T04:20:00+09:00', new7d: 3, interval: 180,
      fields: [
        { key: 'category', label: '분류', type: 'text', role: null }
      ] },
    { id: 's10', name: 'Google AI Blog', url: 'https://ai.googleblog.com', categoryId: 'cat-news-ai', tags: ['tag-ai', 'tag-llm'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T04:10:00+09:00', new7d: 4, interval: 180,
      fields: [
        { key: 'category', label: '분류', type: 'text', role: null }
      ] },
    { id: 's11', name: '전자신문 IT', url: 'https://www.etnews.com/it', categoryId: 'cat-news-it', tags: ['tag-ai'], fetchStrategy: 'html', status: 'ok', lastSuccess: '2026-09-18T06:20:00+09:00', new7d: 18, interval: 30,
      fields: [
        { key: 'reporter', label: '기자', type: 'text', role: null },
        { key: 'section', label: '분야', type: 'text', role: null }
      ] },
    { id: 's12', name: '중소벤처기업부 공고', url: 'https://www.mss.go.kr/site/smba/notice/list.do', categoryId: 'cat-grant-startup', tags: ['tag-startup', 'tag-robot'], fetchStrategy: 'rendered', status: 'warn', lastSuccess: '2026-09-16T09:00:00+09:00', new7d: 2, interval: 60,
      fields: [
        { key: 'announce_no', label: '공고번호', type: 'text', role: null },
        { key: 'period', label: '접수기간', type: 'date_range', role: 'deadline' },
        { key: 'dept', label: '담당부서', type: 'text', role: null }
      ] },
    { id: 's13', name: 'NIPA 사업공고', url: 'https://www.nipa.kr/home/2-2', categoryId: 'cat-grant-rnd', tags: ['tag-ai', 'tag-rnd'], fetchStrategy: 'structured', status: 'ok', lastSuccess: '2026-09-18T06:35:00+09:00', new7d: 5, interval: 60,
      fields: [
        { key: 'announce_no', label: '공고번호', type: 'text', role: null },
        { key: 'period', label: '접수기간', type: 'date_range', role: 'deadline' },
        { key: 'dept', label: '담당부서', type: 'text', role: null }
      ] },
    { id: 's14', name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence', categoryId: 'cat-news-ai', tags: ['tag-ai'], fetchStrategy: 'rss', status: 'warn', lastSuccess: '2026-09-15T11:00:00+09:00', new7d: 1, interval: 60,
      fields: [
        { key: 'author', label: '작성자', type: 'text', role: null }
      ] },
    { id: 's15', name: '한국로봇산업진흥원', url: 'https://www.kiria.org/notice', categoryId: 'cat-grant-rnd', tags: ['tag-robot', 'tag-rnd'], fetchStrategy: 'html', status: 'fail', lastSuccess: '2026-09-10T08:00:00+09:00', new7d: 0, interval: 60,
      fields: [
        { key: 'announce_no', label: '공고번호', type: 'text', role: null },
        { key: 'dept', label: '담당부서', type: 'text', role: null }
      ] },
    { id: 's16', name: 'Anthropic News', url: 'https://www.anthropic.com/news', categoryId: 'cat-news-ai', tags: ['tag-ai', 'tag-llm'], fetchStrategy: 'rss', status: 'ok', lastSuccess: '2026-09-18T03:50:00+09:00', new7d: 2, interval: 180,
      fields: [
        { key: 'category', label: '분류', type: 'text', role: null }
      ] },
    { id: 's17', name: '개인 실험 블로그 (미분류)', url: 'https://example-ai-lab.tistory.com', categoryId: 'cat-uncat', tags: ['tag-llm'], fetchStrategy: 'html', status: 'ok', lastSuccess: '2026-09-17T21:00:00+09:00', new7d: 1, interval: 720,
      fields: [
        { key: 'tags', label: '태그', type: 'tag_list', role: null }
      ] }
  ];

  // ---------- 키워드 규칙 ----------
  var keywordRules = [
    { id: 'kw-humanoid', name: '휴머노이드', keywords: ['휴머노이드'], exclude: [], scope: 'all', scopeId: null, action: 'alert' },
    { id: 'kw-llm-agent', name: 'LLM 에이전트', keywords: ['LLM 에이전트', 'LLM에이전트'], exclude: [], scope: 'all', scopeId: null, action: 'emphasize' },
    { id: 'kw-coin', name: '코인', keywords: ['코인', '암호화폐'], exclude: [], scope: 'all', scopeId: null, action: 'mute' }
  ];

  // ---------- 이야기 묶음 ----------
  var clusters = [
    { id: 'cl-1', representativeItemId: 'i01' }
  ];

  // ---------- 항목 ----------
  var items = [
    // ── 이야기 묶음: 피규어 '헬릭스 02' 공개 (5개 소스) ──
    { id: 'i01', sourceId: 's4', title: '피규어, 신형 휴머노이드 로봇 \'헬릭스 02\' 공개…가정용 배치 목표', url: 'https://www.aitimes.com/news/articleView.html?idxno=190201', publishedAt: '2026-09-18T06:05:00+09:00', collectedAt: '2026-09-18T06:12:00+09:00', excerpt: '피규어AI가 가사노동을 겨냥한 2세대 휴머노이드 로봇 헬릭스 02를 공개했다. 손목 자유도를 늘리고 배터리 지속시간을 개선했다.', fields: { reporter: '김도윤', section: '로봇' }, read: false, starred: true, isBaseline: false, clusterId: 'cl-1', ruleMatch: { ruleId: 'kw-humanoid', action: 'alert' } },
    { id: 'i02', sourceId: 's3', title: '피규어AI \'헬릭스 02\' 공개, 가사노동 겨냥한 두 번째 세대', url: 'https://www.irobotnews.com/news/articleView.html?idxno=88231', publishedAt: '2026-09-18T06:10:00+09:00', collectedAt: '2026-09-18T06:20:00+09:00', excerpt: '전작 대비 관절 자유도가 늘어난 휴머노이드로, 세탁물 개기·식기 정리 등 가정 내 반복 작업을 시연했다.', fields: { reporter: '박서연', section: '해외' }, read: false, starred: false, isBaseline: false, clusterId: 'cl-1', ruleMatch: { ruleId: 'kw-humanoid', action: 'alert' } },
    { id: 'i03', sourceId: 's7', title: 'Figure, 가정용 목표로 신형 휴머노이드 \'헬릭스 02\' 공개', url: 'https://www.therobotreport.com/figure-unveils-helix-02-humanoid', publishedAt: '2026-09-18T06:15:00+09:00', collectedAt: '2026-09-18T06:31:00+09:00', excerpt: 'Figure사가 가정용 배치를 목표로 한 헬릭스 02를 공개했다. 업계는 상업용 대비 훨씬 도전적인 목표라고 평가한다.', fields: { reporter: 'Rachel Kim', section: 'Humanoid' }, read: false, starred: true, isBaseline: false, clusterId: 'cl-1', ruleMatch: { ruleId: 'kw-humanoid', action: 'alert' } },
    { id: 'i04', sourceId: 's8', title: 'IEEE 스펙트럼이 본 \'헬릭스 02\': 가정용 휴머노이드의 승부수', url: 'https://spectrum.ieee.org/figure-helix-02', publishedAt: '2026-09-18T06:20:00+09:00', collectedAt: '2026-09-18T06:45:00+09:00', excerpt: '전문가들은 가정환경의 비정형성이 실제 상용화의 가장 큰 장벽이라고 지적한다.', fields: { reporter: 'Evan Ackerman', section: 'Robotics' }, read: false, starred: false, isBaseline: false, clusterId: 'cl-1', ruleMatch: { ruleId: 'kw-humanoid', action: 'alert' } },
    { id: 'i05', sourceId: 's5', title: '[번역] 피규어, 헬릭스 02 발표…홈 로보틱스 승부수', url: 'https://news.hada.io/topic?id=98213', publishedAt: '2026-09-18T06:40:00+09:00', collectedAt: '2026-09-18T06:58:00+09:00', excerpt: '커뮤니티 반응: "가정용은 아직 멀었다"는 회의론과 "속도가 예상보다 빠르다"는 평가가 엇갈린다.', fields: { section: '번역', votes: 128 }, read: false, starred: false, isBaseline: false, clusterId: 'cl-1', ruleMatch: { ruleId: 'kw-humanoid', action: 'alert' } },

    // ── LLM 에이전트 (강조) ──
    { id: 'i06', sourceId: 's9', title: '새로운 LLM 에이전트 프레임워크로 멀티스텝 작업 자동화', url: 'https://openai.com/blog/agent-framework-multistep', publishedAt: '2026-09-18T05:50:00+09:00', collectedAt: '2026-09-18T06:02:00+09:00', excerpt: '도구 호출과 장기 계획 수립을 결합한 새 프레임워크를 공개했다. 벤치마크에서 기존 대비 완료율이 높다.', fields: { category: 'Product' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-llm-agent', action: 'emphasize' } },
    { id: 'i07', sourceId: 's6', title: '오픈소스 LLM 에이전트 벤치마크 SWE-bench 업데이트', url: 'https://huggingface.co/blog/swe-bench-update', publishedAt: '2026-09-18T05:10:00+09:00', collectedAt: '2026-09-18T05:32:00+09:00', excerpt: '실제 GitHub 이슈 해결 과제를 기준으로 에이전트 성능을 재측정하는 개정판을 공개했다.', fields: { author: 'HF팀', tags: ['LLM', '평가'] }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-llm-agent', action: 'emphasize' } },
    { id: 'i08', sourceId: 's10', title: 'Gemini 기반 LLM 에이전트, 엔터프라이즈 워크플로우 통합', url: 'https://ai.googleblog.com/gemini-enterprise-agent', publishedAt: '2026-09-18T04:40:00+09:00', collectedAt: '2026-09-18T04:58:00+09:00', excerpt: '사내 문서 검색과 티켓 처리를 자동화하는 엔터프라이즈용 에이전트 커넥터를 발표했다.', fields: { category: 'Enterprise' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-llm-agent', action: 'emphasize' } },

    // ── 코인 (뮤트, 정확히 3건) ──
    { id: 'i09', sourceId: 's5', title: '국내 코인 거래소, AI 기반 이상거래 탐지 도입', url: 'https://news.hada.io/topic?id=98220', publishedAt: '2026-09-18T05:20:00+09:00', collectedAt: '2026-09-18T05:41:00+09:00', excerpt: '실시간 이상거래 탐지 모델을 자체 개발해 적용했다고 밝혔다.', fields: { section: '국내', votes: 34 }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-coin', action: 'mute' } },
    { id: 'i10', sourceId: 's11', title: '코인 결제 지원하는 스타트업 결제 SDK 출시', url: 'https://www.etnews.com/it/20260918001', publishedAt: '2026-09-18T04:50:00+09:00', collectedAt: '2026-09-18T05:15:00+09:00', excerpt: '가맹점용 결제 SDK에 암호화폐 결제 옵션을 추가했다.', fields: { reporter: '이하늘', section: '핀테크' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-coin', action: 'mute' } },
    { id: 'i11', sourceId: 's4', title: 'AI 코인 프로젝트 투자 유의보 발령', url: 'https://www.aitimes.com/news/articleView.html?idxno=190189', publishedAt: '2026-09-18T04:30:00+09:00', collectedAt: '2026-09-18T04:55:00+09:00', excerpt: '금융당국이 AI를 내세운 일부 코인 프로젝트에 투자 유의보를 발령했다.', fields: { reporter: '정민아', section: '정책' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-coin', action: 'mute' } },

    // ── 정부 R&D 공고 (마감 임박용) ──
    { id: 'i12', sourceId: 's1', title: '2026년 AI 반도체 첨단 패키징 R&D 지원사업 공고', url: 'https://www.iitp.kr/kr/1/notice/view.it?ArticleIdx=9021', publishedAt: '2026-09-10T09:00:00+09:00', collectedAt: '2026-09-18T06:41:00+09:00', excerpt: 'AI 반도체 첨단 패키징 기술 개발 과제를 공모한다. 총 사업비 120억원 규모.', fields: { announce_no: 'IITP-2026-0912', period: { start: '2026-09-10', end: '2026-09-22' }, dept: 'AI반도체팀' }, read: false, starred: true, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i13', sourceId: 's1', title: '생성형 AI 서비스 실증 지원사업 2차 공고', url: 'https://www.iitp.kr/kr/1/notice/view.it?ArticleIdx=9033', publishedAt: '2026-09-18T06:00:00+09:00', collectedAt: '2026-09-18T06:42:00+09:00', excerpt: '생성형 AI 기반 서비스 실증 과제를 모집한다. 중소·중견기업 우대.', fields: { announce_no: 'IITP-2026-0918', period: { start: '2026-09-18', end: '2026-09-30' }, dept: '디지털서비스팀' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i14', sourceId: 's13', title: '지능형 로봇 실증 기반 구축 지원사업 공고', url: 'https://www.nipa.kr/home/2-2/9102', publishedAt: '2026-09-05T09:00:00+09:00', collectedAt: '2026-09-18T06:36:00+09:00', excerpt: '지능형 로봇 실증 테스트베드 구축 및 운영 기관을 모집한다.', fields: { announce_no: 'NIPA-2026-1102', period: { start: '2026-09-05', end: '2026-09-19' }, dept: '로봇AI팀' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i15', sourceId: 's13', title: 'AI 바우처 지원사업 3차 수요기업 모집', url: 'https://www.nipa.kr/home/2-2/9108', publishedAt: '2026-09-15T09:00:00+09:00', collectedAt: '2026-09-18T06:37:00+09:00', excerpt: 'AI 솔루션 도입을 원하는 수요기업을 대상으로 바우처를 지원한다.', fields: { announce_no: 'NIPA-2026-1108', period: { start: '2026-09-15', end: '2026-09-21' }, dept: 'AI확산팀' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i16', sourceId: 's1', title: '클라우드 기반 AI 학습데이터 플랫폼 고도화 공고', url: 'https://www.iitp.kr/kr/1/notice/view.it?ArticleIdx=8890', publishedAt: '2026-08-20T09:00:00+09:00', collectedAt: '2026-08-21T08:00:00+09:00', excerpt: 'AI 학습데이터 플랫폼의 라벨링 품질 관리 기능을 고도화하는 과제.', fields: { announce_no: 'IITP-2026-0925', period: { start: '2026-08-20', end: '2026-09-05' }, dept: '데이터팀' }, read: true, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },

    // ── 창업지원 공고 ──
    { id: 'i17', sourceId: 's2', title: '예비창업패키지(AI·로봇 특화) 추가 모집 공고', url: 'https://www.k-startup.go.kr/notice/view/3301', publishedAt: '2026-09-16T09:00:00+09:00', collectedAt: '2026-09-18T06:11:00+09:00', excerpt: 'AI·로봇 분야 예비창업자를 대상으로 사업화 자금과 멘토링을 지원한다.', fields: { announce_no: 'KS-2026-3301', period: { start: '2026-09-16', end: '2026-09-23' }, dept: '창업기획팀' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i18', sourceId: 's2', title: '초격차 스타트업 1000+ 프로젝트 8차 모집', url: 'https://www.k-startup.go.kr/notice/view/3312', publishedAt: '2026-09-18T09:00:00+09:00', collectedAt: '2026-09-18T06:12:00+09:00', excerpt: '딥테크 분야 초격차 스타트업을 발굴해 R&D와 후속투자를 연계 지원한다.', fields: { announce_no: 'KS-2026-3312', period: { start: '2026-09-18', end: '2026-10-10' }, dept: '초격차팀' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i19', sourceId: 's2', title: '글로벌 진출 바우처 지원사업 수시 공고', url: 'https://www.k-startup.go.kr/notice/view/3320', publishedAt: '2026-09-12T09:00:00+09:00', collectedAt: '2026-09-18T06:13:00+09:00', excerpt: '해외 진출을 준비하는 스타트업에 통번역·현지화 바우처를 지원한다.', fields: { announce_no: 'KS-2026-3320', period: { start: '2026-09-12', end: '2026-09-19' }, dept: '해외진출팀' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i20', sourceId: 's12', title: '로봇 활용 제조 현장 실증 지원사업 공고', url: 'https://www.mss.go.kr/site/smba/notice/view/450', publishedAt: '2026-09-01T09:00:00+09:00', collectedAt: '2026-09-18T05:00:00+09:00', excerpt: '중소 제조현장에 협동로봇을 도입하는 실증 과제를 지원한다.', fields: { announce_no: 'MSS-2026-0450', period: { start: '2026-09-01', end: '2026-09-18' }, dept: '스마트제조과' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },

    // ── AI 기업 뉴스 ──
    { id: 'i21', sourceId: 's4', title: '네이버, 하이퍼클로바X 차세대 모델 공개 예고', url: 'https://www.aitimes.com/news/articleView.html?idxno=190210', publishedAt: '2026-09-18T03:30:00+09:00', collectedAt: '2026-09-18T03:52:00+09:00', excerpt: '연내 차세대 모델 공개를 예고하며 멀티모달 성능을 강조했다.', fields: { reporter: '한지우', section: 'AI 기업' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i22', sourceId: 's9', title: 'GPT 차기 모델, 코드 생성 벤치마크서 역대 최고 점수', url: 'https://openai.com/blog/next-model-coding-benchmark', publishedAt: '2026-09-18T02:10:00+09:00', collectedAt: '2026-09-18T02:33:00+09:00', excerpt: '내부 코드 생성 평가에서 이전 모델 대비 큰 폭의 향상을 기록했다고 밝혔다.', fields: { category: 'Research' }, read: false, starred: true, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i23', sourceId: 's10', title: 'Gemini 3, 온디바이스 추론 성능 두 배로 개선', url: 'https://ai.googleblog.com/gemini-3-ondevice', publishedAt: '2026-09-18T01:40:00+09:00', collectedAt: '2026-09-18T02:05:00+09:00', excerpt: '모바일 칩에서의 추론 지연을 절반으로 줄였다고 발표했다.', fields: { category: 'On-device' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i24', sourceId: 's16', title: 'Claude, 장시간 자율 작업 벤치마크에서 개선된 안정성 발표', url: 'https://www.anthropic.com/news/long-horizon-stability', publishedAt: '2026-09-18T03:00:00+09:00', collectedAt: '2026-09-18T03:51:00+09:00', excerpt: '장시간 자율 실행 과제에서 중간 실패율을 크게 낮췄다고 밝혔다.', fields: { category: 'Research' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i25', sourceId: 's16', title: 'Anthropic, 기업용 에이전트 배포 가이드라인 공개', url: 'https://www.anthropic.com/news/enterprise-agent-guidelines', publishedAt: '2026-09-18T03:20:00+09:00', collectedAt: '2026-09-18T03:53:00+09:00', excerpt: '권한 범위, 감사 로그, 실패 시 롤백 절차 등을 담은 가이드라인을 제시했다.', fields: { category: 'Enterprise' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i26', sourceId: 's14', title: 'TechCrunch: 실리콘밸리 AI 스타트업 시리즈B 훈풍', url: 'https://techcrunch.com/2026/09/15/ai-startup-series-b', publishedAt: '2026-09-15T10:00:00+09:00', collectedAt: '2026-09-15T11:00:00+09:00', excerpt: '올해 3분기 들어 AI 인프라 스타트업의 시리즈B 투자 유치가 늘고 있다.', fields: { author: 'Sara Lin' }, read: true, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i27', sourceId: 's4', title: '국내 AI 스타트업, 정부 R&D 매칭펀드 유치 소식', url: 'https://www.aitimes.com/news/articleView.html?idxno=190195', publishedAt: '2026-09-18T05:00:00+09:00', collectedAt: '2026-09-18T05:20:00+09:00', excerpt: '정부 매칭펀드를 통해 후속 투자 유치에 성공했다고 밝혔다.', fields: { reporter: '한지우', section: 'AI 기업' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },

    // ── 로봇 산업 뉴스 ──
    { id: 'i28', sourceId: 's3', title: '국내 배송로봇 실외 주행 허용 지역 확대', url: 'https://www.irobotnews.com/news/articleView.html?idxno=88240', publishedAt: '2026-09-18T05:30:00+09:00', collectedAt: '2026-09-18T05:50:00+09:00', excerpt: '실외 배송로봇의 보도 주행 허용 지자체가 5곳 추가됐다.', fields: { reporter: '최윤서', section: '정책' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i29', sourceId: 's7', title: 'Boston Dynamics, 물류창고향 신규 모델 시범 배치', url: 'https://www.therobotreport.com/boston-dynamics-warehouse-pilot', publishedAt: '2026-09-18T04:10:00+09:00', collectedAt: '2026-09-18T04:30:00+09:00', excerpt: '대형 물류업체와 협력해 신규 모델의 현장 시범 배치를 시작했다.', fields: { reporter: 'Mike Tanaka', section: 'Logistics' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i30', sourceId: 's8', title: '촉각 센서 스타트업, 휴머노이드 손 그립력 논문 발표', url: 'https://spectrum.ieee.org/tactile-sensor-humanoid-grip', publishedAt: '2026-09-18T03:40:00+09:00', collectedAt: '2026-09-18T04:00:00+09:00', excerpt: '휴머노이드 손끝 촉각 센서의 그립력 제어 정확도를 높인 연구 결과를 발표했다.', fields: { reporter: 'Evan Ackerman', section: 'Sensors' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-humanoid', action: 'alert' } },
    { id: 'i31', sourceId: 's3', title: '협동로봇 국산화율, 3년 만에 두 배로 증가', url: 'https://www.irobotnews.com/news/articleView.html?idxno=88235', publishedAt: '2026-09-18T02:50:00+09:00', collectedAt: '2026-09-18T03:10:00+09:00', excerpt: '핵심 부품 국산화율이 꾸준히 상승해 원가 경쟁력이 개선되고 있다.', fields: { reporter: '박서연', section: '산업' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },

    // ── 국내 IT 뉴스 ──
    { id: 'i32', sourceId: 's5', title: '국내 개발자 커뮤니티, AI 코딩 도구 설문 결과 공개', url: 'https://news.hada.io/topic?id=98205', publishedAt: '2026-09-18T02:20:00+09:00', collectedAt: '2026-09-18T02:40:00+09:00', excerpt: '응답자의 68%가 매일 AI 코딩 도구를 사용한다고 답했다.', fields: { section: '설문', votes: 87 }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i33', sourceId: 's11', title: '공공기관 클라우드 전환 로드맵 개정', url: 'https://www.etnews.com/it/20260918002', publishedAt: '2026-09-18T01:50:00+09:00', collectedAt: '2026-09-18T02:10:00+09:00', excerpt: '민간 클라우드 이용 확대를 골자로 한 개정안이 발표됐다.', fields: { reporter: '이하늘', section: '공공' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i34', sourceId: 's5', title: '오픈소스 벡터DB 프로젝트, 국내 컨트리뷰터 급증', url: 'https://news.hada.io/topic?id=98198', publishedAt: '2026-09-18T01:20:00+09:00', collectedAt: '2026-09-18T01:41:00+09:00', excerpt: '최근 한 달 새 국내 컨트리뷰터의 PR 비중이 크게 늘었다.', fields: { section: '오픈소스', votes: 203 }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i35', sourceId: 's11', title: '국내 스타트업, AI 반도체 실리콘 검증 완료 발표', url: 'https://www.etnews.com/it/20260918003', publishedAt: '2026-09-18T00:50:00+09:00', collectedAt: '2026-09-18T01:10:00+09:00', excerpt: '첫 실리콘 테이프아웃 이후 검증을 마쳤다고 밝혔다.', fields: { reporter: '정민아', section: '반도체' }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },

    // ── 기술 블로그 ──
    { id: 'i36', sourceId: 's6', title: '확산 모델 경량화 기법 벤치마크 정리', url: 'https://huggingface.co/blog/diffusion-distillation-bench', publishedAt: '2026-09-18T00:30:00+09:00', collectedAt: '2026-09-18T00:50:00+09:00', excerpt: '최신 경량화 기법들을 속도·품질 기준으로 비교했다.', fields: { author: 'HF팀', tags: ['모델경량화'] }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i37', sourceId: 's6', title: '임베딩 모델 리더보드 9월 업데이트', url: 'https://huggingface.co/blog/mteb-september', publishedAt: '2026-09-17T23:40:00+09:00', collectedAt: '2026-09-18T00:05:00+09:00', excerpt: '다국어 검색 태스크 순위에 변동이 있었다.', fields: { author: 'HF팀', tags: ['임베딩', '리더보드'] }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },

    // ── 미분류 ──
    { id: 'i38', sourceId: 's17', title: '개인 실험: 로컬 LLM 에이전트로 리서치 자동화 해보기', url: 'https://example-ai-lab.tistory.com/142', publishedAt: '2026-09-17T22:50:00+09:00', collectedAt: '2026-09-17T23:20:00+09:00', excerpt: '로컬 모델만으로 논문 서베이를 자동화한 개인 실험 기록.', fields: { tags: ['LLM', '자동화'] }, read: false, starred: false, isBaseline: false, clusterId: null, ruleMatch: { ruleId: 'kw-llm-agent', action: 'emphasize' } },

    // ── 지난 방문 이전 (읽음/기준선) ──
    { id: 'i39', sourceId: 's15', title: '2026년 로봇산업 실태조사 결과 발표', url: 'https://www.kiria.org/notice/view/220', publishedAt: '2026-09-01T09:00:00+09:00', collectedAt: '2026-09-01T09:30:00+09:00', excerpt: '국내 로봇산업 사업체 수와 매출 규모 등을 조사한 결과를 공개했다.', fields: { announce_no: 'KIRIA-2026-0220', dept: '조사통계팀' }, read: true, starred: false, isBaseline: true, clusterId: null, ruleMatch: null },
    { id: 'i40', sourceId: 's9', title: 'OpenAI, 개발자 컨퍼런스 일정 공개', url: 'https://openai.com/blog/devday-2026-schedule', publishedAt: '2026-09-16T20:00:00+09:00', collectedAt: '2026-09-16T20:30:00+09:00', excerpt: '올해 개발자 컨퍼런스 일정과 세션 트랙을 공개했다.', fields: { category: 'Event' }, read: true, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i41', sourceId: 's7', title: '산업용 로봇 팔 신제품 라인업 발표', url: 'https://www.therobotreport.com/new-industrial-arm-lineup', publishedAt: '2026-09-17T19:00:00+09:00', collectedAt: '2026-09-17T19:30:00+09:00', excerpt: '페이로드를 세분화한 신제품 라인업을 공개했다.', fields: { reporter: 'Mike Tanaka', section: 'Industrial' }, read: true, starred: false, isBaseline: false, clusterId: null, ruleMatch: null },
    { id: 'i42', sourceId: 's2', title: '청년창업사관학교 15기 모집 공고', url: 'https://www.k-startup.go.kr/notice/view/3280', publishedAt: '2026-08-01T09:00:00+09:00', collectedAt: '2026-08-01T09:30:00+09:00', excerpt: '청년 예비창업자를 대상으로 한 육성 프로그램 15기를 모집한다.', fields: { announce_no: 'KS-2026-3280', period: { start: '2026-08-01', end: '2026-08-28' }, dept: '창업기획팀' }, read: true, starred: false, isBaseline: false, clusterId: null, ruleMatch: null }
  ];

  // ---------- 공개 ----------
  window.MOCK = {
    now: NOW,
    lastVisit: LAST_VISIT,
    meta: { lastCollect: '07:12', sourceCount: 42 },
    statusLabels: STATUS_LABEL,
    statusStampClass: STATUS_STAMP_CLASS,
    fetchStrategyLabels: FETCH_LABEL,
    fieldTypeLabels: FIELD_TYPE_LABEL,
    ruleActionLabels: RULE_ACTION_LABEL,
    categories: categories,
    tags: tags,
    sources: sources,
    keywordRules: keywordRules,
    clusters: clusters,
    items: items
  };
})();
