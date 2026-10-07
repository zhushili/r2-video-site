// 观看记录（只保存在本机浏览器）
import { icon } from "../icons.js";
import { confirmDialog, emptyState, fmtAgo, fmtTime, getVideos, history, siteTitle, visibleVideos } from "../lib.js";
import { attachScrub, skeletonCards, videoCard } from "./cards.js";

export async function render(ctx) {
  const { app, isCurrent } = ctx;
  document.title = siteTitle("观看记录");
  app.innerHTML = `<div class="page-head"><h1>观看记录</h1></div><div class="grid">${skeletonCards(8)}</div>`;
  const videos = await getVideos();
  if (!isCurrent()) return;

  const h = history.all();
  const byId = new Map(visibleVideos(videos).filter((v) => v.status === "ready").map((v) => [v.id, v]));
  const list = Object.entries(h)
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1].at - a[1].at)
    .map(([id, rec]) => ({ v: byId.get(id), rec }));

  app.innerHTML = `
    <div>
      <div class="page-head">
        <div><h1>观看记录</h1><p class="sub">记录只保存在这台设备的浏览器里</p></div>
        ${list.length ? `<button class="btn outline" id="clear">${icon("trash")}清除全部记录</button>` : ""}
      </div>
      ${list.length
        ? `<div class="grid">${list.map(({ v, rec }) => videoCard(v, {
            meta: rec.done ? `已看完 · ${fmtAgo(rec.at)}` : `看到 ${fmtTime(rec.t)} / ${fmtTime(v.duration)} · ${fmtAgo(rec.at)}`,
          })).join("")}</div>`
        : emptyState("history", "还没有观看记录", "看过的视频会出现在这里，方便接着看。", `<a class="btn primary" href="/" data-link>去首页逛逛</a>`)}
    </div>`;

  attachScrub(app.firstElementChild);
  app.querySelector("#clear")?.addEventListener("click", async () => {
    if (await confirmDialog({ title: "清除观看记录", message: "确定清除这台设备上的全部观看记录和播放进度吗？", confirmLabel: "清除", danger: true })) {
      history.clear();
      render(ctx);
    }
  });
}
