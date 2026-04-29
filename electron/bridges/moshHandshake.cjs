/**
 * Node-side replacement for the upstream Mosh Perl wrapper.
 *
 * The upstream `mosh` script is a tiny orchestrator: it execs `ssh` to
 * run `mosh-server new` on the remote host, scrapes the
 * "MOSH CONNECT <port> <key>" line from the SSH stream, then execs
 * `mosh-client` locally with that port/key. This module does the same
 * thing in JS so we no longer need a Perl interpreter on the user's
 * machine — and so we can drive a bundled, statically-linked
 * `mosh-client` even on Windows (which has no Perl wrapper).
 *
 * Flow (driven by terminalBridge.startMoshSession):
 *   1. spawn `ssh -t [-p port] [user@]host -- mosh-server new -s ...`
 *      inside a node-pty, sized to the renderer's cols/rows so password
 *      / 2FA prompts render natively.
 *   2. forward every byte from the ssh PTY to the renderer (parsing
 *      simultaneously via parseMoshConnect).
 *   3. when `MOSH CONNECT <port> <key>` is detected, kill the ssh PTY,
 *      spawn `mosh-client <ip> <port>` in a fresh node-pty with
 *      MOSH_KEY=<key> in the environment, and let the bridge swap that
 *      new PTY into the existing session.
 *
 * On every supported platform the module relies on the system `ssh`
 * binary for the SSH bootstrap (Windows 10 1809+ ships OpenSSH by
 * default, macOS / Linux have it everywhere). That keeps key / agent /
 * config handling identical to what the user already has working with
 * `ssh` — no need to reimplement OpenSSH features in this codebase.
 */

const path = require("node:path");

// MOSH CONNECT line format: "MOSH CONNECT <port> <base64-key>" followed by
// a CR or LF. We accept either separator and trim trailing junk because
// motds and shell prompts may share the same line buffer.
const MOSH_CONNECT_RE = /MOSH CONNECT (\d{1,5}) ([A-Za-z0-9+/]+={0,2})/;

/**
 * Parse a buffer of bytes from the SSH PTY for a MOSH CONNECT line.
 *
 * Returns { port: number, key: string, matchEndIndex: number } when the
 * marker is found, otherwise null. matchEndIndex is the byte offset
 * immediately after the matched line in the *current* chunk so callers
 * can tell what to strip from the renderer-visible stream (since the
 * line is internal protocol, not a user-visible prompt).
 *
 * The parser is deliberately stateless: callers should keep a small
 * trailing window (≤ 4096 bytes) of unmatched data so the marker isn't
 * lost when it spans chunk boundaries.
 */
function parseMoshConnect(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const m = MOSH_CONNECT_RE.exec(text);
  if (!m) return null;
  const port = Number(m[1]);
  const key = m[2];
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  // Decoded MOSH key is 16 bytes → base64 length 22 (no padding) or 24
  // (padded). Anything else is almost certainly a substring match in
  // unrelated remote output.
  if (key.length < 22 || key.length > 24) return null;
  return { port, key, matchEndIndex: m.index + m[0].length };
}

/**
 * Build the argv for the ssh bootstrap command.
 *
 *   ssh -t [-p port] [user@]host -- LC_ALL=... mosh-server new -s [...]
 *
 * `-t` allocates a remote TTY so password / 2FA prompts work; `--`
 * separates ssh's options from the remote command we want it to run.
 * The remote command runs `mosh-server new` and exits, with the magic
 * line emitted to stdout.
 *
 * @param {object} opts
 * @param {string} opts.host        — hostname or IP
 * @param {number} [opts.port]      — ssh port (omit for default 22)
 * @param {string} [opts.username]  — ssh user (defaults to ssh's choice)
 * @param {string} [opts.lang]      — LC_ALL override for mosh-server
 * @param {string} [opts.moshServer]— remote command (default "mosh-server new")
 * @param {string[]} [opts.sshArgs] — extra args passed to ssh (e.g. -i path)
 * @returns {{ command: string, args: string[] }}
 */
function buildSshHandshakeCommand(opts) {
  if (!opts || !opts.host) throw new Error("buildSshHandshakeCommand: host is required");
  // No -t / -tt by default: this command only runs `mosh-server new`
  // and immediately exits; mosh-server itself doesn't need a TTY for
  // the `new` subcommand (it prints MOSH CONNECT to stdout and forks
  // into the background). Forcing a TTY would require -tt and break
  // BatchMode-friendly stdout capture.
  const args = [];
  if (opts.port && Number(opts.port) !== 22) {
    args.push("-p", String(opts.port));
  }
  if (Array.isArray(opts.sshArgs)) {
    args.push(...opts.sshArgs);
  }
  const target = opts.username ? `${opts.username}@${opts.host}` : opts.host;
  args.push(target);
  args.push("--");
  // Quote the remote command minimally — ssh runs it through the
  // remote shell so simple "command arg arg" works without shell
  // metacharacters from us. mosh-server prints the magic CONNECT line
  // and otherwise stays silent.
  const lang = opts.lang || "en_US.UTF-8";
  const moshServer = opts.moshServer || "mosh-server new -s";
  args.push(`LC_ALL=${lang} ${moshServer}`);
  return { command: "ssh", args };
}

/**
 * Build the argv for the local mosh-client invocation once the
 * handshake produced an ip + port + key.
 *
 *   mosh-client <ip> <port>     (with MOSH_KEY in env)
 *
 * `mosh-server` listens on UDP at the IP/port pair it announced. By
 * convention, the IP is derived from the "MOSH IP" line emitted before
 * MOSH CONNECT, but most servers omit it and the client just uses the
 * SSH-resolved hostname / IP. We default to the original hostname when
 * no MOSH IP override is available.
 */
function buildMoshClientCommand({ moshClientPath, host, port }) {
  if (!moshClientPath) throw new Error("buildMoshClientCommand: moshClientPath is required");
  if (!host) throw new Error("buildMoshClientCommand: host is required");
  if (!port || port <= 0) throw new Error("buildMoshClientCommand: port must be > 0");
  return { command: moshClientPath, args: [host, String(port)] };
}

/**
 * Lightweight stream sniffer: hands chunks in, emits MOSH CONNECT
 * details + the byte ranges that should be hidden from the user-
 * visible stream.
 *
 * Usage:
 *   const sniffer = createMoshConnectSniffer();
 *   for each chunk: const { visible, parsed } = sniffer.feed(chunk);
 *     send `visible` to renderer; if `parsed`, switch to mosh-client.
 *
 * Once a parse hits, every subsequent chunk passes through unchanged
 * (defensive: the bridge will tear down the SSH PTY immediately after
 * the parse so further chunks are unlikely, but we don't want to leak
 * partial copies of MOSH CONNECT lines if we somehow get more bytes).
 *
 * The sniffer keeps a trailing window of unmatched bytes (RING_SIZE) so
 * it can detect MOSH CONNECT spanning chunk boundaries.
 */
function createMoshConnectSniffer() {
  const RING_SIZE = 4096;
  let pending = "";
  let parsed = null;

  return {
    feed(chunk) {
      if (parsed) return { visible: chunk, parsed: null };

      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      pending += text;

      const m = MOSH_CONNECT_RE.exec(pending);
      if (!m) {
        // Trim the ring buffer to RING_SIZE.
        if (pending.length > RING_SIZE) {
          pending = pending.slice(pending.length - RING_SIZE);
        }
        return { visible: chunk, parsed: null };
      }

      // Found the marker. Only suppress the bytes from this chunk that
      // overlap the matched line — earlier chunks already shipped to
      // the renderer; the user has likely seen the start of the line
      // already, but mosh-server typically prints CONNECT after the
      // shell-startup lines so the leakage is cosmetic.
      const port = Number(m[1]);
      const key = m[2];
      parsed = { port, key };

      // For the visible passthrough of the *current* chunk: strip the
      // MOSH CONNECT line itself (if it appears in this chunk) so the
      // user doesn't see internal protocol noise.
      const visibleText = text.replace(MOSH_CONNECT_RE, "").replace(/\r?\n\r?\n/g, "\n");
      const visible = Buffer.isBuffer(chunk) ? Buffer.from(visibleText, "utf8") : visibleText;

      pending = "";
      return { visible, parsed };
    },
    isParsed() { return parsed !== null; },
  };
}

/**
 * Assemble the env that `mosh-client` will see. MOSH_KEY is the secret
 * shared with mosh-server, and we preserve TERM + LANG so the local
 * terminfo lookups pick the right entry.
 */
function buildMoshClientEnv({ baseEnv, key, lang }) {
  const env = { ...(baseEnv || {}), MOSH_KEY: key };
  if (lang && !env.LANG) env.LANG = lang;
  if (!env.TERM) env.TERM = "xterm-256color";
  return env;
}

/**
 * Resolve the absolute path of the system `ssh` binary. On Windows we
 * try the in-box OpenSSH location first because PATH may not list
 * it inside the Electron child env.
 */
function resolveSshExecutable({ findExecutable, fileExists, platform = process.platform }) {
  const fromPath = findExecutable("ssh");
  if (fromPath && fromPath !== "ssh" && fileExists(fromPath)) return fromPath;
  if (platform === "win32") {
    const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    // Build with the win32-flavored path module so the result is
    // back-slash-joined regardless of the host platform we're running
    // the lookup from (relevant for cross-platform unit tests).
    const inbox = path.win32.join(sysRoot, "System32", "OpenSSH", "ssh.exe");
    if (fileExists(inbox)) return inbox;
  }
  return null;
}

module.exports = {
  parseMoshConnect,
  buildSshHandshakeCommand,
  buildMoshClientCommand,
  createMoshConnectSniffer,
  buildMoshClientEnv,
  resolveSshExecutable,
};
