#!/usr/bin/env node
// qcheck: runs tests, lint and typecheck and prints only what Claude needs to act on.
// The full output is kept in a log file (inside .git/qcheck) so it can be grepped on demand.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const USAGE = `qcheck: tests, lint y typecheck con salida compacta

Uso:
  qcheck test  [opciones] [-- args para vitest/jest]
  qcheck e2e   [opciones] [-- args para playwright test]
  qcheck lint  [opciones] [-- archivos o args para eslint]   (por defecto: .)
  qcheck types [opciones] [-- args para tsc]
  qcheck all   [opciones]                                     (lint + types + test)
  qcheck run   [--until <regex>] [--timeout <s>] -- <comando> (igual que qrun)
  qcheck hook                                                 (PostToolUse de Claude Code; lee JSON por stdin)
  qcheck guard                                                (PreToolUse de Claude Code; lee JSON por stdin)

Opciones:
  --baseline     Si hay fallos, compara con la rama base (git worktree, cacheado por commit)
  --base <ref>   Rama base (por defecto: la rama de la que salió la actual, según el reflog;
                 si no se sabe, develop o dev)
  --max <n>      Máximo de fallos a mostrar en detalle (por defecto: 10)
  --timeout <s>  Corta el check (y todos sus procesos) si tarda más (por defecto: 540, o QCHECK_TIMEOUT)

Salida: una línea por check si pasa; si falla, solo los errores y la ruta del log completo.
Código de salida: 0 si todo pasa (o, con --baseline, si no hay fallos nuevos); 1 si no.`;

const RUN_USAGE = `qrun: corre cualquier comando y muestra solo el resultado o los errores

Uso:
  qrun [--until <regex>] [--timeout <s>] [--] <comando...>

  qrun -- pnpm build
  qrun -- "docker compose build && docker compose up -d"
  qrun --until "listening on|ready in" --timeout 60 -- pnpm dev

--until    Para procesos que no terminan (dev servers): espera a que una línea coincida, lo detiene y reporta.
--timeout  Segundos máximos (por defecto: sin límite; con --until, 120).

Salida: ✓ y la última línea si sale bien; si falla, las líneas con errores (con contexto) y el final del log.
El log completo queda en .git/qcheck/run-<comando>.log.`;

const CODE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
const MESSAGE_LINES = 12;
const ANSI = /\x1b\[[0-9;]*m/g;
const NOISE_FRAME = /node_modules|node:internal|\(node:|<anonymous>/;
const HANG_GRACE_MS = 10_000;
const DEFAULT_TIMEOUT_S = 540; // below Claude Code's 10-minute Bash limit, so qcheck reports the timeout itself

// ---------- helpers ----------

// ---------- child processes ----------
// Every child runs in its own process group so the whole tree (jest/vitest workers, dev servers)
// can be stopped together: on timeout, when a runner hangs, and when qcheck itself is interrupted
// (e.g. Claude Code's Bash timeout). Without this, workers outlive qcheck and keep their memory.

const running = new Set();

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(signal, () => {
    for (const pid of running) killGroup(pid, "SIGKILL");
    process.exit(code);
  });
}
process.on("exit", () => {
  for (const pid of running) killGroup(pid, "SIGKILL");
});

function cleanOutput(text) {
  // progress bars rewrite the line with \r; keep only what was finally shown
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n");
}

// Options:
//   timeoutMs   stop the group after this long (result.timedOut)
//   until       regex; stop the group as soon as a line matches (result.matched)
//   reportFile  test runners write it when the run is over; if the process is still alive
//               HANG_GRACE_MS later, it's stuck on open handles (DB connections, servers, timers)
//               and gets stopped (result.hung) — the report is still valid
//   keepStragglers  don't kill leftover processes of the group after a normal exit (qrun)
function exec(cmd, args, { cwd, env = {}, timeoutMs = 0, until = null, reportFile = null, keepStragglers = false } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env },
    });
    let out = "";
    let pending = "";
    let matched = null;
    let stopReason = null;
    let killTimer = null;
    let finished = false;
    if (child.pid) {
      running.add(child.pid);
      // Signal handlers can't run on SIGKILL. This tiny shell watchdog (also detached) stops the group
      // if qcheck dies while the command is still running; it exits on its own otherwise.
      const leader = child.pid;
      spawn(
        "sh",
        ["-c", `while kill -0 ${process.pid} 2>/dev/null && kill -0 ${leader} 2>/dev/null; do sleep 1; done; kill -0 ${process.pid} 2>/dev/null || kill -KILL -- -${leader} 2>/dev/null`],
        { detached: true, stdio: "ignore" },
      ).unref();
    }

    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 5000);
    };
    const onData = (chunk) => {
      out += chunk;
      if (!until || matched) return;
      const lines = (pending + chunk).replace(ANSI, "").split(/\r?\n/);
      pending = lines.pop();
      matched = lines.find((line) => until.test(line)) ?? null;
      if (matched) stop("matched");
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", onData);

    const timer = timeoutMs ? setTimeout(() => stop("timeout"), timeoutMs) : null;
    let reportSeenAt = 0;
    const poll = reportFile
      ? setInterval(() => {
          if (!existsSync(reportFile)) return;
          reportSeenAt ||= Date.now();
          if (Date.now() - reportSeenAt > HANG_GRACE_MS) stop("hung");
        }, 1000)
      : null;

    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(poll);
      if (child.pid) {
        if (stopReason || !keepStragglers) killGroup(child.pid, "SIGKILL");
        running.delete(child.pid);
      }
      done({
        code: code ?? 1,
        out: cleanOutput(out),
        matched: matched?.trim() ?? null,
        timedOut: stopReason === "timeout",
        hung: stopReason === "hung",
      });
    };
    child.on("error", (error) => {
      out += `\n${error.message}`;
      if (!child.pid) finish(1);
    });
    child.on("close", finish);
  });
}

// Explains a check that had to be stopped. Returns null when it ended on its own.
function stoppedNote(result, ctx, tool) {
  const hints = {
    jest: "Para ver qué queda abierto: `-- --detectOpenHandles`.",
    vitest: "Para ver qué queda abierto: `-- --reporter=hanging-process`.",
  };
  if (result.hung) {
    return `${tool} terminó pero no salía (handles abiertos: DB, servidores, timers); se detuvo. ${hints[tool] ?? ""}`.trim();
  }
  if (result.timedOut) {
    return `${tool} no terminó en ${ctx.timeoutMs / 1000}s; se detuvo junto con sus procesos. Si es lento, usá --timeout <s>; si se colgó, revisá el log. ${hints[tool] ?? ""}`.trim();
  }
  return null;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findUp(name, from) {
  let dir = resolve(from);
  while (true) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findBin(name, cwd) {
  return findUp(join("node_modules", ".bin", name), cwd);
}

function stateDir(cwd) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  const dir = common ? join(common, "qcheck") : join(tmpdir(), "qcheck");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function projectRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd) ?? resolve(cwd);
}

function readDeps(cwd) {
  const pkgPath = findUp("package.json", cwd);
  if (!pkgPath) return { deps: new Set(), scripts: {}, dir: cwd };
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return {
    deps: new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]),
    scripts: pkg.scripts ?? {},
    dir: dirname(pkgPath),
  };
}

function packageManager(cwd) {
  if (findUp("pnpm-lock.yaml", cwd)) return "pnpm";
  if (findUp("yarn.lock", cwd)) return "yarn";
  return "npm";
}

function trimMessage(message, root = "") {
  const lines = (root ? message.split(`${root}/`).join("") : message)
    .replace(ANSI, "")
    .split("\n")
    .filter((line) => line.trim() && !(line.trim().startsWith("at ") && NOISE_FRAME.test(line)));
  const shown = lines.slice(0, MESSAGE_LINES);
  if (lines.length > MESSAGE_LINES) shown.push(`… (+${lines.length - MESSAGE_LINES} líneas)`);
  return shown.map((line) => `    ${line.trimEnd()}`).join("\n");
}

function tail(text, count, root) {
  return trimMessage(text.split("\n").slice(-count).join("\n"), root);
}

function shortPath(path, cwd) {
  const rel = relative(cwd, path);
  return rel.length < path.length ? rel : path;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function saveLog(dir, prefix, kind, out) {
  const path = join(dir, `${prefix}last-${kind}.log`);
  writeFileSync(path, out);
  return path;
}

// Each check returns { kind, ok, skipped?, crashed?, headline, failures: [{ id, title, detail }], log }

// ---------- tests (vitest / jest) ----------

async function checkTest(ctx) {
  const { cwd, extra, dir, prefix, root } = ctx;
  const { deps, scripts, dir: pkgDir } = readDeps(cwd);
  const report = join(dir, `${prefix}report-test.json`);
  rmSync(report, { force: true });

  let bin;
  let args;
  let tool;
  if (deps.has("vitest") && (bin = findBin("vitest", cwd))) {
    tool = "vitest";
    args = ["run", "--reporter=json", `--outputFile=${report}`, ...extra];
  } else if (deps.has("jest") && (bin = findBin("jest", cwd))) {
    tool = "jest";
    args = ["--json", `--outputFile=${report}`, ...extra];
  } else if (scripts.test) {
    return checkGeneric(ctx, "test", pkgDir);
  } else {
    return { kind: "test", ok: true, skipped: true, headline: "sin vitest, jest ni script test", failures: [] };
  }

  const started = Date.now();
  const result = await exec(bin, args, { cwd, timeoutMs: ctx.timeoutMs, reportFile: report });
  const elapsed = seconds(Date.now() - started);
  const log = saveLog(dir, prefix, "test", result.out);
  const note = stoppedNote(result, ctx, tool);

  if (!existsSync(report)) {
    return {
      kind: "test", ok: false, crashed: true, log, failures: [],
      headline: note ?? `el runner terminó sin reporte (código ${result.code})`,
      detail: tail(result.out, 30, ctx.root),
    };
  }

  const data = JSON.parse(readFileSync(report, "utf8"));
  const failures = [];
  for (const suite of data.testResults ?? []) {
    const file = relative(root, suite.name);
    const failed = (suite.assertionResults ?? []).filter((test) => test.status === "failed");
    for (const test of failed) {
      const name = test.fullName || [...(test.ancestorTitles ?? []), test.title].join(" ");
      failures.push({ id: `${file} > ${name}`, title: `${file} > ${name}`, detail: trimMessage((test.failureMessages ?? []).join("\n"), root) });
    }
    if (!failed.length && suite.status === "failed") {
      failures.push({ id: `${file} > (suite)`, title: `${file} (no se pudo ejecutar el archivo)`, detail: trimMessage(suite.message ?? "", root) });
    }
  }

  const passed = data.numPassedTests ?? 0;
  const skipped = (data.numPendingTests ?? 0) + (data.numTodoTests ?? 0);
  const ok = failures.length === 0 && (result.code === 0 || result.hung);
  const parts = [`${passed} pasaron`];
  if (failures.length) parts.unshift(`${failures.length} fallaron`);
  if (skipped) parts.push(`${skipped} omitidos`);
  parts.push(elapsed);
  if (!ok && !failures.length) {
    return { kind: "test", ok: false, crashed: true, log, failures, headline: note ?? `código ${result.code} sin tests fallidos`, detail: tail(result.out, 30, ctx.root) };
  }
  return { kind: "test", ok, log, failures, headline: parts.join(" · "), note };
}

// ---------- e2e (playwright) ----------

async function checkE2e(ctx) {
  const { cwd, extra, dir, prefix, root } = ctx;
  const bin = readDeps(cwd).deps.has("@playwright/test") && findBin("playwright", cwd);
  if (!bin) return { kind: "e2e", ok: true, skipped: true, headline: "sin @playwright/test", failures: [] };

  const report = join(dir, `${prefix}report-e2e.json`);
  rmSync(report, { force: true });
  const started = Date.now();
  const result = await exec(bin, ["test", "--reporter=json", ...extra], {
    cwd,
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: report },
    timeoutMs: ctx.timeoutMs,
    reportFile: report,
  });
  const elapsed = seconds(Date.now() - started);
  const log = saveLog(dir, prefix, "e2e", result.out);
  const note = stoppedNote(result, ctx, "playwright");
  if (!existsSync(report)) {
    return { kind: "e2e", ok: false, crashed: true, log, failures: [], headline: note ?? `playwright terminó sin reporte (código ${result.code})`, detail: tail(result.out, 30, root) };
  }

  const data = JSON.parse(readFileSync(report, "utf8"));
  const testDir = data.config?.rootDir ?? cwd;
  const failures = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== "unexpected") continue;
        const file = relative(root, resolve(testDir, spec.file));
        const name = [...titles, spec.title].join(" > ");
        const project = test.projectName ? ` [${test.projectName}]` : "";
        const last = test.results?.at(-1);
        const message = (last?.errors ?? [last?.error]).filter(Boolean).map((error) => error.message ?? "").join("\n");
        failures.push({ id: `${file} > ${name}${project}`, title: `${file}:${spec.line} > ${name}${project}`, detail: trimMessage(message, root) });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // top-level suites are files; their title is the file name, already shown in the path
  for (const fileSuite of data.suites ?? []) walk(fileSuite, []);

  const globalErrors = (data.errors ?? []).map((error) => error.message ?? "").join("\n");
  if (!failures.length && ((result.code !== 0 && !result.hung) || globalErrors)) {
    return { kind: "e2e", ok: false, crashed: true, log, failures, headline: `código ${result.code} sin tests fallidos`, detail: trimMessage(globalErrors || result.out.split("\n").slice(-30).join("\n"), root) };
  }
  const stats = data.stats ?? {};
  const parts = [`${stats.expected ?? 0} pasaron`];
  if (failures.length) parts.unshift(`${failures.length} fallaron`);
  if (stats.flaky) parts.push(`${stats.flaky} flaky`);
  if (stats.skipped) parts.push(`${stats.skipped} omitidos`);
  parts.push(elapsed);
  return { kind: "e2e", ok: failures.length === 0, log, failures, headline: parts.join(" · "), note };
}

// ---------- lint (eslint) ----------

async function checkLint(ctx) {
  const { cwd, extra, dir, prefix, root } = ctx;
  const bin = findBin("eslint", cwd);
  if (!bin) return { kind: "lint", ok: true, skipped: true, headline: "eslint no está instalado", failures: [] };

  const report = join(dir, `${prefix}report-lint.json`);
  rmSync(report, { force: true });
  const targets = extra.length ? extra : ["."];
  const result = await exec(bin, ["--format", "json", "--output-file", report, ...targets], { cwd, timeoutMs: ctx.timeoutMs });
  const log = saveLog(dir, prefix, "lint", result.out);

  if (!existsSync(report)) {
    return { kind: "lint", ok: false, crashed: true, log, failures: [], headline: stoppedNote(result, ctx, "eslint") ?? `eslint falló (código ${result.code})`, detail: tail(result.out, 30, ctx.root) };
  }

  const files = JSON.parse(readFileSync(report, "utf8"));
  const failures = [];
  let warnings = 0;
  for (const file of files) {
    const path = relative(root, file.filePath);
    for (const message of file.messages) {
      if (message.severity < 2) {
        if (message.ruleId) warnings += 1;
        continue;
      }
      const rule = message.ruleId ?? "parse";
      failures.push({
        id: `${path} | ${rule} | ${message.message}`,
        group: `${rule}: ${message.message}`,
        where: `${path}:${message.line ?? 0}`,
        title: `${path}:${message.line ?? 0} ${rule}: ${message.message}`,
      });
    }
  }
  const fileCount = new Set(failures.map((failure) => failure.where.split(":")[0])).size;
  const headline = failures.length
    ? `${failures.length} errores en ${fileCount} archivos${warnings ? ` (${warnings} warnings)` : ""}`
    : `sin errores${warnings ? ` (${warnings} warnings)` : ""}`;
  return { kind: "lint", ok: failures.length === 0, log, failures, headline, grouped: true };
}

// ---------- typecheck (tsc) ----------

function parseTsc(output, cwd, root) {
  const failures = [];
  let current = null;
  for (const line of output.split("\n")) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (match) {
      const [, file, row, , code, message] = match;
      const path = relative(root, resolve(cwd, file));
      current = { id: `${path} | ${code} | ${message}`, group: `${code}: ${message}`, where: `${path}:${row}`, title: `${path}:${row} ${code}: ${message}`, extra: [] };
      failures.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.extra.push(line.trim());
    } else {
      current = null;
    }
  }
  for (const failure of failures) {
    if (failure.extra.length) failure.detail = trimMessage(failure.extra.join("\n"));
  }
  return failures;
}

async function checkTypes(ctx) {
  const { cwd, extra, dir, prefix, root } = ctx;
  const bin = findBin("tsc", cwd);
  if (!bin || !findUp("tsconfig.json", cwd)) {
    return { kind: "types", ok: true, skipped: true, headline: "sin typescript o tsconfig.json", failures: [] };
  }
  const started = Date.now();
  const result = await exec(bin, ["--noEmit", "--pretty", "false", ...extra], { cwd, timeoutMs: ctx.timeoutMs });
  const log = saveLog(dir, prefix, "types", result.out);
  const failures = parseTsc(result.out, cwd, root);
  if (result.timedOut) {
    return { kind: "types", ok: false, crashed: true, log, failures: [], headline: stoppedNote(result, ctx, "tsc"), detail: tail(result.out, 10, ctx.root) };
  }
  if (result.code !== 0 && !failures.length) {
    return { kind: "types", ok: false, crashed: true, log, failures, headline: `tsc falló (código ${result.code})`, detail: tail(result.out, 30, ctx.root) };
  }
  const headline = failures.length ? `${failures.length} errores` : `sin errores · ${seconds(Date.now() - started)}`;
  return { kind: "types", ok: failures.length === 0, log, failures, headline };
}

// ---------- fallback: package.json "test" script ----------

async function checkGeneric(ctx, kind, pkgDir) {
  const { dir, prefix, extra } = ctx;
  const pm = packageManager(pkgDir);
  const started = Date.now();
  const result = await exec(pm, ["run", kind, ...(extra.length ? ["--", ...extra] : [])], { cwd: pkgDir, timeoutMs: ctx.timeoutMs });
  const log = saveLog(dir, prefix, kind, result.out);
  if (result.timedOut) {
    return { kind, ok: false, crashed: true, log, failures: [], headline: stoppedNote(result, ctx, `${pm} run ${kind}`), detail: tail(result.out, 30, ctx.root) };
  }
  if (result.code === 0) return { kind, ok: true, log, failures: [], headline: `${pm} run ${kind} ok · ${seconds(Date.now() - started)}` };
  return {
    kind, ok: false, crashed: true, generic: true, log, failures: [],
    headline: `${pm} run ${kind} falló (código ${result.code}); runner no reconocido, se muestran las últimas líneas`,
    detail: tail(result.out, 40, ctx.root),
  };
}

const CHECKS = { test: checkTest, e2e: checkE2e, lint: checkLint, types: checkTypes };

// ---------- baseline (git worktree, cached per merge-base commit) ----------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Git doesn't store which branch a branch was created from; the local reflog is the only record.
// It's missing for branches checked out from the remote and expires after ~90 days.
function parentFromReflog(cwd) {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  if (!branch) return null;
  const branchLog = git(["reflog", "show", "--format=%gs", `refs/heads/${branch}`, "--"], cwd)?.split("\n") ?? [];
  let parent = branchLog.at(-1)?.match(/^branch: Created from (.+)$/)?.[1];
  if (!parent || parent === "HEAD") {
    // `git switch -c` / `checkout -b` record "Created from HEAD"; the HEAD reflog has the branch we were on
    const moveInto = new RegExp(`^checkout: moving from (.+) to ${escapeRegex(branch)}$`);
    const headLog = git(["reflog", "show", "--format=%gs", "HEAD", "--"], cwd)?.split("\n") ?? [];
    parent = headLog.map((line) => line.match(moveInto)?.[1]).filter(Boolean).at(-1);
  }
  const upstream = git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd);
  if (!parent || parent === branch || parent === upstream || parent === `origin/${branch}`) return null;
  return git(["rev-parse", "--verify", "--quiet", parent], cwd) ? parent : null;
}

// Without a recorded parent, compare against the integration branch, never main.
function defaultBase(cwd) {
  const parent = parentFromReflog(cwd);
  if (parent) return { ref: parent, source: "rama de origen" };
  for (const branch of ["develop", "dev"]) {
    for (const candidate of [`origin/${branch}`, branch]) {
      if (git(["rev-parse", "--verify", "--quiet", candidate], cwd)) return { ref: candidate, source: "por defecto" };
    }
  }
  return null;
}

async function installDeps(worktree, dir, timeoutMs) {
  const pm = packageManager(worktree);
  const args = {
    pnpm: ["install", "--frozen-lockfile", "--prefer-offline"],
    yarn: ["install", "--frozen-lockfile"],
    npm: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
  }[pm];
  const result = await exec(pm, args, { cwd: worktree, timeoutMs });
  saveLog(dir, "base-", "install", result.out);
  if (result.timedOut) return false;
  // pnpm >= 10 exits non-zero when it skips unapproved build scripts even though node_modules is complete
  return result.code === 0 || existsSync(join(worktree, "node_modules", ".modules.yaml"));
}

function prepareBase(ctx, baseRef) {
  if (ctx.base) return ctx.base;
  const { cwd, dir, root } = ctx;
  const { ref, source } = baseRef ? { ref: baseRef, source: "--base" } : defaultBase(cwd) ?? {};
  const sha = ref && git(["merge-base", "HEAD", ref], cwd);
  if (!ref) ctx.base = { error: "no se sabe de qué rama salió esta y no hay develop ni dev; usa --base <ref>" };
  else if (!sha) ctx.base = { error: `no se pudo calcular merge-base con ${ref}` };
  else ctx.base = { ref, sha, label: `${ref} @ ${sha.slice(0, 7)} (${source})`, worktree: join(dir, "worktrees", sha.slice(0, 12)) };
  return ctx.base;
}

async function ensureWorktree(ctx, base) {
  if (base.ready) return null;
  const { dir, root } = ctx;
  if (existsSync(base.worktree)) git(["worktree", "remove", "--force", base.worktree], root);
  if (git(["worktree", "add", "--detach", base.worktree, base.sha], root) === null) return "no se pudo crear el worktree de la base";
  base.created = true;
  if (!(await installDeps(base.worktree, dir, ctx.timeoutMs))) return `falló la instalación de dependencias en la base (log: ${shortPath(join(dir, "base-last-install.log"), ctx.cwd)})`;
  base.ready = true;
  return null;
}

function removeWorktree(ctx) {
  if (ctx.base?.created) git(["worktree", "remove", "--force", ctx.base.worktree], ctx.root);
}

async function baselineIds(kind, ctx, baseRef) {
  const base = prepareBase(ctx, baseRef);
  if (base.error) return base;
  const { cwd, extra, dir, root } = ctx;
  const key = createHash("sha1").update(JSON.stringify([kind, relative(root, cwd), extra])).digest("hex").slice(0, 10);
  const cacheDir = join(dir, "baseline");
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${base.sha.slice(0, 12)}-${key}.json`);
  if (existsSync(cacheFile)) return { ids: new Set(JSON.parse(readFileSync(cacheFile, "utf8"))), label: base.label, cached: true };

  const error = await ensureWorktree(ctx, base);
  if (error) {
    base.error = error;
    return base;
  }
  const result = await CHECKS[kind]({ ...ctx, cwd: join(base.worktree, relative(root, cwd)), root: base.worktree, prefix: "base-" });
  if (result.crashed) return { error: `el check no corrió en la base (log: ${shortPath(result.log, ctx.cwd)})` };
  const ids = result.failures.map((failure) => failure.id);
  writeFileSync(cacheFile, JSON.stringify(ids));
  return { ids: new Set(ids), label: base.label, cached: false };
}

// ---------- output ----------

function formatFailures(failures, max) {
  const lines = [];
  if (failures.some((failure) => failure.group)) {
    const groups = new Map();
    for (const failure of failures) {
      const key = failure.group ?? failure.title;
      if (!groups.has(key)) groups.set(key, { where: [], detail: failure.detail });
      groups.get(key).where.push(failure.where);
    }
    const entries = [...groups.entries()];
    for (const [key, group] of entries.slice(0, max)) {
      const where = group.where.slice(0, 8).join(", ") + (group.where.length > 8 ? `, … (+${group.where.length - 8})` : "");
      lines.push(`  ${key}${group.where.length > 1 ? ` (×${group.where.length})` : ""}`);
      lines.push(`    ${where}`);
      if (group.detail) lines.push(group.detail);
    }
    if (entries.length > max) lines.push(`  … y ${entries.length - max} tipos de error más (ver log)`);
    return lines;
  }
  for (const failure of failures.slice(0, max)) {
    lines.push(`  ✗ ${failure.title}`);
    if (failure.detail) lines.push(failure.detail);
  }
  if (failures.length > max) lines.push(`  … y ${failures.length - max} más (ver log)`);
  return lines;
}

async function report(result, options, ctx) {
  const pad = result.kind.padEnd(5);
  const printNote = () => result.note && console.log(`  ⚠ ${result.note}`);
  if (result.skipped) {
    console.log(`- ${pad}  omitido: ${result.headline}`);
    return true;
  }
  if (result.ok) {
    console.log(`✓ ${pad}  ${result.headline}`);
    printNote();
    return true;
  }
  if (result.crashed) {
    console.log(`✗ ${pad}  ${result.headline} · log: ${shortPath(result.log, ctx.cwd)}`);
    if (result.detail) console.log(result.detail);
    return false;
  }

  if (!options.baseline) {
    console.log(`✗ ${pad}  ${result.headline} · log: ${shortPath(result.log, ctx.cwd)}`);
    printNote();
    formatFailures(result.failures, options.max).forEach((line) => console.log(line));
    return false;
  }

  const base = await baselineIds(result.kind, ctx, options.base);
  if (base.error) {
    console.log(`✗ ${pad}  ${result.headline} · log: ${shortPath(result.log, ctx.cwd)}`);
    printNote();
    if (!ctx.baseErrorShown) console.log(`  (sin comparación con la base: ${base.error})`);
    ctx.baseErrorShown = true;
    formatFailures(result.failures, options.max).forEach((line) => console.log(line));
    return false;
  }
  const fresh = result.failures.filter((failure) => !base.ids.has(failure.id));
  const existing = result.failures.filter((failure) => base.ids.has(failure.id));
  const currentIds = new Set(result.failures.map((failure) => failure.id));
  const fixed = [...base.ids].filter((id) => !currentIds.has(id)).length;
  const summary = [`${fresh.length} nuevos`, `${existing.length} ya fallaban en ${base.label}${base.cached ? " (cache)" : ""}`];
  if (fixed) summary.push(`${fixed} arreglados respecto a la base`);
  console.log(`${fresh.length ? "✗" : "~"} ${pad}  ${summary.join(" · ")} · log: ${shortPath(result.log, ctx.cwd)}`);
  printNote();
  if (fresh.length) {
    console.log("  NUEVOS (causados por los cambios actuales):");
    formatFailures(fresh, options.max).forEach((line) => console.log(line));
  }
  if (existing.length) {
    const titles = existing.slice(0, 5).map((failure) => failure.title).join("; ");
    console.log(`  Preexistentes (no son de estos cambios): ${titles}${existing.length > 5 ? `; … (+${existing.length - 5})` : ""}`);
  }
  return fresh.length === 0;
}

// ---------- hook (PostToolUse on Edit/Write) ----------

async function hook() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return 0;
  }
  const file = input.tool_input?.file_path;
  if (!file || !CODE_EXT.has(extname(file)) || !existsSync(file) || file.includes("/node_modules/")) return 0;

  const cwd = dirname(file);
  const dir = stateDir(cwd);
  const shownRoot = input.cwd ?? projectRoot(cwd);
  const problems = [];
  // stays under the hook's own timeout in settings.json (120s), so we stop tsc instead of being killed
  const hookTimeoutMs = (Number(process.env.QCHECK_HOOK_TIMEOUT) || 100) * 1000;

  const eslint = findBin("eslint", cwd);
  if (eslint) {
    const reportFile = join(dir, "hook-lint.json");
    rmSync(reportFile, { force: true });
    await exec(eslint, ["--format", "json", "--output-file", reportFile, file], { cwd, timeoutMs: hookTimeoutMs });
    if (existsSync(reportFile)) {
      for (const entry of JSON.parse(readFileSync(reportFile, "utf8"))) {
        for (const message of entry.messages) {
          if (message.severity === 2) problems.push(`${relative(shownRoot, file)}:${message.line ?? 0} ${message.ruleId ?? "parse"}: ${message.message}`);
        }
      }
    }
  }

  const tsconfig = findUp("tsconfig.json", cwd);
  const tsc = findBin("tsc", cwd);
  if (TS_EXT.has(extname(file)) && tsconfig && tsc && process.env.QCHECK_HOOK_TYPES !== "0") {
    const buildInfo = join(dir, `hook-${createHash("sha1").update(tsconfig).digest("hex").slice(0, 10)}.tsbuildinfo`);
    const result = await exec(tsc, ["-p", tsconfig, "--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile", buildInfo], {
      cwd: dirname(tsconfig),
      timeoutMs: hookTimeoutMs,
    });
    const target = relative(shownRoot, resolve(file));
    for (const failure of parseTsc(result.out, dirname(tsconfig), shownRoot)) {
      if (failure.where.startsWith(`${target}:`)) problems.push(failure.title);
    }
  }

  if (!problems.length) return 0;
  const shown = problems.slice(0, 20);
  if (problems.length > 20) shown.push(`… y ${problems.length - 20} más`);
  console.error(`qcheck: ${problems.length} errores en ${relative(shownRoot, file)}:\n${shown.join("\n")}`);
  return 2;
}

// ---------- qrun: any command ----------

const ERROR_LINE = /\b(errors?|failed|failure|fatal|exception|panic|traceback|denied|refused|cannot|unable to|not found)\b|\bERR!|\bERR_\w+|✖|✗|×/i;
const WARNING_LINE = /\bwarn(ing)?s?\b/i;

function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

// Collapses runs of identical lines ("tick" ×200) into one.
function collapseRepeats(lines) {
  const output = [];
  for (const line of lines) {
    const last = output.at(-1);
    if (last && last.text === line) last.count += 1;
    else output.push({ text: line, count: 1 });
  }
  return output.map(({ text, count }) => (count > 1 ? `${text} (×${count})` : text));
}

function errorExcerpt(lines, maxLines) {
  const shown = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!ERROR_LINE.test(lines[i])) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 4); j += 1) shown.add(j);
  }
  const indexes = [...shown].filter((i) => lines[i].trim()).sort((a, b) => a - b);
  const output = [];
  let previous = -2;
  for (const i of indexes.slice(0, maxLines)) {
    const skipped = lines.slice(previous + 1, i).some((line) => line.trim());
    if (skipped && output.length) output.push("    ⋮");
    output.push(`    ${lines[i].trimEnd()}`);
    previous = i;
  }
  if (indexes.length > maxLines) output.push(`    … (+${indexes.length - maxLines} líneas con errores, ver log)`);
  return { output, shown: new Set(indexes.slice(0, maxLines)) };
}

async function qrun(argv) {
  let until = null;
  let timeout = null;
  let i = 0;
  for (; i < argv.length; i += 1) {
    if (argv[i] === "--until") until = new RegExp(argv[++i], "i");
    else if (argv[i] === "--timeout") timeout = Number(argv[++i]);
    else if (argv[i] === "--") {
      i += 1;
      break;
    } else break;
  }
  const words = argv.slice(i);
  if (!words.length || words[0] === "-h" || words[0] === "--help") {
    console.log(RUN_USAGE);
    return words.length ? 0 : 1;
  }
  const command = words.length === 1 ? words[0] : words.map(shellQuote).join(" ");
  const cwd = process.cwd();
  const dir = stateDir(cwd);
  const timeoutMs = (timeout ?? (until ? 120 : 0)) * 1000;

  const started = Date.now();
  const result = await exec("sh", ["-c", command], { cwd, until, timeoutMs, keepStragglers: true });
  const elapsed = seconds(Date.now() - started);
  const slug = command.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "cmd";
  const log = shortPath(saveLog(dir, "", `run-${slug}`, result.out), cwd);
  const lines = result.out.split("\n");
  const label = command.length > 60 ? `${command.slice(0, 57)}…` : command;

  if (result.matched) {
    console.log(`✓ ${label} · listo en ${elapsed} (detenido) · log: ${log}`);
    console.log(`    ${result.matched}`);
    return 0;
  }
  if (!until && !result.timedOut && result.code === 0) {
    const warnings = lines.filter((line) => WARNING_LINE.test(line)).length;
    const last = lines.filter((line) => line.trim()).at(-1)?.trim();
    console.log(`✓ ${label} · ${elapsed}${warnings ? ` · ${warnings} líneas con warning` : ""} · log: ${log}`);
    if (last) console.log(`    ${last.length > 200 ? `${last.slice(0, 197)}…` : last}`);
    return 0;
  }

  const reason = result.timedOut
    ? `sin terminar${until ? ` ni coincidir con /${until.source}/` : ""} en ${timeoutMs / 1000}s (detenido)`
    : until
      ? `terminó (código ${result.code}) antes de coincidir con /${until.source}/`
      : `código ${result.code}`;
  console.log(`✗ ${label} · ${reason} · ${elapsed} · log: ${log}`);
  const { output, shown } = errorExcerpt(lines, 40);
  if (output.length) console.log(collapseRepeats(output).join("\n"));
  const tailIndexes = lines.map((_, index) => index).filter((index) => lines[index].trim() && !shown.has(index)).slice(-200);
  if (tailIndexes.length) {
    console.log("  Final del log:");
    console.log(collapseRepeats(tailIndexes.map((index) => `    ${lines[index].trimEnd()}`)).slice(-15).join("\n"));
  }
  return 1;
}

// ---------- guard (PreToolUse on Bash) ----------

const PM = "(?:pnpm|npm|yarn|bun)";
const EXEC = "(?:(?:npx|pnpm exec|pnpm dlx|yarn|bunx) )?";
const REDIRECTS = [
  { re: new RegExp(`^(?:${EXEC}playwright test|${PM}(?: run)? (?:test:)?e2e)\\b`), use: "qcheck e2e [-- args]" },
  { re: new RegExp(`^(?:${EXEC}(?:vitest|jest)|${PM}(?: run)? test|${PM} t)(?:\\s|$)`), use: "qcheck test [-- archivos o args]" },
  { re: new RegExp(`^(?:${EXEC}eslint|${PM}(?: run)? lint)(?:\\s|$)`), use: "qcheck lint [-- archivos]" },
  { re: new RegExp(`^(?:${EXEC}tsc|${PM}(?: run)? (?:typecheck|type-check|tsc))(?:\\s|$)`), use: "qcheck types" },
  {
    re: new RegExp(
      `^(?:${PM}(?: run)? build|${PM} (?:install|i|ci|add)|yarn$|docker (?:build|compose (?:up|build))|(?:\\./)?gradlew|xcodebuild|pod install|${EXEC}(?:expo prebuild|cdk (?:synth|diff)|prisma (?:generate|migrate)|nest build|next build|vite build)|terraform (?:plan|init))\\b`,
    ),
    use: "qrun -- <comando>",
  },
];
const HARMLESS = /\s(?:--version|-v|--help|-h)\b/;

function commandSegments(command) {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim().replace(/^(?:cd \S+\s*)$/, "").replace(/^(?:\w+=\S*\s+)+/, ""));
}

function guard() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return 0;
  }
  const command = input.tool_input?.command ?? "";
  if (!command || /\bQCHECK_RAW=1\b/.test(command)) return 0;
  for (const segment of commandSegments(command)) {
    if (!segment || /^(?:qcheck|qrun)\b/.test(segment) || HARMLESS.test(` ${segment}`)) continue;
    const rule = REDIRECTS.find(({ re }) => re.test(segment));
    if (!rule) continue;
    const suggestion = rule.use.startsWith("qrun") ? `qrun -- ${segment.replace(/\s*\d?>&?\s*\S+/g, "")}` : rule.use;
    console.error(
      `qcheck guard: \`${segment}\` imprime el output completo. Usá \`${suggestion}\` (skill quiet-checks): muestra solo errores o ✓ y guarda el log.` +
        (rule.use.startsWith("qcheck") ? " Agregá --baseline para separar fallos nuevos de preexistentes." : "") +
        " Si el usuario pidió explícitamente el output completo, anteponé QCHECK_RAW=1.",
    );
    return 2;
  }
  return 0;
}

// ---------- main ----------

function parseArgs(argv) {
  const options = { baseline: false, base: null, max: 10, timeout: null, extra: [] };
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  options.extra = separator === -1 ? [] : argv.slice(separator + 1);
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--baseline") options.baseline = true;
    else if (own[i] === "--base") options.base = own[++i];
    else if (own[i] === "--max") options.max = Number(own[++i]) || 10;
    else if (own[i] === "--timeout") options.timeout = Number(own[++i]) || null;
    else return null;
  }
  return options;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (basename(process.argv[1]) === "qrun") return qrun(process.argv.slice(2));
  if (command === "run") return qrun(rest);
  if (command === "hook") return hook();
  if (command === "guard") return guard();

  const kinds = command === "all" ? ["lint", "types", "test"] : CHECKS[command] ? [command] : null;
  const options = kinds && parseArgs(rest);
  if (!options || (command === "all" && options.extra.length)) {
    console.log(USAGE);
    return command && command !== "-h" && command !== "--help" ? 1 : 0;
  }

  const cwd = process.cwd();
  const timeoutS = options.timeout ?? (Number(process.env.QCHECK_TIMEOUT) || DEFAULT_TIMEOUT_S);
  const ctx = { cwd, extra: options.extra, dir: stateDir(cwd), prefix: "", root: projectRoot(cwd), timeoutMs: timeoutS * 1000 };
  let ok = true;
  try {
    for (const kind of kinds) {
      if (!(await report(await CHECKS[kind](ctx), options, ctx))) ok = false;
    }
  } finally {
    removeWorktree(ctx);
  }
  return ok ? 0 : 1;
}

process.exitCode = await main();
