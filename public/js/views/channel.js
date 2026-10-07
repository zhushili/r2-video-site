// 频道页 /@username
import { icon } from "../icons.js";
import { api, avatarHtml, canUpload, emptyState, esc, fmtDate, fmtDurationLong, getVideos, me, siteTitle, state, store, visibleVideos } from "../lib.js";
import { attachScrub, skeletonCards, SORTS, sortSelect, videoCard } from "./cards.js";
import { editProfile } from "./editor.js";

export async function render(ctx) {
  const { app, params, isCurrent } = ctx;
  const username = params.username;
  if (!ctx.cached) {
    app.innerHTML = `
      <div class="channel-head"><div class="skeleton" style="width:112px;height:112px;border-radius:50%"></div>
      <div style="flex:1"><div class="skeleton" style="height:30px;width:220px"></div><div class="skeleton" style="height:16px;width:300px;margin-top:12px"></div></div></div>
      <div class="grid">${skeletonCards(4)}</div>`;
  }
  const [user, videos] = await Promise.all([
    ctx.user ? Promise.resolve(ctx.user) : api("GET", `/api/users/${encodeURIComponent(username)}`),
    getVideos(!ctx.cached),
  ]);
  if (!isCurrent()) return;
  document.title = siteTitle(user.displayName);

  const self = me()?.username === user.username;
  const sortKey = SORTS[store.get("sort")] ? store.get("sort") : "new";
  const list = visibleVideos(videos).filter((v) => v.owner === user.username && v.status === "ready").sort(SORTS[sortKey][1]);
  const totalDur = list.reduce((s, v) => s + (v.duration || 0), 0);

  app.innerHTML = `
    <div${ctx.cached ? ` style="animation:none"` : ""}>
      <header class="channel-head">
        ${avatarHtml(user, 112)}
        <div style="min-width:0">
          <h1></h1>
          <div class="channel-meta">
            <span>@${esc(user.username)}</span><span class="sep">·</span>
            <span>${list.length} 个视频</span>
            ${totalDur ? `<span class="sep">·</span><span>共 ${fmtDurationLong(totalDur)}</span>` : ""}
            <span class="sep">·</span><span>${fmtDate(user.createdAt)} 加入</span>
          </div>
          ${user.bio ? `<p class="channel-bio"></p>` : ""}
          ${self ? `
            <div class="channel-actions">
              <button class="btn" data-act="profile">${icon("edit")}编辑资料</button>
              ${canUpload() ? `<a class="btn" href="/studio" data-link>${icon("studio")}管理视频</a>` : ""}
            </div>` : ""}
        </div>
      </header>
      ${list.length ? `
        <div class="toolbar"><h2>视频<span class="count">${list.length}</span></h2>${sortSelect(sortKey)}</div>
        <div class="grid">${list.map((v) => videoCard(v, { channel: false })).join("")}</div>`
        : emptyState("film", "还没有发布视频", self && canUpload() ? "去工作室上传你的第一个视频吧。" : "这个频道还没有公开的视频。",
            self && canUpload() ? `<a class="btn primary" href="/studio" data-link>${icon("upload")}上传视频</a>` : "")}
    </div>`;
  app.querySelector(".channel-head h1").textContent = user.displayName;
  if (user.bio) app.querySelector(".channel-bio").textContent = user.bio;

  attachScrub(app.firstElementChild);
  app.querySelector("[data-sort]")?.addEventListener("change", (e) => {
    store.set("sort", e.target.value);
    render({ ...ctx, user, cached: true });
  });
  app.querySelector("[data-act=profile]")?.addEventListener("click", async () => {
    if (await editProfile()) {
      state.users[user.username] = { displayName: me().displayName, avatar: me().avatar };
      ctx.refreshShell();
      render({ ...ctx, user: me(), cached: true });
    }
  });
}
