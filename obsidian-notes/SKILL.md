---
name: obsidian-notes
description: How to work well with notes in Obsidian vaults connected through the Local REST API MCP server (tools named mcp__obsidian-<vault>__vault_read, vault_patch, search_simple, search_query, vault_move, etc.). Use this skill whenever the user asks to find, read, summarize, create, edit, reorganize, rename, tag or delete notes in their Obsidian vault, or refers to "mi vault", "mis notas", "la nota que tengo abierta", daily notes, frontmatter or backlinks — even if they don't say "Obsidian". Not for connecting a vault or fixing the MCP connection (that's obsidian-vaults).
---

# Working with Obsidian notes

The Obsidian MCP tools describe their own parameters well — read those descriptions for syntax. This skill is about judgment: which tool to reach for, and how to change someone's notes without surprising them. A vault is a personal knowledge base the user edits by hand, often while you work; treat it with the care you'd give someone else's uncommitted code.

If no `obsidian-*` MCP server is available or it shows as failed, stop and point the user to the `obsidian-vaults` skill instead of working around it by editing vault files from the shell (see "Why not the shell").

## 1. Pick the right vault

Each vault is its own server, named `obsidian-<vault>` (e.g. `obsidian-byrrgis-vault`, `obsidian-onsend-vault`), so tools appear as `mcp__obsidian-<vault>__<tool>`. Decide in this order:

1. The user named a vault in the request ("guardala en onsend") → use it.
2. Only one `obsidian-*` server is connected → use it.
3. Otherwise, unless the target is obvious (a note that exists in only one vault), ask with the `AskUserQuestion` tool — creating a note in the wrong vault is the kind of mistake the user only notices weeks later, and a pick-list is faster than typing a name. Question: **"¿En qué vault?"**, one option per connected `obsidian-*` server, labeled with the vault name (e.g. `onsend-vault`). If there are more than 4, offer the 4 most likely for this request; the user can type another via "Other". Then use the chosen vault for the rest of the conversation without asking again.

## 2. Learn the vault's conventions before writing

Vaults have house rules: folder layout, frontmatter fields, tag style, `[[wikilinks]]` vs markdown links, date formats in filenames, templates. New notes that ignore them are clutter the user has to fix by hand.

- If the vault root has a `CLAUDE.md` or `README.md`, read it first — it's where the user writes those rules down.
- Before creating a note, look at 1–2 existing notes of the same kind (same folder, or found by `search_query` on a similar tag/path) and mirror their frontmatter fields, tags and link style.
- Follow what you see rather than what you'd prefer: if the vault uses `status: in-progress`, don't introduce `state: wip`.

## 3. Connect new notes to the graph

A note nobody links to is hard to find again; links and tags are what make a vault useful.

- **Inside the note you're creating** (no confirmation needed): search for related notes and link them with the vault's link style (usually `[[Note name]]`); reuse existing tags from `tag_list` rather than inventing near-duplicates (`#cliente` vs `#clientes`).
- **In other notes** — adding a backlink, updating an index or MOC note, appending to today's daily note: do it when the vault's `CLAUDE.md`/conventions say so (e.g. "every meeting note is linked from its project note"); otherwise offer it and list the notes you'd touch. Editing notes the user didn't mention is a surprise unless it's their established habit.

## 4. Find before you read

Walking folders with `vault_list` + `vault_read` burns context and time. Search first:

- **Words or phrases in the text** → `search_simple` (Obsidian's own search, ranked by relevance).
- **Metadata** — tags, frontmatter values, folder, modified date, links/backlinks → `search_query`. `stat.mtime` / `stat.ctime` are Unix epoch **milliseconds**; compute the timestamp for "this week", "since Monday", etc. from today's date instead of guessing.
- **"This note", "la que tengo abierta", "the one I'm looking at"** → `active_file_get_path`, then read that file.
- Use `vault_list` when the user asks about structure ("¿qué carpetas tengo?"), not as a search strategy.

## 5. Edit surgically

The user may have the same note open in Obsidian. `vault_write` replaces the whole file, so anything they typed since you read it is lost, and any part of the note you didn't mean to touch is rewritten from your copy.

- **Changing part of an existing note** → `vault_get_document_map` to get headings/blocks/frontmatter keys and the `version` token, then `vault_patch` targeting just that section, passing `ifMatch: <version>`. If the patch fails on the version check, the note changed under you: re-read it and retry — don't fall back to `vault_write`.
- **Adding to the end** (log entries, daily note items) → `vault_append`, or `vault_patch` with `append` under the right heading.
- **Frontmatter tweaks** (status, tags, dates) → `vault_patch` with `targetType: frontmatter`.
- **`vault_write`** is for creating new notes. Using it on an existing note is a full rewrite; only do it when the user asked for one, and say so.

## 6. Move and rename through Obsidian

`vault_move` updates every `[[link]]` pointing at the note. A move done any other way leaves those links broken across the vault. Use it for renames, re-foldering and archiving; set `allowOverwrite` only when the user explicitly wants to replace the file at the destination.

## 7. Confirm before the irreversible or unpredictable

Ask first, listing exactly what will happen, before:

- **Deleting** — `vault_delete` moves notes to trash by default; keep it that way. Never pass `permanent: true` unless the user asked for permanent deletion in those words. For bulk deletes, show the list of files first.
- **Overwriting** an existing note with `vault_write`.
- **Bulk changes** — edits, moves or tag changes across more than a handful of notes: show the list and the change, then proceed.
- **`command_execute`** — a command can come from any installed plugin and do almost anything (sync, publish, run scripts). Run `command_list` to find the ID, tell the user which command you'll run, and wait for a yes unless they named that exact command.

Reading, searching and creating new notes don't need confirmation.

## 8. Report what changed

After writing, say which notes you created or changed (paths), what kind of change, and anything you skipped. Offer `open_file` when it would help the user look at the result in Obsidian.

## Why not the shell

Even if the vault folder is reachable from the terminal, editing through the MCP server keeps Obsidian in the loop: moves update links, patches check the version, deletes go to Obsidian's trash, and the metadata cache stays consistent. Shell `mv`, `rm` or `sed` bypass all of that. Use the MCP tools for vault changes; the shell is fine for read-only inspection only if the MCP server isn't available and the user agreed.
