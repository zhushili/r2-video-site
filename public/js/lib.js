// 公共工具：API、格式化、本地存储、提示、菜单、对话框
import { icon } from "./icons.js";

// ================= 全局状态 =================

export const state = {
  // { siteName, siteBadge, privateMode, allowRegistration, user, categories, settings }
  config: { siteName: "视频站", siteBadge: "", privateMode: false, user: null, categories: [] },
  videos: null, // 列表缓存
  users: {}, // 上传者资料：{ username: { displayName, avatar } }
};

export async function getVideos(force = false) {
  if (!state.videos || force) {
    const data = await api("GET", "/api/videos");
    state.videos = data.videos;
    state.users = { ...state.users, ...data.users };
  }
  return state.videos;
}
export function invalidateVideos() {
  state.videos = null;
}

// ================= 用户 / 权限 / 分类 =================

export const me = () => state.config.user;
export const isAdmin = () => me()?.role === "admin";
export const canUpload = () => ["admin", "creator"].includes(me()?.role);
export const canEdit = (v) => Boolean(me() && (isAdmin() || v.owner === me().username));
export const ROLE_LABELS = { admin: "管理员", creator: "创作者", viewer: "观众" };

// NSFW：专区是否开放、当前浏览器是否已解锁
export const nsfwEnabled = () => Boolean(state.config.nsfw?.enabled);
export const nsfwUnlocked = () => Boolean(state.config.nsfw?.unlocked);
// 账号菜单里的 NSFW 开关打开（已输入密码）时全站显示 NSFW 视频，否则过滤掉
export const visibleVideos = (list) => (nsfwUnlocked() ? list : list.filter((v) => !v.nsfw));

export function siteTitle(prefix) {
  const name = [state.config.siteName, state.config.siteBadge].filter(Boolean).join(" ");
  return prefix ? `${prefix} - ${name}` : name;
}

export function categoryById(id) {
  return state.config.categories.find((c) => c.id === id) || null;
}

export function userInfo(username) {
  if (me()?.username === username) return me();
  return { username, displayName: username, ...(state.users[username] || {}) };
}

// 头像：上传过图片用图片，否则用名字首字 + 按用户名生成的颜色
const AVATAR_COLORS = ["#e8590c", "#d6336c", "#ae3ec9", "#7048e8", "#4263eb", "#1c7ed6", "#1098ad", "#0ca678", "#37b24d", "#f59f00"];
export function avatarHtml(u, size = 36) {
  const name = u?.displayName || u?.username || "?";
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px`;
  if (u?.avatar) {
    return `<span class="avatar" style="${style}"><img src="/avatars/${u.username}?v=${u.avatar}" alt="" loading="lazy"></span>`;
  }
  let h = 0;
  for (const ch of u?.username || name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="${style};background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(Array.from(name)[0].toUpperCase())}</span>`;
}

// ================= API =================

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

export function mediaUrl(id, path, version) {
  return `/media/${id}/${path}${version ? `?v=${version}` : ""}`;
}
export function thumbUrl(v) {
  return v.thumb ? mediaUrl(v.id, "thumb.jpg", v.thumb) : "";
}

// ================= 格式化 =================

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "0:00";
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtDurationLong(sec) {
  if (!sec) return "0 分钟";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
}

export function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

export function fmtAgo(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)} 周前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} 个月前`;
  return `${Math.floor(diff / 86400 / 365)} 年前`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

// 清晰度标签：按短边算，竖屏视频也正确
export function qualityLabel(h) {
  if (!h) return "";
  if (h >= 2000) return "4K";
  if (h >= 1400) return "2K";
  return `${h}p`;
}
export function qualityTag(h) {
  if (!h) return "";
  if (h >= 2000) return "4K";
  if (h >= 1400) return "2K";
  if (h >= 1000) return "HD";
  return "";
}

// ================= 本地存储（只在本机浏览器） =================

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`vs:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`vs:${key}`, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(`vs:${key}`);
    } catch {}
  },
};

// 观看记录：{ [id]: { t: 进度秒, d: 时长, at: 时间戳 } }
export const history = {
  all() {
    return store.get("history", {});
  },
  get(id) {
    return this.all()[id] || null;
  },
  set(id, t, d) {
    const h = this.all();
    h[id] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
    const ids = Object.keys(h).sort((a, b) => h[b].at - h[a].at);
    for (const old of ids.slice(200)) delete h[old];
    store.set("history", h);
  },
  finish(id, d) {
    const h = this.all();
    h[id] = { t: 0, d: Math.round(d || 0), at: Date.now(), done: true };
    store.set("history", h);
  },
  clear() {
    store.remove("history");
  },
};

// ================= 提示 =================

export function toast(msg, type = "info") {
  const root = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast";
  const ic = type === "success" ? icon("checkCircle", "t-success") : type === "error" ? icon("xCircle", "t-error") : "";
  el.innerHTML = `${ic}<span></span>`;
  el.querySelector("span").textContent = msg;
  root.append(el);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 250);
  }, type === "error" ? 4500 : 2600);
}

// ================= 弹出菜单 =================

let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

/**
 * items: [{ label, icon, onClick, danger, checked, toggle, sep, header, html }]
 */
export function openMenu(anchor, items, { align = "right" } = {}) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  for (const it of items) {
    if (it.sep) {
      menu.insertAdjacentHTML("beforeend", `<div class="menu-sep"></div>`);
      continue;
    }
    if (it.header) {
      menu.insertAdjacentHTML("beforeend", `<div class="menu-label">${esc(it.header)}</div>`);
      continue;
    }
    if (it.html) {
      menu.insertAdjacentHTML("beforeend", it.html);
      continue;
    }
    const b = document.createElement("button");
    b.className = `menu-item${it.danger ? " danger" : ""}`;
    b.setAttribute("role", "menuitem");
    b.innerHTML = `${it.icon ? icon(it.icon) : ""}<span class="grow"></span>${it.checked ? `<span class="check">${icon("check")}</span>` : ""}${
      it.toggle !== undefined ? `<span class="menu-sw ${it.toggle ? "on" : ""}" aria-hidden="true"></span>` : ""}`;
    if (it.toggle !== undefined) {
      b.setAttribute("role", "menuitemcheckbox");
      b.setAttribute("aria-checked", String(it.toggle));
    }
    b.querySelector(".grow").textContent = it.label;
    b.onclick = (e) => {
      e.stopPropagation();
      closeMenu();
      it.onClick?.();
    };
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = align === "right" ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenuEl = menu;
  menu.querySelector("button")?.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
addEventListener("resize", closeMenu);
addEventListener("scroll", closeMenu, true);

// ================= 对话框 =================

/**
 * 打开模态框。content 为 HTML 字符串；buttons: [{label, value, kind}]
 * onSubmit(value, root) 返回 false 时不关闭（用于校验 / 异步保存）
 */
export function modal({ title, content = "", buttons = [], size = "", onSubmit, onOpen }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal ${size}" role="dialog" aria-modal="true">
        <div class="modal-head"><h2></h2><button class="icon-btn sm" data-close aria-label="关闭">${icon("x")}</button></div>
        <form class="modal-form">
          <div class="modal-body">${content}</div>
          ${buttons.length ? `<div class="modal-foot">${buttons
            .map((b, i) => `<button type="${b.value === "cancel" ? "button" : "submit"}" class="btn ${b.kind || ""}" data-i="${i}">${esc(b.label)}</button>`)
            .join("")}</div>` : ""}
        </form>
      </div>`;
    backdrop.querySelector("h2").textContent = title;
    const form = backdrop.querySelector("form");
    const prevFocus = document.activeElement;

    const close = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      prevFocus?.focus?.({ preventScroll: true });
      resolve(value);
    };
    const onKey = (e) => {
      // 对话框可以叠加（例如编辑视频时再弹出确认框）：Esc 只关闭最上面的那个
      if (e.key === "Escape" && backdrop === [...document.querySelectorAll(".modal-backdrop")].pop()) {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close(null);
    });
    backdrop.querySelector("[data-close]").onclick = () => close(null);
    for (const btn of backdrop.querySelectorAll(".modal-foot button")) {
      const b = buttons[btn.dataset.i];
      if (b.value === "cancel") btn.onclick = () => close(null);
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.submitter || form.querySelector("button[type=submit]");
      const value = buttons[btn?.dataset.i]?.value ?? true;
      if (onSubmit) {
        btn && (btn.disabled = true);
        try {
          const r = await onSubmit(value, backdrop);
          if (r === false) return;
          close(r === undefined ? value : r);
        } catch (err) {
          toast(err.message, "error");
        } finally {
          btn && (btn.disabled = false);
        }
      } else close(value);
    };
    document.body.append(backdrop);
    onOpen?.(backdrop);
    (backdrop.querySelector("[autofocus]") || backdrop.querySelector(".modal-foot button[type=submit]"))?.focus();
  });
}

export async function confirmDialog({ title, message, confirmLabel = "确定", danger = false }) {
  const r = await modal({
    title,
    size: "sm",
    content: `<p style="margin:0">${esc(message)}</p>`,
    buttons: [
      { label: "取消", value: "cancel", kind: "ghost" },
      { label: confirmLabel, value: "ok", kind: danger ? "danger" : "primary" },
    ],
  });
  return r === "ok";
}

// ================= 页面片段 =================

export function emptyState(ic, title, text, action = "") {
  return `<div class="empty"><div class="empty-icon">${icon(ic)}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
}

// 带“显示密码”按钮的密码框，attrs 是 <input> 的其余属性
export function passwordInput(attrs) {
  return `<div class="pw"><input class="input" type="password" ${attrs}><button type="button" class="icon-btn" data-pw-toggle aria-label="显示密码">${icon("eye")}</button></div>`;
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pw-toggle]");
  if (!btn) return;
  const input = btn.previousElementSibling;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.innerHTML = icon(show ? "eyeOff" : "eye");
  btn.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
  input.focus();
});

// ================= 杂项 =================

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// 把画布导出为 JPEG Blob（兼容 OffscreenCanvas）
export function canvasToJpeg(canvas, quality = 0.85) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// 16:9 封面：横屏直接铺满；竖屏/其它比例 → 居中 + 模糊背景
export function composeCover(src, sw, sh, W = 1280, H = 720) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const ar = sw / sh;
  if (Math.abs(ar - W / H) < 0.03) {
    ctx.drawImage(src, 0, 0, W, H);
    return c;
  }
  // 背景：放大铺满 + 模糊变暗
  const cover = Math.max(W / sw, H / sh) * 1.1;
  ctx.filter = "blur(32px)";
  ctx.drawImage(src, (W - sw * cover) / 2, (H - sh * cover) / 2, sw * cover, sh * cover);
  ctx.filter = "none";
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.fillRect(0, 0, W, H);
  // 前景：完整显示
  const contain = Math.min(W / sw, H / sh);
  ctx.drawImage(src, (W - sw * contain) / 2, (H - sh * contain) / 2, sw * contain, sh * contain);
  return c;
}

// 上传 / 替换封面（服务端会自动更新封面版本号）
export async function uploadThumb(id, blob) {
  const res = await fetch(`/api/videos/${id}/files/thumb.jpg`, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "封面上传失败");
  invalidateVideos();
}

// 图片文件 → 1280×720 JPEG
export async function imageFileToCover(file) {
  const bmp = await createImageBitmap(file);
  const blob = await canvasToJpeg(composeCover(bmp, bmp.width, bmp.height), 0.88);
  bmp.close();
  return blob;
}

// 图片文件 → 256×256 居中裁剪的 JPEG 头像
export async function imageFileToAvatar(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  c.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 256, 256);
  bmp.close();
  return canvasToJpeg(c, 0.88);
}
