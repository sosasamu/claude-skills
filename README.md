# claude-skills

Skills de Claude Code.

| Skill | Para qué |
|---|---|
| [`quiet-checks`](quiet-checks/README.md) | Correr tests, e2e, lint, typecheck y comandos ruidosos (build, install, docker, dev servers) gastando pocos tokens: solo los fallos, log completo aparte, comparación con la rama base sin stash y hooks opcionales. |
| [`obsidian-vaults`](obsidian-vaults/README.md) | Conectar vaults de Obsidian a proyectos por MCP: puertos únicos, keys en el Llavero, `.mcp.json` sin secretos, diagnóstico de errores (401, failed). |
| [`obsidian-notes`](obsidian-notes/SKILL.md) | Trabajar con las notas de Obsidian una vez conectado: elegir vault, respetar convenciones, editar por secciones, mover sin romper enlaces, confirmar antes de borrar. |

> Las skills de Obsidian son **solo macOS** (usan el Llavero y la configuración de Obsidian en `~/Library/Application Support`). `quiet-checks` necesita Node 18+ y git.

## Instalación

```bash
git clone <url-de-este-repo> ~/Proyects/claude-skills

# Enlazar las skills a tu configuración de Claude Code
# (~/.claude/skills si usas la configuración por defecto)
ln -s ~/Proyects/claude-skills/quiet-checks    ~/.claude-personal/skills/quiet-checks
ln -s ~/Proyects/claude-skills/obsidian-vaults ~/.claude-personal/skills/obsidian-vaults
ln -s ~/Proyects/claude-skills/obsidian-notes  ~/.claude-personal/skills/obsidian-notes

# Opcional: los scripts en el PATH
ln -sf ~/Proyects/claude-skills/quiet-checks/scripts/qcheck.mjs ~/.local/bin/qcheck
ln -sf ~/Proyects/claude-skills/quiet-checks/scripts/qcheck.mjs ~/.local/bin/qrun
ln -sf ~/Proyects/claude-skills/obsidian-vaults/scripts/obsidian-mcp ~/.local/bin/obsidian-mcp
```

Si mueves el repo de carpeta, rehaz los enlaces y vuelve a ejecutar `obsidian-mcp add` en cada proyecto: los `.mcp.json` guardan la ruta absoluta del script.
