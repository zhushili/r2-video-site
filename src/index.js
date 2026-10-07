/**
 * R2 视频站 —— Cloudflare Worker 后端
 *
 * 转码在上传者的浏览器里完成（WebCodecs），Worker 只负责鉴权、存储和分发。
 * 所有数据（视频、用户、分类、设置）都存在同一个 R2 桶里，不需要数据库。
 *
 * R2 中的存储布局：
 *   videos/<id>/hls/...                 HLS 播放列表和各清晰度数据
 *   videos/<id>/original.<ext>          原片（可选，可单独删除）
 *   videos/<id>/thumb.jpg               封面
 *   videos/<id>/storyboard.jpg          进度条预览图（雪碧图）
 *   meta/<id>.json                      视频元数据；列表页需要的摘要同时写在 customMetadata 里
 *   users/<username>.json               用户（密码为 PBKDF2 哈希）
 *   avatars/<username>/<version>        头像
 *   config/categories.json              分类
 *   config/settings.json                网站设置（是否开放注册等）
 *   config/nsfw.json                    NSFW 专区：是否启用、访问密码哈希、密码版本
 *
 * 角色：admin（管理员）> creator（创作者，可上传、管理自己的视频）> viewer（观众）
 * 管理员账号来自环境变量 ADMIN_USERNAME / ADMIN_PASSWORD，永远可以登录，不会被锁在门外。
 */

const SESSION_COOKIE = "vs_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 登录有效期 30 天
const NSFW_COOKIE = "vs_nsfw";
const NSFW_TTL_MS = 12 * 3600 * 1000; // NSFW 解锁最长 12 小时（关闭浏览器也会失效）
const ID_RE = /^[a-z0-9]{8,40}$/;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED_NAMES = new Set(["admin", "root", "system", "api", "me", "media", "avatars", "studio", "login", "register"]);
const CATEGORY_ID_RE = /^[a-z0-9-]{1,32}$/;
// 视频目录内的相对路径：最多 4 级，不允许以 . 开头（杜绝 ..）
const PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,3}$/;
// 只允许媒体和图片类型，避免同源下被上传 HTML / SVG 之类可执行内容
const ALLOWED_TYPES =
  /^(video|audio)\/[\w.+-]+$|^image\/(jpeg|png|webp)$|^application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream)$/;
const ROLES = ["admin", "creator", "viewer"];
// 免费版 Worker 每个请求只有 10ms CPU，迭代次数不能太高；付费版可以调大（旧哈希仍可验证）
const PBKDF2_ITERATIONS = 30000;
const MAX_DIRECT_UPLOAD = 50 * 1024 * 1024;
const MAX_TITLE = 150;
const MAX_DESCRIPTION = 5000;

const DEFAULT_CATEGORIES = [
  { id: "life", name: "生活", icon: "coffee" },
  { id: "music", name: "音乐", icon: "music" },
  { id: "gaming", name: "游戏", icon: "gamepad" },
  { id: "travel", name: "旅行", icon: "plane" },
  { id: "food", name: "美食", icon: "utensils" },
  { id: "knowledge", name: "知识", icon: "book" },
  { id: "tech", name: "科技", icon: "laptop" },
  { id: "sports", name: "运动", icon: "trophy" },
  { id: "film", name: "影视", icon: "clapperboard" },
];
const DEFAULT_SETTINGS = { allowRegistration: false, defaultRole: "viewer" };

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
      console.error(err);
      return json({ error: "服务器内部错误" }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 每个 Worker 实例内的短时缓存：媒体请求很频繁，不想每次都读 R2
const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  memo.set(key, { value, exp: Date.now() + ttlMs });
  if (memo.size > 5000) memo.delete(memo.keys().next().value);
  return value;
}

async function route(request, env) {
  const url = new URL(request.url);

  // 绑定了自定义域名（SITE_DOMAIN）后，旧的 *.workers.dev 地址自动跳转到新域名
  const domain = String(env.SITE_DOMAIN || "").toLowerCase();
  if (domain && url.hostname !== domain && url.hostname.endsWith(".workers.dev")) {
    url.protocol = "https:";
    url.hostname = domain;
    url.port = "";
    return Response.redirect(url.toString(), request.method === "GET" || request.method === "HEAD" ? 302 : 307);
  }

  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean);
  const ctx = { request, env, url };

  // ---------- 媒体文件：/media/<id>/<path> ----------
  if (parts[0] === "media") {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
    const id = validId(parts[1]);
    const path = validPath(parts.slice(2).join("/"));
    // 私密模式：完整校验登录（账号停用、改密码后立即失效）
    const user = isPrivate(env) ? await requireUser(ctx) : null;
    // 视频的发布状态 / NSFW 标记 / 上传者（短时缓存，修改时会清掉本实例的缓存）
    const flags = await cached(`v:${id}`, 15000, async () => {
      const head = await env.BUCKET.head(`meta/${id}.json`);
      const m = head?.customMetadata;
      return head ? { ready: (m?.status || "ready") === "ready", nsfw: m?.nsfw === "1", owner: m?.owner || adminName(env) } : null;
    });
    if (!flags) throw new HttpError(404, "Not found");
    const restricted = !flags.ready || flags.nsfw;
    if (restricted) {
      const editor = canEdit(user ?? (await currentUser(ctx)), flags);
      // 未发布的视频只有上传者和管理员能读取
      if (!flags.ready && !editor) throw new HttpError(404, "Not found");
      // NSFW 视频的所有文件（视频、封面、预览图）都要解锁后才能访问
      if (flags.nsfw && !editor && !(await nsfwUnlocked(ctx))) {
        throw new HttpError(403, "需要输入 NSFW 访问密码", "nsfw_locked");
      }
    }
    return serveObject(request, env, `videos/${id}/${path}`, {
      cacheControl: mediaCache(env, url, restricted),
      download: url.searchParams.has("download"),
    });
  }

  // ---------- 头像：/avatars/<username> ----------
  if (parts[0] === "avatars" && parts.length === 2) {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
    if (isPrivate(env)) await requireUser(ctx);
    const username = validUsername(parts[1]);
    const v = url.searchParams.get("v") || "";
    // 头像按版本存储（avatars/<用户名>/<版本>）；旧版本的头像在 avatars/<用户名>
    const keys = /^\d{1,16}$/.test(v) ? [`avatars/${username}/${v}`, `avatars/${username}`] : [`avatars/${username}`];
    for (const key of keys) {
      if (await env.BUCKET.head(key)) return serveObject(request, env, key, { cacheControl: mediaCache(env, url) });
    }
    throw new HttpError(404, "Not found");
  }

  if (parts[0] !== "api") return env.ASSETS.fetch(request);

  // ---------- 配置 / 账号 ----------
  if (url.pathname === "/api/config" && method === "GET") {
    const [user, settings, categories, nsfw] = await Promise.all([
      currentUser(ctx),
      getSettings(env),
      getCategories(env),
      getNsfwConfig(env),
    ]);
    return json({
      siteName: env.SITE_NAME || "视频站",
      siteBadge: env.SITE_BADGE || "",
      privateMode: isPrivate(env),
      passwordConfigured: Boolean(env.ADMIN_PASSWORD),
      allowRegistration: settings.allowRegistration,
      user: user ? { ...selfUser(user), primary: user.username === adminName(env) } : null,
      settings: user?.role === "admin" ? settings : undefined,
      categories,
      nsfw: {
        enabled: nsfw.enabled,
        unlocked: await nsfwUnlocked(ctx),
        passwordSet: user?.role === "admin" ? Boolean(nsfw.passwordHash) : undefined,
      },
    });
  }

  // ---------- NSFW 专区 ----------
  if (url.pathname === "/api/nsfw/unlock" && method === "POST") {
    await requireViewer(ctx);
    const cfg = await getNsfwConfig(env);
    if (!cfg.enabled || !cfg.passwordHash) throw new HttpError(404, "NSFW 专区未开放");
    const { password } = await readJson(request);
    if (typeof password !== "string" || !(await verifyPassword(password, cfg.passwordHash))) {
      await new Promise((r) => setTimeout(r, 800));
      throw new HttpError(401, "访问密码不正确");
    }
    const payload = `${Date.now() + NSFW_TTL_MS}.${cfg.version}`;
    const token = `${payload}.${await hmac(env, `nsfw.${payload}`)}`;
    // 不设 Max-Age：关闭浏览器即失效
    return json({ ok: true }, 200, { "set-cookie": `${NSFW_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax` });
  }

  if (url.pathname === "/api/nsfw/lock" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${NSFW_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (url.pathname === "/api/nsfw" && method === "PUT") {
    await requireRole(ctx, "admin");
    const body = await readJson(request);
    const cfg = await getNsfwConfig(env);
    if (body.password !== undefined) {
      cfg.passwordHash = await hashPassword(validPassword(body.password));
      cfg.version = (cfg.version || 0) + 1; // 已解锁的访客需要重新输入新密码
    }
    if (body.enabled !== undefined) {
      if (body.enabled && !cfg.passwordHash) throw new HttpError(400, "请先设置访问密码");
      cfg.enabled = Boolean(body.enabled);
    }
    await putJson(env, "config/nsfw.json", cfg);
    memo.delete("nsfw");
    return json({ enabled: cfg.enabled, passwordSet: Boolean(cfg.passwordHash) });
  }

  if (url.pathname === "/api/login" && method === "POST") {
    const body = await readJson(request);
    const username = String(body.username || adminName(env)).trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const user = await authenticate(env, username, password);
    if (!user) {
      await new Promise((r) => setTimeout(r, 800)); // 稍微拖慢暴力猜密码
      throw new HttpError(401, "用户名或密码错误");
    }
    if (user.disabled) throw new HttpError(403, "该账号已被停用");
    return json({ user: { ...selfUser(user), primary: user.username === adminName(env) } }, 200, {
      "set-cookie": await sessionCookie(env, user),
    });
  }

  if (url.pathname === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, {
      "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    });
  }

  if (url.pathname === "/api/register" && method === "POST") {
    const settings = await getSettings(env);
    if (!settings.allowRegistration) throw new HttpError(403, "暂未开放注册，请联系管理员");
    const body = await readJson(request);
    const user = await createUser(env, { ...body, role: settings.defaultRole });
    return json({ user: selfUser(user) }, 200, { "set-cookie": await sessionCookie(env, user) });
  }

  // 修改自己的资料 / 密码
  if (url.pathname === "/api/me" && method === "PATCH") {
    const me = await requireUser(ctx);
    const body = await readJson(request);
    const changePassword = body.newPassword !== undefined;
    if (changePassword && me.username === adminName(env)) {
      throw new HttpError(400, "管理员密码请用 wrangler secret put ADMIN_PASSWORD 修改");
    }
    const newHash = changePassword ? await hashPassword(validPassword(body.newPassword)) : null;
    const updated = await updateUser(env, me.username, async (u) => {
      assertSameAccount(u, me);
      if (body.displayName !== undefined) u.displayName = cleanName(body.displayName) || u.displayName;
      if (body.bio !== undefined) u.bio = String(body.bio).trim().slice(0, 300);
      if (changePassword) {
        if (!(await verifyPassword(String(body.currentPassword || ""), u.passwordHash))) {
          throw new HttpError(400, "当前密码不正确");
        }
        u.passwordHash = newHash;
        u.sv = (u.sv || 0) + 1; // 让其他设备上的登录失效
      }
      u.updatedAt = Date.now();
    });
    if (!updated) throw new HttpError(401, "登录已失效，请重新登录");
    const cookie = changePassword ? await sessionCookie(env, updated) : null;
    return json(selfUser(updated), 200, cookie ? { "set-cookie": cookie } : {});
  }

  if (url.pathname === "/api/me/avatar" && method === "PUT") {
    const me = await requireUser(ctx);
    const type = validType(request.headers.get("content-type"));
    if (!type.startsWith("image/")) throw new HttpError(400, "头像需要是图片");
    const length = Number(request.headers.get("content-length"));
    if (!length || length > 2 * 1024 * 1024) throw new HttpError(413, "头像图片需小于 2MB");
    // 先按新版本号存图片，再有条件地更新资料：上传期间账号被停用 / 删除 / 改密码时放弃，不覆盖任何状态
    const version = Date.now();
    const key = `avatars/${me.username}/${version}`;
    await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: type } });
    let previous = null;
    let updated;
    try {
      updated = await updateUser(env, me.username, (u) => {
        assertSameAccount(u, me);
        previous = u.avatar;
        u.avatar = u.updatedAt = version;
      });
      if (!updated) throw new HttpError(401, "登录已失效，请重新登录");
    } catch (err) {
      await env.BUCKET.delete(key);
      throw err;
    }
    await env.BUCKET.delete([`avatars/${me.username}`, ...(previous ? [`avatars/${me.username}/${previous}`] : [])]);
    return json(selfUser(updated));
  }

  // ---------- 用户 ----------
  if (parts[1] === "users") {
    // 管理员：用户列表 / 新建用户
    if (parts.length === 2) {
      await requireRole(ctx, "admin");
      if (method === "GET") {
        const admin = adminName(env);
        return json({ users: (await listUsers(env)).map((u) => ({ ...u, primary: u.username === admin })) });
      }
      if (method === "POST") {
        const body = await readJson(request);
        return json(selfUser(await createUser(env, body)));
      }
    }
    const username = validUsername(parts[2]);

    // 公开资料（频道页）
    if (parts.length === 3 && method === "GET") {
      await requireViewer(ctx);
      const u = await getUser(env, username);
      if (!u || u.disabled) throw new HttpError(404, "用户不存在");
      return json(publicUser(u));
    }

    if (parts.length === 3 && method === "PATCH") {
      await requireRole(ctx, "admin");
      const isEnvAdmin = username === adminName(env);
      const body = await readJson(request);
      if (isEnvAdmin) {
        if (body.role !== undefined) throw new HttpError(400, "不能修改主管理员的角色");
        if (body.disabled !== undefined) throw new HttpError(400, "不能停用主管理员");
        if (body.password !== undefined) throw new HttpError(400, "主管理员密码请用 wrangler secret put ADMIN_PASSWORD 修改");
        await ensureAdminRecord(env);
      }
      if (body.role !== undefined && !ROLES.includes(body.role)) throw new HttpError(400, "角色无效");
      const newHash = body.password !== undefined ? await hashPassword(validPassword(body.password)) : null;
      const u = await updateUser(env, username, (u) => {
        if (body.displayName !== undefined) u.displayName = cleanName(body.displayName) || u.displayName;
        if (body.role !== undefined) u.role = body.role;
        if (body.disabled !== undefined) {
          u.disabled = Boolean(body.disabled);
          u.sv = (u.sv || 0) + 1;
        }
        if (newHash) {
          u.passwordHash = newHash;
          u.sv = (u.sv || 0) + 1;
        }
        u.updatedAt = Date.now();
      });
      if (!u) throw new HttpError(404, "用户不存在");
      return json(selfUser(u));
    }

    if (parts.length === 3 && method === "DELETE") {
      await requireRole(ctx, "admin");
      if (username === adminName(env)) throw new HttpError(400, "不能删除主管理员");
      const owned = (await listVideos(env)).filter((v) => v.owner === username);
      if (owned.length) throw new HttpError(409, `该用户还有 ${owned.length} 个视频，请先删除或转移`);
      await env.BUCKET.delete([`users/${username}.json`, `avatars/${username}`]);
      await deletePrefix(env, `avatars/${username}/`);
      return json({ ok: true });
    }
  }

  // ---------- 网站设置 / 分类（管理员） ----------
  if (url.pathname === "/api/settings" && method === "PUT") {
    await requireRole(ctx, "admin");
    const body = await readJson(request);
    const settings = {
      allowRegistration: Boolean(body.allowRegistration),
      defaultRole: body.defaultRole === "creator" ? "creator" : "viewer",
    };
    await putJson(env, "config/settings.json", settings);
    return json(settings);
  }

  if (url.pathname === "/api/categories" && method === "PUT") {
    await requireRole(ctx, "admin");
    const body = await readJson(request);
    if (!Array.isArray(body.categories) || body.categories.length > 50) throw new HttpError(400, "分类数据无效");
    const seen = new Set();
    const categories = body.categories.map((c) => {
      const id = String(c.id || "").toLowerCase();
      if (!CATEGORY_ID_RE.test(id) || seen.has(id)) throw new HttpError(400, `分类 ID 无效或重复：${id}`);
      seen.add(id);
      const name = Array.from(String(c.name || "").trim()).slice(0, 20).join("");
      if (!name) throw new HttpError(400, "分类名称不能为空");
      return { id, name, icon: /^[a-zA-Z]{1,20}$/.test(c.icon) ? c.icon : "film" };
    });
    await putJson(env, "config/categories.json", categories);
    return json({ categories });
  }

  // ---------- 视频 ----------
  if (url.pathname === "/api/videos" && method === "GET") {
    const user = await requireViewer(ctx);
    const all = await listVideos(env);
    const unlocked = await nsfwUnlocked(ctx);
    // 未发布的视频只有上传者和管理员能看到；NSFW 视频需要解锁（上传者和管理员管理时也能看到）
    const videos = all.filter(
      (v) => (v.status === "ready" || canEdit(user, v)) && (!v.nsfw || unlocked || canEdit(user, v))
    );
    const users = await listUsers(env);
    const owners = new Set(videos.map((v) => v.owner));
    return json({
      videos,
      users: Object.fromEntries(users.filter((u) => owners.has(u.username)).map((u) => [u.username, { displayName: u.displayName, avatar: u.avatar }])),
    });
  }

  // 新建视频（处理中状态），之后再往里上传文件，最后 publish
  if (url.pathname === "/api/videos" && method === "POST") {
    const user = await requireRole(ctx, "creator");
    const body = await readJson(request);
    const now = Date.now();
    const filename = String(body.filename || "video").slice(0, 200);
    const meta = {
      id: newId(),
      owner: user.username,
      status: "processing",
      title: cleanTitle(body.title) || stripExt(filename),
      description: "",
      category: await validCategory(env, body.category),
      nsfw: Boolean(body.nsfw),
      filename,
      size: 0,
      duration: null,
      width: null,
      height: null,
      playback: null,
      renditions: [],
      original: null,
      thumb: null,
      storyboard: null,
      createdAt: now,
      updatedAt: now,
    };
    await putMeta(env, meta);
    return json(meta);
  }

  if (parts[1] !== "videos" || parts.length < 3) throw new HttpError(404, "Not found");
  const id = validId(parts[2]);
  const sub = parts[3];

  if (parts.length === 3 && method === "GET") {
    const user = await requireViewer(ctx);
    const meta = await getMeta(env, id);
    if (meta.status !== "ready" && !canEdit(user, meta)) throw new HttpError(404, "视频不存在");
    if (meta.nsfw && !canEdit(user, meta) && !(await nsfwUnlocked(ctx))) {
      throw new HttpError(403, "需要输入 NSFW 访问密码", "nsfw_locked");
    }
    const owner = await getUser(env, meta.owner);
    return json({ ...meta, ownerInfo: owner ? publicUser(owner) : { username: meta.owner, displayName: meta.owner } });
  }

  // 以下操作需要是视频的上传者或管理员
  const user = await requireUser(ctx);
  const meta = await getMeta(env, id);
  if (!canEdit(user, meta)) throw new HttpError(403, "只能管理自己上传的视频");

  if (parts.length === 3 && method === "PATCH") {
    const body = await readJson(request);
    const category = body.category !== undefined ? await validCategory(env, body.category) : undefined;
    const updated = await updateMeta(env, id, (m) => {
      if (body.title !== undefined) m.title = cleanTitle(body.title) || m.title;
      if (body.description !== undefined) m.description = cleanDescription(body.description);
      if (category !== undefined) m.category = category;
      if (body.nsfw !== undefined) m.nsfw = Boolean(body.nsfw);
      m.updatedAt = Date.now();
    });
    return json(updated);
  }

  if (parts.length === 3 && method === "DELETE") {
    await deletePrefix(env, `videos/${id}/`);
    await env.BUCKET.delete(`meta/${id}.json`);
    memo.delete(`v:${id}`);
    return json({ ok: true });
  }

  // DELETE /api/videos/<id>/original   删除原片，转码后的各清晰度保留，播放不受影响
  if (sub === "original" && parts.length === 4 && method === "DELETE") {
    const path = meta.original?.path;
    if (!path) throw new HttpError(404, "这个视频没有保存原片");
    const key = `videos/${id}/${path}`;
    const head = await env.BUCKET.head(key);
    // 先改元数据再删文件：中途失败最多留下一个没人引用的文件（删除视频时会一并清掉），不会出现指向空文件的下载链接
    const updated = await updateMeta(env, id, (m) => {
      if (m.original?.path !== path) throw new HttpError(404, "原片已经删除了");
      if (m.playback?.path === path) throw new HttpError(400, "这个视频没有转码，原片就是播放文件，不能单独删除");
      m.original = null;
      m.size = Math.max(0, (m.size || 0) - (head?.size || 0));
      m.updatedAt = Date.now();
    });
    await env.BUCKET.delete(key);
    return json(updated);
  }

  // POST /api/videos/<id>/publish   所有文件传完后，写入播放信息并公开
  if (sub === "publish" && parts.length === 4 && method === "POST") {
    const body = await readJson(request);
    const playback = body.playback || {};
    if (!["hls", "file"].includes(playback.type)) throw new HttpError(400, "playback.type 无效");
    validPath(playback.path);
    if (!(await env.BUCKET.head(`videos/${id}/${playback.path}`))) throw new HttpError(400, "播放文件不存在");
    const size = await prefixSize(env, `videos/${id}/`);

    const updated = await updateMeta(env, id, (meta) => {
      meta.playback = { type: playback.type, path: playback.path };
      meta.duration = positiveOrNull(body.duration);
      meta.width = positiveOrNull(body.width);
      meta.height = positiveOrNull(body.height);
      meta.fps = positiveOrNull(body.fps);
      meta.renditions = (Array.isArray(body.renditions) ? body.renditions : []).slice(0, 8).map((r) => ({
        width: positiveOrNull(r.width),
        height: positiveOrNull(r.height),
        bitrate: positiveOrNull(r.bitrate),
      }));
      if (body.original?.path) {
        validPath(body.original.path);
        meta.original = {
          path: body.original.path,
          filename: String(body.original.filename || meta.filename).slice(0, 200),
          size: positiveOrNull(body.original.size),
          contentType: String(body.original.contentType || "").slice(0, 100),
        };
      }
      const sb = body.storyboard;
      if (sb?.path) {
        validPath(sb.path);
        meta.storyboard = {
          path: sb.path,
          count: positiveOrNull(sb.count),
          interval: positiveOrNull(sb.interval),
          cols: positiveOrNull(sb.cols),
          rows: positiveOrNull(sb.rows),
          width: positiveOrNull(sb.width),
          height: positiveOrNull(sb.height),
        };
      }
      meta.size = size;
      meta.status = "ready";
      meta.publishedAt = meta.updatedAt = Date.now();
    });
    return json(updated);
  }

  // PUT /api/videos/<id>/files/<path>   小文件直传（播放列表、封面、预览图）
  if (sub === "files" && method === "PUT") {
    const path = validPath(parts.slice(4).join("/"));
    const contentType = validType(request.headers.get("content-type"));
    const length = Number(request.headers.get("content-length"));
    if (!length || length > MAX_DIRECT_UPLOAD) throw new HttpError(413, "文件过大，请使用分片上传");
    const object = await env.BUCKET.put(`videos/${id}/${path}`, request.body, { httpMetadata: { contentType } });
    if (path === "thumb.jpg") {
      await updateMeta(env, id, (m) => {
        m.thumb = m.updatedAt = Date.now();
      });
    }
    return json({ path, size: object.size });
  }

  // ---------- 分片上传（大文件） ----------
  // POST   /api/videos/<id>/uploads                      {path, contentType, filename} → {uploadId}
  // PUT    /api/videos/<id>/uploads/<n>?path=&uploadId=  上传第 n 片
  // POST   /api/videos/<id>/uploads/complete?path=&uploadId=  {parts}
  // DELETE /api/videos/<id>/uploads?path=&uploadId=      放弃
  if (sub === "uploads") {
    if (parts.length === 4 && method === "POST") {
      const body = await readJson(request);
      const path = validPath(body.path);
      const upload = await env.BUCKET.createMultipartUpload(`videos/${id}/${path}`, {
        httpMetadata: { contentType: validType(body.contentType) },
        customMetadata: body.filename ? { filename: String(body.filename).slice(0, 200) } : undefined,
      });
      return json({ uploadId: upload.uploadId });
    }

    const path = validPath(url.searchParams.get("path"));
    const uploadId = url.searchParams.get("uploadId");
    if (!uploadId) throw new HttpError(400, "缺少 uploadId");
    const upload = env.BUCKET.resumeMultipartUpload(`videos/${id}/${path}`, uploadId);

    if (parts.length === 5 && parts[4] === "complete" && method === "POST") {
      const body = await readJson(request);
      if (!Array.isArray(body.parts) || body.parts.length === 0) throw new HttpError(400, "没有分片");
      const object = await upload.complete(
        body.parts
          .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
          .sort((a, b) => a.partNumber - b.partNumber)
      );
      return json({ path, size: object.size });
    }

    if (parts.length === 5 && method === "PUT") {
      const partNumber = Number(parts[4]);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        throw new HttpError(400, "分片编号无效");
      }
      if (!request.body) throw new HttpError(400, "分片为空");
      const part = await upload.uploadPart(partNumber, request.body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (parts.length === 4 && method === "DELETE") {
      await upload.abort().catch(() => {});
      return json({ ok: true });
    }
  }

  throw new HttpError(404, "Not found");
}

// ================= R2 读写 =================

function mediaCache(env, url, restricted = false) {
  // 私密站、NSFW、未发布的文件：浏览器可以存，但每次使用前都必须回服务器校验权限，代理服务器不能存
  if (restricted || isPrivate(env)) return "private, no-cache";
  // 带 ?v= 的地址（封面、头像等会被替换的文件）内容变了 URL 就变，可以长缓存
  return url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=86400";
}

async function serveObject(request, env, key, { cacheControl, download = false }) {
  const isHead = request.method === "HEAD";
  let object;
  try {
    object = isHead
      ? await env.BUCKET.head(key)
      : await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
  } catch {
    // R2 对无法满足的 Range 会抛错
    const head = await env.BUCKET.head(key);
    if (!head) throw new HttpError(404, "Not found");
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
  }
  if (!object) throw new HttpError(404, "Not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", cacheControl);
  headers.set("x-content-type-options", "nosniff");
  if (download) {
    const name = object.customMetadata?.filename || key.split("/").pop();
    headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }

  if (isHead) {
    headers.set("content-length", String(object.size));
    return new Response(null, { headers });
  }

  // onlyIf 条件不满足时 R2 返回不带 body 的对象
  if (!("body" in object)) {
    const conditional = request.headers.has("if-none-match") || request.headers.has("if-modified-since");
    return new Response(null, { status: conditional ? 304 : 412, headers });
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader && object.range) {
    // 起点超出文件末尾：R2 不一定报错，这里统一返回 416
    const start = /^bytes=(\d+)-/.exec(rangeHeader);
    if (start && Number(start[1]) >= object.size) {
      object.body.cancel();
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${object.size}` } });
    }
    // R2 返回的 range 形如 {offset, length} 或 {suffix}（未用到的字段为 undefined）
    const r = object.range;
    let offset, length;
    if (r.offset === undefined && r.suffix !== undefined) {
      length = Math.min(r.suffix, object.size);
      offset = object.size - length;
    } else {
      offset = r.offset ?? 0;
      length = r.length ?? object.size - offset;
    }
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}

async function listVideos(env) {
  const videos = [];
  const fallbackOwner = adminName(env); // 多用户功能之前上传的视频归主管理员
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: "meta/", cursor, include: ["customMetadata"] });
    for (const obj of page.objects) {
      const m = obj.customMetadata || {};
      videos.push({
        id: obj.key.slice("meta/".length, -".json".length),
        owner: m.owner || fallbackOwner,
        category: m.cat || null,
        nsfw: m.nsfw === "1",
        status: m.status || "ready",
        title: m.title || "",
        createdAt: Number(m.createdAt) || obj.uploaded.getTime(),
        duration: m.duration ? Number(m.duration) : null,
        size: Number(m.size) || 0,
        height: m.height ? Number(m.height) : null,
        thumb: m.thumb ? Number(m.thumb) : null,
        storyboard: parseStoryboard(m.sb),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  videos.sort((a, b) => b.createdAt - a.createdAt);
  return videos;
}

async function getMeta(env, id) {
  const obj = await env.BUCKET.get(`meta/${id}.json`);
  if (!obj) throw new HttpError(404, "视频不存在");
  const meta = await obj.json();
  meta.owner ||= adminName(env);
  return meta;
}

// onlyIf：条件写入（见 updateRecord），条件不满足时返回 null
async function putMeta(env, meta, onlyIf) {
  const sb = meta.storyboard;
  const maxHeight = Math.max(0, ...meta.renditions.map((r) => Math.min(r.width || 0, r.height || 0)));
  const res = await env.BUCKET.put(`meta/${meta.id}.json`, JSON.stringify(meta), {
    onlyIf,
    httpMetadata: { contentType: "application/json" },
    // customMetadata 总大小上限 2KB，所以只放列表页要用的短字段
    customMetadata: {
      status: meta.status,
      owner: meta.owner,
      cat: meta.category || "",
      nsfw: meta.nsfw ? "1" : "",
      title: meta.title,
      createdAt: String(meta.createdAt),
      duration: meta.duration == null ? "" : String(meta.duration),
      size: String(meta.size || 0),
      height: String(maxHeight || Math.min(meta.width || 0, meta.height || 0) || ""),
      thumb: meta.thumb ? String(meta.thumb) : "",
      sb: sb ? [sb.path, sb.count, sb.interval, sb.cols, sb.rows, sb.width, sb.height].join(",") : "",
    },
  });
  if (res) memo.delete(`v:${meta.id}`);
  return res;
}

// 读-改-写：用 ETag 做条件写入，期间被别的请求改过就重新读取再改，绝不用旧数据覆盖新数据
async function updateRecord(env, key, mutate, write) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const obj = await env.BUCKET.get(key);
    if (!obj) return null;
    const value = await obj.json();
    await mutate(value);
    if (await write(value, { etagMatches: obj.etag })) return value;
  }
  throw new HttpError(409, "数据刚被修改过，请重试");
}

async function updateMeta(env, id, mutate) {
  const meta = await updateRecord(
    env,
    `meta/${id}.json`,
    async (m) => {
      m.owner ||= adminName(env);
      await mutate(m);
    },
    (m, onlyIf) => putMeta(env, m, onlyIf)
  );
  if (!meta) throw new HttpError(404, "视频不存在");
  return meta;
}

function parseStoryboard(s) {
  if (!s) return null;
  const [path, count, interval, cols, rows, width, height] = s.split(",");
  return { path, count: +count, interval: +interval, cols: +cols, rows: +rows, width: +width, height: +height };
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function prefixSize(env, prefix) {
  let size = 0;
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    for (const o of page.objects) size += o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return size;
}

async function getJson(env, key, fallback) {
  const obj = await env.BUCKET.get(key);
  return obj ? obj.json() : fallback;
}

async function putJson(env, key, value) {
  await env.BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...(await getJson(env, "config/settings.json", {})) };
}

async function getCategories(env) {
  return getJson(env, "config/categories.json", DEFAULT_CATEGORIES);
}

async function validCategory(env, id) {
  if (!id) return null;
  const categories = await getCategories(env);
  if (!categories.some((c) => c.id === id)) throw new HttpError(400, "分类不存在");
  return id;
}

// ================= 用户 =================

function adminName(env) {
  return String(env.ADMIN_USERNAME || "admin").toLowerCase();
}

async function getUser(env, username) {
  if (!username || !USERNAME_RE.test(username)) return null;
  const u = await getJson(env, `users/${username}.json`, null);
  if (u) return u;
  // 主管理员的资料记录在第一次登录时创建；之前先给一个默认值
  if (username === adminName(env)) {
    return { username, displayName: "管理员", role: "admin", bio: "", avatar: null, sv: 0, createdAt: Date.now() };
  }
  return null;
}

async function putUser(env, u, onlyIf) {
  return env.BUCKET.put(`users/${u.username}.json`, JSON.stringify(u), {
    onlyIf,
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      displayName: u.displayName,
      role: u.role,
      disabled: u.disabled ? "1" : "",
      avatar: u.avatar ? String(u.avatar) : "",
      createdAt: String(u.createdAt),
    },
  });
}

function updateUser(env, username, mutate) {
  return updateRecord(env, `users/${username}.json`, mutate, (u, onlyIf) => putUser(env, u, onlyIf));
}

// 主管理员的资料记录在第一次登录时创建
async function ensureAdminRecord(env) {
  const username = adminName(env);
  if (await env.BUCKET.head(`users/${username}.json`)) return;
  await putUser(env, { ...(await getUser(env, username)), uid: newSecretId() });
}

// 写入前核对：仍是发起请求的那个账号（同一个账号 ID、会话版本），且没有被停用
function assertSameAccount(fresh, me) {
  if (fresh.disabled || !fresh.uid || fresh.uid !== me.uid || (fresh.sv || 0) !== (me.sv || 0)) {
    throw new HttpError(401, "登录已失效，请重新登录");
  }
}

async function listUsers(env) {
  const users = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: "users/", cursor, include: ["customMetadata"] });
    for (const obj of page.objects) {
      const m = obj.customMetadata || {};
      users.push({
        username: obj.key.slice("users/".length, -".json".length),
        displayName: m.displayName || "",
        role: m.role || "viewer",
        disabled: m.disabled === "1",
        avatar: m.avatar ? Number(m.avatar) : null,
        createdAt: Number(m.createdAt) || obj.uploaded.getTime(),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const admin = adminName(env);
  if (!users.some((u) => u.username === admin)) users.push(publicUser(await getUser(env, admin)));
  return users.sort((a, b) => a.createdAt - b.createdAt);
}

async function createUser(env, body) {
  const username = String(body.username || "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "用户名需为 3–20 位小写字母、数字或下划线");
  if (RESERVED_NAMES.has(username) || username === adminName(env)) throw new HttpError(400, "这个用户名不能使用");
  if (await env.BUCKET.head(`users/${username}.json`)) throw new HttpError(409, "用户名已被占用");
  const now = Date.now();
  const user = {
    username,
    uid: newSecretId(), // 账号 ID：删除后同名重建是另一个账号，旧登录不会复活
    displayName: cleanName(body.displayName) || username,
    bio: "",
    role: ROLES.includes(body.role) ? body.role : "viewer",
    passwordHash: await hashPassword(validPassword(body.password)),
    disabled: false,
    avatar: null,
    sv: 0,
    createdAt: now,
    updatedAt: now,
  };
  await putUser(env, user);
  return user;
}

async function authenticate(env, username, password) {
  if (!password) return null;
  if (username === adminName(env)) {
    if (!env.ADMIN_PASSWORD) throw new HttpError(500, "服务器还没有设置 ADMIN_PASSWORD");
    if (!(await safeEqual(password, env.ADMIN_PASSWORD))) return null;
    await ensureAdminRecord(env);
    const u = await withAccountId(env, username);
    u.role = "admin";
    return u;
  }
  const u = await getJson(env, `users/${username}.json`, null);
  if (!u || !(await verifyPassword(password, u.passwordHash))) return null;
  return u.uid ? u : withAccountId(env, username);
}

// 早期创建、还没有账号 ID 的账号，登录时补上
async function withAccountId(env, username) {
  const u = await updateUser(env, username, (u) => {
    u.uid ||= newSecretId();
  });
  if (!u) throw new HttpError(401, "用户名或密码错误");
  return u;
}

// 前端可见的用户信息（不含密码哈希）
function publicUser(u) {
  return { username: u.username, displayName: u.displayName, bio: u.bio || "", avatar: u.avatar || null, createdAt: u.createdAt };
}
function selfUser(u) {
  return { ...publicUser(u), role: u.role, disabled: Boolean(u.disabled) };
}

// ================= 登录 / 权限 =================

function isPrivate(env) {
  return String(env.PRIVATE_MODE).toLowerCase() === "true";
}

const ROLE_LEVEL = { viewer: 1, creator: 2, admin: 3 };

async function currentUser(ctx) {
  if (ctx.user !== undefined) return ctx.user;
  ctx.user = null;
  const s = await readSession(ctx.request, ctx.env);
  if (s) {
    const u = await getUser(ctx.env, s.username);
    if (u && u.uid && u.uid === s.uid && !u.disabled && (u.sv || 0) === s.sv) {
      if (u.username === adminName(ctx.env)) u.role = "admin";
      ctx.user = u;
    }
  }
  return ctx.user;
}

async function requireUser(ctx) {
  const u = await currentUser(ctx);
  if (!u) throw new HttpError(401, "请先登录");
  return u;
}

async function requireRole(ctx, role) {
  const u = await requireUser(ctx);
  if ((ROLE_LEVEL[u.role] || 0) < ROLE_LEVEL[role]) {
    throw new HttpError(403, role === "admin" ? "需要管理员权限" : "你的账号没有上传权限，请联系管理员");
  }
  return u;
}

async function requireViewer(ctx) {
  const u = await currentUser(ctx);
  if (isPrivate(ctx.env) && !u) throw new HttpError(401, "请先登录");
  return u;
}

async function getNsfwConfig(env) {
  return { enabled: false, passwordHash: null, version: 0, ...(await getJson(env, "config/nsfw.json", {})) };
}

// NSFW 解锁 token = 过期时间.密码版本.HMAC —— 改密码后版本 +1，旧的解锁全部失效
async function nsfwUnlocked(ctx) {
  if (ctx.nsfw !== undefined) return ctx.nsfw;
  ctx.nsfw = false;
  const token = getCookie(ctx.request, NSFW_COOKIE);
  const m = token && /^(\d+)\.(\d+)\.([\w-]+)$/.exec(token);
  if (m && Number(m[1]) > Date.now()) {
    const cfg = await cached("nsfw", 30000, () => getNsfwConfig(ctx.env));
    if (cfg.enabled && cfg.passwordHash && Number(m[2]) === cfg.version) {
      ctx.nsfw = await safeEqual(m[3], await hmac(ctx.env, `nsfw.${m[1]}.${m[2]}`));
    }
  }
  return ctx.nsfw;
}

function canEdit(user, meta) {
  return Boolean(user && (user.role === "admin" || meta.owner === user.username));
}

// 会话 token = 用户名.账号ID.会话版本.过期时间.HMAC
//  - 账号 ID：每个账号创建时随机生成，删除后同名重建的账号 ID 不同，旧登录不会复活
//  - 会话版本：改密码 / 停用账号时 +1，旧登录随之失效
//  - 主管理员的签名还绑定当前 ADMIN_PASSWORD，修改后旧登录全部失效
function sessionSecret(env) {
  return env.SESSION_SECRET || `session:${env.ADMIN_PASSWORD}`;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

async function sessionSignature(env, payload, username) {
  let data = `session.${payload}`;
  if (username === adminName(env)) {
    const pw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`admin-password:${env.ADMIN_PASSWORD || ""}`));
    data += `.${base64url(pw)}`;
  }
  return hmac(env, data);
}

async function sessionCookie(env, user) {
  const payload = `${user.username}.${user.uid}.${user.sv || 0}.${Date.now() + SESSION_TTL_MS}`;
  const token = `${payload}.${await sessionSignature(env, payload, user.username)}`;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

async function readSession(request, env) {
  if (!env.ADMIN_PASSWORD && !env.SESSION_SECRET) return null;
  const token = getCookie(request, SESSION_COOKIE);
  const m = token && /^([a-z0-9_]{3,20})\.([\w-]{16,64})\.(\d+)\.(\d+)\.([\w-]+)$/.exec(token);
  if (!m || Number(m[4]) < Date.now()) return null;
  const expected = await sessionSignature(env, `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, m[1]);
  if (!(await safeEqual(m[5], expected))) return null;
  return { username: m[1], uid: m[2], sv: Number(m[3]) };
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(bits)}`;
}

async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2" || !hash) return false;
  const bits = await pbkdf2(password, fromBase64url(salt), Number(iter));
  return safeEqual(base64url(bits), hash);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ================= 小工具 =================

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "请求体不是有效的 JSON");
  }
}

function validId(id) {
  if (!id || !ID_RE.test(id)) throw new HttpError(404, "Not found");
  return id;
}

function validUsername(name) {
  if (!name || !USERNAME_RE.test(name)) throw new HttpError(404, "用户不存在");
  return name;
}

function validPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8 || pw.length > 128) throw new HttpError(400, "密码长度需为 8–128 位");
  return pw;
}

function validPath(path) {
  if (typeof path !== "string" || !PATH_RE.test(path)) throw new HttpError(400, "文件路径无效");
  return path;
}

function validType(type) {
  const t = String(type || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.test(t)) throw new HttpError(400, `不支持的文件类型：${t || "空"}`);
  return t;
}

function newSecretId() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

// 时间前缀 + 随机串，例如 "mgf3k2a1x9q7c4"
function newId() {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return Date.now().toString(36) + Array.from(rand, (b) => (b % 36).toString(36)).join("");
}

function cleanTitle(v) {
  return typeof v === "string" ? Array.from(v.trim()).slice(0, MAX_TITLE).join("") : "";
}

function cleanName(v) {
  return typeof v === "string" ? Array.from(v.trim()).slice(0, 30).join("") : "";
}

function cleanDescription(v) {
  return typeof v === "string" ? v.trim().slice(0, MAX_DESCRIPTION) : "";
}

function positiveOrNull(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null;
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, "") || name;
}

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
