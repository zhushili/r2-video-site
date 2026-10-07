// NSFW：账号菜单里的开关。打开时需要输入访问密码，之后全站显示 NSFW 视频；关闭后立即隐藏。
import { icon } from "../icons.js";
import { api, invalidateVideos, modal, passwordInput, state, toast } from "../lib.js";

async function unlock(password) {
  await api("POST", "/api/nsfw/unlock", { password });
  state.config.nsfw.unlocked = true;
  invalidateVideos();
}

export async function lockNsfw() {
  await api("POST", "/api/nsfw/lock");
  state.config.nsfw.unlocked = false;
  invalidateVideos();
}

// 打开开关时弹出的密码框；成功返回 true
export async function unlockDialog() {
  const r = await modal({
    title: "显示 NSFW 内容",
    size: "sm",
    content: `
      <p style="margin:0">这些内容可能不适合在工作场所或公共场合观看，仅限成年人访问。请输入访问密码。</p>
      ${passwordInput(`id="nsfw-unlock-pw" placeholder="访问密码" autocomplete="off" required autofocus`)}
      <p class="field-hint" style="margin:0">开启后关闭浏览器或 12 小时后会自动关闭，也可以随时手动关闭。</p>`,
    buttons: [
      { label: "取消", value: "cancel", kind: "ghost" },
      { label: "开启", value: "ok", kind: "danger" },
    ],
    async onSubmit(_, root) {
      const input = root.querySelector("#nsfw-unlock-pw");
      try {
        await unlock(input.value);
      } catch (err) {
        toast(err.message, "error");
        input.select();
        return false; // 密码错误：对话框保持打开
      }
      toast("已显示 NSFW 内容", "success");
      return true;
    },
  });
  return r === true;
}

// 直接打开 NSFW 视频链接、但开关没打开时显示的密码页
export function nsfwGate(app, onUnlocked) {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login card-box nsfw-gate">
        <div class="login-logo nsfw-icon">${icon("eyeOff")}</div>
        <h1>NSFW 内容</h1>
        <p class="sub">这个视频可能不适合在工作场所或公共场合观看，仅限成年人访问。请输入访问密码继续。</p>
        <form id="nsfw-form">
          ${passwordInput(`name="password" placeholder="访问密码" autocomplete="off" required`)}
          <p class="form-error" id="nsfw-error"></p>
          <button class="btn danger lg block" type="submit">${icon("lock")}继续观看</button>
        </form>
        <div class="auth-switch"><a href="/" data-link>返回首页</a></div>
      </div>
    </div>`;
  const form = app.querySelector("#nsfw-form");
  const input = form.password;
  input.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await unlock(input.value);
      toast("已显示 NSFW 内容", "success");
      onUnlocked();
    } catch (err) {
      form.querySelector("#nsfw-error").textContent = err.message;
      btn.disabled = false;
      input.select();
    }
  };
}
