// ==UserScript==
// @name         bilibili-touch-optimizer
// @namespace    http://tampermonkey.net/
// @version      65.39
// @description  B站HTML5视频触屏手势优化，彻底移除所有自带功能按键与锁屏遮罩，界面纯净零侵入；双指手势固定为0.25x步长档位调速（附带切档触觉反馈）；保留居中Toast、双击Seek动画指示与底部2px微缩进度条；左右30%分别调节亮度（含100%磁吸卡位）与音量，中间40%双击全屏与长按3.0x加速；默认1.5倍速，默认打开字幕与关闭弹幕，默认开启100%音量。
// @author       Zephyr Three, Gemini & 仙, Blysh, Fusion by Copilot
// @license      MIT
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) {
    return;
  }

  const CFG = {
    minDist: 10,
    longPress: 500,
    rateBase: 3.0,
    senseX: 0.25,
    senseY: 1.0,
    progressBarColor: "#FF6699",
    pinchStepDist: 36,
    pinchSpeedStep: 0.25,
    senseRate: 0.015,
    defaultPlaybackRate: 1.5,
    seekStep: 10,
    deadzoneTop: 36,
    deadzoneBottom: 100,
  };

  // [修复] 将 lastTap 替换为更为精准的连击计数器机制
  let startX,
    startY,
    initVol,
    initTime,
    initRate,
    initBri = 1.0,
    inBriSnapZone = false,
    targetV,
    targetP,
    isTouch = false,
    action = null,
    lpTimer = null,
    toastTimer = null,
    lastTapTime = 0,
    tapCount = 0;
  let startInTopDeadzone = false,
    startInBottomDeadzone = false,
    startInControls = false;
  let playerCenterX = 0,
    playerHeight = 0,
    startRatio = 0.5;
  let activeSeekSide = null,
    seekAccumulator = 0,
    seekSessionTimer = null,
    wasPlayingBeforeSequence = false;
  let initPinchDist = 0,
    initSpeed = 1.0;

  let blockGestureUntil = 0;
  let suppressClickUntil = 0;
  let suppressContextMenuUntil = 0;
  let enforceStateUntil = 0;
  let enforceTarget = null;
  let wasPlayingBeforeFullscreenToggle = false;
  let activeFullscreenVideo = null;

  const syncPlaybackStateAfterTransition = () => {
    if (Date.now() > enforceStateUntil) return;
    if (!enforceTarget) return;

    const v =
      activeFullscreenVideo || targetV || document.querySelector("video");
    if (!v) return;

    if (enforceTarget === "playing") {
      if (v.paused) {
        v.play().catch(() => {});
      }
    } else if (enforceTarget === "paused") {
      if (!v.paused) {
        v.pause();
      }
    }
  };

  const schedulePlaybackStateEnforcement = (duration = 2500) => {
    if (!enforceTarget) return;
    const end = Date.now() + duration;
    enforceStateUntil = Math.max(enforceStateUntil, end);
    [0, 80, 200, 400, 700, 1100, 1600, 2200].forEach((delay) => {
      setTimeout(syncPlaybackStateAfterTransition, delay);
    });
    setTimeout(() => {
      if (Date.now() >= enforceStateUntil) {
        enforceTarget = null;
        wasPlayingBeforeFullscreenToggle = false;
        activeFullscreenVideo = null;
      }
    }, duration + 100);
  };

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "gt_lock_orientation") {
      if (screen.orientation && screen.orientation.lock)
        screen.orientation.lock(e.data.dir).catch(() => {});
    } else if (e.data && e.data.type === "gt_unlock_orientation") {
      if (screen.orientation && screen.orientation.unlock)
        screen.orientation.unlock();
    }
  });

  const VIP_SELECTORS =
    '.video-js, .vjs-custom-skin, .player-container, .art-video-player, .xgplayer, .tcplayer, .prism-player, .mui-player, [data-testid="videoComponent"], .plyr, #html5video, #movie_player, .html5-video-player, .bpx-player-container, .dplayer, .artplayer-app, .MacPlayer, .ckplayer, #playleft, iframe';
  const findUp = (el, selector) => {
    while (el && el !== document.body) {
      if (el.matches && el.matches(selector)) return el;
      el = el.parentNode;
    }
    return null;
  };
  const isBilibiliHost = () => /(^|\.)bilibili\.com$/i.test(location.hostname);


  const hijackFullscreenAPI = () => {
    const fsMethods = [
      "requestFullscreen",
      "webkitRequestFullscreen",
      "mozRequestFullScreen",
      "msRequestFullscreen",
    ];
    fsMethods.forEach((method) => {
      if (Element.prototype[method]) {
        const originalMethod = Element.prototype[method];
        Element.prototype[method] = function (...args) {
          let target = this;
          if (this.tagName === "VIDEO") {
            const isNaked =
              !this.parentNode.classList?.contains("gt-video-wrapper") &&
              !findUp(this.parentNode, VIP_SELECTORS.replace(", iframe", ""));
            if (isNaked) {
              target = this.parentNode;
              target.classList.add("gt-fullscreen-active");
            }
          }

          const promise = originalMethod.apply(target, args);
          let v =
            target.tagName === "VIDEO"
              ? target
              : target.querySelector("video") ||
                document.querySelector("video");
          if (v && screen.orientation && screen.orientation.lock) {
            const dir =
              v.videoWidth === 0 || v.videoWidth >= v.videoHeight
                ? "landscape"
                : "portrait";
            screen.orientation.lock(dir).catch(() => {
              try {
                window.top.postMessage(
                  { type: "gt_lock_orientation", dir: dir },
                  "*",
                );
              } catch (err) {}
            });
          }
          return promise;
        };
      }
    });
  };
  hijackFullscreenAPI();

  const toggleNativeFullscreen = (container, video) => {
    activeFullscreenVideo = video || container.querySelector("video") || targetV;
    const isFS =
      !!(document.fullscreenElement || document.webkitFullscreenElement) ||
      container.classList.contains("gt-fullscreen-active");
    const fsBtn = container.querySelector(
      '.bpx-player-ctrl-full, .bilibili-player-video-btn-fullscreen, .art-icon-fullscreenOn, .art-control-fullscreen, .dplayer-full-icon, .plyr__control[data-plyr="fullscreen"], .vjs-fullscreen-control, .xgplayer-fullscreen, .tcplayer-fullscreen-btn, .prism-fullscreen-btn, .fullscreen-btn, [aria-label="全屏"], [title="全屏"], [aria-label="退出全屏"], [title="退出全屏"]',
    );

    if (isFS) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (video && video.webkitExitFullscreen) {
        video.webkitExitFullscreen();
      } else if (fsBtn) {
        try {
          fsBtn.click();
        } catch (e) {}
      }
      container.classList.remove("gt-fullscreen-active");
      if (screen.orientation?.unlock) {
        screen.orientation.unlock();
        try {
          window.top.postMessage({ type: "gt_unlock_orientation" }, "*");
        } catch (e) {}
      }
      schedulePlaybackStateEnforcement(2500);
    } else {
      const forceLockLandscape = () => {
        const dir =
          video && video.videoWidth > 0 && video.videoWidth < video.videoHeight
            ? "portrait"
            : "landscape";
        if (screen.orientation?.lock) {
          screen.orientation
            .lock(dir)
            .catch(() => {
              try {
                window.top.postMessage(
                  { type: "gt_lock_orientation", dir: dir },
                  "*",
                );
              } catch (err) {}
            })
            .finally(() => {
              syncPlaybackStateAfterTransition();
            });
        } else {
          try {
            window.top.postMessage(
              { type: "gt_lock_orientation", dir: dir },
              "*",
            );
          } catch (err) {}
          syncPlaybackStateAfterTransition();
        }
      };

      container.classList.add("gt-fullscreen-active");
      const reqFs =
        container.requestFullscreen ||
        container.webkitRequestFullscreen ||
        container.mozRequestFullScreen;

      if (reqFs) {
        const p = reqFs.call(container);
        if (p && p.then) {
          p.then(() => setTimeout(forceLockLandscape, 150)).catch(() => {
            if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
            setTimeout(forceLockLandscape, 150);
          });
        } else {
          setTimeout(forceLockLandscape, 150);
        }
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
        setTimeout(forceLockLandscape, 150);
      } else if (fsBtn) {
        try {
          fsBtn.click();
        } catch (e) {}
      }
      schedulePlaybackStateEnforcement(2500);
    }
  };



  const TOUCH_LOCK_SELECTORS =
    '.video-js, .vjs-custom-skin, .player-container, .art-video-player, .xgplayer, .tcplayer, .prism-player, .mui-player, [data-testid="videoComponent"], .plyr, #html5video, #movie_player, .html5-video-player, .bpx-player-container, .dplayer, .artplayer-app, .MacPlayer, .ckplayer, #playleft, video, .gt-lock-touch';

  GM_addStyle(`
        ${TOUCH_LOCK_SELECTORS} { touch-action: none !important; overscroll-behavior: none !important; }
        .bpx-player-control-bottom, .bpx-player-control-bottom *, .bpx-player-progress-area, .bpx-player-progress-area * { touch-action: auto !important; }
        ${TOUCH_LOCK_SELECTORS}, ${TOUCH_LOCK_SELECTORS} * { -webkit-user-select: none !important; -moz-user-select: none !important; -ms-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }
        ${TOUCH_LOCK_SELECTORS} input, ${TOUCH_LOCK_SELECTORS} textarea, ${TOUCH_LOCK_SELECTORS} [contenteditable="true"], ${TOUCH_LOCK_SELECTORS} [contenteditable=""], ${TOUCH_LOCK_SELECTORS} [role="textbox"], ${TOUCH_LOCK_SELECTORS} .bpx-player-dm-input { -webkit-user-select: text !important; -moz-user-select: text !important; -ms-user-select: text !important; user-select: text !important; }
        
        .dplayer-pause-ad, .dplayer-notice, .dplayer-ad, .artplayer-plugin-ads, .art-ad, .art-notice, .MacPlayer .play-ad, #playleft .pause-ad, .player-ad, .ad-box, .pause-ad, .ad-mask, .pause-html, #pause-html, [class*="pause-html"], [id*="pause-html"] { display: none !important; pointer-events: none !important; opacity: 0 !important; z-index: -2147483648 !important; width: 0 !important; height: 0 !important; }
        .gt-toast { position: absolute !important; top: 10% !important; left: 50% !important; transform: translateX(-50%) !important; white-space: nowrap !important; background: rgba(0,0,0,0.15); color: #fff; padding: 4px 10px; border-radius: 4px; font: 700 14px system-ui; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.2s; text-shadow: 0 0 2px #000; border: 1px solid rgba(255,255,255,0.05); }
        body > .gt-toast { position: fixed !important; }
        .gt-toast.show { opacity: 1; }
        .gt-seek-msg { position: absolute !important; top: 50% !important; color: rgba(255, 255, 255, 0.95) !important; z-index: 2147483647 !important; pointer-events: none !important; opacity: 0; transition: opacity 0.15s ease-out; display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important; align-items: center !important; justify-content: center !important; gap: 6px !important; font-family: system-ui, -apple-system, sans-serif !important; white-space: nowrap !important; text-shadow: 0 0 10px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.5) !important; }
        .gt-seek-msg.left { left: 15%; transform: translateY(-50%); }
        .gt-seek-msg.right { right: 15%; transform: translateY(-50%); }
        .gt-seek-msg.show { opacity: 1; }
        .gt-seek-text { display: block !important; font-size: 15px !important; font-weight: 500 !important; line-height: 1 !important; white-space: nowrap !important; transform-origin: center center !important; will-change: transform; }
        .gt-arrows { display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important; align-items: center !important; justify-content: center !important; font-size: 22px !important; font-weight: 400 !important; line-height: 1 !important; }
        .gt-arrows span { display: block !important; line-height: 1 !important; white-space: nowrap !important; }
        .gt-pop-anim { animation: gt-pop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        @keyframes gt-pop { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
        .gt-arrow-slide-r { animation: gt-slide-r 0.6s infinite; }
        @keyframes gt-slide-r { 0% { transform: translateX(-4px); opacity: 0; } 40% { opacity: 1; } 100% { transform: translateX(4px); opacity: 0; } }
        .gt-arrow-slide-l { animation: gt-slide-l 0.6s infinite; }
        @keyframes gt-slide-l { 0% { transform: translateX(4px); opacity: 0; } 40% { opacity: 1; } 100% { transform: translateX(-4px); opacity: 0; } }
        :fullscreen { background-color: #000 !important; }
        
        .gt-ui-layer { position: absolute !important; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none !important; z-index: 2147483647 !important; overflow: hidden !important; border-radius: inherit !important; }
        

        .gt-mini-progress { position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: rgba(255,255,255,0.2); z-index: 2147483640; pointer-events: none; overflow: hidden; opacity: 0.9; transition: height 0.2s, opacity 0.3s; box-shadow: 0 -1px 1px rgba(0,0,0,0.2); }
        .gt-mini-progress .gt-fill { height: 100%; width: 0%; background: ${CFG.progressBarColor}; transition: width 0.1s linear; box-shadow: 0 0 4px ${CFG.progressBarColor}; }
        :fullscreen .gt-mini-progress, .gt-fullscreen-active .gt-mini-progress { height: 3px !important; }
    `);

  const getFS = () =>
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement;

  const isInteractiveInput = (el) => {
    return !!findUp(
      el,
      "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox'], [role='searchbox'], .nav-search-content, .nav-search-form",
    );
  };

  const identify = (e) => {
    const t = e.target;
    if (isInteractiveInput(t)) return null;

    let targetVideo = null;
    let rootContainer = null;

    const vip = findUp(t, VIP_SELECTORS);
    if (vip) {
      targetVideo =
        vip.tagName === "VIDEO"
          ? vip
          : vip.querySelector("video") ||
            (vip.shadowRoot ? vip.shadowRoot.querySelector("video") : null);
      rootContainer = vip;
    }

    if (!targetVideo) {
      const videos = document.querySelectorAll("video");
      if (videos.length > 0) {
        targetVideo = Array.from(videos).filter((v) => {
          if (!v || v.clientWidth <= 50) return false;
          // 排除顶栏 Banner、动画背景等非播放类装饰性视频
          if (findUp(v, ".bili-header, .animated-banner, header, [role='banner']")) {
            return false;
          }
          return true;
        }).sort(
          (a, b) =>
            b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
        )[0];
        if (targetVideo) {
          rootContainer =
            findUp(targetVideo, VIP_SELECTORS) || targetVideo.parentNode;
        } else targetVideo = null;
      }
    }

    if (!targetVideo) return null;

    if (rootContainer && rootContainer.tagName === "VIDEO") {
      rootContainer = rootContainer.parentNode;
    }

    // 兜底命中时，若触点目标完全不属于视频或其容器层级（例如悬浮在视频上方的无关顶栏/输入框），则不予接管
    if (
      rootContainer &&
      rootContainer !== document.body &&
      rootContainer !== document.documentElement &&
      !rootContainer.contains(t) &&
      targetVideo !== t
    ) {
      return null;
    }

    let inTopDeadzone = false;
    let inBottomDeadzone = false;
    const inControls = !!findUp(
      t,
      ".bpx-player-control-bottom, .bpx-player-progress-area, .bpx-player-control-top, .bpx-player-mini-header, .art-bottom, .dplayer-controller",
    );

    if (e.touches && e.touches.length > 0) {
      const checkBox = rootContainer || targetVideo;
      const rect = checkBox.getBoundingClientRect();
      const touch = e.touches[0];
      if (
        touch.clientX < rect.left - 10 ||
        touch.clientX > rect.right + 10 ||
        touch.clientY < rect.top - 10 ||
        touch.clientY > rect.bottom + 10
      )
        return null;

      // 上下边缘防误触死区计算：统一按比例与固定阈值计算，不搞特殊化
      const topDeadzone = Math.min(CFG.deadzoneTop, rect.height * 0.15);
      const bottomDeadzone = Math.min(CFG.deadzoneBottom, rect.height * 0.35);

      inTopDeadzone = touch.clientY <= rect.top + topDeadzone;
      inBottomDeadzone = touch.clientY >= rect.bottom - bottomDeadzone;
    }

    return {
      root: rootContainer,
      video: targetVideo,
      inTopDeadzone,
      inBottomDeadzone,
      inControls,
      isGestureZone: !inTopDeadzone && !inBottomDeadzone && !inControls,
      isNaked:
        !rootContainer.classList?.contains("gt-video-wrapper") &&
        !findUp(rootContainer, VIP_SELECTORS.replace(", iframe", "")),
    };
  };

  const showMsg = (txt) => {
    let t = document.getElementById("gt-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "gt-toast";
      t.className = "gt-toast";
    }
    if (!txt) {
      t.classList.remove("show");
      return;
    }
    const currentHost =
      (targetP && (targetP.querySelector(".gt-ui-layer") || targetP)) ||
      document.querySelector(".gt-ui-layer") ||
      document.fullscreenElement ||
      document.body;
    if (t.parentNode !== currentHost) currentHost.appendChild(t);
    t.innerText = txt;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 800);
  };

  const ensureUIAndWrapper = (hit) => {
    let { root, video, isNaked } = hit;

    if (!root.classList.contains("gt-lock-touch"))
      root.classList.add("gt-lock-touch");
    if (!video.classList.contains("gt-lock-touch"))
      video.classList.add("gt-lock-touch");

    if (isNaked) {
      video.setAttribute("controlslist", "nofullscreen");
    }

    let uiLayer = root.querySelector(".gt-ui-layer");
    if (!uiLayer) {
      uiLayer = document.createElement("div");
      uiLayer.className = "gt-ui-layer";

      const bar = document.createElement("div");
      bar.className = "gt-mini-progress";
      bar.innerHTML = '<div class="gt-fill"></div>';
      uiLayer.appendChild(bar);

      const style = window.getComputedStyle(root);
      if (style.position === "static") root.style.position = "relative";
      root.appendChild(uiLayer);
    }

    if (!video.dataset.gtTimeupdate) {
      video.addEventListener("timeupdate", () => {
        const fill = uiLayer.querySelector(".gt-mini-progress .gt-fill");
        if (fill && video.duration)
          fill.style.width = `${(video.currentTime / video.duration) * 100}%`;
      });
      video.dataset.gtTimeupdate = "true";
    }

    if (!video.dataset.gtStateLock) {
      video.addEventListener("pause", () => {
        if (Date.now() < enforceStateUntil && enforceTarget === "playing")
          video.play().catch(() => {});
      });
      video.addEventListener("play", () => {
        if (Date.now() < enforceStateUntil && enforceTarget === "paused")
          video.pause();
      });
      video.dataset.gtStateLock = "true";
    }

    applyDefaultPlaybackRate(video);
    applyDefaultVolume(video);
    schedulePreferences(video);

    return root;
  };

  const getPinchData = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX,
      dy = touches[0].clientY - touches[1].clientY;
    return {
      dist: Math.hypot(dx, dy),
      cx: (touches[0].clientX + touches[1].clientX) / 2,
      cy: (touches[0].clientY + touches[1].clientY) / 2,
    };
  };

  const handleAccumulatedSeek = (dir, uiLayer, video) => {
    activeSeekSide = dir;
    const stepVal = CFG.seekStep || 10;
    seekAccumulator += stepVal;
    video.currentTime =
      dir === "left"
        ? Math.max(0, video.currentTime - stepVal)
        : Math.min(video.duration || 0, video.currentTime + stepVal);
    let t = uiLayer.querySelector("#gt-seek-" + dir);
    if (!t) {
      t = document.createElement("div");
      t.id = "gt-seek-" + dir;
      t.className = `gt-seek-msg ${dir}`;
      uiLayer.appendChild(t);
    }
    t.innerHTML =
      dir === "left"
        ? `<div class="gt-arrows"><span>‹</span><span class="gt-arrow-slide-l">‹</span></div><span class="gt-seek-text gt-pop-anim">-${seekAccumulator}s</span>`
        : `<span class="gt-seek-text gt-pop-anim">+${seekAccumulator}s</span><div class="gt-arrows"><span class="gt-arrow-slide-r">›</span><span>›</span></div>`;
    t.classList.add("show");
    clearTimeout(seekSessionTimer);
    seekSessionTimer = setTimeout(() => {
      t.classList.remove("show");
      activeSeekSide = null;
      seekAccumulator = 0;
      setTimeout(() => {
        if (t && t.parentNode && !t.classList.contains("show"))
          t.innerHTML = "";
      }, 200);
    }, 800);
  };

  const onStart = (e) => {
    if (!getFS()) {
      document
        .querySelectorAll(
          ".plyr--fullscreen-active, .jw-flag-fullscreen, .gt-fullscreen-active",
        )
        .forEach((el) => {
          el.classList.remove(
            "plyr--fullscreen-active",
            "jw-flag-fullscreen",
            "gt-fullscreen-active",
          );
        });
    }

    if (isInteractiveInput(e.target)) {
      clearTimeout(lpTimer);
      return;
    }

    let hit = identify(e);
    if (!hit || !hit.video) return;
    targetP = ensureUIAndWrapper(hit);
    targetV = hit.video;

    // 记录本次触控的区域归属
    startInTopDeadzone = !!hit.inTopDeadzone;
    startInBottomDeadzone = !!hit.inBottomDeadzone;
    startInControls = !!hit.inControls;
    const isEdgeOrControls =
      startInTopDeadzone || startInBottomDeadzone || startInControls;

    // 记录播放器几何参数（自适应全屏、普通居中及悬浮小窗）
    const pRect = (targetP || targetV).getBoundingClientRect();
    playerCenterX = pRect.left + pRect.width / 2;
    playerHeight = Math.max(100, pRect.height);

    // 凡触碰进入视频管理区，加锁屏蔽右键菜单并清理历史选区残留
    if (isBilibiliHost()) {
      suppressContextMenuUntil = Date.now() + 2500;
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !isInteractiveInput(e.target) && sel.removeAllRanges) {
      sel.removeAllRanges();
    }

    clearTimeout(lpTimer);
    const now = Date.now();

    // 边缘死区（顶栏/底栏）与原生控件区清空连击，绝不触发快进、快退与全屏切换
    if (isEdgeOrControls) {
      tapCount = 0;
    } else {
      // 引入连击追踪，对齐浏览器与Hammer 500ms双击判定窗口
      const isRapid = now - lastTapTime < 500;
      if (!isRapid) {
        tapCount = 1;
        wasPlayingBeforeSequence = targetV ? !targetV.paused : false;
        enforceStateUntil = 0;
        enforceTarget = null;
        activeFullscreenVideo = null;
      } else {
        tapCount++;
      }
    }
    lastTapTime = now;

    if (e.touches && e.touches.length > 1) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      tapCount = 0; // 如果检测到双指，则打断连击链条
      enforceTarget = wasPlayingBeforeSequence ? "playing" : "paused";
      enforceStateUntil = now + 800;
      if (enforceTarget === "playing" && targetV.paused)
        targetV.play().catch(() => {});
      else if (enforceTarget === "paused" && !targetV.paused) targetV.pause();
    }

    // [修复] 只要处于连击阻塞期（>=2次），直接拦截并锁死播放状态
    if (tapCount >= 2) {
      blockGestureUntil = now + 1000;
      suppressClickUntil = now + 500;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const touchX = e.touches ? e.touches[0].clientX : e.clientX;
      const refRect = (targetP || targetV).getBoundingClientRect();
      const xInPlayer = Math.max(
        0,
        Math.min(refRect.width, touchX - refRect.left),
      );
      const r = refRect.width > 0 ? xInPlayer / refRect.width : 0.5;
      const uiLayer = targetP.querySelector(".gt-ui-layer") || targetP;

      enforceTarget = wasPlayingBeforeSequence ? "playing" : "paused";
      wasPlayingBeforeFullscreenToggle = wasPlayingBeforeSequence;
      activeFullscreenVideo = targetV;
      schedulePlaybackStateEnforcement(2500);

      if (r < 0.3) handleAccumulatedSeek("left", uiLayer, targetV);
      else if (r > 0.7) handleAccumulatedSeek("right", uiLayer, targetV);
      else if (tapCount === 2) {
        toggleNativeFullscreen(targetP, targetV);
      }

      syncPlaybackStateAfterTransition();

      isTouch = false; // 标记本序列已被阻断，无需追踪常规手势
      return;
    }

    isTouch = true;
    action = null;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startRatio = Math.max(
      0,
      Math.min(1, (startX - pRect.left) / Math.max(1, pRect.width)),
    );
    initVol = targetV.volume;
    initTime = targetV.currentTime;
    initRate = targetV.playbackRate;
    initBri = targetV && targetV.dataset.gtBri ? parseFloat(targetV.dataset.gtBri) : 1.0;
    inBriSnapZone = false;

    if (targetV && !targetV.dataset.gtUserVol && (targetV.muted || targetV.volume < 1.0)) {
      applyDefaultVolume(targetV);
    }

    if (e.touches.length === 2 && !isEdgeOrControls) {
      clearTimeout(lpTimer);
      if (action === "rate" && targetV) {
        targetV.playbackRate = initRate;
      }
      const p = getPinchData(e.touches);
      initPinchDist = p.dist;
      initSpeed = parseFloat(targetV.dataset.gtUserSpeed) || targetV.playbackRate || 1.0;
      action = "pinch";
    } else if (e.touches.length === 1) {
      // 边缘死区（顶栏/底栏）与原生控件区严禁触发长按加速；仅画面中腹安全区域允许长按 3.0x
      if (!isEdgeOrControls) {
        lpTimer = setTimeout(() => {
          if (isTouch) {
            action = "rate";
            targetV.playbackRate = CFG.rateBase;
            showMsg(`${targetV.playbackRate.toFixed(1)}x`);
          }
        }, CFG.longPress);
      }
    }
  };

  const onMove = (e) => {
    if (!isTouch || !targetV) return;

    if (
      action === "pinch" ||
      action === "rate" ||
      action === "seek" ||
      action === "vol" ||
      action === "bri"
    ) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    if (action === "pinch" && e.touches.length === 2) {
      const p = getPinchData(e.touches);
      const deltaDist = p.dist - initPinchDist;
      const steps = Math.round(deltaDist / CFG.pinchStepDist);
      let targetSpeed = initSpeed + steps * CFG.pinchSpeedStep;
      targetSpeed = Math.max(
        0.25,
        Math.min(4.0, Math.round(targetSpeed * 4) / 4),
      );

      if (Math.abs(targetV.playbackRate - targetSpeed) >= 0.01) {
        targetV.dataset.gtUserSpeed = String(targetSpeed);
        targetV.playbackRate = targetSpeed;
        if (navigator.vibrate) {
          try {
            navigator.vibrate(10);
          } catch (err) {}
        }
      }
      showMsg(`${targetSpeed.toFixed(2)}x`);
      return;
    }

    if (action === "pinch" || action === "pinch_wait") return;

    const dx = e.touches[0].clientX - startX,
      dy = startY - e.touches[0].clientY;

    if (action === "rate") {
      targetV.playbackRate = Math.max(
        0.1,
        Math.min(4.0, CFG.rateBase + dx * CFG.senseRate),
      );
      showMsg(`${targetV.playbackRate.toFixed(1)}x`);
      return;
    }

    if (!action) {
      if (Math.abs(dx) > CFG.minDist || Math.abs(dy) > CFG.minDist) {
        clearTimeout(lpTimer); // 只要发生位移立即销毁长按计时器（顶部下拉状态栏不误触加速）

        // 起点在顶部死区（系统下拉栏）、底部死区或原生控件区，严禁触发滑动调节
        if (startInTopDeadzone || startInBottomDeadzone || startInControls) {
          return;
        }

        if (Math.abs(dx) > Math.abs(dy)) {
          action = "seek";
        } else if (startRatio < 0.3) {
          action = "bri";
        } else if (startRatio > 0.7) {
          action = "vol";
        } else {
          action = "none";
        }

        enforceTarget = wasPlayingBeforeSequence ? "playing" : "paused";
        enforceStateUntil = Date.now() + 800;
        if (enforceTarget === "playing" && targetV.paused)
          targetV.play().catch(() => {});
        else if (enforceTarget === "paused" && !targetV.paused) targetV.pause();
      } else return;
    }

    if (action === "seek") {
      targetV.currentTime = Math.max(
        0,
        Math.min(targetV.duration || 0, initTime + dx * CFG.senseX),
      );
      showMsg(
        `${Math.floor(targetV.currentTime / 60)}:${(Math.floor(targetV.currentTime % 60) + "").padStart(2, "0")}`,
      );
    } else if (action === "vol") {
      targetV.dataset.gtUserVol = "1";
      targetV.volume = Math.max(
        0,
        Math.min(1, initVol + (dy / (playerHeight || innerHeight)) * 2 * CFG.senseY),
      );
      showMsg(`Vol: ${Math.round(targetV.volume * 100)}%`);
    } else if (action === "bri") {
      let rawB =
        initBri + (dy / (playerHeight || innerHeight)) * 2 * CFG.senseY;
      rawB = Math.max(0.1, Math.min(2.0, rawB));
      let b = rawB;
      if (rawB >= 0.95 && rawB <= 1.05) {
        b = 1.0;
        if (!inBriSnapZone) {
          inBriSnapZone = true;
          if (navigator.vibrate) {
            try {
              navigator.vibrate(12);
            } catch (e) {}
          }
        }
      } else {
        inBriSnapZone = false;
      }

      if (b === 1.0) {
        targetV.style.filter = "";
        delete targetV.dataset.gtBri;
        showMsg("Bri: 100%");
      } else {
        targetV.style.filter = `brightness(${b})`;
        targetV.dataset.gtBri = b.toFixed(2);
        showMsg(`Bri: ${Math.round(b * 100)}%`);
      }
    }
  };

  const onEnd = (e) => {
    const now = Date.now();

    const cleanupGestureState = () => {
      clearTimeout(lpTimer);
      if (action === "rate" && targetV) {
        targetV.playbackRate = initRate;
        showMsg("");
      }
      action = null;
      isTouch = false;
      targetV = null;
      startInTopDeadzone = false;
      startInBottomDeadzone = false;
      startInControls = false;
      playerCenterX = 0;
      playerHeight = 0;
      startRatio = 0.5;
      inBriSnapZone = false;
    };

    if (tapCount >= 2) {
      suppressClickUntil = Math.max(suppressClickUntil, now + 400);
    }

    // [修复] 尾随物理拦截墙：暴力拦截连击状态下的所有 touchend 遗漏
    if (now < blockGestureUntil) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.cancelable) e.preventDefault();
      cleanupGestureState();
      return;
    }

    if (!isTouch) {
      cleanupGestureState();
      return;
    }
    if (e.touches.length > 0) {
      if (action === "pinch") action = "pinch_wait";
      return;
    }

    clearTimeout(lpTimer);
    if (action === "rate" && targetV) {
      targetV.playbackRate = initRate;
      showMsg("");
    }

    if (action) {
      blockGestureUntil = now + 500;
    }

    const pRef = targetP;
    const vRef = targetV;
    setTimeout(() => {
      if (pRef && !getFS()) pRef.classList.remove("gt-lock-touch");
      if (vRef) vRef.classList.remove("gt-lock-touch");
    }, 100);
    if (isBilibiliHost()) {
      suppressContextMenuUntil = Math.max(suppressContextMenuUntil, now + 1000);
    }
    cleanupGestureState();
  };

  const pOpt = { passive: false, capture: true };
  document.addEventListener("touchstart", onStart, pOpt);
  document.addEventListener("touchmove", onMove, pOpt);
  document.addEventListener("touchend", onEnd, pOpt);
  document.addEventListener("touchcancel", onEnd, pOpt);

  ["pointerdown", "pointerup", "pointercancel", "click", "dblclick"].forEach(
    (evt) => {
      document.addEventListener(
        evt,
        (e) => {
          if (Date.now() < blockGestureUntil) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
          } else if (evt === "click") {
            if (Date.now() < suppressClickUntil) {
              e.stopPropagation();
              e.stopImmediatePropagation();
              e.preventDefault();
            }
          } else if (evt === "dblclick") {
            const isTouchGenerated =
              e.sourceCapabilities?.firesTouchEvents ||
              (e.pointerType && e.pointerType === "touch") ||
              Date.now() - lastTapTime < 700;
            const onVideo =
              e.target.tagName === "VIDEO" ||
              !!findUp(e.target, VIP_SELECTORS) ||
              (targetP && targetP.contains(e.target));
            if (
              (isTouchGenerated || Date.now() < blockGestureUntil) &&
              onVideo
            ) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
            }
          }
        },
        { capture: true, passive: false },
      );
    },
  );

  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!isBilibiliHost()) return;
      const onVideo = !!findUp(
        e.target,
        ".bpx-player-container, #bilibili-player, .html5-video-player, video",
      );
      // 触控进行中 (isTouch) 或处于触碰后保护期内，坚决阻止弹出右键菜单
      if (onVideo && (isTouch || Date.now() < suppressContextMenuUntil)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    },
    { capture: true, passive: false },
  );

  document.addEventListener(
    "selectstart",
    (e) => {
      if (isInteractiveInput(e.target)) return;
      const onVideo =
        !!findUp(e.target, VIP_SELECTORS) ||
        (targetP && targetP.contains(e.target));
      if (onVideo) {
        e.preventDefault();
        const sel = window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      }
    },
    { capture: true },
  );

  [
    "fullscreenchange",
    "webkitfullscreenchange",
    "mozfullscreenchange",
    "MSFullscreenChange",
  ].forEach((evt) => {
    document.addEventListener(evt, () => {
      let fsEl = getFS();
      if (!fsEl) {
        document
          .querySelectorAll(".gt-fullscreen-active")
          .forEach((el) => {
            el.classList.remove("gt-fullscreen-active");
          });
        document
          .querySelectorAll(".gt-lock-touch")
          .forEach((el) => el.classList.remove("gt-lock-touch"));
        if (screen.orientation?.unlock) {
          screen.orientation.unlock();
          try {
            window.top.postMessage({ type: "gt_unlock_orientation" }, "*");
          } catch (e) {}
        }
        schedulePlaybackStateEnforcement(2000);
      } else {
        schedulePlaybackStateEnforcement(2000);
        setTimeout(() => {
          let v =
            activeFullscreenVideo || targetV || document.querySelector("video");
          if (v) {
            const dir =
              v.videoWidth > 0 && v.videoWidth < v.videoHeight
                ? "portrait"
                : "landscape";
            if (screen.orientation?.lock) {
              screen.orientation
                .lock(dir)
                .catch(() => {
                  try {
                    window.top.postMessage(
                      { type: "gt_lock_orientation", dir: dir },
                      "*",
                    );
                  } catch (err) {}
                })
                .finally(() => {
                  syncPlaybackStateAfterTransition();
                });
            } else {
              try {
                window.top.postMessage(
                  { type: "gt_lock_orientation", dir: dir },
                  "*",
                );
              } catch (err) {}
              syncPlaybackStateAfterTransition();
            }
          }
        }, 150);
      }
    });
  });

  const applyDefaultPlaybackRate = (video) => {
    if (!video || video.tagName !== "VIDEO" || video.dataset.gtDefaultRate) return;
    video.dataset.gtDefaultRate = "applied";
    video.defaultPlaybackRate = CFG.defaultPlaybackRate;
    video.playbackRate = CFG.defaultPlaybackRate;
    setTimeout(() => {
      if (video.dataset.gtDefaultRate === "applied" && !video.dataset.gtUserSpeed) {
        video.playbackRate = CFG.defaultPlaybackRate;
      }
    }, 200);
  };

  const unmuteBiliPlayer = () => {
    if (!isBilibiliHost()) return false;
    const muteIcon = document.querySelector(
      ".bpx-player-ctrl-muted-icon, " +
        ".bilibili-player-iconfont-volume-muted, " +
        ".bilibili-player-video-btn-volume.video-state-volume-muted, " +
        ".bpx-player-ctrl-volume[data-state='muted'], " +
        "[aria-label*='取消静音'], [title*='取消静音'], " +
        "[aria-label*='开启声音'], [title*='开启声音']",
    );
    if (muteIcon) {
      try {
        const clickable =
          muteIcon.closest(
            ".bpx-player-ctrl-volume-icon, .bpx-player-ctrl-volume, .bilibili-player-video-btn-volume",
          ) || muteIcon;
        clickable.click();
        return true;
      } catch (err) {}
    }
    return false;
  };

  const applyDefaultVolume = (video) => {
    if (!video || video.tagName !== "VIDEO" || video.dataset.gtUserVol) return;

    if (video.muted) {
      video.muted = false;
    }
    try {
      if (video.volume !== 1.0) {
        video.volume = 1.0;
      }
    } catch (e) {}

    unmuteBiliPlayer();

    if (isBilibiliHost()) {
      try {
        const raw = localStorage.getItem("bilibili_player_settings");
        if (raw) {
          const cfg = JSON.parse(raw);
          if (cfg && cfg.video_status && cfg.video_status.volume !== 1) {
            cfg.video_status.volume = 1;
            localStorage.setItem(
              "bilibili_player_settings",
              JSON.stringify(cfg),
            );
          }
        }
      } catch (e) {}
    }
  };

  const closeDanmaku = () => {
    if (!isBilibiliHost()) return;
    const dmSwitch = document.querySelector(
      ".bpx-player-dm-switch, .bilibili-player-video-danmaku-switch",
    );
    if (!dmSwitch) return;

    const checkbox = dmSwitch.querySelector('input[type="checkbox"]');
    if (checkbox) {
      if (checkbox.checked) checkbox.click();
    } else {
      const isOpen =
        dmSwitch.getAttribute("data-state") === "opened" ||
        dmSwitch.classList.contains("bui-switch-checked") ||
        Boolean(
          dmSwitch.querySelector(".bui-switch-checked, .bui-checkbox-checked"),
        );
      if (isOpen) dmSwitch.click();
    }
  };

  const openSubtitle = () => {
    document.querySelectorAll("video").forEach((v) => {
      if (v.textTracks) {
        for (let i = 0; i < v.textTracks.length; i++) {
          const t = v.textTracks[i];
          if (t.kind === "subtitles" || t.kind === "captions") {
            t.mode = "showing";
          }
        }
      }
    });

    if (!isBilibiliHost()) return;

    const subBtn = document.querySelector(
      ".bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle",
    );
    if (!subBtn) return;
    const style = window.getComputedStyle(subBtn);
    if (style.display === "none" || subBtn.offsetParent === null) return;

    const isActive = Boolean(
      document.querySelector(
        ".bpx-player-ctrl-subtitle-language-item.bpx-state-active",
      ) ||
        subBtn.classList.contains("bpx-state-active") ||
        subBtn.getAttribute("data-state") === "active",
    );
    if (isActive) return;

    const panel = document.querySelector(".bpx-player-ctrl-subtitle-box");
    const isMenuOpen = panel && panel.offsetParent !== null;

    if (isMenuOpen) {
      const langItem = document.querySelector(
        ".bpx-player-ctrl-subtitle-language-item[data-lan], .bpx-player-ctrl-subtitle-language-item",
      );
      if (langItem) langItem.click();
    } else {
      subBtn.click();
      setTimeout(() => {
        const langItem = document.querySelector(
          ".bpx-player-ctrl-subtitle-language-item[data-lan], .bpx-player-ctrl-subtitle-language-item",
        );
        if (langItem) {
          langItem.click();
          setTimeout(() => {
            const currentPanel = document.querySelector(
              ".bpx-player-ctrl-subtitle-box",
            );
            if (currentPanel && currentPanel.offsetParent !== null) {
              subBtn.click();
            }
          }, 100);
        } else {
          const currentPanel = document.querySelector(
            ".bpx-player-ctrl-subtitle-box",
          );
          if (currentPanel && currentPanel.offsetParent !== null) {
            subBtn.click();
          }
        }
      }, 200);
    }
  };

  const schedulePreferences = (video) => {
    if (!video || video.dataset.gtPrefScheduled === "1") return;
    video.dataset.gtPrefScheduled = "1";

    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      closeDanmaku();
      openSubtitle();
      if (!video.dataset.gtUserVol) {
        applyDefaultVolume(video);
      }
      if (tries >= 10) {
        clearInterval(timer);
      }
    }, 400);
  };

  document.addEventListener(
    "play",
    (e) => {
      applyDefaultPlaybackRate(e.target);
      applyDefaultVolume(e.target);
      schedulePreferences(e.target);
    },
    true,
  );

  document.addEventListener(
    "playing",
    (e) => {
      applyDefaultPlaybackRate(e.target);
      applyDefaultVolume(e.target);
      schedulePreferences(e.target);
    },
    true,
  );

  document.addEventListener(
    "loadedmetadata",
    (e) => {
      applyDefaultPlaybackRate(e.target);
      applyDefaultVolume(e.target);
      schedulePreferences(e.target);
    },
    true,
  );

  document.addEventListener(
    "loadstart",
    (e) => {
      const v = e.target;
      if (v && v.tagName === "VIDEO") {
        delete v.dataset.gtDefaultRate;
        delete v.dataset.gtUserSpeed;
        delete v.dataset.gtDefaultVol;
        delete v.dataset.gtUserVol;
        delete v.dataset.gtPrefScheduled;
      }
    },
    true,
  );

  document.addEventListener(
    "ratechange",
    (e) => {
      const v = e.target;
      if (v && v.tagName === "VIDEO" && v.dataset.gtDefaultRate === "applied") {
        if (v.playbackRate !== CFG.defaultPlaybackRate) {
          v.dataset.gtUserSpeed = "1";
        }
      }
    },
    true,
  );

  document.addEventListener(
    "pause",
    (e) => {
      const v = e.target;
      if (v && v.tagName === "VIDEO") {
        if (Date.now() < enforceStateUntil && enforceTarget === "playing") {
          v.play().catch(() => {});
        }
      }
    },
    true,
  );

  document.addEventListener(
    "play",
    (e) => {
      const v = e.target;
      if (v && v.tagName === "VIDEO") {
        if (Date.now() < enforceStateUntil && enforceTarget === "paused") {
          v.pause();
        }
      }
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (
        e.target &&
        e.target.closest &&
        e.target.closest(
          ".bpx-player-ctrl-volume-box, .bpx-player-ctrl-volume-progress, .bilibili-player-volume",
        )
      ) {
        document.querySelectorAll("video").forEach((v) => {
          v.dataset.gtUserVol = "1";
        });
      }
    },
    true,
  );

  document.addEventListener(
    "click",
    (e) => {
      const volBtn =
        e.target &&
        e.target.closest &&
        e.target.closest(
          ".bpx-player-ctrl-volume, .bilibili-player-video-btn-volume",
        );
      if (volBtn) {
        const isMuted = volBtn.querySelector(
          ".bpx-player-ctrl-muted-icon, .bilibili-player-iconfont-volume-muted",
        );
        if (!isMuted) {
          document.querySelectorAll("video").forEach((v) => {
            v.dataset.gtUserVol = "1";
          });
        }
      }
    },
    true,
  );

  const onUserGestureUnmute = (e) => {
    if (
      e.target &&
      e.target.closest &&
      e.target.closest(
        ".bpx-player-ctrl-volume, .bilibili-player-video-btn-volume, .bpx-player-ctrl-volume-box",
      )
    ) {
      return;
    }
    document.querySelectorAll("video").forEach((v) => {
      if (findUp(v, ".bili-header, .animated-banner, header, [role='banner']")) {
        return;
      }
      if (!v.dataset.gtUserVol) {
        applyDefaultVolume(v);
      }
    });
  };

  ["touchstart", "pointerdown", "click"].forEach((evt) => {
    document.addEventListener(evt, onUserGestureUnmute, {
      capture: true,
      passive: true,
    });
  });

  const scanExistingVideos = () => {
    document.querySelectorAll("video").forEach((v) => {
      if (findUp(v, ".bili-header, .animated-banner, header, [role='banner']")) {
        return;
      }
      applyDefaultPlaybackRate(v);
      applyDefaultVolume(v);
      schedulePreferences(v);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanExistingVideos, {
      once: true,
    });
  } else {
    scanExistingVideos();
  }
})();
