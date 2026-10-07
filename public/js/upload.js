// 上传流水线：浏览器内转码（WebCodecs / Mediabunny）→ HLS 多清晰度 → 边转码边分片上传到 R2
//
// 每个文件的处理步骤：
//   1. 分析：读取时长、分辨率、编码
//   2. 生成封面（16:9）和进度条预览雪碧图
//   3. 一次解码、同时编码出多个清晰度（fan-out），输出 HLS（CMAF，每个清晰度一个文件）
//      输出是顺序写入的，每攒够 10MB 就作为一个分片上传，内存占用恒定
//   4. （可选）同时把原片也传上去，供下载（之后可以单独删除）
//   5. 发布
import { api, canvasToJpeg, composeCover, esc, fmtSize, fmtTime, invalidateVideos, store } from "./lib.js";
import { icon } from "./icons.js";

const MiB = 1024 * 1024;
const PART_SIZE = 10 * MiB; // R2 要求除最后一片外每片 ≥5MiB 且大小相同
const PART_RETRIES = 4;
const ORIGINAL_CONCURRENCY = 4;
const HLS_INFLIGHT = 2;

export const LADDER = [2160, 1440, 1080, 720, 480, 360];
const DEFAULT_LADDER = [1080, 720, 480];

// 码率（H.264）按短边估算：1080p≈4.5Mbps，720p≈2.4Mbps，480p≈1.2Mbps
const bitrateFor = (q, fps) => Math.round(4.5e6 * Math.pow(q / 1080, 1.6) * (fps > 40 ? 1.5 : 1));
const even = (x) => Math.max(2, Math.round(x / 2) * 2);

// ================= 能力检测 =================

let mbPromise = null;
const loadMediabunny = () => (mbPromise ??= import("mediabunny"));

let capsPromise = null;
export function capabilities() {
  return (capsPromise ??= (async () => {
    const webcodecs = typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
    if (!webcodecs) return { webcodecs: false, avc: false, aac: false };
    const MB = await loadMediabunny();
    const avc = await MB.canEncodeVideo("avc", { width: 1920, height: 1080 }).catch(() => false);
    let aac = typeof AudioEncoder !== "undefined" && (await MB.canEncodeAudio("aac").catch(() => false));
    let aacWasm = false;
    if (!aac) {
      // 浏览器没有原生 AAC 编码器（如部分 Linux / Firefox）→ 用 WASM 版
      try {
        const { registerAacEncoder } = await import("/vendor/mediabunny-aac-encoder.min.mjs");
        registerAacEncoder();
        aac = aacWasm = true;
      } catch {}
    }
    return { webcodecs, avc, aac, aacWasm };
  })());
}

// ================= 任务队列 =================

export const tasks = [];
const listeners = new Set();
export const onTasksChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => fn());
export const activeTasks = () => tasks.filter((t) => t.state === "queued" || t.state === "running");

let chain = Promise.resolve(); // 文件一个接一个处理：转码很吃 CPU/GPU

export function enqueueFiles(files, settings) {
  for (const file of files) {
    const task = new Task(file, { ...settings });
    tasks.unshift(task);
    chain = chain.then(() => task.run());
  }
  emit();
}

addEventListener("beforeunload", (e) => {
  if (activeTasks().length) e.preventDefault();
});

class Task {
  constructor(file, settings) {
    this.file = file;
    this.settings = settings;
    this.state = "queued"; // queued | running | done | failed | cancelled
    this.id = null;
    this.xhrs = new Set();
    this.multiparts = new Map(); // 还没完成的分片上传：path → uploadId（取消时要中止，否则会占用存储）
    this.pendingCreates = new Set();
    this.conversion = null;
    this.warnings = [];
    this.progress = { transcode: 0, processed: 0, duration: 0, produced: 0, hlsUploaded: 0, original: 0, startedAt: 0 };
    this.el = this.createEl();
  }

  // ---------- UI ----------
  createEl() {
    const el = document.createElement("div");
    el.className = "qitem";
    el.innerHTML = `
      <div class="thumb"><div class="ph">${icon("film")}</div></div>
      <div style="min-width:0">
        <div class="qitem-name"></div>
        <div class="qitem-stage"><span class="spinner" hidden></span><span class="txt">排队中</span></div>
        <div class="qbars"></div>
        <div class="qitem-warn" hidden></div>
      </div>
      <div class="q-actions"><button class="btn sm ghost">取消</button></div>`;
    el.querySelector(".qitem-name").textContent = this.file.name;
    el.querySelector(".q-actions button").onclick = () => (this.isFinished() ? this.dismiss() : this.cancel());
    return el;
  }

  isFinished() {
    return ["done", "failed", "cancelled"].includes(this.state);
  }

  stage(text, kind = "busy") {
    const s = this.el.querySelector(".qitem-stage");
    s.className = `qitem-stage${kind === "ok" ? " ok" : kind === "err" ? " err" : ""}`;
    s.querySelector(".spinner").hidden = kind !== "busy";
    s.querySelector(".txt").textContent = text;
    s.querySelectorAll("svg").forEach((n) => n.remove());
    if (kind === "ok") s.insertAdjacentHTML("afterbegin", icon("checkCircle"));
    if (kind === "err") s.insertAdjacentHTML("afterbegin", icon("alert"));
  }

  warn(msg) {
    this.warnings.push(msg);
    const w = this.el.querySelector(".qitem-warn");
    w.hidden = false;
    w.textContent = this.warnings.join("；");
  }

  bar(key, label) {
    let row = this.el.querySelector(`.qbar[data-k="${key}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "qbar";
      row.dataset.k = key;
      row.innerHTML = `<span>${esc(label)}</span><div class="bar"><i></i></div><span class="val"></span>`;
      this.el.querySelector(".qbars").append(row);
    }
    return row;
  }

  setBar(key, label, frac, text, done = false) {
    const row = this.bar(key, label);
    row.querySelector("i").style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
    row.querySelector(".bar").classList.toggle("done", done);
    row.querySelector(".val").textContent = text;
  }

  setThumb(url) {
    this.el.querySelector(".thumb").innerHTML = `<img src="${url}" alt="">`;
  }

  // 节流刷新进度条
  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const p = this.progress;
      if (p.transcodeActive) {
        const elapsed = (performance.now() - p.startedAt) / 1000;
        const speed = elapsed > 1 ? p.processed / elapsed : 0;
        const eta = speed > 0 ? (p.duration - p.processed) / speed : 0;
        this.setBar("transcode", "转码", p.transcode,
          p.transcode >= 1 ? "完成" : `${(p.transcode * 100).toFixed(0)}%${speed ? ` · ${speed.toFixed(1)}× · 剩余 ${fmtTime(eta)}` : ""}`,
          p.transcode >= 1);
        // 总输出大小未知：用码率估算，转码结束后以实际大小为准
        const total = p.transcode >= 1 ? p.produced : Math.max(p.hlsEstimate || 0, p.produced);
        this.setBar("hls", "上传", total ? p.hlsUploaded / total : 0,
          p.hlsDone ? `${fmtSize(p.produced)} · 完成` : `${fmtSize(p.hlsUploaded)} / ${p.transcode >= 1 ? "" : "约 "}${fmtSize(total)}`, p.hlsDone);
      }
      if (p.originalActive) {
        const f = p.original / this.file.size;
        this.setBar("original", "原片", f, f >= 1 ? `${fmtSize(this.file.size)} · 完成` : `${(f * 100).toFixed(0)}% · ${fmtSize(this.file.size)}`, f >= 1);
      }
    });
  }

  // ---------- 控制 ----------
  async cancel() {
    if (this.isFinished()) return;
    const wasQueued = this.state === "queued";
    this.state = "cancelled";
    this.abortAll();
    this.stage("已取消", "err");
    this.finishUi();
    emit();
    if (!wasQueued && this.id) await this.cleanupRemote();
  }

  fail(err) {
    if (this.isFinished()) return;
    this.state = "failed";
    this.error = err;
    this.abortAll();
    this.stage(`失败：${err.message || err}`, "err");
    this.finishUi();
    emit();
    if (this.id) this.cleanupRemote();
  }

  // 新建分片上传，并记下来以便取消时中止
  createUpload(path, body) {
    const p = api("POST", `/api/videos/${this.id}/uploads`, { path, ...body }).then(({ uploadId }) => {
      this.multiparts.set(path, uploadId);
      return uploadId;
    });
    this.pendingCreates.add(p);
    p.catch(() => {}).finally(() => this.pendingCreates.delete(p));
    return p;
  }

  async completeUpload(path, uploadId, parts) {
    const q = `path=${encodeURIComponent(path)}&uploadId=${encodeURIComponent(uploadId)}`;
    const res = await api("POST", `/api/videos/${this.id}/uploads/complete?${q}`, { parts });
    this.multiparts.delete(path);
    return res;
  }

  // 取消 / 失败后清理服务器：先中止所有未完成的分片上传，再删除这条视频
  async cleanupRemote() {
    await Promise.allSettled([...this.pendingCreates]);
    const aborts = [...this.multiparts].map(([path, uploadId]) =>
      api("DELETE", `/api/videos/${this.id}/uploads?path=${encodeURIComponent(path)}&uploadId=${encodeURIComponent(uploadId)}`).catch(() => {})
    );
    this.multiparts.clear();
    await Promise.all(aborts);
    await api("DELETE", `/api/videos/${this.id}`).catch(() => {});
  }

  abortAll() {
    this.conversion?.cancel().catch(() => {});
    this.xhrs.forEach((x) => x.abort());
    this.xhrs.clear();
    this.wakeLock?.release().catch(() => {});
  }

  finishUi() {
    const b = this.el.querySelector(".q-actions button");
    b.textContent = "移除";
  }

  dismiss() {
    this.el.remove();
    tasks.splice(tasks.indexOf(this), 1);
    emit();
  }

  checkAlive() {
    if (this.state !== "running") throw this.error || new Error("已取消");
  }

  // ---------- 主流程 ----------
  async run() {
    if (this.state !== "queued") return;
    this.state = "running";
    emit();
    try {
      this.wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
      await this.process();
    } catch (err) {
      if (this.state === "running") this.fail(err);
    } finally {
      this.wakeLock?.release().catch(() => {});
      invalidateVideos();
      emit();
    }
  }

  async process() {
    const { file, settings } = this;
    const caps = await capabilities();
    const MB = caps.webcodecs ? await loadMediabunny() : null;

    // 1. 分析
    this.stage("分析视频…");
    let probe = null;
    if (MB) {
      try {
        probe = await probeFile(MB, file);
      } catch (err) {
        console.warn("probe failed", err);
      }
    }
    this.checkAlive();

    const canTranscode = Boolean(settings.transcode && probe?.canDecode && caps.avc);
    if (settings.transcode && !canTranscode) {
      this.warn(
        !caps.webcodecs || !caps.avc
          ? "当前浏览器不支持硬件转码，已直接上传原文件（推荐用最新版 Chrome / Edge / Safari 上传）"
          : !probe
            ? "无法识别此文件格式，已直接上传原文件，可能无法在网页中播放"
            : `浏览器无法解码 ${probe.codec || "该"} 编码，已直接上传原文件，可能无法在网页中播放`
      );
    }
    const keepOriginal = settings.keepOriginal || !canTranscode;

    // 2. 在服务器上建一条“处理中”的视频
    const meta = await api("POST", "/api/videos", { filename: file.name, category: settings.category || null, nsfw: Boolean(settings.nsfw) });
    this.id = meta.id;
    emit(); // 让工作室表格里出现“处理中”的这一行
    this.checkAlive();

    // 3. 原片和转码并行上传
    const ext = (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || "mp4").toLowerCase();
    const originalPath = `original.${ext}`;
    const originalType = /^video\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream";
    let originalPromise = null;
    if (keepOriginal) {
      this.progress.originalActive = true;
      originalPromise = uploadMultipartFile(this, originalPath, file, originalType, (b) => {
        this.progress.original = b;
        this.render();
      });
      originalPromise.catch((err) => this.fail(err));
    }

    // 4. 封面 + 预览图
    let storyboard = null;
    if (probe?.canDecode) {
      this.stage("生成封面和预览图…");
      try {
        const images = await makeImages(MB, probe);
        this.checkAlive();
        this.setThumb(URL.createObjectURL(images.cover));
        await putFile(this, "thumb.jpg", images.cover, "image/jpeg");
        if (images.sprite) {
          await putFile(this, "storyboard.jpg", images.sprite.blob, "image/jpeg");
          storyboard = { path: "storyboard.jpg", ...images.sprite.info };
        }
      } catch (err) {
        if (this.state !== "running") throw err;
        console.warn("thumbnail failed", err);
        this.warn("未能生成封面，可稍后在播放页设置");
      }
    }
    this.checkAlive();

    // 5. 转码
    let renditions = [];
    if (canTranscode) {
      this.stage("转码并上传中…（请保持此页面打开）");
      renditions = await transcode(this, MB, probe);
    }
    this.checkAlive();

    if (originalPromise) {
      this.stage("等待原片上传完成…");
      await originalPromise;
    }
    this.checkAlive();

    // 6. 发布
    this.stage("发布中…");
    await api("POST", `/api/videos/${this.id}/publish`, {
      duration: probe?.duration,
      width: probe?.width,
      height: probe?.height,
      fps: probe?.fps,
      playback: canTranscode ? { type: "hls", path: "hls/master.m3u8" } : { type: "file", path: originalPath },
      renditions: renditions.map(({ width, height, bitrate }) => ({ width, height, bitrate })),
      original: keepOriginal ? { path: originalPath, filename: file.name, size: file.size, contentType: originalType } : null,
      storyboard,
    });
    probe?.input.dispose?.();

    this.state = "done";
    const qs = renditions.map((r) => `${Math.min(r.width, r.height)}p`).join(" / ");
    this.stage(canTranscode ? `已发布 · ${qs}` : "已发布（未转码）", "ok");
    this.el.querySelector(".qitem-stage").insertAdjacentHTML(
      "beforeend",
      ` · <a href="/v/${this.id}" data-link style="color:var(--accent);font-weight:600">立即观看</a>`
    );
    this.finishUi();
  }
}

// ================= 媒体处理 =================

async function probeFile(MB, file) {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("没有视频轨道");
  const audioTrack = await input.getPrimaryAudioTrack();
  const [duration, width, height, canDecode, codec] = await Promise.all([
    input.computeDuration(),
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    videoTrack.canDecode(),
    videoTrack.getCodec(),
  ]);
  let fps = null;
  try {
    fps = Math.round((await videoTrack.computePacketStats(120)).averagePacketRate * 100) / 100;
  } catch {}
  return { input, videoTrack, audioTrack, duration, width, height, canDecode, codec, fps };
}

async function makeImages(MB, probe) {
  const { videoTrack, duration, width, height } = probe;
  // 封面：取 10% 处（最多第 10 秒）的画面，避开片头黑屏
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const frameSink = new MB.CanvasSink(videoTrack, { width: even(width * scale), height: even(height * scale), fit: "fill" });
  const t = duration > 1 ? Math.min(duration * 0.1, 10) : 0;
  const frame = (await frameSink.getCanvas(t)) || (await frameSink.getCanvas(0));
  if (!frame) throw new Error("无法读取画面");
  const cover = await canvasToJpeg(composeCover(frame.canvas, frame.canvas.width, frame.canvas.height), 0.85);

  // 预览雪碧图：最多 120 帧，每帧 160×90，10 列
  let sprite = null;
  if (duration >= 4) {
    const count = Math.min(120, Math.max(4, Math.ceil(duration / 2)));
    const interval = duration / count;
    const cols = 10, rows = Math.ceil(count / cols), tw = 160, th = 90;
    const canvas = document.createElement("canvas");
    canvas.width = cols * tw;
    canvas.height = rows * th;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tileSink = new MB.CanvasSink(videoTrack, { width: tw, height: th, fit: "contain" });
    const stamps = Array.from({ length: count }, (_, i) => i * interval + Math.min(interval / 2, 1));
    let i = 0;
    for await (const wc of tileSink.canvasesAtTimestamps(stamps)) {
      if (wc) ctx.drawImage(wc.canvas, (i % cols) * tw, Math.floor(i / cols) * th, tw, th);
      i++;
    }
    sprite = {
      blob: await canvasToJpeg(canvas, 0.7),
      info: { count, interval: Math.round(interval * 1000) / 1000, cols, rows, width: tw, height: th },
    };
  }
  return { cover, sprite };
}

async function transcode(task, MB, probe) {
  const { input, audioTrack, width: sw, height: sh, duration, fps } = probe;
  const short = Math.min(sw, sh);
  let ladder = task.settings.ladder.filter((q) => q <= short + 8).sort((a, b) => b - a);
  if (!ladder.length) ladder = [even(short)]; // 源视频比最低档还小：保持原尺寸

  // 低码率源没必要“放大”码率
  const sourceBitrate = (task.file.size * 8) / Math.max(duration, 1);
  const renditions = ladder.map((q) => {
    const s = Math.min(1, q / short);
    return {
      width: even(sw * s),
      height: even(sh * s),
      bitrate: Math.round(Math.min(bitrateFor(q, fps), Math.max(sourceBitrate * 1.2, 400e3))),
    };
  });

  let audio = { discard: true };
  if (audioTrack) {
    if (await audioTrack.canDecode()) {
      const [ch, sr] = await Promise.all([audioTrack.getNumberOfChannels(), audioTrack.getSampleRate()]);
      audio = {
        codec: "aac",
        quality: new MB.Quality({ bitrate: 128e3 }),
        numberOfChannels: ch > 2 ? 2 : undefined,
        sampleRate: [44100, 48000].includes(sr) ? undefined : 48000,
      };
    } else {
      task.warn("音轨编码无法解码，转码后的视频将没有声音（原文件保留声音）");
    }
  }

  const writers = [];
  const output = new MB.Output({
    format: new MB.HlsOutputFormat({
      segmentFormat: new MB.CmafOutputFormat(),
      targetDuration: 4,
      singleFilePerPlaylist: true, // 每个清晰度一个文件，播放器用 Range 读取分段 → R2 对象数量少
    }),
    target: new MB.PathedTarget("master.m3u8", ({ path, mimeType }) => {
      const w = path.endsWith(".m3u8")
        ? new SmallFileWriter(task, `hls/${path}`, mimeType)
        : new StreamingPartWriter(task, `hls/${path}`, mimeType);
      writers.push(w);
      return new MB.StreamTarget(w.stream);
    }),
  });

  const conversion = await MB.Conversion.init({
    input,
    output,
    video: renditions.map((r) => ({
      width: r.width,
      height: r.height,
      fit: "fill",
      codec: "avc",
      quality: new MB.Quality({ bitrate: r.bitrate }),
      keyFrameInterval: 2,
      allowTransformationMetadata: false, // 把手机视频的旋转直接“烧”进画面，所有播放器表现一致
    })),
    audio,
  });
  if (!conversion.isValid) {
    throw new Error(`无法转码：${conversion.discardedTracks.map((d) => d.reason).join(", ") || "未知原因"}`);
  }

  const p = task.progress;
  p.transcodeActive = true;
  p.duration = duration;
  p.hlsEstimate = (duration * (renditions.reduce((s, r) => s + r.bitrate, 0) + (audio.discard ? 0 : 128e3))) / 8;
  p.startedAt = performance.now();
  conversion.onProgress = (frac, processed) => {
    p.transcode = frac;
    p.processed = processed ?? frac * duration;
    task.render();
  };
  task.conversion = conversion;
  await conversion.execute();
  p.transcode = 1;
  task.render();

  await Promise.all(writers.map((w) => w.done));
  p.hlsDone = true;
  task.render();
  return renditions;
}

// ================= 上传 =================

// 播放列表等小文件：收集完整内容后一次性 PUT
class SmallFileWriter {
  constructor(task, path, contentType) {
    const chunks = [];
    this.done = new Promise((resolve, reject) => {
      this.stream = new WritableStream({
        write: (c) => {
          if (c.type === "write") chunks.push({ data: c.data.slice(), position: c.position });
        },
        close: async () => {
          const size = Math.max(0, ...chunks.map((c) => c.position + c.data.byteLength));
          const buf = new Uint8Array(size);
          for (const c of chunks) buf.set(c.data, c.position);
          try {
            await putFile(task, path, new Blob([buf]), contentType);
            resolve();
          } catch (err) {
            reject(err);
            throw err;
          }
        },
        abort: (reason) => reject(reason),
      });
    });
    this.done.catch(() => {});
  }
}

// 大文件：转码输出是顺序写入的，攒满 10MB 就作为一个分片上传；每个文件最多 2 片同时在途，超过则对转码施加背压
class StreamingPartWriter {
  constructor(task, path, contentType) {
    Object.assign(this, { task, path, contentType });
    this.pieces = [];
    this.buffered = 0;
    this.written = 0;
    this.partNo = 0;
    this.parts = [];
    this.inflight = new Set();
    this.uploadId = null;
    this.error = null;
    this.done = new Promise((resolve, reject) => {
      this.stream = new WritableStream({
        write: (c) => this.write(c),
        close: () => this.close().then(resolve, (err) => (reject(err), Promise.reject(err))),
        abort: (reason) => reject(reason),
      });
    });
    this.done.catch(() => {});
  }

  async write({ type, data, position }) {
    if (type !== "write") return;
    if (this.error) throw this.error;
    if (position !== this.written) throw new Error("转码输出不是顺序写入，无法流式上传");
    this.written += data.byteLength;
    this.task.progress.produced += data.byteLength;
    this.pieces.push(data.slice());
    this.buffered += data.byteLength;
    while (this.buffered >= PART_SIZE) await this.flush(PART_SIZE);
  }

  async flush(size) {
    const take = [];
    let need = size;
    while (need > 0) {
      const p = this.pieces[0];
      if (p.byteLength <= need) {
        take.push(p);
        this.pieces.shift();
        need -= p.byteLength;
      } else {
        take.push(p.subarray(0, need));
        this.pieces[0] = p.subarray(need);
        need = 0;
      }
    }
    this.buffered -= size;
    const blob = new Blob(take);
    const n = ++this.partNo;
    while (this.inflight.size >= HLS_INFLIGHT) await Promise.race(this.inflight);
    if (this.error) throw this.error;
    this.uploadId ??= await this.task.createUpload(this.path, { contentType: this.contentType });
    let last = 0;
    const p = uploadPart(this.task, this.path, this.uploadId, n, blob, (b) => {
      this.task.progress.hlsUploaded += b - last;
      last = b;
      this.task.render();
    })
      .then((res) => this.parts.push(res))
      .catch((err) => {
        this.error = err;
        this.task.fail(err);
      })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  async close() {
    if (this.buffered > 0 || this.partNo === 0) await this.flush(this.buffered);
    await Promise.all(this.inflight);
    if (this.error) throw this.error;
    await this.task.completeUpload(this.path, this.uploadId, this.parts);
  }
}

async function putFile(task, path, blob, contentType) {
  task.checkAlive();
  const res = await fetch(`/api/videos/${task.id}/files/${path}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `上传失败（${res.status}）`);
  return res.json();
}

// 普通文件（原片）：并发分片上传
async function uploadMultipartFile(task, path, file, contentType, onProgress) {
  const uploadId = await task.createUpload(path, { contentType, filename: file.name });
  let partSize = PART_SIZE;
  while (Math.ceil(file.size / partSize) > 10000) partSize *= 2;
  const total = Math.max(1, Math.ceil(file.size / partSize));
  const loaded = new Array(total + 1).fill(0);
  const parts = [];
  let next = 1;
  const worker = async () => {
    while (next <= total) {
      task.checkAlive();
      const n = next++;
      const blob = file.slice((n - 1) * partSize, n * partSize);
      parts.push(await uploadPart(task, path, uploadId, n, blob, (b) => {
        loaded[n] = b;
        onProgress(loaded.reduce((a, c) => a + c, 0));
      }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(ORIGINAL_CONCURRENCY, total) }, worker));
  await task.completeUpload(path, uploadId, parts);
  onProgress(file.size);
}

// 单个分片：XHR（为了拿到上传进度）+ 指数退避重试
async function uploadPart(task, path, uploadId, partNumber, blob, onProgress) {
  const url = `/api/videos/${task.id}/uploads/${partNumber}?path=${encodeURIComponent(path)}&uploadId=${encodeURIComponent(uploadId)}`;
  for (let attempt = 0; ; attempt++) {
    task.checkAlive();
    try {
      return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        task.xhrs.add(xhr);
        xhr.open("PUT", url);
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () => {
          task.xhrs.delete(xhr);
          let data = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch {}
          if (xhr.status >= 200 && xhr.status < 300) {
            onProgress(blob.size);
            resolve({ partNumber: data.partNumber, etag: data.etag });
          } else reject(Object.assign(new Error(data.error || `HTTP ${xhr.status}`), { status: xhr.status }));
        };
        xhr.onerror = () => (task.xhrs.delete(xhr), reject(new Error("网络错误")));
        xhr.onabort = () => (task.xhrs.delete(xhr), reject(new Error("已取消")));
        xhr.send(blob);
      });
    } catch (err) {
      if (task.state !== "running" || err.status === 401 || attempt >= PART_RETRIES) throw err;
      onProgress(0);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// ================= 设置 =================

export function getUploadSettings() {
  return {
    category: store.get("uploadCategory", ""),
    nsfw: store.get("uploadNsfw", false),
    ladder: store.get("ladder", DEFAULT_LADDER),
    keepOriginal: store.get("keepOriginal", true),
    transcode: store.get("transcode", true),
  };
}
export function saveUploadSettings(s) {
  store.set("uploadCategory", s.category || "");
  store.set("uploadNsfw", Boolean(s.nsfw));
  store.set("ladder", s.ladder);
  store.set("keepOriginal", s.keepOriginal);
  store.set("transcode", s.transcode);
}
