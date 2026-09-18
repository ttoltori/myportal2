/*
  myportal 프로토타입 — 리사이즈 가능한 분할 패널(Split Pane) 유틸리티
  classic script로 로드한다 (ES module 아님, file:// 호환).

  개념:
  - 대상 컨테이너는 CSS Grid(display:grid)이며, 각 화면의 <style> 블록에서
    grid-template-columns 값이 CSS 변수(--pane-0-width, --pane-2-width, ...)를
    var(--pane-N-width, 기본값px) 형태로 참조하도록 이미 작성돼 있어야 한다.
  - 이 스크립트는 그 변수 값만 갱신한다. grid-template-columns 자체를 직접
    덮어쓰지 않으므로, 각 화면에 이미 있는 반응형 미디어쿼리(좁은 화면에서
    1단으로 접히는 규칙 등)는 항상 그대로 유지된다.
  - 이 스크립트가 로드되지 않거나 초기화에 실패해도 var()의 기본값으로
    기존 정적 레이아웃이 그대로 렌더링된다 (file:// 환경 포함).

  사용법:
    <script src="./assets/resizable.js"></script>
    <script>
      MyPortalResizable.init(document.getElementById('app'), {
        storageKey: 'myportal-resize-index',
        flexIndex: 1, // 가변폭(유연한) 패널의 인덱스 (grid의 자식 순서 기준)
        panes: [
          { default: 260, min: 200, max: 420 },                 // 고정폭 패널
          { min: 480 },                                          // 가변폭 패널 (min만 의미 있음)
          { default: 400, min: 320, max: 720,
            responsiveDefaults: [{ minWidth: 1920, default: 480 }] } // 저장값이 없을 때만 적용
        ]
      });
    </script>

  동작 요약:
  - 컨테이너의 직계 자식(children)을 순서대로 패널로 간주한다. 자식 수가
    panes 배열 길이와 다르면 조용히 아무 것도 하지 않는다(안전한 실패).
  - 각 경계마다 분할선(.splitter, role="separator")을 만들어 컨테이너에
    추가한다. 분할선은 position:absolute이므로 grid 트랙 계산에 영향을
    주지 않는다 (실패해도 레이아웃이 깨지지 않는 이유).
  - 포인터 드래그, 더블클릭(기본값 복원), 화살표 키(16px 이동)를 지원하며
    localStorage(storageKey)에 저장한다.
  - 좁은 화면에서 화면이 1단으로 접히거나 패널이 화면 밖으로 밀려나면
    (예: index.html 우측 서랍) 분할선은 실제 렌더링된 위치를 관찰해
    자동으로 숨는다.
*/
(function () {
  'use strict';

  var STEP = 16; // 키보드 화살표 이동 단위(px)
  var HIT_WIDTH = 6; // 분할선 히트 영역 너비(px)
  var ADJACENT_TOLERANCE = 40; // 좌우 패널이 "인접하다"고 볼 허용 오차(px, gap 포함)

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function readStored(storageKey) {
    if (!storageKey) return {};
    try {
      var raw = window.localStorage.getItem(storageKey);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeStored(storageKey, widths) {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch (e) {
      /* 저장 불가 환경(프라이빗 모드 등)이면 조용히 무시한다 */
    }
  }

  function resolveDefault(paneConfig) {
    var d = paneConfig.default;
    if (paneConfig.responsiveDefaults && window.matchMedia) {
      paneConfig.responsiveDefaults.forEach(function (rd) {
        try {
          if (window.matchMedia('(min-width: ' + rd.minWidth + 'px)').matches) {
            d = rd.default;
          }
        } catch (e) {
          /* matchMedia 실패 시 기본값 유지 */
        }
      });
    }
    return d;
  }

  function init(containerEl, options) {
    if (!containerEl || !options || !options.panes || !options.panes.length) return null;

    var panes = options.panes;
    var flexIndex = typeof options.flexIndex === 'number' ? options.flexIndex : -1;
    var storageKey = options.storageKey || null;

    var paneEls = Array.prototype.slice.call(containerEl.children);
    if (paneEls.length !== panes.length) {
      // 화면 구조가 기대와 다르면 조용히 포기하고 기존 정적 레이아웃을 유지한다.
      return null;
    }

    var stored = readStored(storageKey);
    var widths = panes.map(function (p, i) {
      if (i === flexIndex) return null;
      var v = stored[String(i)];
      if (typeof v === 'number' && isFinite(v)) return clamp(v, p.min, p.max);
      return clamp(resolveDefault(p), p.min, p.max);
    });

    function applyCssVar(i) {
      if (i === flexIndex) return;
      containerEl.style.setProperty('--pane-' + i + '-width', widths[i] + 'px');
    }
    panes.forEach(function (p, i) { applyCssVar(i); });

    function persist() {
      var out = {};
      panes.forEach(function (p, i) {
        if (i !== flexIndex && typeof widths[i] === 'number') out[String(i)] = widths[i];
      });
      writeStored(storageKey, out);
    }

    // ---------- 분할선 컨테이너 준비 ----------
    if (!containerEl.style.position) {
      var computedPos = window.getComputedStyle ? window.getComputedStyle(containerEl).position : 'static';
      if (!computedPos || computedPos === 'static') containerEl.style.position = 'relative';
    }

    var splitters = [];
    for (var i = 0; i < paneEls.length - 1; i++) {
      var sp = document.createElement('div');
      sp.className = 'splitter';
      sp.setAttribute('role', 'separator');
      sp.setAttribute('aria-orientation', 'vertical');
      sp.setAttribute('tabindex', '0');
      sp.setAttribute('data-splitter-boundary', String(i));
      containerEl.appendChild(sp);
      splitters.push(sp);
    }

    // ---------- 위치 갱신 (반응형 레이아웃과 항상 동기화) ----------
    function updatePositions() {
      var containerRect = containerEl.getBoundingClientRect();
      splitters.forEach(function (sp, i) {
        var leftPane = paneEls[i];
        var rightPane = paneEls[i + 1];
        var lr = leftPane.getBoundingClientRect();
        var rr = rightPane.getBoundingClientRect();

        var leftVisible = lr.width > 0 && lr.height > 0 && leftPane.offsetParent !== null;
        var rightVisible = rr.width > 0 && rr.height > 0 && rightPane.offsetParent !== null;
        var stackedVertically = rr.top >= lr.bottom - 1;
        var adjacentHorizontally = Math.abs(rr.left - lr.right) < ADJACENT_TOLERANCE;

        if (!leftVisible || !rightVisible || stackedVertically || !adjacentHorizontally) {
          sp.style.display = 'none';
          return;
        }

        sp.style.display = '';
        var boundaryX = ((lr.right + rr.left) / 2) - containerRect.left;
        sp.style.left = (boundaryX - HIT_WIDTH / 2) + 'px';
      });
    }

    updatePositions();

    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { updatePositions(); });
      ro.observe(containerEl);
      paneEls.forEach(function (el) { ro.observe(el); });
    } else if (window.addEventListener) {
      window.addEventListener('resize', updatePositions);
    }

    // ---------- 경계마다 리사이즈 대상 패널 결정 ----------
    // 두 패널 중 가변폭(flexIndex)이 아닌 쪽이 실제로 크기가 바뀌는 패널이다.
    function resizeTargetFor(leftIdx, rightIdx) {
      if (leftIdx !== flexIndex) return { idx: leftIdx, side: 'left' };
      if (rightIdx !== flexIndex) return { idx: rightIdx, side: 'right' };
      return null; // 양쪽 모두 가변폭인 구성은 현재 화면들에서 없다
    }

    splitters.forEach(function (sp, boundaryIdx) {
      var leftIdx = boundaryIdx;
      var rightIdx = boundaryIdx + 1;
      var target = resizeTargetFor(leftIdx, rightIdx);
      if (!target) return;

      var dragging = false;
      var startX = 0;
      var startWidth = 0;

      function setWidth(next) {
        widths[target.idx] = clamp(next, panes[target.idx].min, panes[target.idx].max);
        applyCssVar(target.idx);
        updatePositions();
      }

      function onPointerMove(ev) {
        if (!dragging) return;
        var dx = ev.clientX - startX;
        var delta = target.side === 'left' ? dx : -dx;
        setWidth(startWidth + delta);
      }

      function endDrag(ev) {
        if (!dragging) return;
        dragging = false;
        sp.classList.remove('is-dragging');
        document.body.style.userSelect = '';
        try { sp.releasePointerCapture(ev.pointerId); } catch (e) { /* 무시 */ }
        persist();
      }

      sp.addEventListener('pointerdown', function (ev) {
        if (typeof ev.button === 'number' && ev.button !== 0) return;
        dragging = true;
        startX = ev.clientX;
        startWidth = widths[target.idx];
        sp.classList.add('is-dragging');
        document.body.style.userSelect = 'none';
        try { sp.setPointerCapture(ev.pointerId); } catch (e) { /* 무시 */ }
        ev.preventDefault();
      });
      sp.addEventListener('pointermove', onPointerMove);
      sp.addEventListener('pointerup', endDrag);
      sp.addEventListener('pointercancel', endDrag);

      sp.addEventListener('dblclick', function () {
        setWidth(resolveDefault(panes[target.idx]));
        persist();
      });

      sp.addEventListener('keydown', function (ev) {
        var dir = 0;
        if (ev.key === 'ArrowLeft') dir = -1;
        else if (ev.key === 'ArrowRight') dir = 1;
        else return;
        ev.preventDefault();
        var delta = target.side === 'left' ? dir * STEP : -dir * STEP;
        setWidth(widths[target.idx] + delta);
        persist();
      });
    });

    return {
      updatePositions: updatePositions,
      splitters: splitters
    };
  }

  window.MyPortalResizable = { init: init };
})();
