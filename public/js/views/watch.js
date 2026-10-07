// 播放页
import { icon } from "../icons.js";
import {
  api, avatarHtml, canEdit, canvasToJpeg, categoryById, composeCover, copyText, emptyState, esc, fmtAgo, fmtDate, fmtSize,
  fmtTime, getVideos, history, mediaUrl, openMenu, qualityLabel, qualityTag, siteTitle, store, toast, uploadThumb, userInfo,
  visibleVideos,
} from "../lib.js";
import { Player } from "../player.js";
import { thumbHtml } from "./cards.js";
import { canDeleteOriginal, deleteOriginal, deleteVideo, editVideo } from "./editor.js";
import { nsfwGate } from "./nsfw.js";

export async function render(ctx) {
  const { app, params, url, navigate, isCurrent } = ctx;
  const id = params.id;
  app.innerHTML = `
    <div class="watch">
      <div class="player-band"><div class="skeleton" style="aspect-ratio:16/9;border-radius:16px"></div></div>
      <div class="watch-info">
        <div class="skeleton" style="height:26px;width:60%;margin-top:16px"></div>
        <div class="skeleton" style="height:16px;width:30%;margin-top:12px"></div>
      </div>
      <aside class="watch-secondary"></aside>
    </div>`;

  let meta, videos;
  try {
    [meta, videos] = await Promise.all([api("GET", `/api/videos/${encodeURIComponent(id)}`), getVideos().catch(() => [])]);
  } catch (err) {
    // NSFW 视频：先输入访问密码
    if (err.code !== "nsfw_locked") throw err;
    if (!isCurrent()) return;
    document.title = siteTitle("NSFW 内容");
    nsfwGate(app, () => {
      ctx.refreshShell(); // 更新账号菜单里的开关状态
      render(ctx);
    });
    return;
  }
  if (!isCurrent()) return;
  document.title = siteTitle(meta.title);

  if (meta.status !== "ready" || !meta.playback) {
    app.innerHTML = emptyState("cpu", "视频还没有处理完", "上传或转码尚未完成。如果上传页面已经关闭，可以在工作室里删除后重新上传。",
      `<a class="btn primary" href="/studio" data-link>前往工作室</a>`);
    return;
  }

  // 接下来播放：列表中当前视频之后的（循环）
  const ready = visibleVideos(videos).filter((v) => v.status === "ready");
  const idx = ready.findIndex((v) => v.id === id);
  const upnext = idx >= 0 ? [...ready.slice(idx + 1), ...ready.slice(0, idx)] : ready.filter((v) => v.id !== id);
  const next = upnext[0] || null;

  const top = [...(meta.renditions || [])].sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height))[0];
  const topShort = top ? Math.min(top.width, top.height) : Math.min(meta.width || 0, meta.height || 0);
  const editable = canEdit(meta);
  const owner = { ...userInfo(meta.owner), ...(meta.ownerInfo || {}) };
  const ownerCount = ready.filter((v) => v.owner === meta.owner).length;
  const cat = categoryById(meta.category);

  app.innerHTML = `
    <div class="watch ${store.get("theater", false) ? "theater" : ""}">
      <div class="player-band"></div>
      <div class="watch-info">
        <h1 class="watch-title"></h1>
        <div class="watch-bar">
          <a class="owner-row" href="/@${meta.owner}" data-link>
            ${avatarHtml(owner, 40)}
            <div style="min-width:0"><span class="owner-name">${esc(owner.displayName)}</span><span class="owner-sub">${ownerCount} 个视频</span></div>
          </a>
          <div class="watch-actions">
            <button class="btn" data-act="share">${icon("share")}分享</button>
            ${meta.original ? `<a class="btn" data-original href="${mediaUrl(id, meta.original.path)}?download=1" download>${icon("download")}下载原片</a>` : ""}
            ${editable ? `<button class="btn" data-act="edit">${icon("edit")}编辑</button><button class="icon-btn" data-act="more" aria-label="更多">${icon("more")}</button>` : ""}
          </div>
        </div>
        <div class="desc">
          <div class="watch-meta" style="margin-bottom:6px">
            <b title="${esc(new Date(meta.publishedAt || meta.createdAt).toLocaleString("zh-CN"))}">${fmtDate(meta.publishedAt || meta.createdAt)}</b>
            ${meta.duration ? `<span class="sep">·</span><span>${fmtTime(meta.duration)}</span>` : ""}
            ${topShort ? `<span class="badge">${qualityLabel(topShort)}${qualityTag(topShort) && qualityTag(topShort) !== qualityLabel(topShort) ? ` ${qualityTag(topShort)}` : ""}</span>` : ""}
            ${meta.playback.type === "hls" && meta.renditions?.length > 1 ? `<span class="badge">${meta.renditions.length} 种清晰度</span>` : ""}
            ${cat ? `<a class="cat-badge" href="/c/${cat.id}" data-link>${icon(cat.icon)}${esc(cat.name)}</a>` : ""}
            ${meta.nsfw ? `<span class="cat-badge nsfw-badge">${icon("eyeOff")}NSFW</span>` : ""}
          </div>
          <div class="desc-text"></div><button class="desc-toggle" hidden>展开</button>
        </div>
      </div>
      <aside class="watch-secondary">
        ${upnext.length ? `
          <div class="upnext-head">
            <h3>接下来播放</h3>
            <label class="switch">自动播放<input type="checkbox" id="autoplay" ${store.get("autoplay", true) ? "checked" : ""}></label>
          </div>
          <div class="upnext">
            ${upnext.slice(0, 20).map((v) => `
              <a class="upnext-item" href="/v/${v.id}" data-link>
                ${thumbHtml(v)}
                <div style="min-width:0">
                  <h4 class="vcard-title">${esc(v.title)}</h4>
                  <div class="vcard-meta">${esc(userInfo(v.owner).displayName)}</div>
                  <div class="vcard-meta" style="margin-top:0">${fmtAgo(v.createdAt)}</div>
                </div>
              </a>`).join("")}
          </div>` : ""}
      </aside>
    </div>`;

  const root = app.querySelector(".watch");
  const titleEl = root.querySelector(".watch-title");
  const descEl = root.querySelector(".desc");
  const autoplaySwitch = root.querySelector("#autoplay");

  // 起播位置：?t= 参数 > 本机观看进度
  const tParam = parseTime(url.searchParams.get("t"));
  const saved = meta.nsfw ? null : history.get(id);
  const resumeAt = saved && !saved.done && saved.t > 5 && (!meta.duration || saved.t < meta.duration - 10) ? saved.t : 0;
  const startAt = tParam ?? resumeAt;

  const player = new Player(root.querySelector(".player-band"), {
    source: { type: meta.playback.type, url: mediaUrl(id, meta.playback.path) },
    poster: meta.thumb ? mediaUrl(id, "thumb.jpg", meta.thumb) : "",
    title: meta.title,
    startAt,
    storyboard: meta.storyboard ? { ...meta.storyboard, url: mediaUrl(id, meta.storyboard.path) } : null,
    next: next ? { title: next.title } : null,
    onNext: () => next && navigate(`/v/${next.id}`),
    onTheater: (on) => root.classList.toggle("theater", on),
    onProgress: (t, d) => {
      if (meta.nsfw || !d || !isFinite(d)) return; // NSFW 视频不写入观看记录
      if (t >= d - 10) history.finish(id, d);
      else if (t > 5) history.set(id, t, d);
    },
    onEnded: () => !meta.nsfw && history.finish(id, meta.duration),
    onAutoplayChange: (on) => autoplaySwitch && (autoplaySwitch.checked = on),
  });
  if (!tParam && resumeAt) setTimeout(() => player.flashToast(`从 ${fmtTime(resumeAt)} 继续播放`), 600);
  player.el.focus({ preventScroll: true });

  if (autoplaySwitch) {
    autoplaySwitch.onchange = () => {
      store.set("autoplay", autoplaySwitch.checked);
      player.setAutoplay(autoplaySwitch.checked);
    };
  }

  const paintInfo = () => {
    titleEl.textContent = meta.title;
    document.title = siteTitle(meta.title);
    const text = descEl.querySelector(".desc-text");
    text.innerHTML = meta.description ? richText(meta.description) : `<span class="desc-empty">暂无简介</span>`;
    descEl.classList.remove("clamped");
    const toggle = descEl.querySelector(".desc-toggle");
    const long = text.scrollHeight > parseFloat(getComputedStyle(text).lineHeight) * 3.6;
    toggle.hidden = !long;
    if (long) {
      descEl.classList.add("clamped");
      toggle.textContent = "展开";
    }
  };
  paintInfo();

  descEl.querySelector(".desc-toggle").onclick = () => {
    const clamped = descEl.classList.toggle("clamped");
    descEl.querySelector(".desc-toggle").textContent = clamped ? "展开" : "收起";
  };
  descEl.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-t]");
    if (!a) return;
    e.preventDefault();
    player.seek(Number(a.dataset.t));
    player.video.play().catch(() => {});
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  root.querySelector(".watch-actions").onclick = async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "share") {
      const base = `${location.origin}/v/${id}`;
      openMenu(btn, [
        { label: "复制链接", icon: "link", onClick: async () => toast((await copyText(base)) ? "链接已复制" : base, "success") },
        {
          label: `复制当前时间点链接（${fmtTime(player.video.currentTime)}）`,
          icon: "clock",
          onClick: async () => {
            const link = `${base}?t=${Math.floor(player.video.currentTime)}`;
            toast((await copyText(link)) ? "带时间点的链接已复制" : link, "success");
          },
        },
      ], { align: "left" });
    } else if (act === "edit") {
      const updated = await editVideo(meta);
      if (updated) {
        Object.assign(meta, updated);
        paintInfo();
        if (!meta.original) root.querySelector("[data-original]")?.remove();
        if (updated.thumb) player.video.poster = mediaUrl(id, "thumb.jpg", updated.thumb);
      }
    } else if (act === "more") {
      openMenu(btn, [
        {
          label: "用当前画面作为封面",
          icon: "camera",
          onClick: async () => {
            const v = player.video;
            if (!v.videoWidth) return toast("视频画面还没有加载出来", "error");
            try {
              const blob = await canvasToJpeg(composeCover(v, v.videoWidth, v.videoHeight), 0.88);
              await uploadThumb(id, blob);
              toast("封面已更新", "success");
            } catch (err) {
              toast(err.message, "error");
            }
          },
        },
        { sep: true },
        ...(canDeleteOriginal(meta) ? [{
          label: `删除原片${meta.original.size ? `（${fmtSize(meta.original.size)}）` : ""}`,
          icon: "trash",
          onClick: async () => {
            const updated = await deleteOriginal(meta);
            if (!updated) return;
            Object.assign(meta, updated);
            root.querySelector("[data-original]")?.remove();
          },
        }] : []),
        {
          label: "删除视频",
          icon: "trash",
          danger: true,
          onClick: async () => {
            if (await deleteVideo(meta)) navigate("/");
          },
        },
      ]);
    }
  };

  return () => player.destroy();
}

// "90" / "1:30" / "1m30s" → 秒
function parseTime(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (/^(\d+:)?\d+:\d+$/.test(s)) return s.split(":").reduce((a, b) => a * 60 + Number(b), 0);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  return m && (m[1] || m[2] || m[3]) ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : null;
}

// 简介：转义后识别网址和时间点
function richText(text) {
  return esc(text)
    .replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/(^|[\s(（])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s)）,，。.!！])/gm, (m, pre, t) => {
      const sec = t.split(":").reduce((a, b) => a * 60 + Number(b), 0);
      return `${pre}<a href="?t=${sec}" data-t="${sec}">${t}</a>`;
    });
}
