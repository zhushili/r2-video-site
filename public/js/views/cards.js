// 视频卡片 + 悬停预览（鼠标在封面上左右移动时，按位置显示雪碧图中的画面）
import { icon } from "../icons.js";
import { avatarHtml, esc, fmtAgo, fmtTime, history, mediaUrl, qualityTag, thumbUrl, userInfo } from "../lib.js";

export function thumbHtml(v, { progress = true } = {}) {
  const h = progress ? history.get(v.id) : null;
  const pct = h && h.d && !h.done ? Math.min(100, (h.t / h.d) * 100) : 0;
  const sb = v.storyboard;
  const tag = qualityTag(v.height);
  return `
    <div class="thumb"${sb ? ` data-sb="${esc(JSON.stringify({ ...sb, url: mediaUrl(v.id, sb.path) }))}"` : ""}>
      ${v.thumb ? `<img src="${thumbUrl(v)}" alt="" loading="lazy" decoding="async">` : `<div class="ph">${icon("film")}</div>`}
      ${sb ? `<div class="scrub"></div><div class="scrub-bar"></div>` : ""}
      ${tag ? `<span class="qtag">${tag}</span>` : ""}
      ${v.nsfw ? `<span class="qtag nsfw-tag">NSFW</span>` : ""}
      ${v.duration ? `<span class="dur">${fmtTime(v.duration)}</span>` : ""}
      ${pct > 1 ? `<div class="watched"><i style="width:${pct}%"></i></div>` : ""}
    </div>`;
}

// YouTube 风格：封面 + 头像 + 标题 + 频道名 + 时间
export function videoCard(v, { meta, channel = true } = {}) {
  const u = userInfo(v.owner);
  return `
    <div class="vcard" data-title="${esc(v.title.toLowerCase())}">
      <a href="/v/${v.id}" data-link tabindex="-1">${thumbHtml(v)}</a>
      <div class="vcard-body">
        ${channel ? `<a class="vcard-avatar" href="/@${v.owner}" data-link title="${esc(u.displayName)}">${avatarHtml(u, 36)}</a>` : ""}
        <div style="min-width:0">
          <a href="/v/${v.id}" data-link><h3 class="vcard-title">${esc(v.title)}</h3></a>
          ${channel ? `<a class="vcard-channel" href="/@${v.owner}" data-link>${esc(u.displayName)}</a>` : ""}
          <div class="vcard-meta">${meta ?? fmtAgo(v.createdAt)}</div>
        </div>
      </div>
    </div>`;
}

export function skeletonCards(n = 8) {
  return Array.from({ length: n }, () => `
    <div class="vcard sk-card">
      <div class="thumb"></div>
      <div class="vcard-body">
        <div class="skeleton" style="width:36px;height:36px;border-radius:50%;flex:none"></div>
        <div style="flex:1"><div class="skeleton sk-line" style="margin-top:2px"></div><div class="skeleton sk-line short"></div></div>
      </div>
    </div>`).join("");
}

// 事件委托：给容器里所有带雪碧图的封面加悬停预览
export function attachScrub(root) {
  let active = null;
  const reset = () => {
    active?.classList.remove("scrubbing");
    active = null;
  };
  root.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const thumb = e.target.closest(".thumb[data-sb]");
    if (thumb !== active) reset();
    if (!thumb) return;
    const sb = JSON.parse(thumb.dataset.sb);
    const scrub = thumb.querySelector(".scrub");
    if (!scrub.style.backgroundImage) {
      scrub.style.backgroundImage = `url("${sb.url}")`;
      scrub.style.backgroundSize = `${sb.cols * 100}% ${sb.rows * 100}%`;
    }
    const r = thumb.getBoundingClientRect();
    const frac = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width));
    const i = Math.floor(frac * sb.count);
    const col = i % sb.cols, row = Math.floor(i / sb.cols);
    scrub.style.backgroundPosition = `${sb.cols > 1 ? (col / (sb.cols - 1)) * 100 : 0}% ${sb.rows > 1 ? (row / (sb.rows - 1)) * 100 : 0}%`;
    thumb.querySelector(".scrub-bar").style.width = `${frac * 100}%`;
    thumb.classList.add("scrubbing");
    active = thumb;
  });
  root.addEventListener("pointerleave", reset);
}

// 视频网格页通用的排序
export const SORTS = {
  new: ["最新发布", (a, b) => b.createdAt - a.createdAt],
  old: ["最早发布", (a, b) => a.createdAt - b.createdAt],
  long: ["时长最长", (a, b) => (b.duration || 0) - (a.duration || 0)],
  short: ["时长最短", (a, b) => (a.duration || 0) - (b.duration || 0)],
  title: ["标题", (a, b) => a.title.localeCompare(b.title, "zh-CN")],
};

export function sortSelect(key) {
  return `<select class="select" data-sort aria-label="排序">${Object.entries(SORTS)
    .map(([k, [label]]) => `<option value="${k}" ${k === key ? "selected" : ""}>${label}</option>`)
    .join("")}</select>`;
}

// 分类条（首页 / 分类页顶部）
export function chipBar(categories, active) {
  return `<nav class="chipbar" aria-label="分类">
    <a href="/" data-link class="${!active ? "on" : ""}">全部</a>
    ${categories.map((c) => `<a href="/c/${c.id}" data-link class="${active === c.id ? "on" : ""}">${icon(c.icon)}${esc(c.name)}</a>`).join("")}
  </nav>`;
}
