#!/usr/bin/env node
/**
 * R2 视频站 —— 一键安装 / 更新脚本
 *
 *   首次运行：安装依赖 → 登录 Cloudflare → 填写网站设置 → 创建 R2 桶 → 设置管理员密码 → 部署
 *   再次运行：更新依赖并重新部署，沿用线上网站的现有设置，密码和数据都会保留
 *
 * 仓库里的 wrangler.jsonc 只放默认值，脚本不会修改它：部署时会按你的设置生成一份临时配置
 * （.wrangler.deploy.jsonc，已被 git 忽略），所以 git pull 更新代码不会和你的个人设置冲突。
 *
 * 用法：
 *   ./install.sh                  （Windows：npm run setup）
 *   ./install.sh --yes            全部使用当前设置，不再逐项询问（首次安装仍需输入管理员密码）
 *   ./install.sh --reset-password 重新设置管理员密码
 *   ./install.sh --dry-run        走一遍全部检查，但不创建存储桶、不真正部署
 *   npm run deploy:ci             给 Cloudflare 自动部署（Workers Builds）用：读取线上设置后直接部署，不做任何交互
 *
 * 也可以用环境变量免交互：ADMIN_PASSWORD=... CLOUDFLARE_ACCOUNT_ID=... ./install.sh --yes
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "wrangler.jsonc");
const DEPLOY_CONFIG = join(ROOT, ".wrangler.deploy.jsonc");
const args = new Set(process.argv.slice(2));
const YES = args.has("--yes") || args.has("-y");
const RESET_PASSWORD = args.has("--reset-password");
const DRY_RUN = args.has("--dry-run");
const CI = args.has("--ci");
const isWin = process.platform === "win32";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

// ---------- 输出 ----------
const color = (c) => (s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = color("1"), dim = color("2"), red = color("31"), green = color("32"), yellow = color("33"), cyan = color("36");
let stepNo = 0;
const step = (t) => console.log(`\n${cyan(`[${++stepNo}]`)} ${bold(t)}`);
const ok = (t) => console.log(`    ${green("✓")} ${t}`);
const warn = (t) => console.log(`    ${yellow("!")} ${t}`);
const fail = (t) => {
  console.error(`\n${red("✗")} ${t}\n`);
  process.exit(1);
};

// ---------- 执行命令 ----------
// 运行并把输出直接显示给用户；默认不把键盘输入交给子进程（免得吃掉用户提前输入的回答）
function run(cmd, cmdArgs, { interactive = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, env, stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"], shell: isWin });
  return r.status === 0;
}
// 静默运行，拿到输出
function capture(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: isWin });
  return { ok: r.status === 0, stdout: r.stdout || "", out: `${r.stdout || ""}${r.stderr || ""}` };
}
// 运行并同时显示、记录输出（用于部署，要从输出里取网址）
function tee(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, cmdArgs, { cwd: ROOT, env, stdio: ["inherit", "pipe", "inherit"], shell: isWin });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    p.on("close", (code) => resolve({ ok: code === 0, out }));
  });
}
const wrangler = (...a) => ["npx", ["--no-install", "wrangler", ...a]];

// ---------- 输入 ----------
// 自己维护输入缓冲：一次粘贴 / 提前输入多行时，每个问题依次取一行；密码输入时不回显
const input = { buf: "", waiter: null, hidden: false, value: "", started: false, ended: false };

function startInput() {
  if (input.started) return;
  input.started = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input.buf += chunk;
    pump();
  });
  process.stdin.on("end", () => {
    input.ended = true; // 输入已关闭（管道 / 非交互环境）：之后的问题直接用默认值
    if (input.waiter) finish(input.hidden ? input.value : input.buf);
  });
}

function pump() {
  while (input.waiter) {
    if (input.hidden) {
      if (!input.buf) return;
      const ch = input.buf[0];
      input.buf = input.buf.slice(1);
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && input.buf[0] === "\n") input.buf = input.buf.slice(1);
        finish(input.value);
      } else if (ch === "\u0003") {
        process.stdout.write("\n");
        process.exit(130); // Ctrl-C
      } else if (ch === "\u007f" || ch === "\b") {
        if (input.value) {
          input.value = input.value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (ch >= " ") {
        input.value += ch;
        process.stdout.write("*");
      }
    } else {
      const i = input.buf.indexOf("\n");
      if (i < 0) return;
      const line = input.buf.slice(0, i).replace(/\r$/, "");
      input.buf = input.buf.slice(i + 1);
      finish(line);
    }
  }
}

function finish(value) {
  const resolve = input.waiter;
  input.waiter = null;
  if (input.hidden) {
    input.hidden = false;
    process.stdin.setRawMode?.(false);
    process.stdout.write("\n");
  }
  process.stdin.pause();
  resolve(value);
}

function readLine(prompt, { hidden = false } = {}) {
  startInput();
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    input.waiter = resolve;
    input.value = "";
    input.hidden = hidden && Boolean(process.stdin.isTTY);
    if (input.ended) {
      const rest = input.buf;
      input.buf = "";
      return finish(rest.split(/\r?\n/)[0] || "");
    }
    if (input.hidden) process.stdin.setRawMode(true);
    process.stdin.resume();
    pump();
  });
}

async function ask(question, def) {
  if (YES) return def;
  const a = (await readLine(`    ${question}${def !== undefined && def !== "" ? dim(` [${def}]`) : ""}: `)).trim();
  return a || def;
}

async function confirm(question, def = true) {
  if (YES) return def;
  const a = (await readLine(`    ${question} ${dim(def ? "[Y/n]" : "[y/N]")}: `)).trim().toLowerCase();
  return a ? a.startsWith("y") : def;
}

// 输入密码时不显示明文
const askHidden = (prompt) => readLine(prompt, { hidden: true });

// ---------- wrangler.jsonc：读默认值、按设置生成部署用的配置（保留注释，只替换值） ----------
const KEYS = {
  name: /("name"\s*:\s*")([^"]*)(")/,
  bucket: /("bucket_name"\s*:\s*")([^"]*)(")/,
  SITE_NAME: /("SITE_NAME"\s*:\s*")([^"]*)(")/,
  SITE_BADGE: /("SITE_BADGE"\s*:\s*")([^"]*)(")/,
  SITE_DOMAIN: /("SITE_DOMAIN"\s*:\s*")([^"]*)(")/,
  WORKERS_DEV: /("WORKERS_DEV"\s*:\s*")([^"]*)(")/,
  ADMIN_USERNAME: /("ADMIN_USERNAME"\s*:\s*")([^"]*)(")/,
  PRIVATE_MODE: /("PRIVATE_MODE"\s*:\s*")([^"]*)(")/,
};
function readConfig() {
  const text = readFileSync(CONFIG, "utf8");
  return Object.fromEntries(Object.entries(KEYS).map(([k, re]) => [k, re.exec(text)?.[2] ?? ""]));
}
function writeDeployConfig(values) {
  let text = readFileSync(CONFIG, "utf8");
  for (const [k, v] of Object.entries(values)) {
    text = text.replace(KEYS[k], (_, a, _old, c) => `${a}${String(v).replace(/["\\]/g, "")}${c}`);
  }
  if (values.SITE_DOMAIN) {
    // 绑定自定义域名（Cloudflare 自动创建 DNS 记录和证书）；workers.dev 地址按设置保留（用于跳转）或关闭
    const dev = values.WORKERS_DEV !== "false";
    text = text.replace(
      /"r2_buckets"\s*:/,
      `"routes": [{ "pattern": "${values.SITE_DOMAIN}", "custom_domain": true }],\n  "workers_dev": ${dev},\n  "preview_urls": ${dev},\n\n  "r2_buckets":`
    );
  }
  writeFileSync(DEPLOY_CONFIG, `// 由 scripts/install.mjs 自动生成，用完即删，不要手动修改\n${text}`);
}

// 读取线上正在运行的版本的设置。
// 只有 Cloudflare 明确回答“这个 Worker 不存在”（code 10007）时才返回 null（= 新网站）；
// 网络、权限等其它任何错误都直接停止，避免把私密站、自定义域名等设置当成新站用默认值覆盖掉。
function readLiveConfig(name) {
  const status = capture(...wrangler("deployments", "status", "--name", name, "--json"));
  if (!status.ok) {
    if (/code: 10007\]|does not exist on your account/i.test(status.out)) return null;
    fail(`读取线上部署信息失败，为避免用默认设置覆盖线上网站，已停止。请稍后重试：\n${status.out}`);
  }
  const parse = (text, what) => {
    try {
      return JSON.parse(text.slice(text.search(/^\s*\{/m)));
    } catch {
      fail(`无法解析线上${what}，为避免覆盖线上设置，已停止：\n${text}`);
    }
  };
  const d = parse(status.stdout, "部署信息");
  const versionId = [...(d.versions || [])].sort((a, b) => b.percentage - a.percentage)[0]?.version_id;
  if (!versionId) fail(`Worker “${name}” 存在但没有正在运行的版本，为避免覆盖线上设置，已停止。`);
  const view = capture(...wrangler("versions", "view", versionId, "--name", name, "--json"));
  if (!view.ok) fail(`读取线上版本设置失败，为避免覆盖线上设置，已停止。请稍后重试：\n${view.out}`);
  const v = parse(view.stdout, "版本设置");
  const live = { name };
  for (const b of v.resources?.bindings || []) {
    if (b.type === "r2_bucket" && b.name === "BUCKET") live.bucket = b.bucket_name;
    if (b.type === "plain_text" && b.name in KEYS) live[b.name] = b.text;
  }
  return live;
}

// ---------- 公共步骤 ----------
function requireNode22(hint) {
  if (Number(process.versions.node.split(".")[0]) < 22) fail(`需要 Node.js 22 或更高版本，当前是 ${process.versions.node}。${hint}`);
}

// npm 配置了 ignore-scripts 时 postinstall 不会运行，这里补一次
function ensureVendor() {
  if (!existsSync(join(ROOT, "public", "vendor", "mediabunny.min.mjs")) && !run("node", ["scripts/vendor.mjs"])) {
    fail("复制前端依赖失败。");
  }
}

// 按设置生成临时配置并部署；密钥通过临时文件随部署一起加密上传。临时文件用完即删
async function deploy(values, secrets = {}) {
  writeDeployConfig(values);
  const deployArgs = ["deploy", "-c", DEPLOY_CONFIG, ...(DRY_RUN ? ["--dry-run"] : [])];
  let secretsDir;
  if (Object.keys(secrets).length) {
    secretsDir = mkdtempSync(join(tmpdir(), "r2vs-"));
    const file = join(secretsDir, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    deployArgs.push("--secrets-file", file);
  }
  try {
    return await tee(...wrangler(...deployArgs));
  } finally {
    if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
    rmSync(DEPLOY_CONFIG, { force: true });
  }
}

// ======================================================================
// 自动部署（Workers Builds 等 CI 环境）：依赖已由 CI 安装、凭据由 CI 提供；
// 只读取线上部署的设置并按它部署，读不到就停止，绝不用仓库默认值覆盖线上网站
async function ciDeploy() {
  console.log(bold("\n  R2 视频站 · 自动部署\n"));
  requireNode22("请在构建设置里添加变量 NODE_VERSION=22。");
  ensureVendor();
  const cfg = readConfig();
  const name = env.WORKER_NAME || cfg.name;
  const live = readLiveConfig(name);
  if (!live) fail(`线上没有名为 “${name}” 的 Worker。请先在本机运行 ./install.sh 完成首次部署，再开启自动部署。`);
  const next = { ...cfg, ...live };
  ok(`沿用线上设置：${next.SITE_NAME}${next.SITE_BADGE ? ` ${next.SITE_BADGE}` : ""}${next.SITE_DOMAIN ? ` · ${next.SITE_DOMAIN}` : ""}`);
  if (!(await deploy(next)).ok) fail("部署失败，请查看上面的错误信息。");
  ok(DRY_RUN ? "试运行通过" : "部署完成");
}

async function main() {
  if (CI) return ciDeploy();
  console.log(bold(`\n  R2 视频站 · 一键安装${DRY_RUN ? "（试运行，不会真正部署）" : ""}\n`));
  console.log(dim("  会把网站部署到你自己的 Cloudflare 账号（Workers + R2）。随时按 Ctrl-C 退出。"));

  // 1. 环境检查
  step("检查运行环境");
  requireNode22("请到 https://nodejs.org 下载安装最新 LTS 版。");
  ok(`Node.js ${process.versions.node}`);

  // 2. 依赖
  step("安装依赖");
  if (!run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"])) fail("npm install 失败，请检查网络后重试。");
  ensureVendor();
  ok("依赖已安装");

  // 3. 登录 Cloudflare
  step("登录 Cloudflare");
  let who = capture(...wrangler("whoami"));
  if (/not authenticated|wrangler login/i.test(who.out)) {
    console.log("    即将打开浏览器，请登录 Cloudflare 并点击“Allow”授权。");
    if (!run(...wrangler("login"), { interactive: true })) fail("登录失败，请重新运行脚本。");
    who = capture(...wrangler("whoami"));
  }
  const accounts = [...who.out.matchAll(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map((m) => ({ name: m[1], id: m[2] }));
  if (!accounts.length && !env.CLOUDFLARE_ACCOUNT_ID) fail(`无法读取 Cloudflare 账号信息：\n${who.out}`);
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    let acc = accounts[0];
    if (accounts.length > 1) {
      console.log("    这个登录关联了多个账号：");
      accounts.forEach((a, i) => console.log(`      ${i + 1}. ${a.name}  ${dim(a.id)}`));
      const n = Number(await ask("选择要部署到的账号编号", "1"));
      acc = accounts[n - 1] || accounts[0];
    }
    env.CLOUDFLARE_ACCOUNT_ID = acc.id;
  }
  ok(`账号 ${env.CLOUDFLARE_ACCOUNT_ID}`);

  // 4. 网站设置
  step("网站设置（直接回车保留方括号里的值）");
  let cfg = readConfig();
  const next = { ...cfg };
  for (;;) {
    next.name = await ask("Worker 名称（会成为网址的一部分）", cfg.name);
    if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(next.name)) break;
    warn("只能用小写字母、数字和横线");
    if (YES) fail("wrangler.jsonc 里的 Worker 名称不合法");
  }
  // 已经部署过：以线上的设置为准，避免更新时把网站名称等改回仓库默认值
  const live = readLiveConfig(next.name);
  if (live) {
    cfg = { ...cfg, ...live };
    Object.assign(next, cfg);
    ok(`检测到已部署的网站 ${next.name}，沿用线上设置（${cfg.SITE_NAME}${cfg.SITE_BADGE ? ` ${cfg.SITE_BADGE}` : ""}）`);
  } else ok("这是一个新网站");
  for (;;) {
    next.bucket = await ask("R2 存储桶名称", cfg.bucket);
    if (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(next.bucket)) break;
    warn("3–63 位，只能用小写字母、数字和横线");
    if (YES) fail("wrangler.jsonc 里的存储桶名称不合法");
  }
  next.SITE_NAME = await ask("网站名称（左上角）", cfg.SITE_NAME);
  next.SITE_BADGE = await ask("名称右上角的小角标（输入 - 表示不要）", cfg.SITE_BADGE || "-");
  if (next.SITE_BADGE === "-") next.SITE_BADGE = "";
  for (;;) {
    next.ADMIN_USERNAME = (await ask("管理员用户名", cfg.ADMIN_USERNAME)).toLowerCase();
    if (/^[a-z0-9_]{3,20}$/.test(next.ADMIN_USERNAME)) break;
    warn("3–20 位小写字母、数字或下划线");
    if (YES) fail("wrangler.jsonc 里的管理员用户名不合法");
  }
  next.PRIVATE_MODE = (await confirm("私密模式？（必须登录才能看视频）", cfg.PRIVATE_MODE === "true")) ? "true" : "false";
  for (;;) {
    const d = await ask("自定义域名（可选，如 video.example.com；输入 - 表示不用）", env.SITE_DOMAIN ?? (cfg.SITE_DOMAIN || "-"));
    next.SITE_DOMAIN = d === "-" ? "" : d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!next.SITE_DOMAIN || /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(next.SITE_DOMAIN)) break;
    warn("域名格式不对，例如 video.example.com");
    if (YES) fail("自定义域名格式不对");
  }
  if (next.SITE_DOMAIN && next.SITE_DOMAIN !== cfg.SITE_DOMAIN) {
    console.log(dim(`      ${next.SITE_DOMAIN} 所属的域名需要已经添加到这个 Cloudflare 账号；部署时会自动创建 DNS 记录和 HTTPS 证书。`));
  }
  if (next.SITE_DOMAIN) {
    const keep = env.WORKERS_DEV !== undefined ? env.WORKERS_DEV !== "false" : cfg.WORKERS_DEV !== "false";
    next.WORKERS_DEV = (await confirm("保留旧的 *.workers.dev 地址？（保留时会自动跳转到自定义域名）", keep)) ? "true" : "false";
  } else {
    next.WORKERS_DEV = "true"; // 没有自定义域名时，workers.dev 是唯一的访问地址
  }
  ok("设置已确认");

  // 5. R2
  step("准备 R2 存储桶");
  for (;;) {
    const list = capture(...wrangler("r2", "bucket", "list"));
    if (list.ok) {
      if (new RegExp(`^name:\\s+${next.bucket}\\s*$`, "m").test(list.out)) {
        ok(`存储桶 ${next.bucket} 已存在，数据会保留`);
      } else if (DRY_RUN) {
        ok(`将会创建存储桶 ${next.bucket}（试运行，跳过）`);
      } else {
        const created = capture(...wrangler("r2", "bucket", "create", next.bucket));
        if (!created.ok) fail(`创建存储桶失败：\n${created.out}\n（存储桶名称在全局可能已被占用，换一个名字再试）`);
        ok(`已创建存储桶 ${next.bucket}`);
      }
      break;
    }
    if (/10042|enable R2/i.test(list.out)) {
      warn("这个账号还没有开通 R2。请在浏览器里打开下面的地址开通（需要绑定付款方式，免费额度内不收费）：");
      console.log(`      ${cyan(`https://dash.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/r2/overview`)}`);
      if (YES || !process.stdin.isTTY) fail("开通 R2 后重新运行脚本。");
      await readLine("    开通完成后按回车继续…");
      continue;
    }
    fail(`读取 R2 存储桶失败：\n${list.out}`);
  }

  // 6. 密钥
  step("管理员密码和登录密钥");
  const existing = capture(...wrangler("secret", "list", "--name", next.name, "--format", "json"));
  let names = [];
  if (existing.ok) {
    // 只解析 stdout 里以 “[” 开头的那段 JSON（避免把 “[WARNING]” 之类的提示当成 JSON）
    const start = existing.stdout.search(/^\s*\[/m);
    try {
      names = JSON.parse(existing.stdout.slice(start)).map((s) => s.name);
    } catch {
      fail(`无法读取已有的密钥列表，为避免覆盖现有密码已停止：\n${existing.out}`);
    }
  } else if (!/not found|does not exist|10007/i.test(existing.out)) {
    fail(`读取密钥列表失败：\n${existing.out}`);
  } // Worker 不存在 = 第一次部署
  const secrets = {};
  if (!names.includes("SESSION_SECRET")) {
    secrets.SESSION_SECRET = randomBytes(48).toString("base64");
    ok("已生成随机登录密钥 SESSION_SECRET");
  } else ok("登录密钥已存在，保留");

  if (!names.includes("ADMIN_PASSWORD") || RESET_PASSWORD) {
    let pw = env.ADMIN_PASSWORD;
    if (!pw && input.ended) fail("需要输入管理员密码：请在终端里直接运行脚本，或用环境变量 ADMIN_PASSWORD 提供。");
    while (!pw) {
      const a = await askHidden(`    设置管理员（${next.ADMIN_USERNAME}）密码，至少 12 位: `);
      if (a.length < 12) {
        warn("太短了，至少 12 位");
        continue;
      }
      if ((await askHidden("    再输入一次: ")) !== a) {
        warn("两次输入不一致");
        continue;
      }
      pw = a;
    }
    secrets.ADMIN_PASSWORD = pw;
    ok("管理员密码已设置（会随部署一起加密上传）");
  } else ok("管理员密码已存在，保留（需要修改请加 --reset-password 重新运行）");

  // 7. 部署
  step("部署到 Cloudflare");
  const result = await deploy(next, secrets);
  if (!result.ok) {
    fail(
      next.SITE_DOMAIN
        ? `部署失败，请查看上面的错误信息。\n  如果是自定义域名的问题：确认 ${next.SITE_DOMAIN} 所属的域名已添加到这个 Cloudflare 账号，并且这个子域名没有被其它 DNS 记录占用。`
        : "部署失败，请查看上面的错误信息。"
    );
  }
  if (DRY_RUN) {
    console.log(`\n${green(bold("  ✓ 试运行通过"))}，去掉 --dry-run 重新运行即可正式部署。\n`);
    return;
  }
  const devUrl = result.out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  const url = next.SITE_DOMAIN ? `https://${next.SITE_DOMAIN}` : devUrl;

  // 8. 完成
  console.log(`\n${green(bold("  ✓ 部署完成！"))}\n`);
  if (url) console.log(`  网站地址：${cyan(url)}`);
  if (next.SITE_DOMAIN && devUrl) console.log(dim(`  （${devUrl} 会自动跳转到新域名；新域名的 HTTPS 证书首次签发可能需要几分钟）`));
  if (next.SITE_DOMAIN && next.WORKERS_DEV === "false") console.log(dim("  （旧的 *.workers.dev 地址已关闭）"));
  console.log(`  管理员：  ${next.ADMIN_USERNAME}（${secrets.ADMIN_PASSWORD ? "密码是你刚才设置的" : "密码不变"}）`);
  console.log(dim(`
  接下来：
    · 打开网站，点右上角“登录”，进入“工作室”上传视频
    · 在“管理后台”里创建其他用户、管理分类、设置 NSFW 专区
    · 想换自定义域名：重新运行这个脚本，在“自定义域名”一项输入新域名
    · 以后更新代码后，重新运行这个脚本即可（数据和密码都会保留）
`));
}

main().catch((err) => fail(err.stack || String(err)));
