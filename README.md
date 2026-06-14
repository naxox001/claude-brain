# 🧠 claude-brain

Un **cerebro de memoria persistente** para Claude Code (u otros agentes): markdown soberano,
índice jerárquico que **no crece linealmente en tokens**, grafo de conocimiento navegable en 3D,
y consolidación + respaldo **automáticos en background** — sin servidores, sin base de datos
externa, sin dependencias npm.

> Nació reemplazando un sistema de 7 capas (2 vector stores, 2 plugins conversacionales, journal,
> markdown duplicado) que costaba ~7.200 tokens fijos por sesión y crecía sin techo. El resultado:
> una **parte generada del índice de ~2.600 tokens que crece O(dominios), no O(memorias)** (reglas
> duras + 1 línea por dominio), una sola fuente de verdad, y todo regenerable. La sección Inbox del
> índice es transitoria y la drena el mantenedor; el detalle por dominio se carga bajo demanda.

## Por qué

Las "memorias" de agente suelen fallar de dos formas: o inyectan demasiado en cada sesión
(el índice crece hasta chocar el límite de contexto y se trunca en silencio), o esconden el
conocimiento en un vector store opaco que se desincroniza. `claude-brain` evita ambas:

- **Lo que se inyecta cada sesión es O(dominios), no O(memorias).** Un índice generado (`N0`)
  con tope duro: identidad + reglas duras + 1 línea por dominio. El detalle se carga bajo demanda.
- **El markdown es la fuente de verdad.** El índice, el grafo SQLite y el mapa 3D son DERIVADOS:
  si se borran o corrompen, se regeneran en segundos. Nada vive solo en un binario.
- **Nada se borra.** Lo cerrado se archiva (sigue grep-able y versionado en git), no se destruye.

## Anatomía (mapeo a un cerebro)

| Cerebro | Sistema | Implementación |
|---|---|---|
| Neurona | Nodo `.md` con frontmatter v3 | `memory/*.md` |
| Sinapsis | Relación tipada | `[[wikilinks]]` + `superseded_by` + `relates` |
| Corteza (largo plazo) | 3 niveles: N0 índice / N1 digests / N2 corpus | `MEMORY.md` · `digests/` · `*.md` + `archivo/` |
| Recuerdo asociativo | Grafo + expansión de 1 salto | `graph.mjs` (SQLite `node:sqlite` + FTS5) |
| Sueño (consolidación) | Job nocturno | `consolidate.mjs` (`claude -p`, con auto-rollback) |
| Poda sináptica | Job semanal | `maintain.mjs` (archiva cerrados, respalda, valida) |
| Mapa mental | Visor 3D | `visor/index.html` (3d-force-graph) |

## Componentes

- **`brain.mjs`** — `render-index` (genera el N0), `validate` (estructura, wikilinks, contradicciones: un nodo `vigente` con `superseded_by` se marca como error), `add`, `normalize`, `drain-inbox`, `capture`, `note` (captura intra-sesión instantánea), `refresh-graph` (regenera el grafo del visor).
- **`graph.mjs`** — `build` (grafo en SQLite), `query` (FTS5 + vecindario de 1 salto), `export-3d` (JSON para el visor).
- **`lib.mjs`** — fuente única del parser v3 (`parseFrontmatter`/`parseScalar`, importado por `brain.mjs` y `graph.mjs`) + escritura atómica (`writeAtomic`, tmp+rename) de los derivados.
- **`maintain.mjs`** — mantenedor semanal determinista: valida, escanea secretos (redactados), archiva cerrados >60d, regenera derivados, respalda, genera `SYSTEM-STATE.md`.
- **`consolidate.mjs`** — consolidador nocturno: integra notas de `inbox/` a los digests vía `claude -p`. Corre en un **git-worktree efímero** nacido en HEAD limpio (el LLM aislado con `cwd=WT` + `BRAIN_MEM=WT`), valida ahí (validate, gate diferencial, secretos excl. `inbox/`, magnitud) y **fusiona de vuelta sólo los digests/nodos** al MEM con *aplicar-directo-o-diferir*: si algún archivo destino tiene WIP humano sin commitear, **difiere todo** (fail-closed) y deja las notas en cola; si no, aplica directo. Commitea por **pathspec explícito** (jamás absorbe WIP humano pre-stageado) y drena el inbox sólo tras commit OK. Sentinela de idempotencia ante crash. **Ya no se posterga por WIP de otra sesión.**
- **`install.mjs`** / **`restore.mjs`** — instalación de 1 comando y restauración de datos desde backup.
- **`visor/index.html`** — mapa cerebral 3D interactivo.

## Requisitos

- **Node ≥ 22.5** (usa `node:sqlite` —llegó en 22.5, experimental en la serie 22.x— y `fs.cpSync`; **cero dependencias npm**). **Recomendado Node 24+** donde `node:sqlite` es estable.
- git. Opcional: `claude` CLI (solo para el consolidador nocturno) y un scheduler (Task Scheduler en Windows; cron/launchd en macOS/Linux — ver nota más abajo).

## Instalación

```bash
git clone <este-repo> ~/projects/claude-brain
# 1) descubre tu <slug> (Claude Code codifica el HOME: cada caracter no-alfanumérico -> '-'):
node -e "console.log((process.env.USERPROFILE||process.env.HOME).replace(/[^a-zA-Z0-9]/g,'-'))"
# 2) clona tus datos a esa ruta (reemplaza <slug> por lo que imprimió el paso 1):
git clone <tu-repo-privado-de-memoria> ~/.claude/projects/<slug>/memory
node ~/projects/claude-brain/install.mjs
```

> El `<slug>` no es trivial de calcular a mano (sobre todo en Windows, donde codifica `C:\Users\tu` → `C--Users-tu`); el one-liner de arriba lo imprime exacto. Alternativa: corre `node ~/projects/claude-brain/install.mjs --dry-run` primero — imprime `MEM=` con la ruta resuelta.

`install.mjs` escribe `~/.claude/brain.json`, instala el hook de health-check, cablea el
`SessionStart` en `settings.json` (idempotente), genera los derivados y registra las tareas
programadas. Reinicia Claude Code para cargar el hook.

## Probar sin datos (demo)

```bash
node brain.mjs validate    --mem example/memory   # 7 nodos, 0 errores
node brain.mjs render-index --mem example/memory   # genera el N0 de ejemplo
node graph.mjs export-3d   --mem example/memory   # genera visor/graph.json
# servir y abrir el visor:
cd visor && python -m http.server 8777   # -> http://localhost:8777
```

## Uso diario

- **Escribir memoria (recomendado):** `node brain.mjs add --name <slug> --domain <dom> --desc "una línea"` genera el frontmatter v3 canónico por ti (sin tener que recordarlo). También puedes crear el `.md` a mano (ver `example/`) o dejar una nota cruda en `memory/inbox/`.
- **Captura intra-sesión (instantánea):** `node brain.mjs note --text "<memoria durable>"` deposita una nota durable ya curada en `inbox/` al instante (dedup, cero-LLM, no toca git); el consolidador la integra en su próxima corrida. Baja la latencia de captura de ~24 h a milisegundos.
- **Reparar nodos mal formados:** `node brain.mjs normalize` arregla nodos sin frontmatter v3 (p. ej. los que escribe la memoria automática nativa del harness); usa `--dry-run` para ver primero.
- **Buscar:** `node graph.mjs query "tu consulta"` (semántico + vecindario), o `grep` directo sobre `memory/`.
- **Regenerar el índice:** `node brain.mjs render-index` (lo hace solo el mantenedor semanal).
- **Validar / ver salud:** `node brain.mjs validate` (también corre en cada inicio de sesión vía el hook).
- **Ver el cerebro:** abre el visor.

El resto corre **en background, semi-automático**: un hook `Stop` (`brain.mjs capture`) deposita un puntero de cada sesión en `inbox/` (gitignored, no ensucia el árbol); el **consolidador nocturno** lee esos punteros + sus transcripts (y las notas de `note`) y extrae memorias durables a los digests; el **mantenedor semanal** valida, normaliza nodos mal formados, drena la sección Inbox del índice, archiva cerrados, poda `inbox/.procesadas/` y worktrees huérfanos, y respalda. Todo **serializado con un lock**. El consolidador ya **no se posterga por WIP de otra sesión**: corre en un git-worktree aislado y sólo **difiere** las notas cuyo digest destino tenga WIP humano sin commitear (fail-closed), preservando ese WIP. El **grafo del visor** se refresca al escribir un nodo (`add`/`refresh-graph`) y en cada corrida de los jobs.

> **Deferido a propósito** (ver auditorías): flip completo al formato nativo como entrada (medir frecuencia primero); embeddings locales como re-ranker (solo si BM25 resulta insuficiente); un watcher 24/7 para refrescar el grafo en tiempo real (hoy se refresca al escribir, sin demonio).

> **Multiusuario / multi-sesión y memoria nativa:** el cerebro vive en el mismo directorio que la memoria automática del harness, que puede escribir nodos sin el formato v3. El hook de inicio corre `validate` y te avisa; corre `normalize` para reparar. Los jobs automáticos nunca tocan trabajo sin commitear de otra sesión.

## Automatización en macOS / Linux

El installer registra las tareas automáticas **solo en Windows** (Task Scheduler). En macOS/Linux, agrega tú las líneas de cron (los `.cmd` no aplican; llama a `node` directo):

```cron
0 4 * * *  /ruta/a/node /ruta/a/claude-brain/consolidate.mjs   # consolidador diario
0 5 * * 0  /ruta/a/node /ruta/a/claude-brain/maintain.mjs      # mantenedor semanal
```

El destino de backup es configurable en `~/.claude/brain.json` (`"backupDir": "..."`); por defecto `G:/respaldo-memoria-claude` (Windows).

### Qué respalda (y qué no)

Sé honesto con la cadencia real de respaldo:

- **Markdown + código:** se copian al `backupDir` en **cada `maintain` (semanal)**. Es lo que reconstruye el cerebro en otra máquina.
- **Memoria episódica / transcripts pesados:** **solo** vía tarball (ahora con rotación — ver el fix de `maintain`); no se copian sueltos en cada corrida.
- **Transcripts referenciados por punteros** (los que deja el hook `capture` en `inbox/`): son **referencias, no copias** — **NO se respaldan** salvo que entren explícitamente al backup frío (tarball). Si pierdes los transcripts originales, el consolidador ya no podrá re-extraer de ellos.

En resumen: el backup garantiza markdown + código (la fuente de verdad y todo lo regenerable); la episódica queda cubierta solo por el tarball rotado; los transcripts crudos quedan fuera mientras vivan únicamente como punteros.

## Frontmatter v3

```yaml
---
name: <igual-al-filename-sin-.md>
description: <una línea — esto es lo que viaja al índice>
metadata:
  type: user|feedback|project|reference|handoff
  domain: <dominio>            # agrupa en "lóbulos"
  status: vigente|cerrado|pausado
  valid_from: 2026-01-01
  importance: 1-5              # 5 = regla dura, siempre en el N0
  superseded_by: <otro-nodo>   # opcional: marca contradicciones/reversiones
---
```

## Garantías de diseño

- **Tokens acotados:** el N0 avisa (WARNING) si supera el cap blando (7168 bytes) y el hook de inicio lo señala; la compactación es **manual** (editar descriptions/reglas y regenerar, o dejar que el mantenedor drene el Inbox). El harness trunca por encima de 25000 bytes (techo duro real). La parte generada (reglas + 1 línea/dominio) crece O(dominios).
- **Cero pérdida:** cerrados → `archivo/` (git, grep-able); los wikilinks resuelven cross-directorio.
- **Portable:** una copia de `memory/` + un `git clone` reconstruyen todo en otra máquina (ensayado).
- **Auditable:** cada corrida autónoma es 1 commit git; el consolidador se auto-revierte si rompe la estructura.

## Filosofía

El estado del arte en memoria de agentes (Letta/MemGPT, Zep/Graphiti, Mem0) tiende a agregar
motores: vector DBs, grafos con servidor, demonios. Este proyecto va al revés: **el markdown que
ya escribes es el cerebro**; los motores son índices derivados y desechables encima. Menos piezas,
menos drift, migración trivial, y entendible de punta a punta.

## Licencia

MIT.
