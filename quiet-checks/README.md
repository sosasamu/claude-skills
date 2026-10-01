# quiet-checks

Skill de Claude Code para correr tests, lint y typecheck **gastando pocos tokens**.

Cuando Claude ejecuta `pnpm test` o `eslint .` directamente, todo el output entra a la conversación: líneas de progreso, cientos de tests que pasaron, stack traces por `node_modules`. En una suite grande son miles de tokens por corrida, y se repite cada vez que Claude vuelve a correrla. Peor aún: para saber si un fallo "ya estaba", Claude suele hacer `git stash`, correr todo de nuevo y restaurar.

Con esta skill Claude usa `qcheck`, que:

- **Imprime solo lo que falló**, o una línea `✓` si todo pasa. Agrupa los errores repetidos (40 veces la misma regla de ESLint = 1 entrada con la lista de archivos) y recorta los stack traces a tu código.
- **Guarda el output completo en un log** (`.git/qcheck/last-<check>.log`). Claude lo busca con `grep` solo si el resumen no alcanza.
- **Compara con la rama base sin stash** (`--baseline`): corre el mismo check sobre el punto donde tu rama se separó de su rama de origen, en un `git worktree` aparte, sin tocar tus cambios, y te dice qué fallos son nuevos y cuáles ya existían. El resultado se cachea por commit, así que solo cuesta la primera vez.
- **Hook opcional al editar**: después de cada edición, lint y typecheck del archivo editado; Claude recibe solo los errores.

```
quiet-checks/
├── SKILL.md            instrucciones para Claude
├── README.md           este archivo
└── scripts/
    └── qcheck.mjs      el script (Node, sin dependencias)
```

## Requisitos

- Node 18+ y git
- Proyecto JS/TS con alguno de: vitest o jest, eslint, typescript (los detecta solo desde `node_modules`). Si no reconoce el runner de tests, usa el script `test` del `package.json`.
- `--baseline` instala dependencias en el worktree la primera vez (con pnpm es rápido: reutiliza el store).

## Instalación

```bash
# Skill (elegí el directorio de config que uses: ~/.claude, ~/.claude-personal, ~/.claude-work)
ln -s ~/Proyects/claude-skills/quiet-checks ~/.claude-personal/skills/quiet-checks

# Comando en el PATH
ln -sf ~/Proyects/claude-skills/quiet-checks/scripts/qcheck.mjs ~/.local/bin/qcheck
```

### Hook al editar (opcional)

Agregalo en `settings.json` de tu config de Claude Code (o en `.claude/settings.json` de un proyecto para activarlo solo ahí):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "qcheck hook", "timeout": 120 }]
      }
    ]
  }
}
```

- Si el archivo editado no es JS/TS, o no tiene errores, el hook no dice nada (0 tokens).
- El typecheck usa `tsc --incremental`: la primera vez tarda lo que tarde tu proyecto, después es rápido. Para desactivar solo el typecheck: `QCHECK_HOOK_TYPES=0`.

### Instrucción para el CLAUDE.md del proyecto (opcional)

La skill se activa sola cuando Claude va a correr tests, pero si querés asegurarlo:

```markdown
## Tests y lint
Usá `qcheck` (skill quiet-checks) en vez de `pnpm test`, `pnpm lint` o `tsc` directo.
Para saber si un fallo ya existía, usá `qcheck <check> --baseline`; nunca hagas stash para comprobarlo.
```

## Uso

Le pedís a Claude lo de siempre (*"corré los tests"*, *"¿esto ya fallaba en develop?"*) y usa `qcheck`. También podés correrlo vos:

```bash
qcheck all                          # lint + types + test
qcheck test --baseline              # qué fallos son nuevos respecto a la rama de origen
qcheck test -- src/math.test.ts     # un solo archivo (args van a vitest/jest)
qcheck lint -- src/api              # lint de una carpeta
qcheck types --base release/1.2 --baseline   # otra rama base
```

Ejemplo de salida:

```
✓ lint   sin errores
✗ types  1 nuevos · 0 ya fallaban en develop @ b86ca0a · log: .git/qcheck/last-types.log
  NUEVOS (causados por los cambios actuales):
  TS2322: Type 'string' is not assignable to type 'number'.
    src/math.ts:4
✗ test   1 nuevos · 1 ya fallaban en develop @ b86ca0a · log: .git/qcheck/last-test.log
  NUEVOS (causados por los cambios actuales):
  ✗ src/math.test.ts > math multiplies
    AssertionError: expected 5 to be 6 // Object.is equality
        at src/math.test.ts:5:44
  Preexistentes (no son de estos cambios): src/math.test.ts > math legacy broken
```

### Qué rama usa como base

1. La rama de la que salió la actual, según el reflog local (`git switch -c`, `checkout -b`, `git branch X Y`). Funciona también con ramas apiladas (una feature que salió de otra feature).
2. Si no hay registro (la rama la bajaste del remote, o pasaron más de ~90 días), `develop` y si no `dev`, primero en `origin/`. Nunca `main`.
3. `--base <ref>` para elegirla a mano.

La salida indica cuál usó: `(rama de origen)`, `(por defecto)` o `(--base)`. No hace `git fetch`: compara contra tu copia local de `origin/…`.

## Otras ideas para ahorrar tokens (no incluidas)

- `BASH_MAX_OUTPUT_LENGTH` en el `env` de `settings.json`: tope de caracteres al output de cualquier comando.
- Hook `PreToolUse` que bloquee `pnpm test` directo y sugiera `qcheck`.
- Correr solo tests afectados por los cambios (`qcheck test -- --changed develop` en vitest, `-- --changedSince=develop` en jest).
