---
name: quiet-checks
description: Run tests, e2e, lint, typecheck and any noisy command (build, install, docker, gradle, cdk, migrations, dev servers) with compact output — only failures or one ✓ line, full log kept aside — and tell new test failures apart from ones that already existed on the base branch without stashing. Use this skill whenever you are about to run or re-run tests, playwright, eslint, tsc, `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm install`, docker builds, native builds, or start a dev server to see if it boots; when validating changes before finishing a task; or when checking whether a failure was caused by the current changes — even if the user just says "corré los tests", "fijate si buildea", "levantá la app" or "¿esto ya fallaba antes?".
compatibility: Node 18+, git. Detects vitest/jest, playwright, eslint and tsc from the project's node_modules; falls back to the package.json "test" script.
---

# Quiet checks

Test runners and linters print a lot: progress lines, passing tests, long stack traces through `node_modules`. You only need what failed. `scripts/qcheck.mjs` runs the tools with machine-readable reporters, keeps the full output in a log file, and prints a short summary:

```
✓ lint   sin errores
✗ test   1 nuevos · 3 ya fallaban en develop @ b86ca0a (rama de origen) · log: .git/qcheck/last-test.log
  NUEVOS (causados por los cambios actuales):
  ✗ src/math.test.ts > math multiplies
    AssertionError: expected 5 to be 6
        at src/math.test.ts:5:44
  Preexistentes (no son de estos cambios): src/legacy.test.ts > ...
```

Run it as `<skill-dir>/scripts/qcheck.mjs` or `qcheck` if it's on the PATH, from the project (or package) directory.

| Command | Use it for |
|---|---|
| `qcheck test [-- args]` | Tests. Args after `--` go to vitest/jest, e.g. `-- src/math.test.ts` or `-- -t "adds"`. |
| `qcheck e2e [-- args]` | Playwright tests (`-- e2e/login.spec.ts`, `-- -g "checkout"`). Not part of `all`: run it when the change touches flows the e2e suite covers. |
| `qcheck lint [-- files]` | ESLint errors grouped by rule (warnings only counted). Default target `.`. |
| `qcheck types` | `tsc --noEmit`, errors grouped by message. |
| `qcheck all` | lint + types + test. Use it once before declaring a task done. |
| `--baseline` | When something fails, also runs the same check on the merge-base with the base branch and splits failures into new vs pre-existing. |
| `--timeout <s>` | Stop the check and all its processes after this long (default 540s, or `QCHECK_TIMEOUT`). |
| `--base <ref>` / `--max <n>` | Base branch. Default: the branch the current one was created from (read from the local reflog); if unknown, `develop` then `dev` (preferring `origin/`). Never `main`. The summary says which one was used / failures shown in detail (default 10). |

Exit code: 0 when everything passes (or, with `--baseline`, when there are no new failures), 1 otherwise.

## How to work with it

- **Use `qcheck` instead of calling the tools directly.** `pnpm test`, `npx eslint .` or `tsc` dump their full output into the conversation, which is exactly what this skill avoids. If the project has an unusual setup qcheck doesn't detect, it falls back to `<pm> run test` and shows only the last lines on failure.
- **Never stash, checkout or reset to find out whether a failure is pre-existing.** Use `--baseline`: it runs the merge-base with the base branch in a separate git worktree, leaving the working tree untouched, and caches the result per base commit, so the comparison costs nothing after the first time. Only fix the failures marked as new unless the user asks otherwise; mention the pre-existing ones in your final report. If the base shown is wrong (e.g. `(por defecto)` on a branch stacked on another feature branch), re-run with `--base <branch>`.
- **Narrow re-runs.** While fixing, re-run only the affected file (`qcheck test -- path/to/file.test.ts`, `qcheck lint -- src/file.ts`). Run `qcheck all` once at the end.
- **Read the log only when the summary isn't enough** (e.g. a truncated message marked `… (+N líneas)`). Search it instead of reading it whole: `grep -n -A 20 "test name" .git/qcheck/last-test.log`. The JSON reports next to it (`report-test.json`, `report-lint.json`) have every detail.
- **Give the Bash call room.** Run full suites with the Bash tool's `timeout` at 600000 ms: qcheck stops itself at 540 s and reports why, which is better than being cut off by the tool. For a suite that legitimately takes longer, pass a bigger `--timeout` and run it in the background.
- **`⚠ … no salía (handles abiertos)`** means the runner finished and wrote its results, but something (a DB connection, a server, a timer) kept the process alive; qcheck stopped it after 10 s. The results shown are valid. Mention it to the user — it usually means a missing `afterAll` cleanup — but don't block on it unless asked.
- **Crashes** (`terminó sin reporte`, `eslint falló`, `tsc falló`, `no terminó en Ns`) mean the tool itself couldn't run: config errors, missing deps, syntax errors in config. The summary shows the last lines of output; fix that first.

## Any other noisy command: `qrun`

For commands that aren't tests/lint/types but print a lot — builds, installs, docker, Gradle/Xcode/CocoaPods, `expo prebuild`, `cdk synth`/`diff`, `terraform plan`, migrations — use `qrun` (same script; `qcheck run` works too):

```
qrun -- pnpm build
qrun -- "docker compose build && docker compose up -d"
qrun --until "listening on|ready in|compiled successfully" --timeout 90 -- pnpm dev
```

- On success: `✓`, elapsed time, a count of warning lines and the last output line (usually the tool's own summary).
- On failure: the lines that look like errors with a bit of context, plus the end of the log, repeated lines collapsed. If the excerpt doesn't explain the failure, `grep` the log it points to.
- `--until <regex>` is for processes that never exit (dev servers, watchers): it waits for a matching line, stops the process (and its children) and reports ✓; if the process dies first or `--timeout` passes, it reports the errors. Use it to check that an app boots instead of running the server in the foreground.
- `cdk synth` prints the whole template; `qrun` keeps it in the log. Prefer `cdk diff` to see what changes.

## Hooks

**Guard (PreToolUse).** If the user enabled it, running `pnpm test`, `vitest`, `eslint`, `tsc`, `pnpm build`, `pnpm install`, docker builds, etc. directly is blocked with a message telling you which `qcheck`/`qrun` command to use instead — just run that. Only when the user explicitly asks to see the raw output, prefix the command with `QCHECK_RAW=1` to bypass it.

**Edit hook (PostToolUse).**

If the user has enabled it, every time you edit a JS/TS file, Claude Code runs ESLint on that file and `tsc` (incremental) filtered to that file. If there are errors, they arrive right after the edit as a short list; fix them before moving on. No message means the file is clean. Don't re-run lint/types manually after each edit when the hook is on.

## Where things live

Logs, reports, baseline cache and the temporary worktree go in `.git/qcheck/` of the repo (never committed, no `.gitignore` needed). Outside git, they go in the system temp dir and `--baseline` is unavailable.
