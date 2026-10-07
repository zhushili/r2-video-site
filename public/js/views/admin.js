// 管理后台：用户 /admin/users、分类 /admin/categories、NSFW 专区 /admin/nsfw
import { CATEGORY_ICONS, icon } from "../icons.js";
import {
  api, avatarHtml, closeMenu, confirmDialog, esc, fmtDate, getVideos, invalidateVideos, isAdmin, modal, openMenu,
  passwordInput, ROLE_LABELS, siteTitle, state, toast,
} from "../lib.js";

function tabs(active) {
  return `
    <div class="page-head"><div><h1>管理后台</h1><p class="sub">管理用户、权限、分类和 NSFW 专区</p></div></div>
    <nav class="tabs">
      <a href="/admin/users" data-link class="${active === "users" ? "on" : ""}">${icon("users")}用户</a>
      <a href="/admin/categories" data-link class="${active === "categories" ? "on" : ""}">${icon("tag")}分类</a>
      <a href="/admin/nsfw" data-link class="${active === "nsfw" ? "on" : ""}">${icon("eyeOff")}NSFW</a>
    </nav>`;
}

function guard(ctx) {
  if (isAdmin()) return true;
  ctx.navigate(state.config.user ? "/" : `/login?next=${encodeURIComponent(location.pathname)}`, true);
  return false;
}

// ================= 用户 =================

export async function renderUsers(ctx) {
  if (!guard(ctx)) return;
  const { app, isCurrent } = ctx;
  document.title = siteTitle("用户管理");
  app.innerHTML = `<div class="studio">${tabs("users")}<div class="skeleton" style="height:120px;border-radius:16px"></div></div>`;
  const [{ users }, videos] = await Promise.all([api("GET", "/api/users"), getVideos(true)]);
  if (!isCurrent()) return;
  const settings = state.config.settings || { allowRegistration: false, defaultRole: "viewer" };
  const counts = {};
  for (const v of videos) counts[v.owner] = (counts[v.owner] || 0) + 1;

  app.innerHTML = `
    <div class="studio">
      ${tabs("users")}
      <section class="panel card-box">
        <div class="panel-head"><h2>注册设置</h2></div>
        <div class="settings-row" style="margin-top:0">
          <label class="switch"><input type="checkbox" id="allow-reg" ${settings.allowRegistration ? "checked" : ""}>允许新用户自行注册</label>
          <div class="settings-group">
            <span class="lbl">注册后的角色</span>
            <select class="select" id="default-role">
              <option value="viewer" ${settings.defaultRole === "viewer" ? "selected" : ""}>观众（只能观看）</option>
              <option value="creator" ${settings.defaultRole === "creator" ? "selected" : ""}>创作者（可以上传）</option>
            </select>
          </div>
        </div>
        <p class="field-hint" style="margin:12px 0 0">关闭注册时，只能由管理员在下面创建账号。开放注册并允许上传会消耗你的 R2 存储空间，请谨慎选择。</p>
      </section>

      <section class="panel card-box">
        <div class="panel-head">
          <h2>全部用户 <span class="subtle" style="font-weight:500">${users.length}</span></h2>
          <button class="btn primary" id="new-user">${icon("userPlus")}新建用户</button>
        </div>
        <table class="vtable">
          <thead><tr><th>用户</th><th>角色</th><th class="hide-md">视频</th><th>状态</th><th class="hide-md">加入时间</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr data-u="${u.username}">
                <td><a class="ut-user" href="/@${u.username}" data-link>${avatarHtml(u, 36)}<div style="min-width:0"><b>${esc(u.displayName)}</b><span>@${esc(u.username)}</span></div></a></td>
                <td>${u.primary
                  ? `<span class="badge accent">${icon("shield")}主管理员</span>`
                  : `<select class="select sm" data-role>${Object.entries(ROLE_LABELS).map(([k, l]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${l}</option>`).join("")}</select>`}</td>
                <td class="vt-num hide-md hide-sm">${counts[u.username] || 0}</td>
                <td class="vt-status">${u.disabled ? `<span class="badge danger"><span class="dot"></span>已停用</span>` : `<span class="badge success"><span class="dot"></span>正常</span>`}</td>
                <td class="vt-num hide-md hide-sm">${fmtDate(u.createdAt)}</td>
                <td>${u.primary ? "" : `<div class="row-actions"><button class="icon-btn sm" data-act="more" aria-label="更多操作">${icon("more")}</button></div>`}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </section>
    </div>`;

  const saveSettings = async () => {
    try {
      state.config.settings = await api("PUT", "/api/settings", {
        allowRegistration: app.querySelector("#allow-reg").checked,
        defaultRole: app.querySelector("#default-role").value,
      });
      state.config.allowRegistration = state.config.settings.allowRegistration;
      toast("注册设置已保存", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  app.querySelector("#allow-reg").onchange = saveSettings;
  app.querySelector("#default-role").onchange = saveSettings;
  app.querySelector("#new-user").onclick = async () => {
    if (await createUserDialog()) renderUsers(ctx);
  };

  const tbody = app.querySelector("tbody");
  tbody.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-role]");
    if (!sel) return;
    const username = sel.closest("tr").dataset.u;
    try {
      await api("PATCH", `/api/users/${username}`, { role: sel.value });
      toast(`已将 @${username} 设为${ROLE_LABELS[sel.value]}`, "success");
    } catch (err) {
      toast(err.message, "error");
      renderUsers(ctx);
    }
  });
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act=more]");
    if (!btn) return;
    const u = users.find((x) => x.username === btn.closest("tr").dataset.u);
    openMenu(btn, [
      { label: "查看频道", icon: "userCircle", onClick: () => ctx.navigate(`/@${u.username}`) },
      { label: "重置密码", icon: "lock", onClick: () => resetPasswordDialog(u) },
      {
        label: u.disabled ? "启用账号" : "停用账号",
        icon: u.disabled ? "checkCircle" : "xCircle",
        onClick: async () => {
          try {
            await api("PATCH", `/api/users/${u.username}`, { disabled: !u.disabled });
            toast(u.disabled ? "账号已启用" : "账号已停用，该用户的登录已失效", "success");
            renderUsers(ctx);
          } catch (err) {
            toast(err.message, "error");
          }
        },
      },
      { sep: true },
      { label: "删除用户", icon: "trash", danger: true, onClick: () => deleteUser(ctx, u, videos.filter((v) => v.owner === u.username)) },
    ]);
  });
}

async function createUserDialog() {
  return modal({
    title: "新建用户",
    content: `
      <div class="form-grid">
        <div class="field"><label class="field-label" for="nu-name">昵称</label><input class="input" id="nu-name" maxlength="30" required autofocus></div>
        <div class="field"><label class="field-label" for="nu-user">用户名</label><input class="input" id="nu-user" required pattern="[a-z0-9_]{3,20}" autocapitalize="off" spellcheck="false" placeholder="小写字母 / 数字 / 下划线"></div>
        <div class="field"><label class="field-label" for="nu-pass">初始密码</label><input class="input" id="nu-pass" type="text" required minlength="8" autocomplete="off"></div>
        <div class="field"><label class="field-label" for="nu-role">角色</label>
          <select class="input" id="nu-role"><option value="viewer">观众（只能观看）</option><option value="creator" selected>创作者（可以上传）</option><option value="admin">管理员（全部权限）</option></select>
        </div>
      </div>
      <p class="field-hint" style="margin:0">创建后把用户名和初始密码告诉对方，对方登录后可以在“编辑资料”里修改密码。</p>`,
    buttons: [
      { label: "取消", value: "cancel", kind: "ghost" },
      { label: "创建", value: "ok", kind: "primary" },
    ],
    onOpen(root) {
      const pass = root.querySelector("#nu-pass");
      const chars = "abcdefghjkmnpqrstuvwxyz23456789";
      pass.value = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => chars[b % chars.length]).join("");
    },
    async onSubmit(_, root) {
      const u = await api("POST", "/api/users", {
        displayName: root.querySelector("#nu-name").value,
        username: root.querySelector("#nu-user").value.trim().toLowerCase(),
        password: root.querySelector("#nu-pass").value,
        role: root.querySelector("#nu-role").value,
      });
      toast(`已创建用户 @${u.username}`, "success");
      return true;
    },
  });
}

async function resetPasswordDialog(u) {
  await modal({
    title: `重置 @${u.username} 的密码`,
    size: "sm",
    content: `<div class="field"><label class="field-label" for="rp">新密码（至少 8 位）</label><input class="input" id="rp" type="text" minlength="8" required autofocus autocomplete="off"></div>
      <p class="field-hint" style="margin:0">重置后该用户在所有设备上的登录都会失效。</p>`,
    buttons: [
      { label: "取消", value: "cancel", kind: "ghost" },
      { label: "重置密码", value: "ok", kind: "primary" },
    ],
    async onSubmit(_, root) {
      await api("PATCH", `/api/users/${u.username}`, { password: root.querySelector("#rp").value });
      toast("密码已重置", "success");
    },
  });
}

async function deleteUser(ctx, u, owned) {
  const ok = await confirmDialog({
    title: "删除用户",
    message: owned.length
      ? `@${u.username} 上传了 ${owned.length} 个视频。删除用户会同时永久删除这些视频，无法恢复。确定继续吗？`
      : `确定删除用户 @${u.username} 吗？`,
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    for (const v of owned) await api("DELETE", `/api/videos/${v.id}`);
    await api("DELETE", `/api/users/${u.username}`);
    invalidateVideos();
    toast("用户已删除", "success");
  } catch (err) {
    toast(err.message, "error");
  }
  renderUsers(ctx);
}

// ================= 分类 =================

export async function renderCategories(ctx) {
  if (!guard(ctx)) return;
  const { app, isCurrent } = ctx;
  document.title = siteTitle("分类管理");
  const videos = await getVideos();
  if (!isCurrent()) return;
  const counts = {};
  for (const v of videos) if (v.category) counts[v.category] = (counts[v.category] || 0) + 1;
  // 编辑中的副本；existing 标记已有分类（ID 不可改，避免已有视频失去分类）
  let cats = state.config.categories.map((c) => ({ ...c, existing: true }));

  app.innerHTML = `
    <div class="studio">
      ${tabs("categories")}
      <section class="panel card-box">
        <div class="panel-head">
          <h2>分类</h2>
          <div style="display:flex;gap:8px">
            <button class="btn" id="add-cat">${icon("plus")}添加分类</button>
            <button class="btn primary" id="save-cats">${icon("check")}保存</button>
          </div>
        </div>
        <div class="cat-list" id="cat-list"></div>
        <p class="field-hint" style="margin:14px 0 0">分类会显示在首页顶部和侧栏里。ID 用于网址（如 <code>/c/music</code>），保存后不能修改；删除分类后，其中的视频会变成“未分类”。</p>
      </section>
    </div>`;
  const list = app.querySelector("#cat-list");

  const paint = () => {
    list.innerHTML = cats.length
      ? cats.map((c, i) => `
        <div class="cat-row" data-i="${i}">
          <div class="order">
            <button class="icon-btn" data-act="up" ${i === 0 ? "disabled" : ""} aria-label="上移">${icon("chevronUp")}</button>
            <button class="icon-btn" data-act="down" ${i === cats.length - 1 ? "disabled" : ""} aria-label="下移">${icon("chevronDown")}</button>
          </div>
          <button class="icon-pick" data-act="icon" aria-label="选择图标">${icon(c.icon)}</button>
          <input class="input" data-f="name" maxlength="20" placeholder="分类名称" value="${esc(c.name)}">
          <input class="input cat-id" data-f="id" maxlength="32" placeholder="网址 ID，如 music" value="${esc(c.id)}" ${c.existing ? `disabled title="已有分类的 ID 不能修改"` : ""}>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="subtle" style="font-size:12px;white-space:nowrap">${counts[c.id] || 0} 个视频</span>
            <button class="icon-btn sm" data-act="del" aria-label="删除">${icon("trash")}</button>
          </div>
        </div>`).join("")
      : `<div class="empty" style="padding:32px">还没有分类，点击“添加分类”</div>`;
  };
  paint();

  list.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    cats[e.target.closest(".cat-row").dataset.i][f] = f === "id" ? e.target.value.toLowerCase() : e.target.value;
  });
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const i = Number(btn.closest(".cat-row").dataset.i);
    const act = btn.dataset.act;
    if (act === "up" || act === "down") {
      const j = act === "up" ? i - 1 : i + 1;
      [cats[i], cats[j]] = [cats[j], cats[i]];
      paint();
    } else if (act === "del") {
      const c = cats[i];
      if (counts[c.id] && !(await confirmDialog({ title: "删除分类", message: `「${c.name}」里有 ${counts[c.id]} 个视频，删除后它们会变成“未分类”。`, confirmLabel: "删除", danger: true }))) return;
      cats.splice(i, 1);
      paint();
    } else if (act === "icon") {
      openMenu(btn, [{ html: `<div class="icon-grid">${CATEGORY_ICONS.map((n) => `<button data-icon="${n}" class="${cats[i].icon === n ? "on" : ""}" aria-label="${n}">${icon(n)}</button>`).join("")}</div>` }], { align: "left" });
      document.querySelector(".menu .icon-grid").onclick = (ev) => {
        const b = ev.target.closest("[data-icon]");
        if (!b) return;
        cats[i].icon = b.dataset.icon;
        closeMenu();
        paint();
      };
    }
  });

  app.querySelector("#add-cat").onclick = () => {
    cats.push({ id: `c${Math.random().toString(36).slice(2, 7)}`, name: "", icon: CATEGORY_ICONS[cats.length % CATEGORY_ICONS.length] });
    paint();
    list.querySelector(".cat-row:last-child [data-f=name]").focus();
  };
  app.querySelector("#save-cats").onclick = async () => {
    if (cats.some((c) => !c.name.trim())) return toast("分类名称不能为空", "error");
    try {
      const res = await api("PUT", "/api/categories", { categories: cats.map(({ id, name, icon }) => ({ id, name: name.trim(), icon })) });
      state.config.categories = res.categories;
      cats = res.categories.map((c) => ({ ...c, existing: true }));
      paint();
      ctx.refreshShell();
      toast("分类已保存", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };
}

// ================= NSFW 专区 =================

export async function renderNsfwSettings(ctx) {
  if (!guard(ctx)) return;
  const { app } = ctx;
  document.title = siteTitle("NSFW 设置");
  const nsfw = state.config.nsfw || {};
  const count = (await getVideos()).filter((v) => v.nsfw).length;

  app.innerHTML = `
    <div class="studio">
      ${tabs("nsfw")}
      <section class="panel card-box">
        <div class="panel-head"><h2>NSFW 专区</h2>${nsfw.enabled ? `<span class="badge success"><span class="dot"></span>已启用</span>` : `<span class="badge"><span class="dot"></span>未启用</span>`}</div>
        <p class="field-hint" style="margin:0 0 16px">标记为 NSFW 的视频默认在全站隐藏。启用后，登录用户的账号菜单（右上角头像）里会出现“NSFW 内容”开关，打开开关并输入访问密码后，这些视频才会出现在首页、搜索、分类和频道里（带红色 NSFW 标记）。未开启时，视频文件、封面和预览图在服务器端同样受保护，知道链接也打不开。当前共有 <b>${count}</b> 个 NSFW 视频。</p>
        <label class="switch nsfw-switch"><input type="checkbox" id="nsfw-enabled" ${nsfw.enabled ? "checked" : ""}>启用 NSFW 专区</label>
      </section>

      <section class="panel card-box">
        <div class="panel-head"><h2>访问密码</h2>${nsfw.passwordSet ? `<span class="badge success">已设置</span>` : `<span class="badge warning">未设置</span>`}</div>
        <form id="nsfw-pw" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">
          <div style="flex:1;min-width:220px">${passwordInput(`name="pw" placeholder="${nsfw.passwordSet ? "输入新密码以修改" : "设置访问密码（至少 8 位）"}" minlength="8" required autocomplete="new-password"`)}</div>
          <button class="btn primary" type="submit" style="height:44px">${icon("check")}${nsfw.passwordSet ? "修改密码" : "保存密码"}</button>
        </form>
        <p class="field-hint" style="margin:12px 0 0">这个密码和账号密码无关，可以单独告诉需要访问的人。修改后，所有已经解锁的浏览器都需要重新输入新密码。解锁在关闭浏览器或 12 小时后自动失效。</p>
      </section>
    </div>`;

  const sync = (data) => {
    state.config.nsfw = { ...state.config.nsfw, ...data };
    ctx.refreshShell();
    renderNsfwSettings(ctx);
  };
  app.querySelector("#nsfw-enabled").onchange = async (e) => {
    try {
      sync(await api("PUT", "/api/nsfw", { enabled: e.target.checked }));
      toast(e.target.checked ? "NSFW 专区已启用" : "NSFW 专区已关闭", "success");
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, "error");
    }
  };
  const form = app.querySelector("#nsfw-pw");
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.pw.value.length < 8) return toast("密码至少 8 位", "error");
    try {
      const res = await api("PUT", "/api/nsfw", { password: form.pw.value });
      // 改密码后当前浏览器的解锁也失效了
      sync({ ...res, unlocked: false });
      invalidateVideos();
      toast(nsfw.passwordSet ? "访问密码已修改" : "访问密码已设置，现在可以启用专区了", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };
}
