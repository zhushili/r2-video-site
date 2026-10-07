// 自定义视频播放器：HLS 自适应码率（hls.js）、画质/倍速菜单、进度条预览图、快捷键、剧场模式、自动连播
import { icon } from "./icons.js";
import { esc, fmtTime, isTyping, modal, qualityLabel, store } from "./lib.js";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const IDLE_MS = 2600;

export class Player {
  /**
   * @param {HTMLElement} mount
   * @param {object} o
   *   source: { type: 'hls' | 'file', url }
   *   poster, title, startAt, storyboard: { url, count, interval, cols, rows, width, height }
   *   next: { title, thumb } | null, onNext(), onTheater(bool), onProgress(t, d), onEnded()
   */
  constructor(mount, o) {
    this.o = o;
    this.cleanups = [];
    this.hls = null;
    this.levels = []; // [{index, short, width, height, bitrate}]
    this.menuPage = null;

    const el = (this.el = document.createElement("div"));
    el.className = "vp";
    el.tabIndex = 0;
    el.setAttribute("aria-label", "视频播放器");
    el.innerHTML = `
      <video playsinline preload="metadata"></video>
      <div class="vp-spinner spinner"></div>
      <div class="vp-flash"></div>
      <div class="vp-toast"></div>
      <button class="vp-big" aria-label="播放">${icon("play")}</button>
      <div class="vp-controls">
        <div class="vp-progress" role="slider" aria-label="进度" tabindex="-1">
          <div class="vp-rail"><div class="vp-buffer"></div><div class="vp-hoverbar"></div><div class="vp-played"></div><div class="vp-knob"></div></div>
          <div class="vp-tip"><div class="vp-tip-frame" hidden></div><div class="vp-tip-time">0:00</div></div>
        </div>
        <div class="vp-bar">
          <button class="vp-btn" data-a="play" aria-label="播放 (k)">${icon("play")}</button>
          ${o.next ? `<button class="vp-btn" data-a="next" aria-label="下一个 (Shift+N)">${icon("next")}</button>` : ""}
          <div class="vp-vol">
            <button class="vp-btn" data-a="mute" aria-label="静音 (m)">${icon("volume")}</button>
            <div class="vp-vol-slider"><input type="range" min="0" max="1" step="0.01" aria-label="音量"></div>
          </div>
          <div class="vp-time"><span class="cur">0:00</span> <span class="total">/ 0:00</span></div>
          <div class="vp-spacer"></div>
          <button class="vp-btn vp-settings-btn" data-a="settings" aria-label="设置">${icon("settings")}<span class="vp-qbadge" hidden></span></button>
          <button class="vp-btn vp-hide-sm" data-a="pip" aria-label="画中画 (i)">${icon("pip")}</button>
          <button class="vp-btn vp-hide-sm" data-a="theater" aria-label="剧场模式 (t)">${icon("theater")}</button>
          <button class="vp-btn" data-a="fullscreen" aria-label="全屏 (f)">${icon("fullscreen")}</button>
        </div>
      </div>
      <div class="vp-menu" hidden></div>`;
    mount.append(el);

    const $ = (s) => el.querySelector(s);
    this.video = $("video");
    this.ui = {
      big: $(".vp-big"), flash: $(".vp-flash"), toast: $(".vp-toast"),
      progress: $(".vp-progress"), buffer: $(".vp-buffer"), played: $(".vp-played"), knob: $(".vp-knob"),
      hoverbar: $(".vp-hoverbar"), tip: $(".vp-tip"), tipFrame: $(".vp-tip-frame"), tipTime: $(".vp-tip-time"),
      cur: $(".cur"), total: $(".total"), vol: $(".vp-vol input"), menu: $(".vp-menu"), qbadge: $(".vp-qbadge"),
    };
    this.btn = Object.fromEntries([...el.querySelectorAll("[data-a]")].map((b) => [b.dataset.a, b]));
    if (!document.pictureInPictureEnabled) this.btn.pip.hidden = true;

    const v = this.video;
    if (o.poster) v.poster = o.poster;

    // 偏好：音量 / 倍速 / 自动连播
    const vol = store.get("volume", { v: 1, muted: false });
    v.volume = vol.v;
    v.muted = vol.muted;
    v.playbackRate = store.get("rate", 1);
    this.autoplayNext = store.get("autoplay", true);

    this.bindMedia();
    this.bindPointer();
    this.bindKeys();
    this.bindMediaSession();
    this.updateVolume();
    this.load(o.startAt || 0);
  }

  // ================= 加载源 =================
  async load(startAt) {
    const v = this.video;
    const { source } = this.o;
    this.hideError();
    if (source.type === "hls") {
      const { default: Hls } = await import("hls.js");
      if (this.destroyed) return;
      if (Hls.isSupported()) {
        const hls = (this.hls = new Hls({
          startPosition: startAt || -1,
          capLevelToPlayerSize: true,
          maxBufferLength: 30,
          maxMaxBufferLength: 120,
          enableWorker: true,
        }));
        hls.on(Hls.Events.MANIFEST_PARSED, () => this.onManifest());
        hls.on(Hls.Events.LEVEL_SWITCHED, () => this.updateQualityBadge());
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && (this.netRetries = (this.netRetries || 0) + 1) <= 3) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.recovered) {
            this.recovered = true;
            hls.recoverMediaError();
          } else this.showError("视频加载失败，请检查网络后重试");
        });
        hls.loadSource(source.url);
        hls.attachMedia(v);
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        // iOS Safari 等：原生 HLS（自动切换画质，不提供手动选择）
        v.src = source.url;
        if (startAt) v.addEventListener("loadedmetadata", () => (v.currentTime = startAt), { once: true });
      } else {
        this.showError("当前浏览器不支持 HLS 播放");
        return;
      }
    } else {
      v.src = source.url;
      if (startAt) v.addEventListener("loadedmetadata", () => (v.currentTime = startAt), { once: true });
    }
    this.tryAutoplay();
  }

  tryAutoplay() {
    const p = this.video.play();
    p?.catch(() => {
      // 浏览器拦截了自动播放：显示大播放按钮等用户点击
      this.el.classList.remove("started");
    });
  }

  onManifest() {
    const hls = this.hls;
    this.levels = hls.levels
      .map((l, index) => ({ index, width: l.width, height: l.height, short: Math.min(l.width, l.height), bitrate: l.bitrate }))
      .sort((a, b) => b.short - a.short);
    const pref = store.get("quality", "auto");
    if (pref !== "auto") {
      const lv = this.levels.find((l) => l.short <= pref) || this.levels[this.levels.length - 1];
      if (lv) hls.currentLevel = lv.index;
    }
    this.updateQualityBadge();
  }

  currentLevel() {
    if (!this.hls) return null;
    const idx = this.hls.currentLevel >= 0 ? this.hls.currentLevel : this.hls.loadLevel;
    return this.levels.find((l) => l.index === idx) || null;
  }

  updateQualityBadge() {
    const lv = this.currentLevel();
    const b = this.ui.qbadge;
    const tag = lv ? (lv.short >= 2000 ? "4K" : lv.short >= 1400 ? "2K" : lv.short >= 720 ? "HD" : "") : "";
    b.hidden = !tag;
    b.textContent = tag;
    if (this.menuPage === "main") this.renderMenu("main");
  }

  setQuality(short) {
    store.set("quality", short);
    if (!this.hls) return;
    if (short === "auto") {
      this.hls.currentLevel = -1;
      this.flashToast("画质：自动");
    } else {
      const lv = this.levels.find((l) => l.short === short);
      if (lv) this.hls.currentLevel = lv.index;
      this.flashToast(`画质：${qualityLabel(short)}`);
    }
    this.updateQualityBadge();
  }

  // ================= 媒体事件 =================
  bindMedia() {
    const v = this.video;
    const on = (ev, fn) => v.addEventListener(ev, fn);
    on("play", () => {
      this.el.classList.add("started");
      this.setPlayIcon();
      this.startRaf();
      this.armIdle();
    });
    on("pause", () => {
      this.setPlayIcon();
      this.setIdle(false);
      this.o.onProgress?.(v.currentTime, v.duration);
    });
    on("waiting", () => this.el.classList.add("waiting"));
    for (const ev of ["playing", "canplay", "seeked", "pause"]) on(ev, () => this.el.classList.remove("waiting"));
    on("loadedmetadata", () => this.updateTime());
    on("durationchange", () => this.updateTime());
    on("timeupdate", () => {
      if (v.paused) this.updateTime();
      if (!this.lastSave || Date.now() - this.lastSave > 5000) {
        this.lastSave = Date.now();
        this.o.onProgress?.(v.currentTime, v.duration);
      }
    });
    on("seeked", () => {
      this.updateTime();
      this.o.onProgress?.(v.currentTime, v.duration);
    });
    on("progress", () => this.updateBuffer());
    on("volumechange", () => {
      this.updateVolume();
      store.set("volume", { v: v.volume, muted: v.muted });
    });
    on("ratechange", () => store.set("rate", v.playbackRate));
    on("ended", () => {
      this.setIdle(false);
      this.o.onEnded?.();
      if (!v.loop && this.o.next && this.autoplayNext) this.showNextOverlay();
    });
    on("error", () => {
      if (!this.hls && v.error) {
        this.showError(v.error.code === 4 ? "当前浏览器无法播放此视频格式，可以下载原文件观看" : "视频加载失败，请检查网络后重试");
      }
    });
    on("enterpictureinpicture", () => this.btn.pip.classList.add("active"));
    on("leavepictureinpicture", () => this.btn.pip.classList.remove("active"));

    const onFs = () => {
      const fs = document.fullscreenElement === this.el;
      this.btn.fullscreen.innerHTML = icon(fs ? "exitFullscreen" : "fullscreen");
      if (!fs) screen.orientation?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onFs);
    this.cleanups.push(() => document.removeEventListener("fullscreenchange", onFs));
  }

  startRaf() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      this.updateTime();
      if (!this.video.paused && !this.destroyed) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  updateTime() {
    const v = this.video;
    const d = v.duration || 0;
    const t = this.dragTime ?? v.currentTime;
    const pct = d ? (t / d) * 100 : 0;
    this.ui.played.style.width = `${pct}%`;
    this.ui.knob.style.left = `${pct}%`;
    this.ui.cur.textContent = fmtTime(t);
    this.ui.total.textContent = `/ ${fmtTime(d)}`;
    this.ui.progress.setAttribute("aria-valuenow", Math.round(t));
    this.updateBuffer();
  }

  updateBuffer() {
    const v = this.video;
    const d = v.duration;
    if (!d) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    }
    this.ui.buffer.style.width = `${(end / d) * 100}%`;
  }

  setPlayIcon() {
    const paused = this.video.paused;
    this.btn.play.innerHTML = icon(paused ? "play" : "pause");
    this.btn.play.setAttribute("aria-label", paused ? "播放 (k)" : "暂停 (k)");
  }

  updateVolume() {
    const v = this.video;
    const level = v.muted ? 0 : v.volume;
    this.btn.mute.innerHTML = icon(level === 0 ? "mute" : level < 0.5 ? "volumeLow" : "volume");
    this.ui.vol.value = level;
    this.ui.vol.style.accentColor = "#fff";
  }

  // ================= 操作 =================
  toggle() {
    const v = this.video;
    if (v.paused || v.ended) {
      this.hideNextOverlay();
      v.play().catch(() => {});
    } else v.pause();
  }

  seek(t, { flash } = {}) {
    const v = this.video;
    const d = v.duration || 0;
    v.currentTime = Math.max(0, Math.min(d ? d - 0.05 : t, t));
    this.updateTime();
    if (flash) this.flash(flash.icon, flash.text, flash.side);
  }

  seekBy(delta) {
    this.seek(this.video.currentTime + delta, {
      flash: { icon: delta < 0 ? "back10" : "fwd10", text: `${Math.abs(delta)} 秒`, side: delta < 0 ? "left" : "right" },
    });
  }

  setVolume(vol) {
    const v = this.video;
    v.volume = Math.max(0, Math.min(1, vol));
    v.muted = v.volume === 0;
    this.flashToast(`音量 ${Math.round(v.volume * 100)}%`);
  }

  setRate(r) {
    this.video.playbackRate = r;
    this.flashToast(`倍速 ${r}×`);
  }

  toggleFullscreen() {
    const v = this.video;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (this.el.requestFullscreen) {
      this.el.requestFullscreen().then(() => {
        if (v.videoWidth > v.videoHeight) screen.orientation?.lock?.("landscape").catch(() => {});
      }).catch(() => {});
    } else if (v.webkitEnterFullscreen) {
      v.webkitEnterFullscreen(); // iPhone
    }
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {}
  }

  toggleTheater() {
    const on = !store.get("theater", false);
    store.set("theater", on);
    this.btn.theater.classList.toggle("active", on);
    this.o.onTheater?.(on);
  }

  flash(name, text = "", side = "") {
    const f = this.ui.flash;
    f.className = `vp-flash ${side}`;
    f.innerHTML = `${icon(name)}${text ? `<span>${esc(text)}</span>` : ""}`;
    void f.offsetWidth;
    f.classList.add("show");
  }

  flashToast(text) {
    const t = this.ui.toast;
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove("show"), 1400);
  }

  // ================= 控制栏自动隐藏 =================
  setIdle(idle) {
    this.el.classList.toggle("idle", idle);
  }
  armIdle() {
    this.setIdle(false);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.video.paused && this.ui.menu.hidden && this.dragTime == null && !this.el.querySelector(".vp-controls").matches(":hover")) this.setIdle(true);
    }, IDLE_MS);
  }

  // ================= 鼠标 / 触摸 =================
  bindPointer() {
    const { el, video, ui } = this;
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") this.armIdle();
    });
    el.addEventListener("pointerleave", () => {
      if (!this.video.paused && this.ui.menu.hidden) this.setIdle(true);
    });

    // 点击画面：单击播放/暂停，双击全屏；触摸：单击显示控制栏，双击左右两侧快退/快进
    let clickTimer = null;
    let lastTap = 0;
    video.addEventListener("pointerup", (e) => {
      if (!this.ui.menu.hidden) return this.closeMenu();
      if (e.pointerType === "touch") {
        const now = Date.now();
        const x = e.offsetX / video.clientWidth;
        if (now - lastTap < 300 && (x < 0.35 || x > 0.65)) {
          clearTimeout(clickTimer);
          this.seekBy(x < 0.5 ? -10 : 10);
          lastTap = 0;
          return;
        }
        lastTap = now;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          if (this.el.classList.contains("idle") || this.video.paused) this.armIdle();
          else this.setIdle(true);
        }, 280);
        return;
      }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        this.toggle();
        this.flash(this.video.paused ? "pause" : "play");
      }, 200);
    });
    video.addEventListener("dblclick", () => {
      clearTimeout(clickTimer);
      this.toggleFullscreen();
    });
    ui.big.onclick = () => this.toggle();

    // 按钮
    const b = this.btn;
    b.play.onclick = () => this.toggle();
    b.mute.onclick = () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 0.5;
    };
    ui.vol.oninput = () => {
      video.volume = Number(ui.vol.value);
      video.muted = video.volume === 0;
    };
    b.fullscreen.onclick = () => this.toggleFullscreen();
    b.pip.onclick = () => this.togglePip();
    b.theater.onclick = () => this.toggleTheater();
    b.theater.classList.toggle("active", store.get("theater", false));
    if (b.next) b.next.onclick = () => this.o.onNext?.();
    b.settings.onclick = (e) => {
      e.stopPropagation();
      this.ui.menu.hidden ? this.renderMenu("main") : this.closeMenu();
    };
    const outside = (e) => {
      if (!this.ui.menu.hidden && !this.ui.menu.contains(e.target) && !b.settings.contains(e.target)) this.closeMenu();
    };
    document.addEventListener("pointerdown", outside);
    this.cleanups.push(() => document.removeEventListener("pointerdown", outside));

    // 进度条：悬停预览、拖动
    const p = ui.progress;
    const timeAt = (clientX) => {
      const r = p.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return { frac, t: frac * (video.duration || 0), r };
    };
    const showTip = (clientX) => {
      const { frac, t, r } = timeAt(clientX);
      ui.hoverbar.style.width = `${frac * 100}%`;
      ui.tipTime.textContent = fmtTime(t);
      const sb = this.o.storyboard;
      let tipW = ui.tipTime.offsetWidth;
      if (sb && video.duration) {
        const scale = 1.1;
        const w = sb.width * scale, h = sb.height * scale;
        const i = Math.min(sb.count - 1, Math.floor(t / sb.interval));
        Object.assign(ui.tipFrame.style, {
          width: `${w}px`,
          height: `${h}px`,
          backgroundImage: `url("${sb.url}")`,
          backgroundSize: `${sb.cols * w}px ${sb.rows * h}px`,
          backgroundPosition: `${-(i % sb.cols) * w}px ${-Math.floor(i / sb.cols) * h}px`,
        });
        ui.tipFrame.hidden = false;
        tipW = w + 4;
      }
      const x = Math.max(tipW / 2, Math.min(r.width - tipW / 2, frac * r.width));
      ui.tip.style.left = `${x}px`;
    };
    p.addEventListener("pointermove", (e) => {
      p.classList.add("tip-on");
      showTip(e.clientX);
    });
    p.addEventListener("pointerleave", () => p.classList.remove("tip-on"));
    p.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      p.setPointerCapture(e.pointerId);
      p.classList.add("dragging");
      this.wasPlaying = !video.paused;
      const move = (ev) => {
        showTip(ev.clientX);
        this.dragTime = timeAt(ev.clientX).t;
        this.updateTime();
      };
      const up = (ev) => {
        p.removeEventListener("pointermove", move);
        p.removeEventListener("pointerup", up);
        p.removeEventListener("pointercancel", up);
        p.classList.remove("dragging");
        const t = timeAt(ev.clientX).t;
        this.dragTime = null;
        this.seek(t);
        this.armIdle();
      };
      move(e);
      p.addEventListener("pointermove", move);
      p.addEventListener("pointerup", up);
      p.addEventListener("pointercancel", up);
    });
  }

  // ================= 设置菜单 =================
  closeMenu() {
    this.ui.menu.hidden = true;
    this.menuPage = null;
    this.armIdle();
  }

  renderMenu(page) {
    const m = this.ui.menu;
    this.menuPage = page;
    m.hidden = false;
    const v = this.video;
    const item = (attrs, left, right = "") => `<button class="vp-menu-item" ${attrs}>${left}<span class="grow"></span>${right}</button>`;
    const check = (on) => `<span class="check">${on ? icon("check") : ""}</span>`;
    const head = (title) => `<div class="vp-menu-head"><button data-back aria-label="返回">${icon("chevronLeft")}</button>${esc(title)}</div>`;
    const pref = store.get("quality", "auto");

    if (page === "main") {
      const lv = this.currentLevel();
      const qText = !this.levels.length
        ? (this.hls ? "自动" : "原画")
        : pref === "auto"
          ? `自动${lv ? `（${qualityLabel(lv.short)}）` : ""}`
          : qualityLabel(pref);
      m.innerHTML = [
        this.levels.length > 1 ? item(`data-go="quality"`, `${icon("layers")}<span>画质</span>`, `<span class="val">${qText}${icon("chevronRight")}</span>`) : "",
        item(`data-go="speed"`, `${icon("gauge")}<span>播放速度</span>`, `<span class="val">${v.playbackRate === 1 ? "正常" : `${v.playbackRate}×`}${icon("chevronRight")}</span>`),
        this.o.next ? item(`data-toggle="autoplay"`, `${icon("next")}<span>自动播放下一个</span>`, `<label class="switch"><input type="checkbox" tabindex="-1" ${this.autoplayNext ? "checked" : ""}></label>`) : "",
        item(`data-toggle="loop"`, `${icon("history")}<span>循环播放</span>`, `<label class="switch"><input type="checkbox" tabindex="-1" ${v.loop ? "checked" : ""}></label>`),
        item(`data-go="keys"`, `${icon("keyboard")}<span>键盘快捷键</span>`, `<span class="val">?</span>`),
      ].join("");
    } else if (page === "quality") {
      m.innerHTML =
        head("画质") +
        this.levels.map((l) => item(`data-q="${l.short}"`, `${check(pref === l.short)}<span>${qualityLabel(l.short)}${l.short >= 720 ? `<span class="vp-hd">HD</span>` : ""}</span>`, `<span class="val">${(l.bitrate / 1e6).toFixed(1)} Mbps</span>`)).join("") +
        item(`data-q="auto"`, `${check(pref === "auto")}<span>自动</span>`, `<span class="val">根据网速切换</span>`);
    } else if (page === "speed") {
      m.innerHTML = head("播放速度") + SPEEDS.map((s) => item(`data-s="${s}"`, `${check(v.playbackRate === s)}<span>${s === 1 ? "正常" : `${s}×`}</span>`)).join("");
    } else if (page === "keys") {
      this.closeMenu();
      showShortcuts();
      return;
    }

    m.onclick = (e) => {
      e.stopPropagation();
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.back !== undefined) return this.renderMenu("main");
      if (t.dataset.go) return this.renderMenu(t.dataset.go);
      if (t.dataset.q) {
        this.setQuality(t.dataset.q === "auto" ? "auto" : Number(t.dataset.q));
        return this.closeMenu();
      }
      if (t.dataset.s) {
        this.setRate(Number(t.dataset.s));
        return this.closeMenu();
      }
      if (t.dataset.toggle === "autoplay") {
        this.autoplayNext = !this.autoplayNext;
        store.set("autoplay", this.autoplayNext);
        this.o.onAutoplayChange?.(this.autoplayNext);
      }
      if (t.dataset.toggle === "loop") v.loop = !v.loop;
      this.renderMenu("main");
    };
  }

  setAutoplay(on) {
    this.autoplayNext = on;
  }

  // ================= 快捷键 =================
  bindKeys() {
    const onKey = (e) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".modal-backdrop")) return;
      const v = this.video;
      const focused = this.el.contains(document.activeElement) || document.fullscreenElement === this.el;
      let handled = true;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          this.toggle();
          this.flash(v.paused ? "pause" : "play");
          break;
        case "ArrowLeft": this.seekBy(-5); break;
        case "ArrowRight": this.seekBy(5); break;
        case "j": case "J": this.seekBy(-10); break;
        case "l": case "L": this.seekBy(10); break;
        case "ArrowUp":
          if (!focused) return;
          this.setVolume(v.volume + 0.05);
          break;
        case "ArrowDown":
          if (!focused) return;
          this.setVolume(v.volume - 0.05);
          break;
        case "m": case "M":
          v.muted = !v.muted;
          this.flashToast(v.muted ? "已静音" : `音量 ${Math.round(v.volume * 100)}%`);
          break;
        case "f": case "F": this.toggleFullscreen(); break;
        case "t": case "T": if (!document.fullscreenElement) this.toggleTheater(); break;
        case "i": case "I": this.togglePip(); break;
        case "N": if (this.o.next) this.o.onNext?.(); break;
        case ">": this.setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(v.playbackRate) + 1)] || 1); break;
        case "<": this.setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(v.playbackRate) - 1)] || 1); break;
        case ",": if (v.paused) this.seek(v.currentTime - 1 / 30); break;
        case ".": if (v.paused) this.seek(v.currentTime + 1 / 30); break;
        case "Home": this.seek(0); break;
        case "End": this.seek(v.duration); break;
        default:
          if (/^[0-9]$/.test(e.key) && v.duration) this.seek((v.duration * Number(e.key)) / 10);
          else handled = false;
      }
      if (handled) {
        e.preventDefault();
        this.armIdle();
      }
    };
    document.addEventListener("keydown", onKey);
    this.cleanups.push(() => document.removeEventListener("keydown", onKey));
  }

  // 系统媒体控制（锁屏、耳机按键、浏览器媒体中心）
  bindMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title: this.o.title || "",
        artwork: this.o.poster ? [{ src: this.o.poster, sizes: "1280x720", type: "image/jpeg" }] : [],
      });
    } catch {}
    const handlers = {
      play: () => this.video.play(),
      pause: () => this.video.pause(),
      seekbackward: () => this.seekBy(-10),
      seekforward: () => this.seekBy(10),
      seekto: (d) => this.seek(d.seekTime),
      nexttrack: this.o.next ? () => this.o.onNext?.() : null,
    };
    for (const [k, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(k, fn); } catch {}
    }
    this.cleanups.push(() => {
      for (const k of Object.keys(handlers)) {
        try { ms.setActionHandler(k, null); } catch {}
      }
    });
  }

  // ================= 自动连播 =================
  showNextOverlay() {
    const { next } = this.o;
    const wrap = document.createElement("div");
    wrap.className = "vp-next";
    const R = 32, C = 2 * Math.PI * R;
    wrap.innerHTML = `
      <div class="vp-next-card">
        <div class="vp-next-label">即将播放</div>
        <div class="vp-next-title"></div>
        <div class="vp-next-ring">
          <svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="${R}" stroke="rgb(255 255 255 / 20%)"/><circle class="arc" cx="36" cy="36" r="${R}" stroke="var(--vp-accent)" stroke-dasharray="${C}" stroke-dashoffset="${C}" stroke-linecap="round"/></svg>
          <button aria-label="立即播放">${icon("play")}</button>
        </div>
        <button class="btn sm">取消</button>
      </div>`;
    wrap.querySelector(".vp-next-title").textContent = next.title;
    this.el.append(wrap);
    this.nextEl = wrap;
    const arc = wrap.querySelector(".arc");
    const total = 5000;
    const start = performance.now();
    const step = (now) => {
      const f = Math.min(1, (now - start) / total);
      arc.setAttribute("stroke-dashoffset", String(C * (1 - f)));
      if (f >= 1) return this.o.onNext?.();
      this.nextRaf = requestAnimationFrame(step);
    };
    this.nextRaf = requestAnimationFrame(step);
    wrap.querySelector(".vp-next-ring button").onclick = () => this.o.onNext?.();
    wrap.querySelector(".btn").onclick = () => this.hideNextOverlay();
  }

  hideNextOverlay() {
    cancelAnimationFrame(this.nextRaf);
    this.nextEl?.remove();
    this.nextEl = null;
  }

  // ================= 错误 =================
  showError(msg) {
    this.hideError();
    const e = document.createElement("div");
    e.className = "vp-error";
    e.innerHTML = `<div>${icon("alert")}<p></p><button class="btn sm">重试</button></div>`;
    e.querySelector("p").textContent = msg;
    e.querySelector("button").onclick = () => {
      const t = this.video.currentTime;
      this.hls?.destroy();
      this.hls = null;
      this.recovered = false;
      this.netRetries = 0;
      this.load(t);
    };
    this.el.append(e);
    this.errEl = e;
  }

  hideError() {
    this.errEl?.remove();
    this.errEl = null;
  }

  destroy() {
    this.destroyed = true;
    this.o.onProgress?.(this.video.currentTime, this.video.duration);
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.nextRaf);
    clearTimeout(this.idleTimer);
    this.cleanups.forEach((fn) => fn());
    if (document.pictureInPictureElement === this.video) document.exitPictureInPicture().catch(() => {});
    this.hls?.destroy();
    this.video.removeAttribute("src");
    this.video.load();
    this.el.remove();
  }
}

// 快捷键说明
export function showShortcuts() {
  const rows = [
    ["播放 / 暂停", "K 或 空格"], ["快退 / 快进 5 秒", "← / →"], ["快退 / 快进 10 秒", "J / L"],
    ["音量", "↑ / ↓"], ["静音", "M"], ["全屏", "F"], ["剧场模式", "T"], ["画中画", "I"],
    ["跳到 0%–90%", "0 – 9"], ["逐帧（暂停时）", ", / ."], ["倍速", "< / >"], ["下一个视频", "Shift + N"],
    ["搜索", "/"], ["快捷键说明", "?"],
  ];
  modal({
    title: "键盘快捷键",
    size: "lg",
    content: `<div class="shortcuts">${rows.map(([a, b]) => `<div><span>${a}</span><kbd>${b}</kbd></div>`).join("")}</div>`,
  });
}
