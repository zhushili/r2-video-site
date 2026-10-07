// 工作室：统计、上传（转码设置 + 队列）、视频管理表格
import { icon } from "../icons.js";
import {
  api, avatarHtml, canUpload, categoryById, emptyState, esc, fmtAgo, fmtDurationLong, fmtSize, fmtTime, getVideos, isAdmin, me,
  qualityLabel, siteTitle, store, toast, userInfo,
} from "../lib.js";
import {
  activeTasks, capabilities, enqueueFiles, getUploadSettings, LADDER, onTasksChange, saveUploadSettings, tasks,
} from "../upload.js";
import { thumbHtml } from "./cards.js";
import { categoryOptions, deleteVideo, editVideo } from "./editor.js";

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts|m2ts|3gp|ogv)$/i;

export async function render({ app, navigate, isCurrent }) {
  if (!me()) return navigate("/login?next=/studio", true);
  document.title = siteTitle("工作室");
  if (!canUpload()) {
    app.innerHTML = emptyState("lock", "你的账号还不能上传视频", "当前角色是“观众”。如需上传，请联系管理员把你设为创作者。", `<a class="btn primary" href="/" data-link>回到首页</a>`);
    return;
  }
  const settings = getUploadSettings();
  if (settings.category && !categoryById(settings.category)) settings.category = "";
  let scope = isAdmin() ? store.get("studioScope", "all") : "mine";

  app.innerHTML = `
    <div class="studio">
      <div class="page-head">
        <div><h1>工作室</h1><p class="sub">上传、转码和管理${isAdmin() ? "全站" : "你的"}视频</p></div>
        <button class="btn primary" id="pick">${icon("upload")}上传视频</button>
      </div>

      <div class="stats" id="stats">${Array.from({ length: 4 }, () => `<div class="card-box stat"><div class="skeleton" style="width:42px;height:42px;border-radius:12px"></div><div style="flex:1"><div class="skeleton" style="height:12px;width:50%"></div><div class="skeleton" style="height:20px;width:70%;margin-top:8px"></div></div></div>`).join("")}</div>

      <section class="panel card-box">
        <div class="panel-head"><h2>上传视频</h2></div>
        <label class="dropzone" id="dz">
          <div class="dropzone-icon">${icon("upload")}</div>
          <strong>拖拽视频到这里，或点击选择文件</strong>
          <span>支持 MP4、MOV、MKV、WebM 等格式，可一次选择多个</span>
          <input type="file" id="file" accept="video/*,.mkv,.mov,.m4v,.webm,.ts,.mts" multiple hidden>
        </label>
        <div class="settings-row">
          <div class="settings-group"><span class="lbl">分类</span><select class="select" id="opt-cat">${categoryOptions(settings.category)}</select></div>
          <label class="switch"><input type="checkbox" id="opt-transcode" ${settings.transcode ? "checked" : ""}>自动转码</label>
          <label class="switch nsfw-switch" title="勾选后视频只出现在需要密码的 NSFW 专区"><input type="checkbox" id="opt-nsfw" ${settings.nsfw ? "checked" : ""}>NSFW</label>
          <div class="settings-group" id="ladder-group">
            <span class="lbl">清晰度</span>
            <div class="chips" id="ladder">
              ${LADDER.map((q) => `<button type="button" class="chip ${settings.ladder.includes(q) ? "on" : ""}" data-q="${q}">${settings.ladder.includes(q) ? icon("check") : ""}${qualityLabel(q)}</button>`).join("")}
            </div>
          </div>
          <label class="switch"><input type="checkbox" id="opt-keep" ${settings.keepOriginal ? "checked" : ""}>保留原片（可供下载，之后也能单独删除）</label>
        </div>
        <div class="caps" id="caps"><span class="spinner"></span>正在检测浏览器的转码能力…</div>
        <div class="queue" id="queue"></div>
      </section>

      <section class="panel card-box">
        <div class="panel-head">
          <h2>${isAdmin() ? "视频管理" : "我的视频"}</h2>
          <div class="table-tools">
            ${isAdmin() ? `<select class="select" id="scope"><option value="all" ${scope === "all" ? "selected" : ""}>全部用户</option><option value="mine" ${scope === "mine" ? "selected" : ""}>只看我的</option></select>` : ""}
            <input class="input" id="filter" type="search" placeholder="筛选标题…" autocomplete="off">
          </div>
        </div>
        <div id="table"><div class="skeleton" style="height:72px"></div></div>
      </section>
    </div>`;

  const root = app.querySelector(".studio");
  const $ = (s) => root.querySelector(s);

  // ---------- 转码设置 ----------
  const readSettings = () => ({
    category: $("#opt-cat").value,
    nsfw: $("#opt-nsfw").checked,
    transcode: $("#opt-transcode").checked,
    keepOriginal: $("#opt-keep").checked,
    ladder: [...root.querySelectorAll("#ladder .chip.on")].map((c) => Number(c.dataset.q)),
  });
  const syncSettingsUi = () => {
    const s = readSettings();
    $("#ladder-group").style.opacity = s.transcode ? "" : ".45";
    root.querySelectorAll("#ladder .chip").forEach((c) => (c.disabled = !s.transcode));
  };
  $("#ladder").onclick = (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const on = !chip.classList.contains("on");
    if (!on && root.querySelectorAll("#ladder .chip.on").length === 1) return toast("至少保留一种清晰度");
    chip.classList.toggle("on", on);
    chip.innerHTML = `${on ? icon("check") : ""}${qualityLabel(Number(chip.dataset.q))}`;
    saveUploadSettings(readSettings());
  };
  $("#opt-transcode").onchange = $("#opt-keep").onchange = $("#opt-cat").onchange = $("#opt-nsfw").onchange = () => {
    saveUploadSettings(readSettings());
    syncSettingsUi();
  };
  syncSettingsUi();

  capabilities().then((caps) => {
    const el = $("#caps");
    if (!el) return;
    if (caps.avc && caps.aac) {
      el.className = "caps ok";
      el.innerHTML = `${icon("checkCircle")}<span>你的浏览器支持硬件加速转码（H.264${caps.aacWasm ? " + AAC 软件编码" : " + AAC"}）。转码在本机完成，视频会被转成 HLS 自适应码率格式。</span>`;
    } else {
      el.className = "caps warn";
      el.innerHTML = `${icon("alert")}<span>当前浏览器不支持 WebCodecs 视频编码，文件将不转码直接上传。推荐使用最新版 Chrome、Edge 或 Safari 上传。</span>`;
    }
  });

  // ---------- 选择文件 ----------
  const input = $("#file");
  const dz = $("#dz");
  const add = (files) => {
    const vids = files.filter((f) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name));
    if (vids.length < files.length) toast(`已忽略 ${files.length - vids.length} 个非视频文件`);
    if (vids.length) enqueueFiles(vids, readSettings());
  };
  $("#pick").onclick = () => input.click();
  input.onchange = () => {
    add([...input.files]);
    input.value = "";
  };
  dz.ondragover = (e) => {
    e.preventDefault();
    dz.classList.add("over");
  };
  dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove("over");
    add([...e.dataTransfer.files]);
  };

  // ---------- 队列 / 表格 / 统计 ----------
  let videos = [];
  const mountQueue = () => {
    const q = $("#queue");
    tasks.forEach((t, i) => {
      if (q.children[i] !== t.el) q.insertBefore(t.el, q.children[i] || null);
    });
    while (q.children.length > tasks.length) q.lastChild.remove();
  };

  const scoped = () => (scope === "mine" ? videos.filter((v) => v.owner === me().username) : videos);
  const paintStats = () => {
    const ready = scoped().filter((v) => v.status === "ready");
    const totalDur = ready.reduce((s, v) => s + (v.duration || 0), 0);
    const totalSize = scoped().reduce((s, v) => s + (v.size || 0), 0);
    const stat = (ic, label, value) => `<div class="card-box stat"><div class="stat-icon">${icon(ic)}</div><div><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div></div>`;
    $("#stats").innerHTML =
      stat("film", "已发布视频", ready.length) +
      stat("clock", "总时长", fmtDurationLong(totalDur)) +
      stat("database", "存储占用", fmtSize(totalSize)) +
      stat("cpu", "正在处理", activeTasks().length);
  };

  const paintTable = () => {
    const needle = $("#filter").value.trim().toLowerCase();
    const list = scoped().filter((v) => !needle || v.title.toLowerCase().includes(needle));
    const active = new Set(activeTasks().map((t) => t.id));
    if (!scoped().length) {
      $("#table").innerHTML = `<div class="empty" style="padding:40px 20px"><div class="empty-icon">${icon("film")}</div><h3>还没有视频</h3><p>把视频拖到上面的区域开始上传</p></div>`;
      return;
    }
    $("#table").innerHTML = `
      <table class="vtable">
        <thead><tr><th>视频</th><th>状态</th>${isAdmin() && scope === "all" ? `<th class="hide-md">上传者</th>` : ""}<th class="hide-md">分类</th><th class="hide-md">清晰度</th><th class="hide-md">时长</th><th class="hide-md">大小</th><th class="hide-md">上传时间</th><th></th></tr></thead>
        <tbody>
          ${list.map((v) => {
            const status = v.status === "ready"
              ? `<span class="badge success"><span class="dot"></span>已发布</span>`
              : active.has(v.id)
                ? `<span class="badge warning"><span class="dot pulse"></span>处理中</span>`
                : `<span class="badge danger"><span class="dot"></span>未完成</span>`;
            return `
              <tr data-id="${v.id}">
                <td>
                  <div class="vt-video${v.nsfw ? " nsfw-blur" : ""}">
                    ${v.status === "ready" ? `<a href="/v/${v.id}" data-link>${thumbHtml(v, { progress: false })}</a>` : thumbHtml(v, { progress: false })}
                    <div style="min-width:0">
                      <div class="vcard-title">${v.nsfw ? `<span class="badge nsfw-badge" style="margin-right:6px;vertical-align:1px">NSFW</span>` : ""}${esc(v.title)}</div>
                      <div class="vt-file">${fmtAgo(v.createdAt)}${v.duration ? ` · ${fmtTime(v.duration)}` : ""} · ${fmtSize(v.size)}</div>
                    </div>
                  </div>
                </td>
                <td class="vt-status">${status}</td>
                ${isAdmin() && scope === "all" ? `<td class="hide-md hide-sm"><a class="ut-user" href="/@${v.owner}" data-link>${avatarHtml(userInfo(v.owner), 24)}<span style="font-size:13px;color:var(--text-2)">${esc(userInfo(v.owner).displayName)}</span></a></td>` : ""}
                <td class="hide-md hide-sm">${categoryById(v.category) ? `<span class="badge">${esc(categoryById(v.category).name)}</span>` : `<span class="subtle">—</span>`}</td>
                <td class="hide-md hide-sm">${v.height ? `<span class="badge">${qualityLabel(v.height)}</span>` : `<span class="subtle">—</span>`}</td>
                <td class="vt-num hide-md hide-sm">${v.duration ? fmtTime(v.duration) : "—"}</td>
                <td class="vt-num hide-md hide-sm">${fmtSize(v.size)}</td>
                <td class="vt-num hide-md hide-sm">${new Date(v.createdAt).toLocaleDateString("zh-CN")}</td>
                <td>
                  <div class="row-actions">
                    ${v.status === "ready" ? `<a class="icon-btn sm" href="/v/${v.id}" data-link title="观看">${icon("play")}</a>` : ""}
                    <button class="icon-btn sm" data-act="edit" title="编辑">${icon("edit")}</button>
                    <button class="icon-btn sm" data-act="delete" title="删除">${icon("trash")}</button>
                  </div>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${list.length ? "" : `<div class="empty" style="padding:32px">没有匹配的视频</div>`}`;
  };

  const refresh = async () => {
    try {
      videos = await getVideos(true);
    } catch (err) {
      return toast(err.message, "error");
    }
    if (!isCurrent()) return;
    paintStats();
    paintTable();
  };

  $("#filter").oninput = paintTable;
  $("#scope")?.addEventListener("change", (e) => {
    scope = e.target.value;
    store.set("studioScope", scope);
    paintStats();
    paintTable();
  });
  $("#table").onclick = async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    const v = videos.find((x) => x.id === id);
    if (btn.dataset.act === "edit") {
      const meta = await api("GET", `/api/videos/${id}`);
      if (await editVideo(meta)) refresh();
    } else if (btn.dataset.act === "delete") {
      const task = activeTasks().find((t) => t.id === id);
      if (task) {
        task.cancel();
        return refresh();
      }
      if (await deleteVideo(v)) refresh();
    }
  };

  mountQueue();
  await refresh();
  const off = onTasksChange(() => {
    mountQueue();
    refresh();
  });
  return off;
}
