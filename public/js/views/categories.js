// 分类：总览页 /categories 和单个分类页 /c/<id>
import { icon } from "../icons.js";
import { categoryById, emptyState, esc, getVideos, isAdmin, siteTitle, state, store, thumbUrl, visibleVideos } from "../lib.js";
import { attachScrub, chipBar, skeletonCards, SORTS, sortSelect, videoCard } from "./cards.js";

export async function renderOverview({ app, isCurrent }) {
  document.title = siteTitle("分类");
  const cats = state.config.categories;
  app.innerHTML = `<div class="page-head"><h1>分类</h1></div><div class="cat-grid">${cats.map(() => `<div class="cat-tile skeleton"></div>`).join("")}</div>`;
  const videos = visibleVideos(await getVideos()).filter((v) => v.status === "ready");
  if (!isCurrent()) return;

  const tiles = [...cats, { id: "", name: "未分类", icon: "grid" }].map((c) => {
    const list = videos.filter((v) => (c.id ? v.category === c.id : !categoryById(v.category)));
    if (!c.id && !list.length) return "";
    const cover = list.find((v) => v.thumb);
    return `
      <a class="cat-tile ${cover ? "" : "empty-cover"}" href="/c/${c.id || "none"}" data-link>
        ${cover ? `<img src="${thumbUrl(cover)}" alt="" loading="lazy">` : ""}
        <div class="cat-tile-body">
          <div class="cat-tile-icon">${icon(c.icon)}</div>
          <div><div class="cat-tile-name">${esc(c.name)}</div><div class="cat-tile-count">${list.length} 个视频</div></div>
        </div>
      </a>`;
  });

  app.innerHTML = `
    <div>
      <div class="page-head">
        <div><h1>分类</h1><p class="sub">按主题浏览全部 ${videos.length} 个视频</p></div>
        ${isAdmin() ? `<a class="btn outline" href="/admin/categories" data-link>${icon("edit")}管理分类</a>` : ""}
      </div>
      ${cats.length ? `<div class="cat-grid">${tiles.join("")}</div>` : emptyState("tag", "还没有分类", isAdmin() ? "在后台添加分类后，上传视频时就可以选择分类了。" : "管理员还没有设置分类。")}
    </div>`;
}

export async function renderCategory(ctx) {
  const { app, params, isCurrent } = ctx;
  const id = params.id;
  const cat = id === "none" ? { id: "none", name: "未分类", icon: "grid" } : categoryById(id);
  if (!cat) {
    document.title = siteTitle("分类不存在");
    app.innerHTML = emptyState("tag", "分类不存在", "这个分类可能已被删除。", `<a class="btn primary" href="/categories" data-link>查看全部分类</a>`);
    return;
  }
  document.title = siteTitle(cat.name);
  const chips = chipBar(state.config.categories, cat.id);
  if (!ctx.cached) app.innerHTML = `${chips}<div class="grid">${skeletonCards(8)}</div>`;

  const videos = visibleVideos(await getVideos(!ctx.cached)).filter((v) => v.status === "ready");
  if (!isCurrent()) return;
  const sortKey = SORTS[store.get("sort")] ? store.get("sort") : "new";
  const list = videos
    .filter((v) => (id === "none" ? !categoryById(v.category) : v.category === id))
    .sort(SORTS[sortKey][1]);

  app.innerHTML = `
    <div${ctx.cached ? ` style="animation:none"` : ""}>
      ${chips}
      <div class="toolbar">
        <div class="cat-head" style="margin:0">
          <div class="cat-head-icon">${icon(cat.icon)}</div>
          <div><h1>${esc(cat.name)}</h1><p>${list.length} 个视频</p></div>
        </div>
        ${list.length ? sortSelect(sortKey) : ""}
      </div>
      ${list.length
        ? `<div class="grid">${list.map((v) => videoCard(v)).join("")}</div>`
        : emptyState(cat.icon, "这个分类还没有视频", "上传视频时选择这个分类，就会出现在这里。")}
    </div>`;

  attachScrub(app.firstElementChild);
  const sel = app.querySelector("[data-sort]");
  if (sel) {
    sel.onchange = (e) => {
      store.set("sort", e.target.value);
      renderCategory({ ...ctx, cached: true });
    };
  }
}
