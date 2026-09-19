// ==UserScript==
// @name         HTML5视频手势 x Bilibili触屏优化
// @namespace    http://tampermonkey.net/
// @version      65.16
// @description  保留HTML5视频手势核心逻辑，并融合B站收藏/历史触屏Hover优化与长按防右键菜单。
// @author       Gemini & 仙, Blysh, Fusion by Copilot
// @license      MIT
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const CFG = {
    minDist: 10,
    longPress: 500,
    rateBase: 3.0,
    senseX: 0.25,
    senseY: 1.0,
    progressBarColor: "#FF6699",
    uiTimeout: 2500,
    maxScale: 8.0,
    senseRate: 0.015,
  };

  let seekSec = GM_getValue("gt_seek_sec", 10);
  let seekMode = GM_getValue("gt_seek_mode", "sec");
  let fpsMode = GM_getValue("gt_fps", 30);

  let state = {
    isScreenLocked: false,
    pinchMode: "speed",
    scale: 1.0,
    panX: 0,
    panY: 0,
  };
  // [修复] 将 lastTap 替换为更为精准的连击计数器机制
  let startX,
    startY,
    initVol,
    initTime,
    initRate,
    targetV,
    targetP,
    isTouch = false,
    action = null,
    lpTimer = null,
    toastTimer = null,
    lastTapTime = 0,
    tapCount = 0,
    uiTimer = null;
  let activeSeekSide = null,
    seekAccumulator = 0,
    seekSessionTimer = null,
    wasPlayingBeforeSequence = false;
  let initPinchDist = 0,
    initScale = 1.0,
    initPanX = 0,
    initPanY = 0,
    initSpeed = 1.0,
    initCenterX = 0,
    initCenterY = 0,
    originDx = 0,
    originDy = 0;

  let blockGestureUntil = 0;
  let suppressContextMenuUntil = 0;
  let enforceStateUntil = 0;
  let enforceTarget = null;

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

  const initBiliNavHoverShim = () => {
    if (!isBilibiliHost()) return;

    const bind = (entryRoot) => {
      if (!entryRoot || entryRoot.dataset.gtBiliHoverBound === "1") return;
      entryRoot.dataset.gtBiliHoverBound = "1";

      const onClick = (event) => {
        const target = event.target;
        const anchor = target && target.closest ? target.closest("a") : null;
        if (!anchor) return;

        // 仅处理右上导航一级入口：ul.right-entry > li > a。
        // 这样弹层内的“查看全部”等二级按钮不会被误拦截。
        const isTopNavAnchor =
          anchor.parentElement &&
          anchor.parentElement.tagName === "LI" &&
          anchor.parentElement.parentElement === entryRoot;
        if (!isTopNavAnchor) {
          return;
        }

        const href = (anchor.getAttribute("href") || "").toLowerCase();
        const label =
          `${anchor.textContent || ""} ${anchor.getAttribute("title") || ""} ${anchor.getAttribute("aria-label") || ""}`.toLowerCase();

        const isHistory =
          href.includes("/history") ||
          label.includes("历史") ||
          label.includes("history");
        const isFavorite =
          href.includes("/favlist") ||
          href.includes("/favorite") ||
          label.includes("收藏") ||
          label.includes("favorite") ||
          label.includes("favourite");

        // 仅收藏/历史阻止默认跳转，个人中心等其它入口保持直接进入。
        if (isHistory || isFavorite) {
          event.preventDefault();
        }
      };

      entryRoot.addEventListener("click", onClick);
    };

    const tryBind = () => {
      const entry =
        document.querySelector("#biliMainHeader ul.right-entry") ||
        document.querySelector(".right-entry");
      if (entry) bind(entry);
    };

    tryBind();
    setInterval(tryBind, 1200);
  };
  initBiliNavHoverShim();

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
    const isFS =
      !!(document.fullscreenElement || document.webkitFullscreenElement) ||
      container.classList.contains("gt-fullscreen-active");
    const fsBtn = container.querySelector(
      '.art-icon-fullscreenOn, .art-control-fullscreen, .dplayer-full-icon, .plyr__control[data-plyr="fullscreen"], .vjs-fullscreen-control, .xgplayer-fullscreen, .tcplayer-fullscreen-btn, .prism-fullscreen-btn, [aria-label*="全屏"], [title*="全屏"], .fullscreen-btn, .bilibili-player-video-btn-fullscreen',
    );

    if (isFS) {
      if (fsBtn) {
        try {
          fsBtn.click();
        } catch (e) {}
      }

      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      container.classList.remove("gt-fullscreen-active");
      if (screen.orientation?.unlock) {
        screen.orientation.unlock();
        try {
          window.top.postMessage({ type: "gt_unlock_orientation" }, "*");
        } catch (e) {}
      }
    } else {
      const forceLockLandscape = () => {
        const dir =
          video && video.videoWidth > 0 && video.videoWidth < video.videoHeight
            ? "portrait"
            : "landscape";
        if (screen.orientation?.lock) {
          screen.orientation.lock(dir).catch(() => {
            try {
              window.top.postMessage(
                { type: "gt_lock_orientation", dir: dir },
                "*",
              );
            } catch (err) {}
          });
        } else {
          try {
            window.top.postMessage(
              { type: "gt_lock_orientation", dir: dir },
              "*",
            );
          } catch (err) {}
        }
      };

      if (fsBtn) {
        try {
          fsBtn.click();
        } catch (e) {}
      }

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
      }
    }
  };

  GM_registerMenuCommand("🔗 拷贝视频源(直链/页面)", () => {
    if (sniffedUrl) {
      GM_setClipboard(sniffedUrl);
      showMsg("已复制嗅探流媒体直链");
      return;
    }
    let v =
      targetV ||
      (document.querySelectorAll("video").length > 0
        ? Array.from(document.querySelectorAll("video")).sort(
            (a, b) =>
              b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
          )[0]
        : null);
    if (!v) {
      showMsg("未找到视频元素");
      return;
    }
    let src = v.src;
    if (!src || src.startsWith("blob:")) {
      const s = v.querySelector("source");
      if (s && s.src) src = s.src;
    }
    if (src && !src.startsWith("blob:")) {
      GM_setClipboard(src);
      showMsg("已复制视频直链");
    } else {
      GM_setClipboard(window.location.href);
      showMsg("已复制网页源地址");
    }
  });

  let sniffedUrl = "";
  const mediaReg = /\.(m3u8|mpd|mp4|webm|flv)(\?|$)/i;
  const sniff = (url) => {
    try {
      if (
        url &&
        typeof url === "string" &&
        mediaReg.test(url) &&
        url.startsWith("http")
      )
        sniffedUrl = url;
    } catch (e) {}
  };

  const oFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      let u =
        typeof args[0] === "string"
          ? args[0]
          : args[0] && args[0].url
            ? args[0].url
            : "";
      sniff(u);
    } catch (e) {}
    return oFetch.apply(window, args);
  };
  const oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      sniff(url);
    } catch (e) {}
    return oOpen.call(this, method, url, ...rest);
  };

  const toggleOrientation = () => {
    if (!screen.orientation) return;
    const dir = screen.orientation.type.startsWith("landscape")
      ? "portrait"
      : "landscape";
    if (screen.orientation.lock) {
      screen.orientation.lock(dir).catch(() => {
        try {
          window.top.postMessage(
            { type: "gt_lock_orientation", dir: dir },
            "*",
          );
        } catch (e) {}
      });
    }
  };

  const TOUCH_LOCK_SELECTORS =
    '.video-js, .vjs-custom-skin, .player-container, .art-video-player, .xgplayer, .tcplayer, .prism-player, .mui-player, [data-testid="videoComponent"], .plyr, #html5video, #movie_player, .html5-video-player, .bpx-player-container, .dplayer, .artplayer-app, .MacPlayer, .ckplayer, #playleft, video, .gt-lock-touch';

  GM_addStyle(`
        ${TOUCH_LOCK_SELECTORS} { touch-action: none !important; overscroll-behavior: none !important; }
        
        .dplayer-pause-ad, .dplayer-notice, .dplayer-ad, .artplayer-plugin-ads, .art-ad, .art-notice, .MacPlayer .play-ad, #playleft .pause-ad, .player-ad, .ad-box, .pause-ad, .ad-mask, .pause-html, #pause-html, [class*="pause-html"], [id*="pause-html"] { display: none !important; pointer-events: none !important; opacity: 0 !important; z-index: -2147483648 !important; width: 0 !important; height: 0 !important; }
        .gt-toast { position: fixed; top: 10%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.15); color: #fff; padding: 4px 10px; border-radius: 4px; font: 700 14px system-ui; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.2s; text-shadow: 0 0 2px #000; border: 1px solid rgba(255,255,255,0.05); }
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
        
        .gt-ui-layer { position: absolute !important; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none !important; z-index: 2147483647 !important; }
        
        .gt-mini-progress { position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: rgba(255,255,255,0.2); z-index: 2147483640; pointer-events: none; overflow: hidden; opacity: 0.9; transition: height 0.2s, opacity 0.3s; box-shadow: 0 -1px 1px rgba(0,0,0,0.2); }
        .gt-mini-progress .gt-fill { height: 100%; width: 0%; background: ${CFG.progressBarColor}; transition: width 0.1s linear; box-shadow: 0 0 4px ${CFG.progressBarColor}; }
        :fullscreen .gt-mini-progress, .gt-fullscreen-active .gt-mini-progress { height: 3px !important; }
        .gt-lock-shield { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483645; background: rgba(0,0,0,0); touch-action: none; display: none; pointer-events: auto; }
        :fullscreen .gt-lock-shield, .gt-fullscreen-active .gt-lock-shield { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; }
        
        .gt-btn-base { position: absolute; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; z-index: 2147483647; opacity: 0; pointer-events: none; transition: opacity 0.3s ease, transform 0.15s ease; border: none; background: transparent; color: rgba(255, 255, 255, 0.95); filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.8)); }
        .gt-btn-base * { pointer-events: none !important; }
        .gt-btn-base svg { width: 15px; height: 15px; transition: all 0.2s ease; transform-origin: center center; fill: none !important; stroke: currentColor !important; stroke-width: 2 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
        .gt-btn-base svg * { fill: none !important; stroke: currentColor !important; stroke-width: 2 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
        
        .gt-btn-base span { font-size: 11px; font-weight: 800; font-family: system-ui; letter-spacing: 0.5px; transform-origin: center center; display: inline-block; }
        .gt-ui-visible .gt-btn-base { opacity: 0.65 !important; pointer-events: auto !important; }
        .gt-ui-visible .gt-btn-base.hidden-by-state { display: none !important; pointer-events: none !important; }
        .gt-btn-base:active { opacity: 0.9 !important; color: #fff; }
        
        .gt-rotate-btn { top: 10px; left: 10px; }
        .gt-seek-mode-btn { top: calc(10px + 38px); left: 10px; }
        .gt-seek-val-btn { top: calc(10px + 76px); left: 10px; }
        .gt-reset-speed-btn { top: calc(50% + 40px); left: 10px; transform: translateY(-50%); }
 
        .gt-lock-btn { top: calc(50% - 38px); right: 10px; transform: translateY(-50%); }
        .gt-mode-btn { top: calc(50% + 40px); right: 10px; transform: translateY(-50%); }
        .gt-reset-zoom-btn { top: calc(50% + 78px); right: 10px; transform: translateY(-50%); }
        
        :fullscreen .gt-btn-base, .gt-fullscreen-active .gt-btn-base { width: 38px; height: 38px; }
        :fullscreen .gt-ui-visible .gt-btn-base, .gt-fullscreen-active .gt-ui-visible .gt-btn-base { opacity: 0.5 !important; }
        :fullscreen .gt-btn-base svg, .gt-fullscreen-active .gt-btn-base svg { width: 22px; height: 22px; }
        :fullscreen .gt-btn-base span, .gt-fullscreen-active .gt-btn-base span { font-size: 14px; }
        :fullscreen .gt-rotate-btn, .gt-fullscreen-active .gt-rotate-btn { top: 20px; left: 20px; }
        :fullscreen .gt-seek-mode-btn, .gt-fullscreen-active .gt-seek-mode-btn { top: calc(20px + 60px); left: 20px; }
        :fullscreen .gt-seek-val-btn, .gt-fullscreen-active .gt-seek-val-btn { top: calc(20px + 120px); left: 20px; }
        
        :fullscreen .gt-reset-speed-btn, .gt-fullscreen-active .gt-reset-speed-btn { top: calc(50% + 35px); left: 20px; }
        :fullscreen .gt-lock-btn, .gt-fullscreen-active .gt-lock-btn { top: calc(50% - 35px); right: 20px; }
        :fullscreen .gt-mode-btn, .gt-fullscreen-active .gt-mode-btn { top: calc(50% + 35px); right: 20px; }
        :fullscreen .gt-reset-zoom-btn, .gt-fullscreen-active .gt-reset-zoom-btn { top: calc(50% + 85px); right: 20px; }
    `);

  const SVG_LOCK = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
  const SVG_UNLOCK = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`;
  const SVG_SPEED = `<svg viewBox="0 0 24 24" width="100%" height="100%"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
  const SVG_ZOOM = `<svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`;
  const SVG_RESET_ZOOM = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke-dasharray="4 2"></rect></svg>`;
  const SVG_SEC = `<svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
  const SVG_FRAME = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>`;

  const getFS = () =>
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement;

  const identify = (e) => {
    const t = e.target;
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
        targetVideo = Array.from(videos).sort(
          (a, b) =>
            b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
        )[0];
        if (targetVideo && targetVideo.clientWidth > 50) {
          rootContainer =
            findUp(targetVideo, VIP_SELECTORS) || targetVideo.parentNode;
        } else targetVideo = null;
      }
    }

    if (!targetVideo) return null;

    if (rootContainer && rootContainer.tagName === "VIDEO") {
      rootContainer = rootContainer.parentNode;
    }

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
    }

    return {
      root: rootContainer,
      video: targetVideo,
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
    const p = document.fullscreenElement || document.body;
    if (t.parentNode !== p) p.appendChild(t);
    t.innerText = txt;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 800);
  };

  let activeUIEl = null;
  const updateUIState = (root, video) => {
    if (!root) return;
    const uiLayer = root.querySelector(".gt-ui-layer");
    if (!uiLayer) return;
    const btnLock = uiLayer.querySelector(".gt-lock-btn"),
      btnMode = uiLayer.querySelector(".gt-mode-btn"),
      btnRot = uiLayer.querySelector(".gt-rotate-btn"),
      btnRst = uiLayer.querySelector(".gt-reset-speed-btn"),
      btnZoomRst = uiLayer.querySelector(".gt-reset-zoom-btn"),
      btnSeekMode = uiLayer.querySelector(".gt-seek-mode-btn"),
      btnSeekVal = uiLayer.querySelector(".gt-seek-val-btn"),
      shield = uiLayer.querySelector(".gt-lock-shield");
    const isFS = !!getFS() || root.classList.contains("gt-fullscreen-active");

    if (btnLock)
      btnLock.innerHTML = state.isScreenLocked ? SVG_LOCK : SVG_UNLOCK;
    if (btnMode)
      btnMode.innerHTML = state.pinchMode === "speed" ? SVG_SPEED : SVG_ZOOM;
    if (btnSeekMode)
      btnSeekMode.innerHTML = seekMode === "sec" ? SVG_SEC : SVG_FRAME;
    if (btnSeekVal)
      btnSeekVal.innerHTML = `<span>${seekMode === "sec" ? seekSec + "s" : fpsMode + "f"}</span>`;

    if (state.isScreenLocked) {
      if (shield) shield.style.display = "block";
      [btnMode, btnRot, btnRst, btnZoomRst, btnSeekMode, btnSeekVal].forEach(
        (b) => b?.classList.add("hidden-by-state"),
      );
    } else {
      if (shield) shield.style.display = "none";
      [btnMode, btnSeekMode, btnSeekVal].forEach((b) =>
        b?.classList.remove("hidden-by-state"),
      );
      if (btnRot) {
        if (isFS) btnRot.classList.remove("hidden-by-state");
        else btnRot.classList.add("hidden-by-state");
      }
      if (btnRst) {
        if (video && video.playbackRate !== 1.0)
          btnRst.classList.remove("hidden-by-state");
        else btnRst.classList.add("hidden-by-state");
      }
      if (btnZoomRst) {
        if (state.scale > 1.0) btnZoomRst.classList.remove("hidden-by-state");
        else btnZoomRst.classList.add("hidden-by-state");
      }
    }
  };

  const wakeUpUI = (root, video) => {
    if (!root) return;
    const uiLayer = root.querySelector(".gt-ui-layer");
    if (!uiLayer) return;
    if (activeUIEl && activeUIEl !== uiLayer)
      activeUIEl.classList.remove("gt-ui-visible");
    activeUIEl = uiLayer;
    uiLayer.classList.add("gt-ui-visible");
    updateUIState(root, video);
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      if (activeUIEl) activeUIEl.classList.remove("gt-ui-visible");
      activeUIEl = null;
    }, CFG.uiTimeout);
  };
  const hideUI = (root) => {
    if (!root) return;
    const uiLayer = root.querySelector(".gt-ui-layer");
    if (uiLayer) {
      uiLayer.classList.remove("gt-ui-visible");
      if (activeUIEl === uiLayer) activeUIEl = null;
    }
    if (uiTimer) clearTimeout(uiTimer);
  };

  const applyTransform = () => {
    if (!targetV) return;
    if (state.scale <= 1.05) {
      state.scale = 1.0;
      state.panX = 0;
      state.panY = 0;
    } else {
      const mX = (targetV.clientWidth * state.scale - targetV.clientWidth) / 2,
        mY = (targetV.clientHeight * state.scale - targetV.clientHeight) / 2;
      state.panX = Math.max(-mX, Math.min(mX, state.panX));
      state.panY = Math.max(-mY, Math.min(mY, state.panY));
    }
    targetV.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
  };

  let pendingRate = null;
  let lastRateUpdateTime = 0;
  const setRateThrottled = (v, rate) => {
    pendingRate = rate;
    const now = Date.now();
    if (now - lastRateUpdateTime > 150) {
      v.playbackRate = pendingRate;
      lastRateUpdateTime = now;
      pendingRate = null;
    }
  };

  const bindTap = (btn, handler) => {
    let lastExec = 0;
    const wrap = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type === "touchend" && e.cancelable) e.preventDefault();
      const now = Date.now();
      if (now - lastExec < 300) return;
      lastExec = now;
      handler(e);
      const icon = btn.querySelector("svg") || btn.querySelector("span");
      if (icon) {
        icon.classList.remove("gt-pop-anim");
        void icon.offsetWidth;
        icon.classList.add("gt-pop-anim");
      }
    };
    btn.addEventListener("touchend", wrap, { passive: false, capture: true });
    btn.addEventListener("click", wrap, { capture: true });
    [
      "touchstart",
      "mousedown",
      "pointerdown",
      "contextmenu",
      "dblclick",
    ].forEach((evt) => {
      btn.addEventListener(
        evt,
        (e) => {
          e.stopPropagation();
          e.stopImmediatePropagation();
        },
        { capture: true, passive: false },
      );
    });
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

      const shield = document.createElement("div");
      shield.className = "gt-lock-shield";
      const blk = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        wakeUpUI(root, video);
      };
      [
        "click",
        "mousedown",
        "mouseup",
        "pointerdown",
        "pointerup",
        "dblclick",
        "touchstart",
        "touchend",
      ].forEach((evt) =>
        shield.addEventListener(evt, blk, { capture: true, passive: false }),
      );
      uiLayer.appendChild(shield);

      const rBtn = document.createElement("div");
      rBtn.className = "gt-btn-base gt-rotate-btn";
      rBtn.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>`;
      bindTap(rBtn, () => {
        toggleOrientation();
        wakeUpUI(root, video);
      });
      uiLayer.appendChild(rBtn);
      const smBtn = document.createElement("div");
      smBtn.className = "gt-btn-base gt-seek-mode-btn";
      bindTap(smBtn, () => {
        seekMode = seekMode === "sec" ? "frame" : "sec";
        GM_setValue("gt_seek_mode", seekMode);
        updateUIState(root, video);
        showMsg(`切换为: ${seekMode === "sec" ? "按秒" : "按帧"}`);
        wakeUpUI(root, video);
      });
      uiLayer.appendChild(smBtn);
      const svBtn = document.createElement("div");
      svBtn.className = "gt-btn-base gt-seek-val-btn";
      bindTap(svBtn, () => {
        if (seekMode === "sec") {
          const a = [10, 15, 30, 1, 5];
          seekSec = a[(a.indexOf(seekSec) + 1) % a.length];
          GM_setValue("gt_seek_sec", seekSec);
          showMsg(`步进: ${seekSec}s`);
        } else {
          fpsMode = fpsMode === 30 ? 60 : 30;
          GM_setValue("gt_fps", fpsMode);
          showMsg(`帧率: ${fpsMode}`);
        }
        updateUIState(root, video);
        wakeUpUI(root, video);
      });
      uiLayer.appendChild(svBtn);
      const lBtn = document.createElement("div");
      lBtn.className = "gt-btn-base gt-lock-btn";
      bindTap(lBtn, () => {
        state.isScreenLocked = !state.isScreenLocked;
        if (state.isScreenLocked) {
          const r = video.getBoundingClientRect();
          const clk = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          });
          video.dispatchEvent(clk);
        }
        wakeUpUI(root, video);
      });
      uiLayer.appendChild(lBtn);
      const mBtn = document.createElement("div");
      mBtn.className = "gt-btn-base gt-mode-btn";
      bindTap(mBtn, () => {
        state.pinchMode = state.pinchMode === "speed" ? "zoom" : "speed";
        wakeUpUI(root, video);
        showMsg(state.pinchMode === "speed" ? "双指: 变速" : "双指: 缩平移");
      });
      uiLayer.appendChild(mBtn);
      const rstBtn = document.createElement("div");
      rstBtn.className = "gt-btn-base gt-reset-speed-btn";
      rstBtn.innerHTML = `<span>1.0x</span>`;
      bindTap(rstBtn, () => {
        video.playbackRate = 1.0;
        showMsg("恢复原速");
        wakeUpUI(root, video);
      });
      uiLayer.appendChild(rstBtn);
      const zoomRstBtn = document.createElement("div");
      zoomRstBtn.className = "gt-btn-base gt-reset-zoom-btn";
      zoomRstBtn.innerHTML = SVG_RESET_ZOOM;
      bindTap(zoomRstBtn, () => {
        state.scale = 1.0;
        state.panX = 0;
        state.panY = 0;
        if (video.parentNode && video.parentNode.dataset.gtOverflow) {
          video.parentNode.style.overflow = video.parentNode.dataset.gtOverflow;
        }
        if (video) video.style.transform = `translate(0px, 0px) scale(1)`;
        showMsg("恢复大小");
        wakeUpUI(root, video);
      });
      uiLayer.appendChild(zoomRstBtn);

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
    const stepVal = seekMode === "sec" ? seekSec : 1 / fpsMode;
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
        ? `<div class="gt-arrows"><span>‹</span><span class="gt-arrow-slide-l">‹</span></div><span class="gt-seek-text gt-pop-anim">-${seekMode === "sec" ? seekAccumulator : Math.round(seekAccumulator * fpsMode)}${seekMode === "sec" ? "s" : "帧"}</span>`
        : `<span class="gt-seek-text gt-pop-anim">+${seekMode === "sec" ? seekAccumulator : Math.round(seekAccumulator * fpsMode)}${seekMode === "sec" ? "s" : "帧"}</span><div class="gt-arrows"><span class="gt-arrow-slide-r">›</span><span>›</span></div>`;
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
          ".plyr--fullscreen-active, .jw-flag-fullscreen, .gt-fullscreen-active, .gt-ui-visible",
        )
        .forEach((el) => {
          el.classList.remove(
            "plyr--fullscreen-active",
            "jw-flag-fullscreen",
            "gt-fullscreen-active",
            "gt-ui-visible",
          );
          el.style.cssText = "";
        });
    }

    const isBtn = findUp(e.target, ".gt-btn-base");
    const isFS =
      !!getFS() ||
      (targetP && targetP.classList.contains("gt-fullscreen-active"));

    if (state.isScreenLocked && !isBtn) {
      if (isFS || (targetP && targetP.contains(e.target))) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (targetP && targetV) wakeUpUI(targetP, targetV);
        lastTapTime = Date.now();
        return;
      }
    }

    if (isBtn) {
      clearTimeout(lpTimer);
      return;
    }

    let hit = identify(e);
    if (!hit || !hit.video) return;
    targetP = ensureUIAndWrapper(hit);
    targetV = hit.video;
    // 仅在触摸操作后短窗口拦截右键菜单，避免长期影响鼠标右键。
    if (isBilibiliHost()) {
      suppressContextMenuUntil = Date.now() + 2000;
    }

    clearTimeout(lpTimer);
    const now = Date.now();

    // [修复] 引入连击追踪，抛弃旧版的双击清零逻辑
    const isRapid = now - lastTapTime < 350;
    if (!isRapid) {
      tapCount = 1;
      wasPlayingBeforeSequence = targetV ? !targetV.paused : false;
    } else {
      tapCount++;
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
      blockGestureUntil = now + 500;
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

      if (r < 0.3) handleAccumulatedSeek("left", uiLayer, targetV);
      else if (r > 0.7) handleAccumulatedSeek("right", uiLayer, targetV);
      else if (tapCount === 2) toggleNativeFullscreen(targetP, targetV);

      enforceTarget = wasPlayingBeforeSequence ? "playing" : "paused";
      enforceStateUntil = now + 800;
      if (enforceTarget === "playing" && targetV.paused)
        targetV.play().catch(() => {});
      else if (enforceTarget === "paused" && !targetV.paused) targetV.pause();

      isTouch = false; // 标记本序列已被阻断，无需追踪常规手势
      if (getFS()) hideUI(targetP);
      return;
    }

    isTouch = true;
    action = null;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    initVol = targetV.volume;
    initTime = targetV.currentTime;
    initRate = targetV.playbackRate;

    if (e.touches.length === 2) {
      const p = getPinchData(e.touches);
      initPinchDist = p.dist;
      initCenterX = p.cx;
      initCenterY = p.cy;
      initScale = state.scale;
      initPanX = state.panX;
      initPanY = state.panY;
      initSpeed = targetV.playbackRate;
      const rect = targetV.getBoundingClientRect();
      originDx = initCenterX - (rect.left + rect.width / 2 - initPanX);
      originDy = initCenterY - (rect.top + rect.height / 2 - initPanY);
      action = "pinch";
      if (getFS()) hideUI(targetP);
    } else if (e.touches.length === 1 && state.scale === 1.0) {
      lpTimer = setTimeout(() => {
        if (isTouch) {
          action = "rate";
          targetV.playbackRate = Math.max(0.1, initRate + CFG.rateBase - 1.0);
          showMsg(`${targetV.playbackRate.toFixed(1)}x`);
          if (getFS()) hideUI(targetP);
        }
      }, CFG.longPress);
    }
  };

  const onMove = (e) => {
    if (state.isScreenLocked) {
      if (
        !findUp(e.target, ".gt-btn-base") &&
        (!!getFS() || (targetP && targetP.contains(e.target)))
      ) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      return;
    }

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
      if (state.pinchMode === "zoom") {
        state.scale = Math.max(
          1.0,
          Math.min(CFG.maxScale, initScale * (p.dist / initPinchDist)),
        );
        if (state.scale > 1.0) {
          const ds = state.scale / initScale;
          state.panX = p.cx - initCenterX + initPanX * ds + originDx * (1 - ds);
          state.panY = p.cy - initCenterY + initPanY * ds + originDy * (1 - ds);
        } else {
          state.panX = 0;
          state.panY = 0;
        }
        applyTransform();
      } else {
        let s = initSpeed + (p.dist - initPinchDist) * 0.005;
        let finalSpeed = s;
        if (finalSpeed > 0.95 && finalSpeed < 1.05) finalSpeed = 1.0;
        finalSpeed = Math.max(0.1, Math.min(4.0, finalSpeed));
        setRateThrottled(targetV, finalSpeed);
        showMsg(finalSpeed === 1.0 ? "1.0x" : `${finalSpeed.toFixed(2)}x`);
      }
      return;
    }

    if (action === "pinch" || action === "pinch_wait") return;

    const dx = e.touches[0].clientX - startX,
      dy = startY - e.touches[0].clientY;

    if (action === "rate") {
      targetV.playbackRate = Math.max(
        0.1,
        Math.min(4.0, initRate + (CFG.rateBase + dx * CFG.senseRate) - 1.0),
      );
      showMsg(`${targetV.playbackRate.toFixed(1)}x`);
      return;
    }

    if (!action) {
      if (Math.abs(dx) > CFG.minDist || Math.abs(dy) > CFG.minDist) {
        clearTimeout(lpTimer);
        action =
          Math.abs(dx) > Math.abs(dy)
            ? "seek"
            : startX < innerWidth / 2
              ? "bri"
              : "vol";

        enforceTarget = wasPlayingBeforeSequence ? "playing" : "paused";
        enforceStateUntil = Date.now() + 800;
        if (enforceTarget === "playing" && targetV.paused)
          targetV.play().catch(() => {});
        else if (enforceTarget === "paused" && !targetV.paused) targetV.pause();

        if (getFS()) hideUI(targetP);
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
      targetV.volume = Math.max(
        0,
        Math.min(1, initVol + (dy / innerHeight) * 2 * CFG.senseY),
      );
      showMsg(`Vol: ${Math.round(targetV.volume * 100)}%`);
    } else if (action === "bri") {
      let b = Math.max(
        0.1,
        Math.min(2.0, 1 + (dy / innerHeight) * 2 * CFG.senseY),
      );
      targetV.style.filter = `brightness(${b})`;
      showMsg(`Bri: ${Math.round(b * 100)}%`);
    }
  };

  const onEnd = (e) => {
    const now = Date.now();

    // [修复] 尾随物理拦截墙：暴力拦截连击状态下的所有 touchend 遗漏
    if (now < blockGestureUntil && !findUp(e.target, ".gt-btn-base")) {
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.cancelable) e.preventDefault();
      isTouch = false;
      return;
    }

    if (state.isScreenLocked) {
      if (
        !findUp(e.target, ".gt-btn-base") &&
        (!!getFS() || (targetP && targetP.contains(e.target)))
      ) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      isTouch = false;
      return;
    }
    if (!isTouch) return;
    if (e.touches.length > 0) {
      if (action === "pinch") action = "pinch_wait";
      return;
    }

    if (pendingRate !== null && targetV) {
      targetV.playbackRate = pendingRate;
      pendingRate = null;
    }

    clearTimeout(lpTimer);
    if (action === "rate" && targetV) {
      targetV.playbackRate = initRate;
      showMsg("");
      wakeUpUI(targetP, targetV);
    }
    if (
      (action === "pinch" || action === "pinch_wait" || action === "pan") &&
      targetV
    ) {
      wakeUpUI(targetP, targetV);
    }

    if (!action) {
      if (!activeSeekSide) wakeUpUI(targetP, targetV);
    } else {
      blockGestureUntil = now + 500;
    }

    setTimeout(() => {
      if (targetP && !getFS()) targetP.classList.remove("gt-lock-touch");
      if (targetV) targetV.classList.remove("gt-lock-touch");
    }, 100);
    isTouch = false;
    targetV = null;
    action = null;
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
            if (!findUp(e.target, ".gt-btn-base")) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
            }
          } else if (evt === "click") {
            const isL =
              state.isScreenLocked &&
              !findUp(e.target, ".gt-btn-base") &&
              (!!getFS() || (targetP && targetP.contains(e.target)));
            if (activeSeekSide || isL) {
              e.stopPropagation();
              e.stopImmediatePropagation();
              e.preventDefault();
              if (isL && targetP && targetV) wakeUpUI(targetP, targetV);
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
      if (onVideo && Date.now() < suppressContextMenuUntil) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    },
    { capture: true, passive: false },
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
        hideUI(targetP);
        document
          .querySelectorAll(".gt-lock-touch")
          .forEach((el) => el.classList.remove("gt-lock-touch"));
        if (screen.orientation?.unlock) {
          screen.orientation.unlock();
          try {
            window.top.postMessage({ type: "gt_unlock_orientation" }, "*");
          } catch (e) {}
        }
      } else {
        setTimeout(() => {
          let v = targetV || document.querySelector("video");
          let root = fsEl;
          if (root && root.tagName === "VIDEO") root = root.parentNode;
          wakeUpUI(root, v);
          if (v) {
            const dir =
              v.videoWidth > 0 && v.videoWidth < v.videoHeight
                ? "portrait"
                : "landscape";
            if (screen.orientation?.lock) {
              screen.orientation.lock(dir).catch(() => {
                try {
                  window.top.postMessage(
                    { type: "gt_lock_orientation", dir: dir },
                    "*",
                  );
                } catch (err) {}
              });
            } else {
              try {
                window.top.postMessage(
                  { type: "gt_lock_orientation", dir: dir },
                  "*",
                );
              } catch (err) {}
            }
          }
        }, 200);
      }
    });
  });
})();
