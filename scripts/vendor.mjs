// 把前端用到的第三方库从 node_modules 复制到 public/vendor/（npm install 后自动运行）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");
mkdirSync(out, { recursive: true });

const libs = [
  ["mediabunny", "dist/bundles/mediabunny.min.mjs", "mediabunny.min.mjs"],
  ["@mediabunny/aac-encoder", "dist/bundles/mediabunny-aac-encoder.min.mjs", "mediabunny-aac-encoder.min.mjs"],
  ["hls.js", "dist/hls.min.mjs", "hls.min.mjs"],
];

for (const [pkg, file, name] of libs) {
  const dir = join(root, "node_modules", pkg);
  const { version, license, homepage } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const code = readFileSync(join(dir, file), "utf8").replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "\n");
  writeFileSync(join(out, name), `/*! ${pkg} ${version} | ${license} | ${homepage} */\n${code}`);
}
console.log(`vendor: ${libs.length} 个前端依赖已复制到 public/vendor/`);
