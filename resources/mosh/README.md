# Bundled `mosh-client`

This directory holds the static, network-protocol-only `mosh-client`
binary bundled with the Netcatty installer. The wrapper logic that
drives `ssh` + `mosh-server` bootstrap remains the system `mosh` Perl
wrapper for now; the bundled `mosh-client` is wired in via
`MOSH_CLIENT=<bundled path>` (see `electron/bridges/terminalBridge.cjs`).

## How binaries land here

1. `.github/workflows/build-mosh-binaries.yml` builds `mosh-client` on a
   `workflow_dispatch` or `mosh-bin-*` tag push. It uses
   `scripts/build-mosh/build-linux.sh`, `…/build-macos.sh`, and
   `…/fetch-windows.sh` to produce one binary per target:

   | target            | provenance                                          |
   |-------------------|-----------------------------------------------------|
   | `linux-x64`       | upstream `mobile-shell/mosh` source, manylinux2014  |
   | `linux-arm64`     | upstream `mobile-shell/mosh` source, manylinux2014  |
   | `darwin-universal`| upstream source, lipo arm64 + x86_64, macOS ≥ 11    |
   | `win32-x64`       | (Phase 1) pinned `felixse/FluentTerminal` mosh-cygwin |

2. The release built by that workflow gets a tag like
   `mosh-bin-1.4.0-1`, with `SHA256SUMS` attached.

3. During `npm run pack`, set `MOSH_BIN_RELEASE=mosh-bin-1.4.0-1`
   (and run `npm run fetch:mosh`) to pull the binaries into
   `resources/mosh/<platform-arch>/`. `electron-builder.config.cjs`
   then copies the matching one into `Resources/mosh/mosh-client[.exe]`.

The directory is otherwise empty (binaries are gitignored).

## Licenses

- Mosh itself is licensed under **GPL-3.0**
  (https://github.com/mobile-shell/mosh).
- Netcatty is **GPL-3.0**, so redistribution as part of the installer
  is permitted.
- For the Phase-1 Windows binary, the upstream is
  https://github.com/felixse/FluentTerminal commit `bad0f85`, also
  GPL-3.0. Source for that build is available from
  https://github.com/mobile-shell/mosh @ tag `mosh-1.3.2`.
- Static deps (OpenSSL Apache-2.0, protobuf BSD-3-Clause, ncurses MIT)
  are compatible with GPL-3.0 when statically linked.

## Reproducible build

To reproduce the binaries locally:

```sh
docker run --rm -v $PWD:/workspace -w /workspace \
  -e MOSH_REF=mosh-1.4.0 -e ARCH=x64 -e OUT_DIR=/workspace/out \
  quay.io/pypa/manylinux2014_x86_64 \
  bash scripts/build-mosh/build-linux.sh
```

For macOS the build needs an Xcode toolchain; see
`scripts/build-mosh/build-macos.sh`.

## Phase 2 — done in this PR

- `electron/bridges/moshHandshake.cjs` reimplements the upstream Mosh
  Perl wrapper in Node: spawn `ssh [user@]host -- mosh-server new`,
  parse `MOSH CONNECT <port> <key>`, then spawn `mosh-client` locally
  with `MOSH_KEY` in env. No Perl required.
- `terminalBridge.startMoshSession` prefers this path whenever a bare
  `mosh-client` (bundled or system) and `ssh` (in-box on Windows 10
  1809+, system everywhere else) are both detectable. The legacy path
  through the system `mosh` Perl wrapper is preserved as a fallback.
- Auth is delegated to system `ssh` — keys, agent, ssh_config, and
  known_hosts all keep working transparently. Password / 2FA prompts
  require an interactive controlling TTY which the bootstrap does not
  provide; users with those flows should keep using the legacy path
  (system `mosh` wrapper) until a dedicated UI lands.

## Roadmap

- Replace the FluentTerminal-pinned Windows binary with an in-CI
  Cygwin static build from upstream `mobile-shell/mosh` source so
  Netcatty owns the provenance end-to-end.
- Add password / 2FA prompt UI for the Phase-2 handshake so users
  without key auth can drop the system `mosh` wrapper requirement.
