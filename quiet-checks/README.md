# quiet-checks

Skill de Claude Code para correr tests, lint, typecheck y cualquier comando ruidoso **gastando pocos tokens**.

Cuando Claude ejecuta `pnpm test`, `pnpm build` o `docker compose up` directamente, todo el output entra a la conversación: líneas de progreso, cientos de tests que pasaron, stack traces por `node_modules`, logs de Gradle. Son miles de tokens por corrida y se repiten cada vez que Claude vuelve a correr el comando. Peor aún: para saber si un fallo "ya estaba", Claude suele hacer `git stash`, correr todo de nuevo y restaurar.

Con esta skill Claude usa dos comandos (el mismo script):

- **`qcheck`** para tests (vitest/jest), e2e (Playwright), lint (ESLint) y typecheck (tsc):
  - **Solo lo que falló**, o una línea `✓`. Agrupa errores repetidos (40 veces la misma regla de ESLint = 1 entrada con la lista de archivos) y recorta los stack traces a tu código.
  - **Compara con la rama base sin stash** (`--baseline`): corre el mismo check sobre el punto donde tu rama se separó de su rama de origen, en un `git worktree` aparte, sin tocar tus cambios, y te dice qué fallos son nuevos y cuáles ya existían. Se cachea por commit: solo cuesta la primera vez.
- **`qrun`** para cualquier otro comando (build, install, docker, Gradle, Xcode, `cdk`, migraciones): `✓` y la última línea si sale bien; si falla, las líneas de error con contexto y el final del log. Con `--until` sirve para comprobar que un dev server arranca y detenerlo.

El output completo siempre queda en un log (`.git/qcheck/`), y Claude lo busca con `grep` solo si el resumen no alcanza.

Además, dos **hooks** opcionales:

- **Guard**: si Claude intenta correr `pnpm test`, `pnpm build`, etc. directo, lo bloquea y le dice qué comando usar.
- **Al editar**: lint y typecheck del archivo que Claude acaba de editar; Claude recibe solo los errores.

```
quiet-checks/
├── SKILL.md            instrucciones para Claude
├── README.md           este archivo
└── scripts/
    └── qcheck.mjs      el script (Node, sin dependencias); qrun es un symlink a él
```

## Requisitos

- Node 18+ y git
- Para `qcheck`: proyecto JS/TS con alguno de vitest o jest, @playwright/test, eslint, typescript (los detecta solo desde `node_modules`). Si no reconoce el runner de tests, usa el script `test` del `package.json`.
- Gestor de paquetes: pnpm, npm o yarn (se detecta por el lockfile). Solo se usa para el fallback y para instalar dependencias en la base con `--baseline` (con pnpm es rápido: reutiliza el store).

## Instalación

```bash
# Skill (elegí el directorio de config que uses: ~/.claude, ~/.claude-personal, ~/.claude-work)
ln -s ~/Proyects/claude-skills/quiet-checks ~/.claude-personal/skills/quiet-checks

# Comandos en el PATH (qrun es el mismo script con otro nombre)
ln -sf ~/Proyects/claude-skills/quiet-checks/scripts/qcheck.mjs ~/.local/bin/qcheck
ln -sf ~/Proyects/claude-skills/quiet-checks/scripts/qcheck.mjs ~/.local/bin/qrun
```

### Configuración recomendada de Claude Code (opcional)

Agregá lo que quieras de esto al `settings.json` de tu config (o a `.claude/settings.json` de un proyecto para activarlo solo ahí):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "qcheck guard", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "qcheck hook", "timeout": 120 }]
      }
    ]
  },
  "permissions": {
    "deny": [
      "Read(**/pnpm-lock.yaml)",
      "Read(**/package-lock.json)",
      "Read(**/yarn.lock)",
      "Read(**/dist/**)",
      "Read(**/build/**)",
      "Read(**/coverage/**)",
      "Read(**/.next/**)"
    ]
  }
}
```

**Guard (`qcheck guard`)** — bloquea y redirige:

| Si Claude corre… | Le indica usar |
|---|---|
| `pnpm test`, `vitest`, `jest` | `qcheck test` |
| `playwright test`, `pnpm test:e2e` | `qcheck e2e` |
| `pnpm lint`, `eslint` | `qcheck lint` |
| `tsc`, `pnpm typecheck` | `qcheck types` |
| `pnpm build`, `pnpm install`/`add`, `docker build`, `docker compose up`, `gradlew`, `xcodebuild`, `pod install`, `expo prebuild`, `cdk synth`/`diff`, `prisma generate`/`migrate`, `terraform plan` | `qrun -- <el mismo comando>` |

Detecta el comando aunque esté en una cadena (`cd api && pnpm test`) o con variables delante (`CI=1 pnpm test`). No toca `--version`/`--help` ni comandos como `git commit -m "pnpm test"`. Si alguna vez querés el output completo, pedíselo a Claude: antepone `QCHECK_RAW=1` y el guard lo deja pasar.

**Al editar (`qcheck hook`)**
- Si el archivo editado no es JS/TS, o no tiene errores, no dice nada (0 tokens).
- El typecheck usa `tsc --incremental`: la primera vez tarda lo que tarde tu proyecto, después es rápido. Para desactivar solo el typecheck: `QCHECK_HOOK_TYPES=0`.

**`permissions.deny`** — impide que Claude lea con sus herramientas de archivos los lockfiles y las carpetas generadas, que son enormes y casi nunca aportan. No bloquea `cat` por Bash. Los snapshots de tests quedan afuera a propósito: Claude a veces necesita leerlos para actualizarlos.

### Instrucción para el CLAUDE.md del proyecto (opcional)

La skill se activa sola, y con el guard no hace falta; sin el guard, esto lo asegura:

```markdown
## Tests, lint y comandos largos
Usá `qcheck` (skill quiet-checks) en vez de `pnpm test`, `pnpm lint` o `tsc` directo, y `qrun -- <comando>` para builds, installs y docker.
Para saber si un fallo ya existía, usá `qcheck <check> --baseline`; nunca hagas stash para comprobarlo.
```

## Uso

Le pedís a Claude lo de siempre (*"corré los tests"*, *"fijate si buildea"*, *"¿esto ya fallaba en develop?"*) y usa estos comandos. También podés correrlos vos:

```bash
qcheck all                          # lint + types + test
qcheck test --baseline              # qué fallos son nuevos respecto a la rama de origen
qcheck test -- src/math.test.ts     # un solo archivo (args van a vitest/jest)
qcheck e2e -- -g "checkout"         # playwright, filtrado
qcheck lint -- src/api              # lint de una carpeta
qcheck types --base release/1.2 --baseline   # otra rama base

qrun -- pnpm build
qrun -- "docker compose build && docker compose up -d"
qrun --until "listening on|ready in" --timeout 90 -- pnpm dev   # ¿arranca? lo detiene al estar listo
```

Ejemplos de salida:

```
✓ lint   sin errores
✗ types  1 nuevos · 0 ya fallaban en develop @ b86ca0a (rama de origen) · log: .git/qcheck/last-types.log
  NUEVOS (causados por los cambios actuales):
  TS2322: Type 'string' is not assignable to type 'number'.
    src/math.ts:4
✗ test   1 nuevos · 1 ya fallaban en develop @ b86ca0a (rama de origen) · log: .git/qcheck/last-test.log
  NUEVOS (causados por los cambios actuales):
  ✗ src/math.test.ts > math multiplies
    AssertionError: expected 5 to be 6 // Object.is equality
        at src/math.test.ts:5:44
  Preexistentes (no son de estos cambios): src/math.test.ts > math legacy broken
```

```
# (el de Gradle es ilustrativo)
✓ node server.mjs · listo en 0.8s (detenido) · log: .git/qcheck/last-run-node-server-mjs.log
    Server listening on http://localhost:3000

✗ ./gradlew assembleDebug · código 1 · 84.2s · log: .git/qcheck/last-run-gradlew-assembleDebug.log
    > Task :app:compileDebugKotlin FAILED
    e: MainActivity.kt:42:5 Unresolved reference: foo
    ⋮
    FAILURE: Build failed with an exception.
  Final del log:
    BUILD FAILED in 1m 24s
```

### Qué rama usa `--baseline` como base

1. La rama de la que salió la actual, según el reflog local (`git switch -c`, `checkout -b`, `git branch X Y`). Funciona también con ramas apiladas (una feature que salió de otra feature).
2. Si no hay registro (la rama la bajaste del remote, o pasaron más de ~90 días), `develop` y si no `dev`, primero en `origin/`. Nunca `main`.
3. `--base <ref>` para elegirla a mano.

La salida indica cuál usó: `(rama de origen)`, `(por defecto)` o `(--base)`. No hace `git fetch`: compara contra tu copia local de `origin/…`.

## Limitaciones conocidas

- Bun y Yarn Plug'n'Play no están soportados (con PnP no hay `node_modules/.bin`).
- Monorepos: corré `qcheck` desde la carpeta del paquete.
- `qrun` detecta errores por palabras clave (`error`, `failed`, `ERR!`, `exception`…); si una herramienta usa otro formato, igual muestra el final del log.

## Otras ideas para ahorrar tokens (no incluidas)

- `BASH_MAX_OUTPUT_LENGTH` en el `env` de `settings.json`: tope de caracteres al output de cualquier comando.
- Correr solo tests afectados por los cambios (`qcheck test -- --changed develop` en vitest, `-- --changedSince=develop` en jest).
