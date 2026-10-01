#!/usr/bin/env node
// qcheck: runs tests, lint and typecheck and prints only what Claude needs to act on.
// The full output is kept in a log file (inside .git/qcheck) so it can be grepped on demand.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";

const USAGE = `qcheck: tests, lint y typecheck con salida compacta

Uso:
  qcheck test  [opciones] [-- args para vitest/jest]
  qcheck lint  [opciones] [-- archivos o args para eslint]   (por defecto: .)
  qcheck types [opciones] [-- args para tsc]
  qcheck all   [opciones]                                     (lint + types + test)
  qcheck hook                                                 (PostToolUse de Claude Code; lee JSON por stdin)

Opciones:
  --baseline     Si hay fallos, compara con la rama base (git worktree, cacheado por commit)
  --base <ref>   Rama base (por defecto: la rama de la que salió la actual, según el reflog;
                 si no se sabe, develop o dev)
  --max <n>      Máximo de fallos a mostrar en detalle (por defecto: 10)

Salida: una línea por check si pasa; si falla, solo los errores y la ruta del log completo.
Código de salida: 0 si todo pasa (o, con --baseline, si no hay fallos nuevos); 1 si no.`;

const CODE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
const MESSAGE_LINES = 12;
const ANSI = /\x1b\[[0-9;]*m/g;
const NOISE_FRAME = /node_modules|node:internal|\(node:|<anonymous>/;

// ---------- helpers ----------

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  return { code: result.status ?? 1, out: out.replace(ANSI, "") };
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

function checkTest(ctx) {
  const { cwd, extra, dir, prefix, root } = ctx;
  const { deps, scripts, dir: pkgDir } = readDeps(cwd);
  const report = join(dir, `${prefix}report-test.json`);
  rmSync(report, { force: true });

  let bin;
  let args;
  if (deps.has("vitest") && (bin = findBin("vitest", cwd))) {
    args = ["run", "--reporter=json", `--outputFile=${report}`, ...extra];
  } else if (deps.has("jest") && (bin = findBin("jest", cwd))) {
    args = ["--json", `--outputFile=${report}`, ...extra];
  } else if (scripts.test) {
    return checkGeneric(ctx, "test", pkgDir);
  } else {
    return { kind: "test", ok: true, skipped: true, headline: "sin vitest, jest ni script test", failures: [] };
  }

  const started = Date.now();
  const result = run(bin, args, cwd);
  const elapsed = seconds(Date.now() - started);
  const log = saveLog(dir, prefix, "test", result.out);

  if (!existsSync(report)) {
    return {
      kind: "test", ok: false, crashed: true, log, failures: [],
      headline: `el runner terminó sin reporte (código ${result.code})`,
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
  const ok = failures.length === 0 && result.code === 0;
  const parts = [`${passed} pasaron`];
  if (failures.length) parts.unshift(`${failures.length} fallaron`);
  if (skipped) parts.push(`${skipped} omitidos`);
  parts.push(elapsed);
  if (!ok && !failures.length) {
    return { kind: "test", ok: false, crashed: true, log, failures, headline: `código ${result.code} sin tests fallidos`, detail: tail(result.out, 30, ctx.root) };
  }
  return { kind: "test", ok, log, failures, headline: parts.join(" · ") };
}

// ---------- lint (eslint) ----------

function checkLint(ctx) {
  const { cwd, extra, dir, prefix, root } = ctx;
  const bin = findBin("eslint", cwd);
  if (!bin) return { kind: "lint", ok: true, skipped: true, headline: "eslint no está instalado", failures: [] };

  const report = join(dir, `${prefix}report-lint.json`);
  rmSync(report, { force: true });
  const targets = extra.length ? extra : ["."];
  const result = run(bin, ["--format", "json", "--output-file", report, ...targets], cwd);
  const log = saveLog(dir, prefix, "lint", result.out);

  if (!existsSync(report)) {
    return { kind: "lint", ok: false, crashed: true, log, failures: [], headline: `eslint falló (código ${result.code})`, detail: tail(result.out, 30, ctx.root) };
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

function checkTypes(ctx) {
  const { cwd, extra, dir, prefix, root } = ctx;
  const bin = findBin("tsc", cwd);
  if (!bin || !findUp("tsconfig.json", cwd)) {
    return { kind: "types", ok: true, skipped: true, headline: "sin typescript o tsconfig.json", failures: [] };
  }
  const started = Date.now();
  const result = run(bin, ["--noEmit", "--pretty", "false", ...extra], cwd);
  const log = saveLog(dir, prefix, "types", result.out);
  const failures = parseTsc(result.out, cwd, root);
  if (result.code !== 0 && !failures.length) {
    return { kind: "types", ok: false, crashed: true, log, failures, headline: `tsc falló (código ${result.code})`, detail: tail(result.out, 30, ctx.root) };
  }
  const headline = failures.length ? `${failures.length} errores` : `sin errores · ${seconds(Date.now() - started)}`;
  return { kind: "types", ok: failures.length === 0, log, failures, headline };
}

// ---------- fallback: package.json "test" script ----------

function checkGeneric(ctx, kind, pkgDir) {
  const { dir, prefix, extra } = ctx;
  const pm = packageManager(pkgDir);
  const started = Date.now();
  const result = run(pm, ["run", kind, ...(extra.length ? ["--", ...extra] : [])], pkgDir);
  const log = saveLog(dir, prefix, kind, result.out);
  if (result.code === 0) return { kind, ok: true, log, failures: [], headline: `${pm} run ${kind} ok · ${seconds(Date.now() - started)}` };
  return {
    kind, ok: false, crashed: true, generic: true, log, failures: [],
    headline: `${pm} run ${kind} falló (código ${result.code}); runner no reconocido, se muestran las últimas líneas`,
    detail: tail(result.out, 40, ctx.root),
  };
}

const CHECKS = { test: checkTest, lint: checkLint, types: checkTypes };

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

function installDeps(worktree, dir) {
  const pm = packageManager(worktree);
  const args = {
    pnpm: ["install", "--frozen-lockfile", "--prefer-offline"],
    yarn: ["install", "--frozen-lockfile"],
    npm: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
  }[pm];
  const result = run(pm, args, worktree);
  saveLog(dir, "base-", "install", result.out);
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

function ensureWorktree(ctx, base) {
  if (base.ready) return null;
  const { dir, root } = ctx;
  if (existsSync(base.worktree)) git(["worktree", "remove", "--force", base.worktree], root);
  if (git(["worktree", "add", "--detach", base.worktree, base.sha], root) === null) return "no se pudo crear el worktree de la base";
  base.created = true;
  if (!installDeps(base.worktree, dir)) return `falló la instalación de dependencias en la base (log: ${shortPath(join(dir, "base-last-install.log"), ctx.cwd)})`;
  base.ready = true;
  return null;
}

function removeWorktree(ctx) {
  if (ctx.base?.created) git(["worktree", "remove", "--force", ctx.base.worktree], ctx.root);
}

function baselineIds(kind, ctx, baseRef) {
  const base = prepareBase(ctx, baseRef);
  if (base.error) return base;
  const { cwd, extra, dir, root } = ctx;
  const key = createHash("sha1").update(JSON.stringify([kind, relative(root, cwd), extra])).digest("hex").slice(0, 10);
  const cacheDir = join(dir, "baseline");
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${base.sha.slice(0, 12)}-${key}.json`);
  if (existsSync(cacheFile)) return { ids: new Set(JSON.parse(readFileSync(cacheFile, "utf8"))), label: base.label, cached: true };

  const error = ensureWorktree(ctx, base);
  if (error) {
    base.error = error;
    return base;
  }
  const result = CHECKS[kind]({ ...ctx, cwd: join(base.worktree, relative(root, cwd)), root: base.worktree, prefix: "base-" });
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

function report(result, options, ctx) {
  const pad = result.kind.padEnd(5);
  if (result.skipped) {
    console.log(`- ${pad}  omitido: ${result.headline}`);
    return true;
  }
  if (result.ok) {
    console.log(`✓ ${pad}  ${result.headline}`);
    return true;
  }
  if (result.crashed) {
    console.log(`✗ ${pad}  ${result.headline} · log: ${shortPath(result.log, ctx.cwd)}`);
    if (result.detail) console.log(result.detail);
    return false;
  }

  if (!options.baseline) {
    console.log(`✗ ${pad}  ${result.headline} · log: ${shortPath(result.log, ctx.cwd)}`);
    formatFailures(result.failures, options.max).forEach((line) => console.log(line));
    return false;
  }

  const base = baselineIds(result.kind, ctx, options.base);
  if (base.error) {
    console.log(`✗ ${pad}  ${result.headline} · log: ${shortPath(result.log, ctx.cwd)}`);
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

function hook() {
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

  const eslint = findBin("eslint", cwd);
  if (eslint) {
    const reportFile = join(dir, "hook-lint.json");
    rmSync(reportFile, { force: true });
    run(eslint, ["--format", "json", "--output-file", reportFile, file], cwd);
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
    const result = run(tsc, ["-p", tsconfig, "--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile", buildInfo], dirname(tsconfig));
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

// ---------- main ----------

function parseArgs(argv) {
  const options = { baseline: false, base: null, max: 10, extra: [] };
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  options.extra = separator === -1 ? [] : argv.slice(separator + 1);
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--baseline") options.baseline = true;
    else if (own[i] === "--base") options.base = own[++i];
    else if (own[i] === "--max") options.max = Number(own[++i]) || 10;
    else return null;
  }
  return options;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "hook") return hook();

  const kinds = command === "all" ? ["lint", "types", "test"] : CHECKS[command] ? [command] : null;
  const options = kinds && parseArgs(rest);
  if (!options || (command === "all" && options.extra.length)) {
    console.log(USAGE);
    return command && command !== "-h" && command !== "--help" ? 1 : 0;
  }

  const cwd = process.cwd();
  const ctx = { cwd, extra: options.extra, dir: stateDir(cwd), prefix: "", root: projectRoot(cwd) };
  let ok = true;
  try {
    for (const kind of kinds) {
      if (!report(CHECKS[kind](ctx), options, ctx)) ok = false;
    }
  } finally {
    removeWorktree(ctx);
  }
  return ok ? 0 : 1;
}

process.exitCode = main();
