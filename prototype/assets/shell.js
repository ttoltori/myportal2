/*
  myportal 프로토타입 — 공통 셸 (머리띠/네비게이션/테마)
  classic script로 로드한다 (ES module 아님, file:// 호환).

  사용법 (각 화면 HTML):
    <body data-active-page="index">
      <header id="masthead"></header>
      ...
      <script src="./assets/mock-data.js"></script>
      <script src="./assets/shell.js"></script>

  data-active-page 값: index | add-source | sources | categories | schema-map | keywords | digest
  MOCK(window.MOCK, mock-data.js)이 먼저 로드되어 있어야 소스 수/주의 수를 머리띠에 표시할 수 있다.
*/

(function () {
  'use strict';

  var THEME_KEY = 'myportal-theme'; // localStorage: 'light' | 'dark'

  var NAV_ITEMS = [
    { id: 'index', label: '데스크', href: 'index.html' },
    { id: 'add-source', label: '소스 등록', href: 'add-source.html' },
    { id: 'sources', label: '소스', href: 'sources.html' },
    { id: 'categories', label: '분류 정리', href: 'categories.html' },
    { id: 'schema-map', label: '구조 조망', href: 'schema-map.html' },
    { id: 'keywords', label: '키워드', href: 'keywords.html' },
    { id: 'digest', label: '다이제스트', href: 'digest.html' }
  ];

  var WEEKDAY = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

  // ---------- 테마 ----------
  function getStoredTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }

  function storeTheme(theme) {
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      /* 저장 불가 환경(프라이빗 모드 등)이면 조용히 무시한다 */
    }
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function currentEffectiveTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  }

  function toggleTheme() {
    var next = currentEffectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storeTheme(next);
    updateThemeButtonLabel();
  }

  function updateThemeButtonLabel() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    var isDark = currentEffectiveTheme() === 'dark';
    btn.textContent = isDark ? '주간' : '야간';
    btn.setAttribute('aria-label', isDark ? '주간 모드로 전환' : '야간 모드로 전환');
    btn.title = isDark ? '주간 모드로 전환' : '야간 모드로 전환';
  }

  // 최대한 빨리 적용해 테마 깜빡임(FOUC)을 줄인다.
  (function initThemeEarly() {
    var stored = getStoredTheme();
    if (stored === 'dark' || stored === 'light') {
      applyTheme(stored);
    }
  })();

  // ---------- 날짜/시간 포맷 ----------
  function formatMastheadDate(date) {
    var y = date.getFullYear();
    var m = date.getMonth() + 1;
    var d = date.getDate();
    var w = WEEKDAY[date.getDay()];
    return y + '년 ' + m + '월 ' + d + '일 ' + w + ' · 조간';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatTimeHM(date) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  // ---------- 머리띠 렌더링 ----------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function warnSourceCount() {
    if (!window.MOCK || !window.MOCK.sources) return 0;
    var n = 0;
    window.MOCK.sources.forEach(function (s) {
      if (s.status === 'warn' || s.status === 'fail') n += 1;
    });
    return n;
  }

  function renderMasthead(activePage) {
    var el = document.getElementById('masthead');
    if (!el) return;

    var now = window.MOCK && window.MOCK.now ? new Date(window.MOCK.now) : new Date();
    var lastCollect = window.MOCK && window.MOCK.meta ? window.MOCK.meta.lastCollect : formatTimeHM(now);
    var sourceCount = window.MOCK && window.MOCK.meta ? window.MOCK.meta.sourceCount : (window.MOCK ? window.MOCK.sources.length : 0);
    var warnCount = warnSourceCount();

    var navHtml = NAV_ITEMS.map(function (item) {
      var active = item.id === activePage;
      var cls = active
        ? 'text-ink border-b border-ink pb-0.5'
        : 'text-ink-2 hover:text-ink';
      return '<a href="' + item.href + '" class="' + cls + '" style="transition: color var(--transition) ease, border-color var(--transition) ease;">' + escapeHtml(item.label) + '</a>';
    }).join('<span class="text-ink-2" aria-hidden="true">·</span>');

    el.innerHTML =
      '<div class="h-full flex items-center justify-between gap-6 px-4" style="border-bottom:2px solid var(--ink); box-shadow: 0 1px 0 var(--rule);">' +
        '<a href="index.html" class="shrink-0" style="font-size:20px; font-weight:700; color:var(--ink);">myportal</a>' +
        '<div class="hidden md:block font-mono text-ink-2 shrink-0" style="font-size:12px;">' + escapeHtml(formatMastheadDate(now)) + '</div>' +
        '<div class="flex items-center gap-4 min-w-0 justify-end flex-1">' +
          '<div class="font-mono text-ink-2 shrink-0 hidden lg:block" style="font-size:11px;">' +
            '최근 수집 ' + escapeHtml(lastCollect) + ' · 소스 ' + sourceCount + ' · 주의 ' + warnCount +
          '</div>' +
          '<nav class="hidden lg:flex items-center gap-3" style="font-size:12px;">' + navHtml + '</nav>' +
          '<button id="theme-toggle" type="button" class="btn btn-sm shrink-0"></button>' +
          '<div class="stamp shrink-0" style="width:28px; height:28px; font-size:11px; border-color:var(--ink); color:var(--ink);" title="ttoltori@gmail.com">TT</div>' +
        '</div>' +
      '</div>';

    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', toggleTheme);
    }
    updateThemeButtonLabel();
  }

  // ---------- 토스트 (짧은 안내) ----------
  var toastTimer = null;
  function showToast(message, duration) {
    var el = document.getElementById('shell-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shell-toast';
      el.className = 'toast-mono';
      document.body.appendChild(el);
    }
    el.textContent = message;
    // reflow 후 show 클래스를 붙여 transition이 항상 재생되도록 한다
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      el.classList.remove('show');
    }, duration || 1800);
  }

  // ---------- 하단 되돌리기 띠 ----------
  var undoTimer = null;
  function showUndoBand(message, onUndo, duration) {
    var el = document.getElementById('shell-undo-band');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shell-undo-band';
      el.className = 'undo-band';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    var span = document.createElement('span');
    span.className = 'font-mono';
    span.textContent = message;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '되돌리기';
    el.appendChild(span);
    el.appendChild(btn);

    function hide() {
      el.classList.remove('show');
    }

    btn.addEventListener('click', function () {
      hide();
      if (undoTimer) window.clearTimeout(undoTimer);
      if (typeof onUndo === 'function') onUndo();
    });

    void el.offsetWidth;
    el.classList.add('show');
    if (undoTimer) window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(hide, duration || 5000);
  }

  // ---------- 초기화 ----------
  function init() {
    var activePage = document.body ? document.body.getAttribute('data-active-page') : '';
    renderMasthead(activePage);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 시스템 다크모드 변경에 반응 (명시적 테마가 저장되지 않은 경우에만 버튼 라벨 갱신)
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var mqHandler = function () {
      if (!getStoredTheme()) updateThemeButtonLabel();
    };
    if (mq.addEventListener) mq.addEventListener('change', mqHandler);
    else if (mq.addListener) mq.addListener(mqHandler);
  }

  window.MyPortalShell = {
    NAV_ITEMS: NAV_ITEMS,
    renderMasthead: renderMasthead,
    toggleTheme: toggleTheme,
    applyTheme: applyTheme,
    currentEffectiveTheme: currentEffectiveTheme,
    showToast: showToast,
    showUndoBand: showUndoBand,
    formatMastheadDate: formatMastheadDate,
    formatTimeHM: formatTimeHM,
    pad2: pad2,
    escapeHtml: escapeHtml
  };
})();
