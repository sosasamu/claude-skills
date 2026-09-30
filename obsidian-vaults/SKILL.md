---
name: obsidian-vaults
description: Connect Obsidian vaults to Claude Code as MCP servers through the "Local REST API" plugin, on macOS. Use this skill whenever the user wants to connect, add, link or set up an Obsidian vault (or several) in a project, give Claude access to their Obsidian notes via MCP, fix an Obsidian MCP server that shows 401 / failed / disconnected in /mcp, resolve port conflicts between vaults, or see which vaults are connected — even if they just say "conecta mi vault X a este proyecto" or "no me anda el MCP de obsidian".
compatibility: macOS only (uses the Keychain via `security` and Obsidian's config in ~/Library/Application Support). Requires python3 and the Obsidian "Local REST API" plugin in each vault.
---

# Obsidian vaults → Claude Code (MCP)

The Obsidian "Local REST API" plugin runs an MCP server inside Obsidian, one per open vault, at `http://127.0.0.1:<port>/mcp`. Wiring many vaults by hand is tedious and error-prone: every vault defaults to the same ports, and every vault has its own API key. `scripts/obsidian-mcp` automates it:

| Command | What it does |
|---|---|
| `obsidian-mcp list` | Lists every vault Obsidian knows about: plugin installed?, HTTP/HTTPS ports, HTTP server on?, key in Keychain? |
| `obsidian-mcp sync` | Gives each vault with the plugin a unique port pair, turns the HTTP server on, and copies each API key into the Keychain (`obsidian-api-key-<vault>`). Only writes plugin config when Obsidian is closed. |
| `obsidian-mcp add <project-dir> <vault>...` | Adds `obsidian-<vault>` entries to `<project-dir>/.mcp.json`, keeping other servers. |
| `obsidian-mcp headers <vault>` | Prints the auth header from the Keychain. Claude Code calls this through `headersHelper`; you don't. |

Run it as `<skill-dir>/scripts/obsidian-mcp` (it's a Python 3 script). Vault names are the vault's folder name, slugified (`byrrgis-vault`, `onsend-vault`).

## Secrets: why the script does the handling

Each vault's `.obsidian/plugins/obsidian-local-rest-api/data.json` holds the API key and TLS private keys in plain text. Anything you `cat`, `grep` or print lands in the conversation transcript, so don't read that file, don't read the Keychain entries, and don't run `obsidian-mcp headers` in a way that prints its output. The script moves keys from `data.json` to the Keychain (via stdin, so they never appear in `ps`) and `.mcp.json` only stores a `headersHelper` command — no key ever needs to pass through you. If you need to know the state of a vault, `obsidian-mcp list` tells you everything without exposing secrets.

## Workflow: connect vaults to a project

1. **Find the vaults.** Run `obsidian-mcp list`. Match what the user asked for ("el vault de onsend") to a slug. If it's ambiguous, ask.
   - Vault shows `PLUGIN no` → the user must install it from Obsidian (Settings → Community plugins → Browse → "Local REST API" → Install → Enable). Installing it yourself would mean dropping third-party code into their vault without going through Obsidian, so leave that to them.
   - Vault not in the list at all → it has never been opened in Obsidian; ask them to open it once.

2. **Sync.** Run `obsidian-mcp sync`.
   - If it exits 1 saying Obsidian is open, port changes are pending. Obsidian rewrites plugin config when it quits, so edits made while it runs get lost. Ask the user to fully quit Obsidian (⌘Q), then re-run `sync`, then reopen Obsidian. Keys were already stored even in that case.
   - A vault whose plugin hasn't generated a key yet needs to be opened once in Obsidian with the plugin enabled.

3. **Add to the project.** Run `obsidian-mcp add <project-dir> <vault>...`. The project dir is the current working directory unless the user names another one. If the script warns that `.mcp.json` isn't gitignored, tell the user: the file holds absolute paths from their machine, which would break for teammates. Offer to add it to `.gitignore`, don't do it silently.

4. **Check for duplicates.** Read `.mcp.json` and look for older, hand-written entries that point to the same URL (e.g. an `obsidian` server using `${OBSIDIAN_API_KEY}`). Two servers for one vault means Claude sees every tool twice. Point them out and ask before removing them.

5. **Hand off.** MCP config is read at startup, and project `.mcp.json` servers need approval the first time (the `headersHelper` runs a command, so Claude Code asks). Tell the user to restart Claude Code in that project, approve the servers, and run `/mcp` to confirm each shows **connected**. Obsidian must be running with those vaults open (each in its own window) for them to connect.

## Troubleshooting

- **401 in `/mcp`** — the header reached a server that doesn't accept that key. Usual cause: the URL points to another vault's port (two vaults on the same port → only the first one to open gets it). Run `list`; if ports collide, `sync` (with Obsidian closed), then `add` again so URLs are refreshed.
- **"failed" / connection refused** — Obsidian is closed, the vault isn't open, or its HTTP server is off. `list` shows `HTTP ON`; `sync` turns it on.
- **Ports changed after a `sync`** — existing `.mcp.json` files keep the old port. Re-run `add` in each project that uses those vaults.
- **Keychain prompt** — the first time `headersHelper` reads the Keychain, macOS may ask for permission. The user should choose "Always Allow", otherwise it asks on every connection.

## Why HTTP and not HTTPS

The plugin's HTTPS port uses a self-signed certificate that Node (and so Claude Code) rejects. The HTTP server only listens on `127.0.0.1`, so traffic never leaves the machine. If the user insists on HTTPS, it's possible with `NODE_EXTRA_CA_CERTS` pointing to the plugin's certificate, but they'd have to redo it whenever the certificate is regenerated; explain the tradeoff rather than switching silently.
