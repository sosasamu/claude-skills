---
name: quiet-checks
description: Run tests, lint and typecheck in JavaScript/TypeScript projects with compact output (only failures, or one ✓ line), and tell new failures apart from ones that already existed on the base branch without stashing. Use this skill whenever you are about to run or re-run tests, eslint, tsc, `pnpm test`, `pnpm lint`, vitest or jest, validate changes before finishing a task, or check whether a failure was caused by the current changes — even if the user just says "corré los tests", "fijate si pasa el lint" or "¿esto ya fallaba antes?".
compatibility: Node 18+, git. Detects vitest/jest, eslint and tsc from the project's node_modules; falls back to the package.json "test" script.
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
| `qcheck lint [-- files]` | ESLint errors grouped by rule (warnings only counted). Default target `.`. |
| `qcheck types` | `tsc --noEmit`, errors grouped by message. |
| `qcheck all` | lint + types + test. Use it once before declaring a task done. |
| `--baseline` | When something fails, also runs the same check on the merge-base with the base branch and splits failures into new vs pre-existing. |
| `--base <ref>` / `--max <n>` | Base branch. Default: the branch the current one was created from (read from the local reflog); if unknown, `develop` then `dev` (preferring `origin/`). Never `main`. The summary says which one was used / failures shown in detail (default 10). |

Exit code: 0 when everything passes (or, with `--baseline`, when there are no new failures), 1 otherwise.

## How to work with it

- **Use `qcheck` instead of calling the tools directly.** `pnpm test`, `npx eslint .` or `tsc` dump their full output into the conversation, which is exactly what this skill avoids. If the project has an unusual setup qcheck doesn't detect, it falls back to `<pm> run test` and shows only the last lines on failure.
- **Never stash, checkout or reset to find out whether a failure is pre-existing.** Use `--baseline`: it runs the merge-base with the base branch in a separate git worktree, leaving the working tree untouched, and caches the result per base commit, so the comparison costs nothing after the first time. Only fix the failures marked as new unless the user asks otherwise; mention the pre-existing ones in your final report. If the base shown is wrong (e.g. `(por defecto)` on a branch stacked on another feature branch), re-run with `--base <branch>`.
- **Narrow re-runs.** While fixing, re-run only the affected file (`qcheck test -- path/to/file.test.ts`, `qcheck lint -- src/file.ts`). Run `qcheck all` once at the end.
- **Read the log only when the summary isn't enough** (e.g. a truncated message marked `… (+N líneas)`). Search it instead of reading it whole: `grep -n -A 20 "test name" .git/qcheck/last-test.log`. The JSON reports next to it (`report-test.json`, `report-lint.json`) have every detail.
- **Crashes** (`terminó sin reporte`, `eslint falló`, `tsc falló`) mean the tool itself couldn't run: config errors, missing deps, syntax errors in config. The summary shows the last lines of output; fix that first.

## Edit hook

If the user has enabled the hook (see README), every time you edit a JS/TS file, Claude Code runs ESLint on that file and `tsc` (incremental) filtered to that file. If there are errors, they arrive right after the edit as a short list; fix them before moving on. No message means the file is clean. Don't re-run lint/types manually after each edit when the hook is on.

## Where things live

Logs, reports, baseline cache and the temporary worktree go in `.git/qcheck/` of the repo (never committed, no `.gitignore` needed). Outside git, they go in the system temp dir and `--baseline` is unavailable.
