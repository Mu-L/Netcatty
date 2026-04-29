#!/usr/bin/env node
/* eslint-disable no-console */
//
// Download platform-specific mosh-client binaries built by the
// `build-mosh-binaries` GitHub Actions workflow into resources/mosh/, so
// electron-builder can bundle them via `extraResources`. Designed to be
// idempotent and safe to skip in dev / CI matrix legs that don't ship
// mosh (e.g. when MOSH_BIN_RELEASE is unset).
//
// Usage:
//   node scripts/fetch-mosh-binaries.cjs                # all platforms
//   node scripts/fetch-mosh-binaries.cjs --platform=darwin --arch=universal
//
// Env knobs:
//   MOSH_BIN_RELEASE  — release tag in ${MOSH_BIN_OWNER}/${MOSH_BIN_REPO}.
//                       Skip the whole step if unset (printed as a notice
//                       so the build doesn't silently miss the bundling).
//   MOSH_BIN_OWNER    — default 'binaricat'
//   MOSH_BIN_REPO     — default 'Netcatty' (binaries attached to a
//                       dedicated tag in the netcatty repo to keep
//                       provenance auditable).
//   MOSH_BIN_BASE_URL — full override (e.g. for staging / local mirror).
//
// Network failures or SHA256 mismatches are fatal in CI (when
// CI=true) and warnings locally — local devs can build without bundled
// mosh and still get a working app for non-Windows platforms.
//

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const RES_DIR = path.join(ROOT, "resources", "mosh");

// (file basename in the release ⟶ relative subpath under resources/mosh/)
// Using flat names in the release for SHA256SUMS readability, then
// fanning out into platform-arch subdirs locally.
//
// `extract` indicates a tar.gz archive containing the binary + helper
// DLLs (Windows). The tarball is unpacked into the platform-arch
// directory so resources/mosh/win32-x64/ ends up with mosh-client.exe
// alongside cygwin1.dll, cygcrypto-*.dll, etc.
const TARGETS = [
  { platform: "linux",  arch: "x64",        file: "mosh-client-linux-x64",          local: "linux-x64/mosh-client" },
  { platform: "linux",  arch: "arm64",      file: "mosh-client-linux-arm64",        local: "linux-arm64/mosh-client" },
  { platform: "darwin", arch: "universal",  file: "mosh-client-darwin-universal",   local: "darwin-universal/mosh-client" },
  { platform: "win32",  arch: "x64",        file: "mosh-client-win32-x64.tar.gz",   localDir: "win32-x64", extract: "tar.gz" },
];

const release = process.env.MOSH_BIN_RELEASE;
if (!release) {
  console.log("[fetch-mosh-binaries] MOSH_BIN_RELEASE is unset — skipping. " +
    "Set it (e.g. mosh-bin-1.4.0-1) to bundle mosh-client into the package.");
  process.exit(0);
}

const owner = process.env.MOSH_BIN_OWNER || "binaricat";
const repo  = process.env.MOSH_BIN_REPO  || "Netcatty";
const baseUrl = process.env.MOSH_BIN_BASE_URL ||
  `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(release)}`;

const args = process.argv.slice(2);
const platformFilter = (args.find((a) => a.startsWith("--platform=")) || "").split("=")[1];
const archFilter     = (args.find((a) => a.startsWith("--arch="))     || "").split("=")[1];
const failHard = process.env.CI === "true";

function log(msg)  { console.log(`[fetch-mosh-binaries] ${msg}`); }
function warn(msg) { console.warn(`[fetch-mosh-binaries] WARN ${msg}`); }
function die(msg)  {
  if (failHard) {
    console.error(`[fetch-mosh-binaries] FATAL ${msg}`);
    process.exit(1);
  }
  warn(msg);
}

function follow(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("too many redirects"));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(follow(new URL(res.headers.location, url).toString(), depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchSums() {
  // Fail-soft on missing SHA256SUMS in unusual mirrors — CI runs hit the
  // canonical release and always have it.
  try {
    const buf = await follow(`${baseUrl}/SHA256SUMS`);
    const map = new Map();
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{64})\s+\*?\s*(\S+)\s*$/i);
      if (m) map.set(m[2], m[1].toLowerCase());
    }
    return map;
  } catch (err) {
    die(`could not fetch SHA256SUMS from ${baseUrl} (${err.message})`);
    return new Map();
  }
}

async function fetchOne(target, sums) {
  const url = `${baseUrl}/${target.file}`;
  let buf;
  try {
    buf = await follow(url);
  } catch (err) {
    die(`download failed for ${target.file}: ${err.message}`);
    return false;
  }

  const expected = sums.get(target.file);
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (expected && expected !== actual) {
    die(`SHA256 mismatch for ${target.file}: expected ${expected}, got ${actual}`);
    return false;
  }
  if (!expected) {
    warn(`no SHA256 entry for ${target.file} — accepting actual ${actual}`);
  }

  if (target.extract === "tar.gz") {
    const destDir = path.join(RES_DIR, target.localDir);
    fs.mkdirSync(destDir, { recursive: true });
    // Use the system `tar` to unpack — it ships on macOS, Linux, and
    // Windows 10 1803+. Avoids pulling in a Node tar dependency just
    // for the prebuild step.
    const { execFileSync } = require("node:child_process");
    const tmp = path.join(destDir, ".__mosh_bundle.tar.gz");
    fs.writeFileSync(tmp, buf);
    try {
      execFileSync("tar", ["-xzf", tmp, "-C", destDir], { stdio: "inherit" });
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    // Mark unpacked .exe / DLLs executable on POSIX (no-op on Win).
    if (process.platform !== "win32") {
      const exe = path.join(destDir, "mosh-client.exe");
      if (fs.existsSync(exe)) {
        try { fs.chmodSync(exe, 0o755); } catch { /* ignore */ }
      }
    }
    log(`unpacked ${target.file} into ${path.relative(ROOT, destDir)}/ (sha256=${actual})`);
    return true;
  }

  const dest = path.join(RES_DIR, target.local);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  if (target.platform !== "win32") {
    fs.chmodSync(dest, 0o755);
  }
  log(`wrote ${path.relative(ROOT, dest)} (${buf.length} bytes, sha256=${actual})`);
  return true;
}

(async () => {
  log(`release=${release} owner=${owner} repo=${repo}`);
  const sums = await fetchSums();
  let ok = 0, total = 0;
  for (const t of TARGETS) {
    if (platformFilter && t.platform !== platformFilter) continue;
    if (archFilter && t.arch !== archFilter) continue;
    total += 1;
    if (await fetchOne(t, sums)) ok += 1;
  }
  log(`done — ${ok}/${total} binaries written`);
  if (failHard && ok < total) process.exit(1);
})();
