// 首页：分类条 + 继续观看 + 全部视频（搜索、排序）
import { icon } from "../icons.js";
import { canUpload, emptyState, esc, fmtTime, getVideos, history, siteTitle, state, store, visibleVideos } from "../lib.js";
import { attachScrub, chipBar, skeletonCards, SORTS, sortSelect, videoCard } from "./cards.js";

export async function render(ctx) {
  const { app, url, isCurrent } = ctx;
  const q = (url.searchParams.get("q") || "").trim();
  document.title = q ? siteTitle(`${q} - 搜索`) : siteTitle();
  const chips = q ? "" : chipBar(state.config.categories, null);
  if (!ctx.cached) {
    app.innerHTML = `${chips}<div class="toolbar"><div class="skeleton" style="width:140px;height:24px"></div></div><div class="grid">${skeletonCards(12)}</div>`;
  }

  const all = visibleVideos(await getVideos(!ctx.cached)).filter((v) => v.status === "ready");
  if (!isCurrent()) return;

  if (!all.length) {
    app.innerHTML = `<div>${chips}${emptyState(
      "film",
      "还没有视频",
      canUpload() ? "上传第一个视频，浏览器会自动转码成多种清晰度。" : "这里暂时空空如也，稍后再来看看吧。",
      canUpload() ? `<a class="btn primary" href="/studio" data-link>${icon("upload")}上传视频</a>` : ""
    )}</div>`;
    return;
  }

  // 继续观看：本机有进度且未看完的
  const h = history.all();
  const continuing = q
    ? []
    : all
        .filter((v) => h[v.id] && !h[v.id].done && h[v.id].t > 5)
        .sort((a, b) => h[b.id].at - h[a.id].at)
        .slice(0, 4);

  const sortKey = SORTS[store.get("sort")] ? store.get("sort") : "new";
  const needle = q.toLowerCase();
  const list = all
    .filter((v) => !needle || v.title.toLowerCase().includes(needle) || (state.users[v.owner]?.displayName || "").toLowerCase().includes(needle))
    .sort(SORTS[sortKey][1]);

  app.innerHTML = `<div${ctx.cached ? ` style="animation:none"` : ""}>
    ${chips}
    ${continuing.length ? `
      <section class="shelf">
        <div class="toolbar"><h2>继续观看</h2><a class="btn ghost sm" href="/history" data-link>查看全部${icon("chevronRight")}</a></div>
        <div class="grid">${continuing.map((v) => videoCard(v, { meta: `看到 ${fmtTime(h[v.id].t)} / ${fmtTime(v.duration)}` })).join("")}</div>
      </section>` : ""}
    <section>
      <div class="toolbar">
        <h2>${q ? `“${esc(q)}” 的搜索结果` : "全部视频"}<span class="count">${list.length}</span></h2>
        ${sortSelect(sortKey)}
      </div>
      ${list.length
        ? `<div class="grid">${list.map((v) => videoCard(v)).join("")}</div>`
        : emptyState("search", "没有找到相关视频", "换个关键词试试")}
    </section></div>`;

  attachScrub(app.firstElementChild);
  app.querySelector("[data-sort]").onchange = (e) => {
    store.set("sort", e.target.value);
    render({ ...ctx, cached: true });
  };
}
