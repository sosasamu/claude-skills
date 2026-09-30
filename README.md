# obsidian-claude-skills

Skills de Claude Code para trabajar con vaults de Obsidian a través del plugin [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) y su servidor MCP.

| Skill | Para qué |
|---|---|
| [`obsidian-vaults`](obsidian-vaults/README.md) | Conectar vaults a proyectos: puertos únicos, keys en el Llavero, `.mcp.json` sin secretos, diagnóstico de errores (401, failed). |
| [`obsidian-notes`](obsidian-notes/SKILL.md) | Trabajar con las notas una vez conectado: elegir vault, respetar convenciones, editar por secciones, mover sin romper enlaces, confirmar antes de borrar. |

> **Solo macOS** (`obsidian-vaults` usa el Llavero y la configuración de Obsidian en `~/Library/Application Support`).

## Instalación

```bash
git clone <url-de-este-repo> ~/Proyects/obsidian-claude-skills

# Enlazar las skills a tu configuración de Claude Code
# (~/.claude/skills si usas la configuración por defecto)
ln -s ~/Proyects/obsidian-claude-skills/obsidian-vaults ~/.claude-personal/skills/obsidian-vaults
ln -s ~/Proyects/obsidian-claude-skills/obsidian-notes  ~/.claude-personal/skills/obsidian-notes

# Opcional: el script en el PATH
ln -sf ~/Proyects/obsidian-claude-skills/obsidian-vaults/scripts/obsidian-mcp ~/.local/bin/obsidian-mcp
```

Si mueves el repo de carpeta, rehaz los enlaces y vuelve a ejecutar `obsidian-mcp add` en cada proyecto: los `.mcp.json` guardan la ruta absoluta del script.
