#!/usr/bin/env node
// set-compaction.cjs <N> [--profile name] [--preset id] [--dry]
// Ставит порог автокомпрессии DSH равным N токенов для пресетов агента.
const fs = require("fs");
const path = require("path");
const os = require("os");

const argv = process.argv.slice(2);
const N = Number(argv[0]);
const dry = argv.includes("--dry");
const pi = argv.indexOf("--profile");
const profileArg = pi >= 0 ? argv[pi + 1] : undefined;
const si = argv.indexOf("--preset");
const presetArg = si >= 0 ? argv[si + 1] : undefined;

if (!N || N <= 0) {
  console.error("usage: node set-compaction.cjs <N> [--profile name] [--preset id] [--dry]");
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

// окно модели W из самой свежей проекции сессии
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
      const v = j && j.record && j.record.rows && j.record.rows.contextPressure
        && j.record.rows.contextPressure.val && j.record.rows.contextPressure.val.contextWindow;
      if (v) { W = v; break; }
    } catch { /* пропускаем битые */ }
  }
}
if (!W) {
  console.error("не нашёл contextWindow в кэше проекций");
  process.exit(1);
}

const ratio = N / W;

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
const asarPath = findAsar();
if (!asarPath) {
  console.error("не нашёл app.asar; укажи DSH_ASAR");
  process.exit(1);
}

function openAsar(p) {
  const fd = fs.openSync(p, "r");
  const h = Buffer.alloc(16);
  fs.readSync(fd, h, 0, 16, 0);
  const hl = h.readUInt32LE(12);
  const hb = Buffer.alloc(hl);
  fs.readSync(fd, hb, 0, hl, 16);
  return { fd, header: JSON.parse(hb.toString("utf8")), base: 17 + hl };
}
function readEntry(asar, entry) {
  let n = asar.header;
  for (const s of entry.split("/").filter(Boolean)) n = n && n.files ? n.files[s] : undefined;
  if (!n || n.files) throw new Error("не файл: " + entry);
  const b = Buffer.alloc(n.size);
  fs.readSync(asar.fd, b, 0, n.size, asar.base + Number(n.offset));
  return b.toString("utf8");
}
function listPresets(asar) {
  let n = asar.header;
  for (const s of "dsh/node_modules/@deepseek-ai/dsh-web-app/presets".split("/")) n = n && n.files ? n.files[s] : undefined;
  if (!n || !n.files) return [];
  return Object.keys(n.files).filter((k) => k.endsWith(".patch.yml")).map((k) => k.replace(/\.patch\.yml$/, ""));
}
const indentOf = (l) => l.length - l.trimStart().length;

function presetEntry(id, src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp("^\\s*- id: preset-" + id + "\\s*$").test(l));
  if (start < 0) return null;
  const base = indentOf(lines[start]);
  const nameLine = lines.slice(start + 1, start + 4).find((l) => /^\s*name:/.test(l));
  if (!nameLine) return null;
  const name = nameLine.slice(nameLine.indexOf(":") + 1).trim();
  let cfgIdx = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*config:\s*$/.test(lines[i])) { cfgIdx = i; break; }
    if (lines[i].trim() && indentOf(lines[i]) <= base) break;
  }
  if (cfgIdx < 0) return null;
  const cfgIndent = indentOf(lines[cfgIdx]);
  const raw = [];
  for (let i = cfgIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { raw.push(""); continue; }
    if (indentOf(l) <= cfgIndent) break;
    raw.push(l);
  }
  const nonEmpty = raw.filter((l) => l.trim());
  if (!nonEmpty.length) return null;
  const min = Math.min(...nonEmpty.map(indentOf));
  const block = raw.map((l) => (l.trim() ? l.slice(min - 4) : ""));
  const cbIdx = block.findIndex((l) => /^\s*- id: compaction-basic\s*$/.test(l));
  if (cbIdx < 0) return null;
  let nameAt = -1;
  for (let i = cbIdx + 1; i < Math.min(cbIdx + 4, block.length); i++) {
    if (/^\s*name:/.test(block[i])) { nameAt = i; break; }
  }
  if (nameAt < 0) return null;
  const pad = " ".repeat(indentOf(block[nameAt]));
  block.splice(nameAt + 1, 0, pad + "config:", pad + "  thresholdRatio: " + ratio, pad + "  retainTokens: 60000");
  return ["- id: preset-" + id, "  name: " + name, "  config:", ...block].join("\n");
}

function upsert(text, id, entry) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => new RegExp("^- id: preset-" + id + "\\s*$").test(l));
  if (at < 0) return text.replace(/\s*$/, "") + "\n" + entry + "\n";
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) { end = i; break; }
  }
  while (end > at && !lines[end - 1].trim()) end--;
  return [...lines.slice(0, at), ...entry.split("\n"), "", ...lines.slice(end)].join("\n");
}

const asar = openAsar(asarPath);
const presetsDir = "dsh/node_modules/@deepseek-ai/dsh-web-app/presets";
const targets = presetArg ? [presetArg] : listPresets(asar);
let text = fs.readFileSync(patchPath, "utf8");
const rows = [];
for (const id of targets) {
  let src;
  try { src = readEntry(asar, presetsDir + "/" + id + ".patch.yml"); } catch { continue; }
  const entry = presetEntry(id, src);
  if (!entry) continue;
  const had = new RegExp("^- id: preset-" + id + "\\s*$", "m").test(text);
  text = upsert(text, id, entry);
  rows.push(id + "  " + (had ? "заменена" : "дописана") + "  (" + (entry.split("\n").length) + " строк)");
}
fs.closeSync(asar.fd);
if (!rows.length) {
  console.error("не нашёл ни одного пресета с compaction-basic");
  process.exit(1);
}

console.log("home:      " + home);
console.log("profile:   " + profile + "  (" + patchPath + ")");
console.log("W:         " + W);
console.log("N:         " + N);
console.log("ratio:     " + ratio);
console.log("retain:    60000");
console.log("asar:      " + asarPath);
console.log("пресеты:");
for (const r of rows) console.log("  " + r);

if (dry) {
  console.log("--- DRY, не записано ---");
  process.exit(0);
}

const backup = patchPath + ".bak-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
fs.copyFileSync(patchPath, backup);
fs.writeFileSync(patchPath, text);
console.log("backup:    " + backup);
console.log("written:   " + patchPath);
