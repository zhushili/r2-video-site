// 登录 / 注册
import { icon } from "../icons.js";
import { api, esc, invalidateVideos, passwordInput, siteTitle, state, toast } from "../lib.js";

const safeNext = (url) => {
  const next = url.searchParams.get("next") || "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
};

function shell({ title, sub, form, footer }) {
  return `
    <div class="login-wrap">
      <div class="login card-box">
        <div class="login-logo">${icon("userCircle")}</div>
        <h1>${title}</h1>
        <p class="sub">${sub}</p>
        <form id="auth-form" novalidate>${form}
          <p class="form-error" id="auth-error"></p>
          <button class="btn primary lg block" type="submit"></button>
        </form>
        ${footer ? `<div class="auth-switch">${footer}</div>` : ""}
      </div>
    </div>`;
}

const pwField = (name, placeholder, autocomplete) =>
  passwordInput(`name="${name}" placeholder="${placeholder}" autocomplete="${autocomplete}" required minlength="${autocomplete === "new-password" ? 8 : 1}"`);

function bindForm(app, label, submit) {
  const form = app.querySelector("#auth-form");
  const btn = form.querySelector("button[type=submit]");
  btn.textContent = label;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector("#auth-error");
    err.textContent = "";
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${label}中…`;
    try {
      await submit(form);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  form.querySelector("input").focus();
}

async function onAuthed(ctx, user, message) {
  state.config.user = user;
  invalidateVideos();
  // 重新拿一次配置：管理员能看到网站设置
  try {
    state.config = await api("GET", "/api/config");
  } catch {}
  ctx.refreshShell();
  toast(message, "success");
  ctx.navigate(safeNext(ctx.url), true);
}

export function renderLogin(ctx) {
  const { app, url, navigate } = ctx;
  if (state.config.user) return navigate(safeNext(url), true);
  document.title = siteTitle("登录");
  const regLink = state.config.allowRegistration
    ? `还没有账号？<a href="/register${url.search}" data-link>注册</a>`
    : "";
  app.innerHTML = shell({
    title: state.config.privateMode ? "登录后继续观看" : "登录",
    sub: `使用你的 ${esc(siteTitle())} 账号`,
    form: `
      <input class="input" name="username" placeholder="用户名" autocomplete="username" autocapitalize="off" spellcheck="false" required style="height:44px">
      ${pwField("password", "密码", "current-password")}
      ${state.config.passwordConfigured === false ? `<p class="form-error">服务器还没有设置 ADMIN_PASSWORD，请先按 README 设置。</p>` : ""}`,
    footer: regLink,
  });
  bindForm(app, "登录", async (form) => {
    const { user } = await api("POST", "/api/login", {
      username: form.username.value.trim().toLowerCase(),
      password: form.password.value,
    });
    await onAuthed(ctx, user, `欢迎回来，${user.displayName}`);
  });
}

export function renderRegister(ctx) {
  const { app, url, navigate } = ctx;
  if (state.config.user) return navigate(safeNext(url), true);
  document.title = siteTitle("注册");
  if (!state.config.allowRegistration) {
    app.innerHTML = shell({
      title: "暂未开放注册",
      sub: "请联系网站管理员为你创建账号",
      form: "",
      footer: `已有账号？<a href="/login${url.search}" data-link>登录</a>`,
    });
    app.querySelector("#auth-form").hidden = true;
    return;
  }
  app.innerHTML = shell({
    title: "创建账号",
    sub: `加入 ${esc(siteTitle())}`,
    form: `
      <input class="input" name="displayName" placeholder="昵称" maxlength="30" required style="height:44px">
      <input class="input" name="username" placeholder="用户名（3–20 位小写字母、数字、下划线）" autocomplete="username" autocapitalize="off" spellcheck="false" required pattern="[a-z0-9_]{3,20}" style="height:44px">
      ${pwField("password", "密码（至少 8 位）", "new-password")}
      ${pwField("confirm", "再输入一次密码", "new-password")}`,
    footer: `已有账号？<a href="/login${url.search}" data-link>登录</a>`,
  });
  bindForm(app, "注册", async (form) => {
    const username = form.username.value.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("用户名需为 3–20 位小写字母、数字或下划线");
    if (form.password.value.length < 8) throw new Error("密码至少 8 位");
    if (form.password.value !== form.confirm.value) throw new Error("两次输入的密码不一致");
    const { user } = await api("POST", "/api/register", {
      username,
      displayName: form.displayName.value.trim() || username,
      password: form.password.value,
    });
    await onAuthed(ctx, user, "注册成功，欢迎加入！");
  });
}
