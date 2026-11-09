#!/usr/bin/env node
// set-compaction.mjs <N> [--profile name] [--dry]
// Одна правка: вписывает порог автокомпрессии DSH в профиль.
const fs = require("fs");
const path = require("path");
const os = require("os");

const argv = process.argv.slice(2);
const N = Number(argv[0]);
const dry = argv.includes("--dry");
const pi = argv.indexOf("--profile");
const profileArg = pi >= 0 ? argv[pi + 1] : undefined;
if (!N || N <= 0) {
  console.error("usage: node set-compaction.mjs <N> [--profile name] [--dry]");
  process.exit(1);
}

const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profilesDir = path.join(home, "profiles");
if (!fs.existsSync(profilesDir)) {
  console.error("не нашёл " + profilesDir);
  process.exit(1);
}
const names = fs.readdirSync(profilesDir).filter((d) => {
  try { return fs.statSync(path.join(profilesDir, d)).isDirectory(); } catch { return false; }
});
const profile = profileArg || (names.includes("desktop") ? "desktop" : names.length === 1 ? names[0] : undefined);
if (!profile) {
  console.error("профилей несколько, укажи --profile: " + names.join(", "));
  process.exit(1);
}
const patchPath = path.join(profilesDir, profile, "cordis.patch.yml");
if (!fs.existsSync(patchPath)) {
  console.error("нет файла " + patchPath);
  process.exit(1);
}

// пресет и окно модели из кэша проекций (самая свежая сессия)
let preset = null;
let W = null;
const projDir = path.join(home, "storages", "session_projcache", "sessions");
if (fs.existsSync(projDir)) {
  const files = fs.readdirSync(projDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, t: fs.statSync(path.join(projDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(projDir, f), "utf8"));
      const rows = j && j.record && j.record.rows ? j.record.rows : {};
      if (!preset && rows.agentPreset && typeof rows.agentPreset.val === "string" && rows.agentPreset.val) preset = rows.agentPreset.val;
      if (W === null && rows.contextPressure && rows.contextPressure.val && rows.contextPressure.val.contextWindow) W = rows.contextPressure.val.contextWindow;
      if (preset && W !== null) break;
    } catch { /* пропускаем битые */ }
  }
}
if (!preset) preset = "standard";
if (!W) {
  console.error("не нашёл contextWindow в кэше проекций; укажи W вручную");
  process.exit(1);
}

function findAsar() {
  const cand = [
    process.env.DSH_ASAR,
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app.asar"),
    "C:\\Program Files\\DeepSeek Harness\\resources\\app.asar",
    "/opt/DeepSeek Harness/resources/app.asar",
  ].filter(Boolean);
  return cand.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
const asar = findAsar();
if (!asar) {
  console.error("не нашёл app.asar; укажи DSH_ASAR");
  process.exit(1);
}

function readAsarEntry(asarPath, entryPath) {
  const fd = fs.openSync(asarPath, "r");
  const h = Buffer.alloc(16);
  fs.readSync(fd, h, 0, 16, 0);
  const hl = h.readUInt32LE(12);
  const hb = Buffer.alloc(hl);
  fs.readSync(fd, hb, 0, hl, 16);
  let n = JSON.parse(hb.toString("utf8"));
  for (const s of entryPath.split("/").filter(Boolean)) n = n.files[s];
  if (!n || n.files) throw new Error("не файл: " + entryPath);
  const b = Buffer.alloc(n.size);
  fs.readSync(fd, b, 0, n.size, 17 + hl + Number(n.offset));
  fs.closeSync(fd);
  return b.toString("utf8");
}

const presetRel = "dsh/node_modules/@deepseek-ai/dsh-web-app/presets/" + preset + ".patch.yml";
let presetText;
try {
  presetText = readAsarEntry(asar, presetRel);
} catch (e) {
  console.error("не нашёл " + presetRel + ": " + e.message);
  process.exit(1);
}

const lines = presetText.split("\n");
const startIdx = lines.findIndex((l) => new RegExp("^\\s*- id: preset-" + preset + "\\s*$").test(l));
if (startIdx < 0) {
  console.error("в пресете нет строки - id: preset-" + preset);
  process.exit(1);
}
const baseIndent = lines[startIdx].match(/^\s*/)[0].length;
let cfgIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (/^\s*config:\s*$/.test(lines[i])) { cfgIdx = i; break; }
  const ind = lines[i].match(/^\s*/)[0].length;
  if (lines[i].trim() && ind <= baseIndent) break;
}
if (cfgIdx < 0) {
  console.error("не нашёл config у пресета");
  process.exit(1);
}
const block = [];
for (let i = cfgIdx + 1; i < lines.length; i++) {
  const l = lines[i];
  if (!l.trim()) { block.push(""); continue; }
  const ind = l.match(/^\s*/)[0].length;
  if (ind <= baseIndent) break;
  block.push(l.slice(4));
}

const ratio = N / W;
const cbIdx = block.findIndex((l) => /^\s*- id: compaction-basic\s*$/.test(l));
if (cbIdx < 0) {
  console.error("в пресете нет compaction-basic");
  process.exit(1);
}
let nameIdx = -1;
for (let i = cbIdx + 1; i < Math.min(cbIdx + 4, block.length); i++) {
  if (/^\s*name:/.test(block[i])) { nameIdx = i; break; }
}
if (nameIdx < 0) {
  console.error("нет name у compaction-basic");
  process.exit(1);
}
const nameIndent = block[nameIdx].match(/^\s*/)[0].length;
const pad = " ".repeat(nameIndent);
const insert = [
  pad + "config:",
  pad + "  thresholdRatio: " + ratio,
  pad + "  retainTokens: 60000",
];
block.splice(nameIdx + 1, 0, ...insert);

const entry = [
  "- id: preset-" + preset,
  "  name: '@deepseek-ai/dsh-agent-preset'",
  "  config:",
  ...block,
].join("\n");

const current = fs.readFileSync(patchPath, "utf8");
const curLines = current.split("\n");
const existing = curLines.findIndex((l) => new RegExp("^- id: preset-" + preset + "\\s*$").test(l));
let next;
if (existing >= 0) {
  let end = curLines.length;
  for (let i = existing + 1; i < curLines.length; i++) {
    if (/^- /.test(curLines[i])) { end = i; break; }
  }
  while (end > existing && !curLines[end - 1].trim()) end--;
  next = [...curLines.slice(0, existing), ...entry.split("\n"), "", ...curLines.slice(end)].join("\n");
} else {
  next = current.replace(/\s*$/, "") + "\n" + entry + "\n";
}

const backup = patchPath + ".bak-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
console.log("home:      " + home);
console.log("profile:   " + profile + "  (" + patchPath + ")");
console.log("preset:    " + preset + "  (плагинов в copied config: " + block.filter((l) => /^\s*- id: /.test(l)).length + ")");
console.log("W:         " + W);
console.log("N:         " + N);
console.log("ratio:     " + ratio);
console.log("retain:    60000");
console.log("asar:      " + asar);
console.log("replace:   " + (existing >= 0 ? "существующая запись preset-" + preset : "дописать в конец"));
if (dry) {
  console.log("--- DRY, не записано ---");
  console.log(entry.split("\n").slice(0, 8).join("\n") + "\n...");
  process.exit(0);
}
fs.copyFileSync(patchPath, backup);
fs.writeFileSync(patchPath, next);
console.log("backup:    " + backup);
console.log("written:   " + patchPath);
