// Compute the platform-specific `extraResources` entry for bundling
// mosh-client. Lives under scripts/ (eslint-ignored) so it can use
// Node CommonJS globals freely; consumed from electron-builder.config.cjs.
//
// Binaries are produced by .github/workflows/build-mosh-binaries.yml and
// downloaded into resources/mosh/<platform-arch>/ by
// scripts/fetch-mosh-binaries.cjs (gated on MOSH_BIN_RELEASE).
//
// We only emit the directive when the binary is actually on disk so that
// `npm run pack` keeps working without bundled mosh — for example, when
// the developer skipped the fetch step or the relevant arch hasn't been
// built yet.
const fs = require("node:fs");
const path = require("node:path");

function moshExtraResources(platform) {
  const moshRoot = path.resolve(process.cwd(), "resources", "mosh");
  if (!fs.existsSync(moshRoot)) return [];

  if (platform === "darwin") {
    const file = path.join(moshRoot, "darwin-universal", "mosh-client");
    if (!fs.existsSync(file)) return [];
    return [
      { from: "resources/mosh/darwin-universal/", to: "mosh/", filter: ["mosh-client"] },
    ];
  }

  if (platform === "linux" || platform === "win32") {
    // electron-builder substitutes ${arch} per build target. We don't
    // know which arch the upcoming build will run for here, so include
    // the directive whenever *any* matching arch is on disk and let
    // electron-builder expand `${arch}` at build time. If the arch
    // directory is missing for the target the build will fail loudly —
    // by design, shipping an installer without its mosh binary is
    // worse than a clear error.
    const prefix = platform === "win32" ? "win32-" : "linux-";
    const filter = platform === "win32" ? ["mosh-client.exe"] : ["mosh-client"];
    const anyArchDir = fs.readdirSync(moshRoot).some((d) => d.startsWith(prefix));
    if (!anyArchDir) return [];
    return [{ from: `resources/mosh/${prefix}\${arch}/`, to: "mosh/", filter }];
  }

  return [];
}

module.exports = { moshExtraResources };
