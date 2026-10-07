// 入口：外框（顶栏 / 侧栏 / 主题）+ 路由
import { icon } from "./icons.js";
import {
  api, avatarHtml, canUpload, closeMenu, debounce, emptyState, esc, invalidateVideos, isAdmin, isTyping, me, nsfwEnabled,
  nsfwUnlocked, openMenu, ROLE_LABELS, siteTitle, state, store, toast,
} from "./lib.js";
import { showShortcuts } from "./player.js";
import { activeTasks, onTasksChange } from "./upload.js";
import * as home from "./views/home.js";
import * as watch from "./views/watch.js";
import * as studio from "./views/studio.js";
import * as historyView from "./views/history.js";
import * as channel from "./views/channel.js";
import { renderCategory, renderOverview } from "./views/categories.js";
import { renderLogin, renderRegister } from "./views/auth.js";
import { renderCategories as adminCategories, renderNsfwSettings as adminNsfw, renderUsers as adminUsers } from "./views/admin.js";
import { lockNsfw, unlockDialog } from "./views/nsfw.js";
import { editProfile } from "./views/editor.js";

const app = document.getElementById("app");
const shell = document.getElementById("shell");
const sidebar = document.getElementById("sidebar");
const searchInput = document.getElementById("search");

const ROUTES = [
  { name: "home", re: /^\/$/, render: home.render },
  { name: "watch", re: /^\/v\/([a-z0-9]+)$/, render: watch.render, params: ["id"] },
  { name: "categories", re: /^\/categories$/, render: renderOverview },
  { name: "category", re: /^\/c\/([a-z0-9-]+)$/, render: renderCategory, params: ["id"] },
  { name: "channel", re: /^\/@([a-z0-9_]{3,20})$/, render: channel.render, params: ["username"] },
  { name: "history", re: /^\/history$/, render: historyView.render },
  { name: "studio", re: /^\/studio$/, render: studio.render },
  { name: "admin-users", re: /^\/admin\/users$/, render: adminUsers },
  { name: "admin-categories", re: /^\/admin\/categories$/, render: adminCategories },
  { name: "admin-nsfw", re: /^\/admin\/nsfw$/, render: adminNsfw },
  { name: "login", re: /^\/login$/, render: renderLogin, public: true },
  { name: "register", re: /^\/register$/, render: renderRegister, public: true },
];

// ================= 主题 =================

function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem("vs:theme", t); // index.html 里的防闪烁脚本读这个原始值
  } catch {}
  renderTopbar();
}
const currentTheme = () => {
  try {
    return localStorage.getItem("vs:theme") || "system";
  } catch {
    return "system";
  }
};
function themeMenu(anchor) {
  const t = currentTheme();
  openMenu(anchor, [
    { header: "外观" },
    { label: "跟随系统", icon: "monitor", checked: t === "system", onClick: () => applyTheme("system") },
    { label: "浅色", icon: "sun", checked: t === "light", onClick: () => applyTheme("light") },
    { label: "深色", icon: "moon", checked: t === "dark", onClick: () => applyTheme("dark") },
  ]);
}

// ================= 外框 =================

function brandHtml() {
  return `<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="1.5" y="3.5" width="21" height="17" rx="5" fill="var(--accent)"/><path d="M10 8.6v6.8l5.6-3.4z" fill="#fff"/></svg></span>
    <span class="brand-name">${esc(state.config.siteName)}<sup class="brand-badge">${esc(state.config.siteBadge || "")}</sup></span>`;
}

function renderTopbar() {
  document.getElementById("site-name").textContent = state.config.siteName;
  document.getElementById("site-badge").textContent = state.config.siteBadge || "";
  document.getElementById("menu-btn").innerHTML = icon("menu");
  document.getElementById("search-back").innerHTML = icon("chevronLeft");
  document.querySelector(".search-icon").innerHTML = icon("search");
  const t = currentTheme();
  const user = me();
  const right = document.getElementById("topbar-right");
  right.innerHTML = `
    <button class="icon-btn topbar-search-btn" id="search-open" aria-label="搜索">${icon("search")}</button>
    ${user ? "" : `<button class="icon-btn hide-sm" id="theme-btn" aria-label="主题" title="主题">${icon(t === "light" ? "sun" : t === "dark" ? "moon" : "monitor")}</button>`}
    ${canUpload() ? `<a class="btn sm" href="/studio" data-link title="上传视频">${icon("upload")}<span class="hide-sm">上传</span></a>` : ""}
    ${user
      ? `<button class="avatar-btn" id="account-btn" aria-label="账户菜单">${avatarHtml(user, 32)}</button>`
      : `<a class="btn outline sm" href="/login" data-link>${icon("userCircle")}登录</a>`}`;

  right.querySelector("#search-open").onclick = () => {
    shell.classList.add("search-open");
    searchInput.focus();
  };
  right.querySelector("#theme-btn")?.addEventListener("click", (e) => themeMenu(e.currentTarget));
  right.querySelector("#account-btn")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    openMenu(btn, [
      {
        html: `<div class="menu-user">${avatarHtml(user, 40)}<div style="min-width:0"><b>${esc(user.displayName)}</b><span>@${esc(user.username)} · ${ROLE_LABELS[user.role]}</span><br><a href="/@${user.username}" data-link>查看你的频道</a></div></div>`,
      },
      ...(canUpload() ? [{ label: "工作室", icon: "studio", onClick: () => navigate("/studio") }] : []),
      { label: "编辑资料", icon: "edit", onClick: profile },
      // NSFW 开关：打开要输入访问密码，关闭立即生效
      ...(nsfwEnabled() ? [{ label: "NSFW 内容", icon: nsfwUnlocked() ? "eye" : "eyeOff", toggle: nsfwUnlocked(), onClick: toggleNsfw }] : []),
      ...(isAdmin() ? [{ label: "管理后台", icon: "shield", onClick: () => navigate("/admin/users") }] : []),
      { sep: true },
      { label: `外观：${{ system: "跟随系统", light: "浅色", dark: "深色" }[t]}`, icon: t === "light" ? "sun" : t === "dark" ? "moon" : "monitor", onClick: () => setTimeout(() => themeMenu(btn)) },
      { label: "键盘快捷键", icon: "keyboard", onClick: showShortcuts },
      { sep: true },
      { label: "退出登录", icon: "logout", onClick: logout },
    ]);
  });
}

async function profile() {
  if (await editProfile()) {
    refreshShell();
    if (shell.dataset.route === "channel") render();
  }
}

function renderSidebar(route) {
  const user = me();
  const path = location.pathname;
  const item = (href, ic, label, active, { extra = false, badge = "" } = {}) =>
    `<a class="nav-item ${active ? "active" : ""} ${extra ? "nav-extra" : ""}" href="${href}" data-link>${icon(ic)}<span>${esc(label)}</span>${badge ? `<span class="nav-badge" title="${badge} 个视频处理中">${badge}</span>` : ""}</a>`;
  const busy = activeTasks().length;
  const cats = state.config.categories;
  sidebar.innerHTML = `
    <div class="sidebar-head">
      <button class="icon-btn" data-close-drawer aria-label="关闭菜单">${icon("menu")}</button>
      <a href="/" class="brand" data-link>${brandHtml()}</a>
    </div>
    ${item("/", "home", "首页", route === "home")}
    ${item("/categories", "compass", "分类", route === "categories" || route === "category")}
    ${item("/history", "history", "观看记录", route === "history")}
    ${user ? `
      <div class="nav-sep nav-extra"></div>
      <div class="nav-title nav-extra">我</div>
      ${item(`/@${user.username}`, "userCircle", "你的频道", path === `/@${user.username}`, { extra: true })}
      ${canUpload() ? item("/studio", "studio", "工作室", route === "studio", { badge: busy }) : ""}` : ""}
    ${cats.length ? `
      <div class="nav-sep nav-extra"></div>
      <div class="nav-title nav-extra">分类</div>
      ${cats.map((c) => item(`/c/${c.id}`, c.icon, c.name, path === `/c/${c.id}`, { extra: true })).join("")}` : ""}
    ${isAdmin() ? `
      <div class="nav-sep nav-extra"></div>
      <div class="nav-title nav-extra">管理</div>
      ${item("/admin/users", "users", "用户管理", route === "admin-users", { extra: true })}
      ${item("/admin/categories", "tag", "分类管理", route === "admin-categories", { extra: true })}` : ""}
    ${user ? "" : `
      <div class="nav-sep nav-extra"></div>
      <div class="sidebar-foot nav-extra" style="margin-top:0;padding-top:4px">登录后可以上传视频、管理你的频道。<br><a class="btn outline sm" href="/login" data-link style="margin-top:10px">${icon("userCircle")}登录</a></div>`}
    <div class="sidebar-foot nav-extra">
      视频存储于 Cloudflare R2<br>
      按 <kbd>?</kbd> 查看快捷键
    </div>`;
  sidebar.querySelector("[data-close-drawer]").onclick = closeDrawer;
}

function navMode(route) {
  if (route === "watch" || route === "login" || route === "register" || innerWidth < 800) return "drawer";
  if (innerWidth < 1280) return "mini";
  return store.get("sidebar", "full") === "mini" ? "mini" : "full";
}
function applyNavMode() {
  shell.dataset.nav = navMode(shell.dataset.route);
  if (shell.dataset.nav !== "drawer") closeDrawer();
}
function closeDrawer() {
  shell.classList.remove("drawer-open");
}

document.getElementById("menu-btn").onclick = () => {
  if (shell.dataset.nav === "drawer") shell.classList.toggle("drawer-open");
  else {
    store.set("sidebar", shell.dataset.nav === "full" ? "mini" : "full");
    applyNavMode();
  }
};
document.getElementById("scrim").onclick = closeDrawer;
addEventListener("resize", debounce(applyNavMode, 100));

// 账号菜单里的 NSFW 开关：打开要输入密码，关闭立即生效；之后重新渲染当前页面
async function toggleNsfw() {
  if (nsfwUnlocked()) {
    await lockNsfw();
    toast("已隐藏 NSFW 内容");
  } else if (!(await unlockDialog())) {
    return;
  }
  refreshShell();
  render(scrollY);
}

async function logout() {
  if (activeTasks().length) return toast("还有视频正在上传，请等待完成后再退出", "error");
  await api("POST", "/api/logout");
  await api("POST", "/api/nsfw/lock").catch(() => {}); // 退出登录时一并锁上 NSFW 专区
  state.config.user = null;
  if (state.config.nsfw) state.config.nsfw.unlocked = false;
  state.config.settings = undefined;
  invalidateVideos();
  refreshShell();
  toast("已退出登录");
  navigate("/");
}

function refreshShell() {
  renderTopbar();
  renderSidebar(shell.dataset.route);
}

// ================= 搜索 =================

document.getElementById("search-form").onsubmit = (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  searchInput.blur();
  shell.classList.remove("search-open");
  navigate(q ? `/?q=${encodeURIComponent(q)}` : "/");
};
document.getElementById("search-back").onclick = () => shell.classList.remove("search-open");
searchInput.addEventListener("input", debounce(() => {
  if (location.pathname !== "/") return;
  const q = searchInput.value.trim();
  history.replaceState(history.state, "", q ? `/?q=${encodeURIComponent(q)}` : "/");
  home.render({ ...makeCtx(renderToken), url: new URL(location.href), cached: true });
}, 150));

// ================= 全局快捷键 =================

document.addEventListener("keydown", (e) => {
  if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector(".modal-backdrop")) {
    if (e.key === "Escape" && e.target === searchInput) {
      searchInput.blur();
      shell.classList.remove("search-open");
    }
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    shell.classList.add("search-open");
    searchInput.focus();
    searchInput.select();
  } else if (e.key === "?") {
    e.preventDefault();
    showShortcuts();
  } else if (e.key === "Escape") closeDrawer();
});

// ================= 路由 =================

let renderToken = 0;
let cleanup = null;

function navigate(path, replace = false) {
  if (!replace) history.replaceState({ ...(history.state || {}), scroll: scrollY }, "");
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  render();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
  e.preventDefault();
  closeMenu();
  const href = a.getAttribute("href");
  if (href === location.pathname + location.search) {
    if (shell.dataset.route !== "watch") window.scrollTo({ top: 0, behavior: "smooth" });
    closeDrawer();
    return;
  }
  navigate(href);
});
addEventListener("popstate", () => render(history.state?.scroll));
history.scrollRestoration = "manual";

function makeCtx(token) {
  return {
    app,
    url: new URL(location.href),
    navigate,
    refreshShell,
    isCurrent: () => token === renderToken,
  };
}

async function render(restoreScroll) {
  const token = ++renderToken;
  try {
    cleanup?.();
  } catch {}
  cleanup = null;
  closeMenu();
  closeDrawer();
  shell.classList.remove("search-open");

  const url = new URL(location.href);
  // 直接在地址栏输入 /@用户名 时，浏览器会把 @ 编码成 %40
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (path === "/admin") return navigate("/admin/users", true);
  const route = ROUTES.find((r) => r.re.test(path));

  if (state.config.privateMode && !me() && !route?.public) {
    return navigate(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, true);
  }

  shell.dataset.route = route?.name || "404";
  applyNavMode();
  renderSidebar(route?.name);
  searchInput.value = route?.name === "home" ? url.searchParams.get("q") || "" : "";
  window.scrollTo(0, 0);

  if (!route) {
    document.title = siteTitle("页面不存在");
    app.innerHTML = emptyState("alert", "页面不存在", "你访问的页面可能已被删除或地址有误。", `<a class="btn primary" href="/" data-link>回到首页</a>`);
    return;
  }

  const ctx = makeCtx(token);
  const m = route.re.exec(path);
  ctx.params = Object.fromEntries((route.params || []).map((p, i) => [p, m[i + 1]]));
  try {
    const result = await route.render(ctx);
    if (typeof result === "function") {
      if (ctx.isCurrent()) cleanup = result;
      else result();
    }
    if (ctx.isCurrent() && restoreScroll) requestAnimationFrame(() => window.scrollTo(0, restoreScroll));
  } catch (err) {
    if (!ctx.isCurrent()) return;
    if (err.status === 401) return navigate(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, true);
    const notFound = err.status === 404;
    if (!notFound) console.error(err);
    const what = route.name === "channel" ? "用户" : "视频";
    document.title = siteTitle(notFound ? `${what}不存在` : "加载失败");
    app.innerHTML = notFound
      ? emptyState(route.name === "channel" ? "userCircle" : "film", `${what}不存在`, `这个${what}可能已经被删除了。`, `<a class="btn primary" href="/" data-link>回到首页</a>`)
      : emptyState("wifiOff", "加载失败", esc(err.message), `<button class="btn primary" onclick="location.reload()">重新加载</button>`);
  }
}

// 上传任务状态变化时刷新侧栏里的“处理中”计数
onTasksChange(() => renderSidebar(shell.dataset.route));

// ================= 启动 =================

(async () => {
  try {
    state.config = { ...state.config, ...(await api("GET", "/api/config")) };
  } catch {}
  renderTopbar();
  render();
})();
