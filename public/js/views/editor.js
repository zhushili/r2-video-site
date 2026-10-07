// 对话框：编辑视频、编辑个人资料
import { icon } from "../icons.js";
import {
  api, avatarHtml, confirmDialog, esc, fmtSize, imageFileToAvatar, imageFileToCover, invalidateVideos, me, modal, state,
  thumbUrl, toast, uploadThumb,
} from "../lib.js";

export function categoryOptions(selected) {
  return `<option value="">未分类</option>${state.config.categories
    .map((c) => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`)
    .join("")}`;
}

function bindCounters(root) {
  for (const counter of root.querySelectorAll(".count[data-for]")) {
    const input = root.querySelector(`#${counter.dataset.for}`);
    const update = () => (counter.textContent = `${[...input.value].length} / ${input.maxLength}`);
    input.addEventListener("input", update);
    update();
  }
}

// 原片能否单独删除：没有转码的视频，原片就是播放文件
export const canDeleteOriginal = (meta) => Boolean(meta.original && meta.playback?.path !== meta.original.path);

export async function editVideo(meta) {
  let coverBlob = null;
  let previewUrl = null;
  let latest = null; // 在对话框里删除了原片：即使之后点了取消，也把最新的元数据交给调用方
  const original = meta.original;
  const result = await modal({
    title: "编辑视频",
    size: "lg",
    content: `
      <div class="field">
        <label class="field-label" for="ed-title">标题 <span class="count" data-for="ed-title"></span></label>
        <input class="input" id="ed-title" maxlength="150" required autofocus value="${esc(meta.title)}">
      </div>
      <div class="field">
        <label class="field-label" for="ed-desc">简介 <span class="count" data-for="ed-desc"></span></label>
        <textarea class="textarea" id="ed-desc" maxlength="5000" placeholder="介绍一下这个视频。支持网址链接，写 1:23 这样的时间点可以点击跳转。">${esc(meta.description || "")}</textarea>
      </div>
      <div class="form-grid">
        <div class="field">
          <label class="field-label" for="ed-cat">分类</label>
          <select class="input" id="ed-cat">${categoryOptions(meta.category)}</select>
        </div>
        <div class="field">
          <span class="field-label">可见性</span>
          <label class="switch nsfw-switch" style="height:42px"><input type="checkbox" id="ed-nsfw" ${meta.nsfw ? "checked" : ""}>NSFW（需要访问密码才能观看）</label>
        </div>
      </div>
      <div class="field">
        <span class="field-label">封面</span>
        <div class="cover-edit">
          <div class="thumb">${meta.thumb ? `<img src="${thumbUrl(meta)}" alt="">` : `<div class="ph">${icon("image")}</div>`}</div>
          <div class="btns">
            <label class="btn outline sm">${icon("image")}上传图片<input type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
            <span class="field-hint">建议 16:9，会自动处理为 1280×720。也可以在播放时用“当前画面作为封面”。</span>
          </div>
        </div>
      </div>
      ${original ? `
      <div class="field" id="ed-original">
        <span class="field-label">原片</span>
        <div class="file-row">
          ${icon("film")}
          <div class="file-row-name"><b></b><span>${original.size ? fmtSize(original.size) : ""}</span></div>
          ${canDeleteOriginal(meta)
            ? `<button type="button" class="btn outline danger sm" data-del-original>${icon("trash")}删除原片</button>`
            : `<span class="field-hint">未转码，原片就是播放文件</span>`}
        </div>
        ${canDeleteOriginal(meta) ? `<span class="field-hint">删除后保留转码后的各清晰度，播放不受影响，但不能再下载原片。</span>` : ""}
      </div>` : ""}`,
    buttons: [
      { label: "取消", value: "cancel", kind: "ghost" },
      { label: "保存", value: "save", kind: "primary" },
    ],
    onOpen(root) {
      bindCounters(root);
      const field = root.querySelector("#ed-original");
      if (field) {
        field.querySelector(".file-row-name b").textContent = original.filename || original.path;
        field.querySelector("[data-del-original]")?.addEventListener("click", async () => {
          latest = await deleteOriginal(meta);
          if (latest) field.remove();
        });
      }
      const file = root.querySelector("input[type=file]");
      file.onchange = async () => {
        if (!file.files[0]) return;
        try {
          coverBlob = await imageFileToCover(file.files[0]);
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(coverBlob);
          root.querySelector(".cover-edit .thumb").innerHTML = `<img src="${previewUrl}" alt="">`;
        } catch {
          toast("无法读取这张图片", "error");
        }
      };
    },
    async onSubmit(_, root) {
      const updated = await api("PATCH", `/api/videos/${meta.id}`, {
        title: root.querySelector("#ed-title").value,
        description: root.querySelector("#ed-desc").value,
        category: root.querySelector("#ed-cat").value || null,
        nsfw: root.querySelector("#ed-nsfw").checked,
      });
      if (coverBlob) {
        await uploadThumb(meta.id, coverBlob);
        updated.thumb = Date.now();
      }
      invalidateVideos();
      toast("已保存", "success");
      return updated;
    },
  });
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  return result && typeof result === "object" ? result : latest;
}

// 删除原片；成功返回最新的视频元数据，取消或失败返回 null
export async function deleteOriginal(meta) {
  const size = meta.original.size ? `，可释放 ${fmtSize(meta.original.size)} 存储空间` : "";
  const ok = await confirmDialog({
    title: "删除原片",
    message: `确定删除「${meta.title}」的原片吗？转码后的各清晰度会保留，播放不受影响，但之后不能再下载原片${size}。删除后无法恢复。`,
    confirmLabel: "删除原片",
    danger: true,
  });
  if (!ok) return null;
  try {
    const updated = await api("DELETE", `/api/videos/${meta.id}/original`);
    invalidateVideos();
    toast("原片已删除", "success");
    return updated;
  } catch (err) {
    toast(err.message, "error");
    return null;
  }
}

export async function deleteVideo(v) {
  const ok = await confirmDialog({
    title: "删除视频",
    message: `确定删除「${v.title}」吗？所有清晰度、原片和封面都会被永久删除，无法恢复。`,
    confirmLabel: "删除",
    danger: true,
  });
  if (!ok) return false;
  try {
    await api("DELETE", `/api/videos/${v.id}`);
  } catch (err) {
    toast(err.message, "error");
    return false;
  }
  invalidateVideos();
  toast("已删除", "success");
  return true;
}

// 编辑自己的资料：昵称、简介、头像、密码
export async function editProfile() {
  const u = me();
  let avatarBlob = null;
  const result = await modal({
    title: "编辑资料",
    size: "lg",
    content: `
      <div style="display:flex;align-items:center;gap:16px">
        <span id="pf-avatar">${avatarHtml(u, 72)}</span>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">
          <label class="btn outline sm">${icon("camera")}更换头像<input type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
          <span class="field-hint">会自动裁成正方形</span>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="pf-name">昵称 <span class="count" data-for="pf-name"></span></label>
        <input class="input" id="pf-name" maxlength="30" required value="${esc(u.displayName)}">
      </div>
      <div class="field">
        <label class="field-label" for="pf-bio">频道简介 <span class="count" data-for="pf-bio"></span></label>
        <textarea class="textarea" id="pf-bio" maxlength="300" style="min-height:80px" placeholder="介绍一下你的频道">${esc(u.bio || "")}</textarea>
      </div>
      ${u.primary ? `<p class="field-hint" style="margin:0">主管理员的密码请用 <code>npx wrangler secret put ADMIN_PASSWORD</code> 修改。</p>` : `
      <div class="field">
        <span class="field-label">修改密码（不改请留空）</span>
        <div class="form-grid">
          <input class="input" id="pf-cur" type="password" placeholder="当前密码" autocomplete="current-password">
          <input class="input" id="pf-new" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" minlength="8">
        </div>
      </div>`}`,
    buttons: [
      { label: "取消", value: "cancel", kind: "ghost" },
      { label: "保存", value: "save", kind: "primary" },
    ],
    onOpen(root) {
      bindCounters(root);
      const file = root.querySelector("input[type=file]");
      file.onchange = async () => {
        if (!file.files[0]) return;
        try {
          avatarBlob = await imageFileToAvatar(file.files[0]);
          root.querySelector("#pf-avatar").innerHTML = `<span class="avatar" style="width:72px;height:72px"><img src="${URL.createObjectURL(avatarBlob)}" alt=""></span>`;
        } catch {
          toast("无法读取这张图片", "error");
        }
      };
    },
    async onSubmit(_, root) {
      const body = { displayName: root.querySelector("#pf-name").value, bio: root.querySelector("#pf-bio").value };
      const pw = root.querySelector("#pf-new")?.value;
      if (pw) {
        body.newPassword = pw;
        body.currentPassword = root.querySelector("#pf-cur").value;
      }
      let updated = await api("PATCH", "/api/me", body);
      if (avatarBlob) {
        const res = await fetch("/api/me/avatar", { method: "PUT", headers: { "content-type": "image/jpeg" }, body: avatarBlob });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "头像上传失败");
        updated = await res.json();
      }
      state.config.user = { ...u, ...updated };
      state.users[u.username] = { displayName: updated.displayName, avatar: updated.avatar };
      toast(pw ? "资料已保存，密码已修改" : "资料已保存", "success");
      return true;
    },
  });
  return result === true;
}
