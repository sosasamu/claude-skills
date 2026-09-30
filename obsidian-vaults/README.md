# obsidian-vaults

Skill de Claude Code para conectar vaults de Obsidian a tus proyectos por MCP, usando el plugin [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

Sin la skill, cada vault se configura a mano: elegir puertos que no choquen, copiar la API key, guardarla en `.zshrc`, escribir el `.mcp.json`… Con 10 vaults eso no escala. Con la skill le pides a Claude *"conecta el vault onsend a este proyecto"* y se encarga del resto.

> **Solo macOS.** Usa el Llavero (`security`) y la configuración de Obsidian en `~/Library/Application Support/obsidian`.

## Qué hace

```
obsidian-vaults/
├── SKILL.md              instrucciones para Claude
├── README.md             este archivo
└── scripts/
    └── obsidian-mcp      script que hace el trabajo (Python 3)
```

- **Puertos únicos por vault**: respeta los que ya funcionan y reasigna solo los que chocan (27123/27124, 27125/27126, …).
- **Keys en el Llavero**: lee la key que el plugin generó en cada vault y la guarda como `obsidian-api-key-<vault>`. No hace falta copiarla ni tocar `.zshrc`.
- **`.mcp.json` sin secretos**: cada servidor usa `headersHelper`, un comando que Claude Code ejecuta al conectarse para leer la key del Llavero.
- **Nunca imprime keys ni certificados.**

## Requisitos

- macOS con Python 3
- Obsidian con el plugin **Local REST API** instalado y activado en cada vault que quieras conectar
- Claude Code

## Instalación

Enlaza la carpeta a tus skills personales de Claude Code:

```bash
ln -s ~/Proyects/obsidian-claude-skills/obsidian-vaults ~/.claude-personal/skills/obsidian-vaults
```

(Si usas la configuración por defecto de Claude Code, la carpeta es `~/.claude/skills/`.)

Opcional, para usar el script directamente desde la terminal:

```bash
ln -sf ~/Proyects/obsidian-claude-skills/obsidian-vaults/scripts/obsidian-mcp ~/.local/bin/obsidian-mcp
```

## Uso con Claude

Ejemplos de lo que puedes pedirle:

| Le dices | Claude hace |
|---|---|
| "conecta el vault byrrgis a este proyecto" | `list` → `sync` → `add <proyecto actual> byrrgis-vault` y te dice que reinicies y apruebes |
| "agrega mis vaults onsend y byrrgis al proyecto ~/Proyects/space/api" | Lo mismo, con dos vaults y otra carpeta |
| "qué vaults tengo conectables?" | `list` y te explica cuáles tienen el plugin y cuáles no |
| "el MCP de obsidian me da 401" | Revisa puertos con `list`, detecta choques, corrige con `sync` y vuelve a ejecutar `add` |
| "instalé el plugin en un vault nuevo, sumalo acá" | `sync` para asignarle puertos y guardar su key, luego `add` |

Después de que Claude configure el proyecto:

1. Reinicia Claude Code en ese proyecto.
2. Aprueba los servidores `obsidian-<vault>` la primera vez.
3. Ejecuta `/mcp`: deben aparecer como **connected**.

Obsidian tiene que estar abierto con esos vaults (cada uno en su ventana) para que conecten.

## Uso directo del script

```bash
# Ver el estado de todos tus vaults
$ obsidian-mcp list
VAULT                        PLUGIN  HTTP   HTTPS  HTTP ON  LLAVERO
aws-course                   no
byrrgis-vault                sí      27123  27124  sí       ok
onsend-vault                 sí      27125  27126  sí       ok

# Asignar puertos y guardar keys (los cambios de puertos requieren Obsidian cerrado)
$ obsidian-mcp sync
- aws-course: sin plugin, se ignora (instálalo desde Obsidian)
- onsend-vault: key guardada en el Llavero (obsidian-api-key-onsend-vault)
Puertos OK, no hay cambios pendientes.

# Añadir vaults al .mcp.json de un proyecto
$ obsidian-mcp add ~/Proyects/space/byrrgis/byrrgis byrrgis-vault onsend-vault
- obsidian-byrrgis-vault -> http://127.0.0.1:27123/mcp
- obsidian-onsend-vault -> http://127.0.0.1:27125/mcp
Actualizado /Users/samuel/Proyects/space/byrrgis/byrrgis/.mcp.json
```

Resultado en `.mcp.json`:

```json
{
  "mcpServers": {
    "obsidian-byrrgis-vault": {
      "type": "http",
      "url": "http://127.0.0.1:27123/mcp",
      "headersHelper": "/Users/samuel/Proyects/obsidian-claude-skills/obsidian-vaults/scripts/obsidian-mcp headers byrrgis-vault"
    }
  }
}
```

## Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `401` en `/mcp` | La URL apunta al puerto de otro vault | `obsidian-mcp list`, `sync` con Obsidian cerrado y `add` otra vez |
| `failed` / no conecta | Obsidian cerrado, vault no abierto o HTTP apagado | Abre el vault; `sync` activa HTTP |
| `sync` dice "Obsidian está abierto" | Hay cambios de puertos pendientes | Cierra Obsidian (⌘Q), `sync`, vuelve a abrirlo |
| macOS pide permiso del Llavero en cada conexión | No se eligió "Permitir siempre" | Acepta con **Permitir siempre** la próxima vez |
| Funcionaba y dejó de hacerlo tras un `sync` | Cambiaron los puertos | Vuelve a ejecutar `add` en cada proyecto |

## Por qué HTTP y no HTTPS

El puerto HTTPS del plugin usa un certificado autofirmado que Claude Code (Node) rechaza. El servidor HTTP solo escucha en `127.0.0.1`: el tráfico no sale de tu Mac.

## Seguridad

- La API key vive en el `data.json` del plugin (lo gestiona Obsidian) y en el Llavero. No aparece en `.mcp.json`, `.zshrc` ni en la salida de ningún comando.
- `.mcp.json` contiene rutas absolutas de tu máquina: mantenlo en `.gitignore` si el proyecto es compartido. El script avisa si no lo está.
- Si una key se filtra, regenérala en Obsidian (**Settings → Local REST API**) y ejecuta `obsidian-mcp sync`.
