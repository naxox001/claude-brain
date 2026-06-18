#!/usr/bin/env node
// consolidate.mjs — consolidador nocturno (el "sueño REM" del cerebro). Integra notas crudas de
// memory/inbox/ a los digests de dominio via claude -p headless. Pensado para correr a diario.
//
// SEGURIDAD (cero-regresion):
//  - NO-OP si inbox/ vacio (el caso comun): no invoca al LLM, no commitea.
//  - El LLM SOLO puede tocar digests/ e inbox/ (lo dice el prompt); nunca N0, cuerpos de nodos ni borrar.
//  - AUTO-ROLLBACK: si falla validate, el gate diferencial (borrado/MEMORY.md/cuerpo/vaciado de digest),
//    el escaneo de secretos, el LLM hace timeout, o falla la regeneracion/commit -> se revierte el scope
//    TRACKED del LLM (git checkout -- digests/) + se limpian SOLO los untracked nuevos del LLM + se re-encolan
//    las notas de inbox movidas. Preserva el WIP de otra sesion (NO usa reset --hard global). Alerta siempre.
//  - Cada corrida exitosa = 1 commit git (auditable y revertible con git revert).
// Uso: node consolidate.mjs [--dry-run]
import { readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveMem, BRAIN_DIR, acquireLock, releaseLock } from './brain.config.mjs';
import { writeAtomic } from './lib.mjs';
import { secretScan } from './maintain.mjs';

const DRY = process.argv.includes('--dry-run');
const MEM = resolveMem(null);
const BRAIN = BRAIN_DIR;
const INBOX = join(MEM, 'inbox');
const log = (...a) => console.log(DRY ? '[dry]' : '[run]', ...a);
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });
const hashStr = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16); };  // hash de contenido (sentinela)

function buildPrompt(digests, inboxPath = INBOX) {
  return [
    'Eres el consolidador nocturno del cerebro de memoria (sueno REM). Espanol neutro chileno, nunca voseo.',
    `Hay notas crudas en ${inboxPath}. Para cada una: decide a que dominio pertenece (digests disponibles: ${digests.join(', ')}),`,
    // Rutas RELATIVAS al cwd (=WT, la raiz de la capa de memoria); no hay subdir 'memory/' aqui (fix audit round-3).
    'integra su contenido al digest de ese dominio en digests/<dominio>.md (seccion adecuada: Vigente ahora / Pendientes / Detalle), deduplicando.',
    'Las notas son CURADAS (_note_*.md / _pending_*.md): memoria durable lista para integrar. Los _session_*.md NO llegan aca (el consolidador los archiva sin leer; episodic-memory es el indexador conversacional). NUNCA abras un transcript .jsonl. Integra cada nota directo al digest del dominio que corresponda.',
    'Si una nota amerita un nodo propio, crea <prefijo>_<slug>.md en la raiz con frontmatter v3 (name==filename, domain, status, valid_from, importance). Si dudas del formato, copia el patron de un nodo .md existente en la raiz.',
    'REGLAS DURAS: NO edites MEMORY.md (es generado). NO borres ni reescribas cuerpos de nodos existentes. NO vacies ni recortes drasticamente un digest. NO toques nada fuera de digests/ y la raiz del repo (tu cwd).',
    'Al terminar, mueve cada nota procesada de inbox/ a inbox/.procesadas/ (crea el dir). No borres las notas.',
    'Se conservador: ante la duda, deja la nota en inbox/ sin tocar y registra por que.',
  ].join(' ');
}

// promueve las notas de staging _entrante_*.md a _note_*.md (Pieza 2). Se llama al INICIO de la corrida bajo
// el lock: las _entrante_ que existian quedan listas para ESTE ciclo; las que nazcan despues no entran (siguen
// como _entrante_ hasta el proximo). Idempotente y robusto: si ya existe el _note_ destino (dup), borra el _entrante_.
export function drainEntrante(inbox = INBOX) {
  let entr = [];
  try { entr = readdirSync(inbox).filter(f => f.startsWith('_entrante_') && f.endsWith('.md')); } catch { return 0; }
  let n = 0;
  for (const f of entr) {
    const src = join(inbox, f);
    const target = join(inbox, f.replace(/^_entrante_/, '_note_'));
    try { if (existsSync(target)) rmSync(src); else { renameSync(src, target); n++; } } catch { /* dejarla para el proximo ciclo */ }
  }
  return n;
}

function digestsOf(dir) {
  const dd = join(dir, 'digests');
  try { return existsSync(dd) ? readdirSync(dd).filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')) : []; } catch { return []; }
}

// --- worktree efimero (Pieza 1 realtime): el consolidador corre en un git-worktree nacido en HEAD LIMPIO,
// asi opera AUNQUE el MEM tenga WIP humano sin commitear (antes el gate de arbol-sucio lo posterga). El LLM
// JAMAS ve el WIP (cwd=WT + BRAIN_MEM=WT). Al terminar se fusionan de vuelta SOLO los digests/nodos por
// archivo (aplicar-directo-o-diferir), preservando el WIP. El WT vive en tmpdir (no ensucia MEM ni BRAIN).
function setupWorktree(head) {
  const WT = join(tmpdir(), `brain-wt-${process.pid}-${Date.now()}`);
  sh('git', ['-C', MEM, 'worktree', 'add', '--detach', WT, head], { stdio: 'ignore' });
  // copiar las notas (gitignored, no vienen en el checkout) EXCLUYENDO _entrante_ (staging aun no promovido): si
  // el LLM las viera podria integrar una nota que NO esta en la lista de drenado -> doble-integracion (audit-realtime #8/#11).
  try { if (existsSync(INBOX)) cpSync(INBOX, join(WT, 'inbox'), { recursive: true, filter: s => !basename(s).startsWith('_entrante_') }); } catch {}
  return WT;
}
function teardownWorktree(WT) {
  if (!WT) return;
  try { sh('git', ['-C', MEM, 'worktree', 'remove', '--force', WT], { stdio: 'ignore' }); }
  catch { try { rmSync(WT, { recursive: true, force: true }); } catch {} try { sh('git', ['-C', MEM, 'worktree', 'prune'], { stdio: 'ignore' }); } catch {} }
}

// drena el inbox REAL (mueve las notas procesadas a .procesadas/). Solo se llama TRAS un commit OK (cero perdida).
function drainReal(notes) {
  const proc = join(INBOX, '.procesadas'); try { mkdirSync(proc, { recursive: true }); } catch {}
  for (const n of notes) { try { const src = join(INBOX, n); if (existsSync(src)) renameSync(src, join(proc, n)); } catch {} }
}

// SENTINELA de idempotencia: si una corrida escribio en MEM y crasheo antes de commitear, el re-run revierte
// exactamente esos paths antes de re-consolidar (evita doble-integracion). Respalda antes de revertir.
const SENTINEL = join(BRAIN, 'last-consolidate.json');
function writeSentinel(head, paths) { try { writeFileSync(SENTINEL, JSON.stringify({ head, paths, ts: Date.now() })); } catch {} }
function clearSentinel() { try { if (existsSync(SENTINEL)) rmSync(SENTINEL); } catch {} }
function recoverFromSentinel() {
  let s; try { s = JSON.parse(readFileSync(SENTINEL, 'utf8')); } catch { return; }
  let head; try { head = sh('git', ['-C', MEM, 'rev-parse', 'HEAD']).trim(); } catch { clearSentinel(); return; }
  if (!s || s.head !== head) { clearSentinel(); return; }  // HEAD avanzo o sentinela ajeno: no aplica
  const bdir = join(BRAIN, 'rollback-backups', 'sentinel-' + Date.now());
  let preserved = 0;
  for (const e of (s.paths || [])) {
    const p = typeof e === 'string' ? e : e.p, hash = typeof e === 'string' ? null : e.hash;
    const memP = join(MEM, p);
    let cur = null; try { cur = readFileSync(memP, 'utf8'); } catch {}
    try { if (cur !== null) { mkdirSync(dirname(join(bdir, p)), { recursive: true }); cpSync(memP, join(bdir, p)); } } catch {}  // respaldo SIEMPRE
    // si el contenido actual NO es lo que escribio la corrida crasheada (hash distinto), un HUMANO lo edito encima
    // -> NO revertir (preservar su WIP); el respaldo ya quedo. Si coincide (o desaparecio), revertir es seguro (audit-realtime #3/#20).
    if (hash && cur !== null && hashStr(cur) !== hash) { preserved++; continue; }
    try { sh('git', ['-C', MEM, '-c', 'core.quotepath=false', 'checkout', '--', p]); }      // revierte tracked a HEAD
    catch { try { rmSync(memP, { force: true }); } catch {} }                                // nodo nuevo (untracked): borrar
  }
  clearSentinel();
  if (preserved) alert(`recuperacion: ${preserved} path(s) con edicion humana posterior al crash NO se revirtieron (preservados; respaldo en ${bdir})`);
  log('recuperacion: cambios de una consolidacion crasheada previa procesados (respaldo en ' + bdir + ')');
}

// fusiona los cambios del WT (commit C) de vuelta al MEM. APLICAR-DIRECTO-O-DIFERIR (all-or-nothing): si ALGUN
// digest/nodo destino esta DIRTY en el MEM (humano editandolo), se difiere TODO (fail-closed) y las notas quedan
// en cola. Sin colisiones, cada target del MEM == HEAD == base, asi que se aplica la version del WT directo.
function mergeBack(head, WT) {
  const changed = sh('git', ['-C', WT, '-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=ACMR', head, 'HEAD'])
    .split('\n').map(s => s.trim()).filter(p => p && (p.startsWith('digests/') || (p.endsWith('.md') && !p.includes('/'))));
  if (!changed.length) return { applied: [], conflict: null };
  for (const p of changed) {  // detectar colisiones SIN escribir
    let dirty = false;
    try { dirty = sh('git', ['-C', MEM, '-c', 'core.quotepath=false', 'status', '--porcelain', '--', p]).trim() !== ''; } catch {}
    if (dirty) return { applied: [], conflict: p };
  }
  const entries = [];
  for (const p of changed) { const theirs = join(WT, p); if (existsSync(theirs)) entries.push({ p, content: readFileSync(theirs, 'utf8') }); }
  writeSentinel(head, entries.map(e => ({ p: e.p, hash: hashStr(e.content) })));  // ANTES de escribir: {p, hash} para distinguir luego nuestro write de una edicion humana
  const applied = [];
  for (const e of entries) { const memP = join(MEM, e.p); mkdirSync(dirname(memP), { recursive: true }); writeAtomic(memP, e.content); applied.push(e.p); }
  return { applied, conflict: null };
}

function main() {
  if (!existsSync(INBOX)) { log('inbox/ no existe — nada que consolidar'); return; }
  if (DRY) {
    const notes = readdirSync(INBOX).filter(f => f.endsWith('.md') && !f.startsWith('_entrante_'));
    if (!notes.length) { log('inbox/ vacio — no-op (no se invoca LLM)'); return; }
    log('DRY: consolidaria', notes.length, 'nota(s) en un git-worktree aislado y fusionaria los digests de vuelta'); return;
  }
  const lock = acquireLock();
  if (!lock) { log('otro job tiene el lock (.brain.lock fresco) — abort para no solapar'); return; }
  try {
    // MEM debe ser repo git con al menos un commit (el worktree lo requiere). ABORT LIMPIO si no (audit#5 #8).
    try { sh('git', ['-C', MEM, 'rev-parse', 'HEAD']); } catch { log('MEM no es repo git o sin commits — ABORT (no tocar)'); return; }
    recoverFromSentinel();   // limpia una consolidacion crasheada previa (idempotencia)
    drainEntrante();         // promueve _entrante_ -> _note_ bajo el lock (Pieza 2)
    const allNotes = readdirSync(INBOX).filter(f => f.endsWith('.md') && !f.startsWith('_entrante_'));
    if (!allNotes.length) { log('inbox/ vacio — no-op (no se invoca LLM)'); return; }
    // Opcion A (fix 2026-06-18): los _session_*.md son PUNTEROS a transcripts .jsonl de hasta ~28MB que
    // NO caben en la ventana de claude -p (causaba ETIMEDOUT en cada corrida, sin progreso). episodic-memory
    // ya es el unico indexador conversacional -> los _session se ARCHIVAN sin re-leer; al LLM solo van las
    // notas CURADAS (_note/_pending), que ya son memoria durable lista para integrar.
    const sessionNotes = allNotes.filter(f => f.startsWith('_session_'));
    const curated = allNotes.filter(f => !f.startsWith('_session_'));
    if (sessionNotes.length) {
      drainReal(sessionNotes);
      log(`archivadas ${sessionNotes.length} nota(s) _session sin leer (episodic-memory las indexa)`);
    }
    if (!curated.length) { log('sin notas curadas (_note/_pending) — no-op (no se invoca LLM)'); return; }
    log(`inbox: ${curated.length} nota(s) curada(s) -> ${curated.join(', ')}`);
    runConsolidation(curated, null);
  } finally { releaseLock(lock); }
}

// buildClaudeInvocation — arma el comando de `claude -p` del consolidador. Extraido para test + para BLINDAR el
// fix del cuelgue (2026-06-18, hallado por debug sistematico): el `claude -p` headless HEREDABA la config
// INTERACTIVA de la maquina (model Opus[1m] + effortLevel xhigh + alwaysThinking + ~27 MCP servers), lo que
// disparaba un razonamiento (thinking) que NUNCA convergia a las ediciones dentro del timeout (ni en 600s) ->
// `spawnSync claude ETIMEDOUT` en cada corrida, sin integrar nada. El fix:
//   --model <rapido>      : NO heredar Opus[1m]; default 'haiku' (rapido/barato, calidad verificada en repro),
//                           override por BRAIN_LLM_MODEL (p.ej. 'sonnet').
//   --strict-mcp-config   : no cargar los MCP del usuario (decenas de connectors inutiles para consolidar texto).
//   MAX_THINKING_TOKENS=0 : APAGA el thinking extendido (la causa raiz). Decisivo.
// Mantiene los flags de seguridad (permission-mode acotado + allow/deny tools) y stdio:'ignore'.
export function buildClaudeInvocation(WT, prompt) {
  const model = process.env.BRAIN_LLM_MODEL || 'haiku';
  return {
    args: ['--model', model, '--strict-mcp-config', '--permission-mode', 'default',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--disallowedTools', 'Bash,WebFetch,WebSearch', '-p', prompt],
    opts: { cwd: WT, timeout: 600000, stdio: 'ignore',
      env: { ...process.env, BRAIN_CONSOLIDATING: '1', BRAIN_MEM: WT, MAX_THINKING_TOKENS: '0' } },
  };
}

// runConsolidation: corre el LLM en un worktree AISLADO, valida ahi, y fusiona los digests de vuelta al MEM
// preservando el WIP humano. llmStep inyectable (tests): si se pasa, reemplaza el spawn de 'claude' (recibe el WT).
export function runConsolidation(notes, llmStep) {
  const head = sh('git', ['-C', MEM, 'rev-parse', 'HEAD']).trim();
  let WT;
  try {
    WT = setupWorktree(head);
    // 1) LLM en el WORKTREE: cwd=WT y BRAIN_MEM=WT (CRITICO: sin el override de BRAIN_MEM, resolveMem prioriza
    //    env/brain.json sobre el cwd y el LLM tocaria el MEM REAL con WIP — el split-brain del audit). Mismos
    //    flags de seguridad + BRAIN_CONSOLIDATING=1. El prompt referencia el inbox del WT.
    try {
      if (llmStep) { llmStep(WT); }
      else {
        const prompt = buildPrompt(digestsOf(WT), join(WT, 'inbox'));
        log('invocando claude -p (headless) en worktree…');
        const inv = buildClaudeInvocation(WT, prompt);
        sh('claude', inv.args, inv.opts);
      }
    } catch (e) { log('claude -p fallo o timeout — se descarta el worktree (nada en el MEM):', (e.message || '').slice(0, 70)); alert('consolidador: claude -p fallo o timeout (revisar login/creditos/red)'); return; }

    // 2) GATES sobre el WT (nacio limpio: los untracked son del LLM, untrackedBefore=[])
    try { sh('node', [join(BRAIN, 'brain.mjs'), 'validate', '--mem', WT]); }
    catch { log('VALIDATE FALLO en el worktree — se descarta'); alert('consolidador rompio validate (en worktree); descartado'); return; }
    const viol = diffViolations(head, [], WT);
    if (viol.length) { log('GATE DIFERENCIAL (worktree) — se descarta:'); viol.slice(0, 3).forEach(v => log('   ' + v)); alert('consolidador violo el contrato (worktree); descartado: ' + viol.slice(0, 3).join(' | ')); return; }
    // secretScan EXCLUYE inbox/ (audit-realtime #12): las notas crudas son INSUMO del usuario, no algo que el LLM
    // escribio. Sin esto, una nota con texto tipo-secreto descartaba la consolidacion en CADA ciclo -> stall permanente.
    const secrets = secretScan(WT, ['inbox']);
    if (secrets.length) { log(`SECRETOS en el worktree (${secrets.length}) — se descarta`); secrets.slice(0, 3).forEach(h => log(`   ${h.kind} ${h.file}:${h.line} ${h.sample}`)); alert(`consolidador integro ${secrets.length} secreto(s) (worktree); descartado`); return; }

    // 3) commit en el WT (HEAD comparable). add -A es seguro: el WT esta AISLADO, sin WIP humano.
    sh('git', ['-C', WT, 'add', '-A']);
    if (!sh('git', ['-C', WT, 'status', '--porcelain']).trim()) { log('el LLM no integro nada durable — no-op; se drenan las notas'); drainReal(notes); return; }
    sh('git', ['-C', WT, '-c', 'user.name=brain-consolidator', '-c', 'user.email=brain@local', 'commit', '-q', '-m', 'wt-consolidate']);

    // 4) RE-LEER HEAD del MEM: si avanzo durante la corrida (maintain/humano commiteo), el WT nacio en un head
    //    viejo -> diferir y reintentar el proximo ciclo (las notas siguen en cola).
    if (sh('git', ['-C', MEM, 'rev-parse', 'HEAD']).trim() !== head) { log('HEAD del MEM avanzo durante la corrida — notas diferidas al proximo ciclo'); alert('consolidador: HEAD avanzo durante la corrida; notas diferidas'); return; }

    // 5) MERGE-BACK: aplicar-directo-o-diferir (preserva WIP humano)
    const { applied, conflict } = mergeBack(head, WT);
    if (conflict) { log(`colision con WIP humano en ${conflict} — notas diferidas al proximo ciclo (fail-closed)`); alert(`consolidador: colision con WIP humano en ${conflict}; notas diferidas`); return; }
    if (!applied.length) { log('nada que aplicar — no-op; se drenan las notas'); clearSentinel(); drainReal(notes); return; }

    // 6) regenerar derivados + commit por PATHS EXPLICITOS; drenar el inbox SOLO tras commit OK (cero perdida)
    try {
      sh('node', [join(BRAIN, 'brain.mjs'), 'render-index', '--mem', MEM]);
      sh('node', [join(BRAIN, 'graph.mjs'), 'build', '--mem', MEM]);
      sh('node', [join(BRAIN, 'graph.mjs'), 'export-3d', '--mem', MEM]);
      const stage = [...applied, 'MEMORY.md'];
      if (existsSync(join(MEM, 'archivo', 'CATALOGO.md'))) stage.push('archivo/CATALOGO.md');
      // stagear SOLO los paths del consolidador (el add tracked-iza los untracked: nodos nuevos, CATALOGO) y COMMIT por
      // PATHSPEC EXPLICITO: 'commit -- <paths>' persiste SOLO esos e IGNORA cualquier WIP humano PRE-STAGEADO en el index
      // (verificado empiricamente: un nodo humano pre-stageado queda staged y NO entra al commit). Nunca add -A ni commit
      // sin pathspec (eso absorberia el WIP ajeno) (audit-realtime #1).
      for (const p of stage) { try { sh('git', ['-C', MEM, 'add', '--', p]); } catch {} }
      sh('git', ['-C', MEM, '-c', 'user.name=brain-consolidator', '-c', 'user.email=brain@local', 'commit', '-q', '-m', `consolidate: ${notes.length} nota(s) integradas (${new Date().toISOString().slice(0, 10)})`, '--', ...stage]);
    } catch (e) {
      log('FALLO regenerando/commiteando tras el merge — revirtiendo aplicados + derivados (notas NO drenadas, en cola):', (e.message || '').slice(0, 70));
      for (const p of [...applied, 'MEMORY.md', 'archivo/CATALOGO.md']) { try { sh('git', ['-C', MEM, '-c', 'core.quotepath=false', 'checkout', '--', p]); } catch { try { rmSync(join(MEM, p), { force: true }); } catch {} } }
      clearSentinel(); alert('consolidador: fallo tras el merge; revertido (digests+derivados); notas en cola'); return;
    }
    clearSentinel();
    drainReal(notes);  // recien tras commit OK: si crashea entre commit y aca, las notas se re-procesan (el LLM deduplica)
    try { sh('git', ['-C', MEM, 'push', '-q', 'origin', 'main']); log('push OK'); } catch (pe) { log('push fallo (commit local conservado):', (pe.message || '').slice(0, 50)); }
    log(`consolidacion OK: ${applied.length} archivo(s) aplicado(s), ${notes.length} nota(s) integradas`);
  } catch (e) {
    // fallo INESPERADO (git worktree add, commit del WT, re-parse HEAD, etc.) antes de un return-con-alert: sin
    // este catch la excepcion cruda crasheaba el job SIN escribir CONSOLIDATOR-ALERT (audit-realtime #6).
    log('consolidador: fallo inesperado (git/worktree):', (e.message || '').slice(0, 80));
    alert('consolidador: fallo inesperado (' + (e.message || '').slice(0, 100) + ')');
  } finally { teardownWorktree(WT); }
}

// detecta cambios FUERA del contrato del consolidador (vs HEAD pre-LLM)
// Fix audit#4 (P1 gate ciego a untracked): 'git diff HEAD' (sin --cached) NO ve archivos nuevos
// (untracked) que el LLM haya creado fuera de digests/ e inbox/. SIN mutar el index (no 'git add':
// stagear absorberia los untracked del humano y un reset --hard posterior los destruiria), unimos:
//   - 'git diff --name-status HEAD' -> cambios sobre archivos TRACKED (D/M/R).
//   - 'git ls-files --others --exclude-standard' menos untrackedBefore -> archivos NUEVOS del LLM (A).
// Un .md nuevo en raiz sin frontmatter v3 valido tambien es violacion.
export function diffViolations(head, untrackedBefore, dir = MEM) {
  const viol = [];
  const classifyPath = (p) => {
    const inInbox = p.startsWith('inbox/');
    const inDigests = p.startsWith('digests/');
    // nodo valido en raiz: <prefijo>_<slug>.md con frontmatter v3 (name/domain/status/valid_from/importance)
    const isRootMd = p.endsWith('.md') && !p.includes('/');
    return { inInbox, inDigests, isRootMd };
  };
  // 1) cambios sobre archivos tracked. core.quotepath=false (audit#5 #16): sin el, un path no-ASCII sale
  //    quoteado ("project_cami\303\263n.md") y classifyPath lo clasifica mal -> rollback espurio.
  const out = sh('git', ['-C', dir, '-c', 'core.quotepath=false', 'diff', '--name-status', head]);
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [st, ...rest] = line.split('\t');
    const p = rest.join('\t');
    const { inInbox, inDigests } = classifyPath(p);
    if (p === 'MEMORY.md') viol.push('toco MEMORY.md (generado)');
    else if (st.startsWith('D') && !inInbox) viol.push('borro ' + p);
    else if (st.startsWith('M') && inDigests) {
      // editar un digest esta PERMITIDO; VACIARLO o recortarlo drasticamente NO (audit#5 #14): es perdida
      // de datos dentro de un archivo permitido que validate no detecta. Comparamos magnitud vs HEAD.
      try {
        const oldTxt = sh('git', ['-C', dir, 'show', `${head}:${p}`]);
        const newTxt = readFileSync(join(dir, p), 'utf8');
        const ol = oldTxt.split('\n').length, nl = newTxt.split('\n').length;
        if (nl < ol * 0.5 || newTxt.trim().length < 80) viol.push(`vacio/recorto >50% el digest ${p} (${ol}->${nl} lineas)`);
      } catch { /* no se pudo comparar (digest nuevo, etc.): no bloquear por esto */ }
    }
    else if (st.startsWith('M') && !inInbox) viol.push('reescribio cuerpo de ' + p);
    else if (st.startsWith('R') && !inInbox) viol.push('renombro ' + p);
  }
  // 2) archivos nuevos (untracked) que cree el LLM (excluyendo los que ya tenia el humano)
  const before = new Set(untrackedBefore || []);
  for (const p of listUntracked(dir)) {
    if (before.has(p)) continue; // del humano: no es del LLM, no se evalua aqui
    const { inInbox, inDigests, isRootMd } = classifyPath(p);
    if (inInbox || inDigests) continue; // permitido: nuevas notas movidas / nuevos digests
    if (isRootMd && validV3Node(p, dir)) continue; // permitido: nodo nuevo con frontmatter v3 valido
    viol.push('creo archivo no-permitido ' + p);
  }
  return viol;
}

// valida frontmatter v3 minimo de un nodo nuevo en raiz (name==filename + claves obligatorias)
function validV3Node(p, dir = MEM) {
  try {
    const txt = readFileSync(join(dir, p), 'utf8');
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return false;
    const fm = m[1];
    const expectedName = p.replace(/\.md$/, '');
    const nameOk = new RegExp(`(^|\\n)name:\\s*["']?${expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*(\\r?\\n|$)`).test(fm);
    // \\s* tras (^|\\n): las claves de metadata van INDENTADas (`  domain:`) (audit#5 test #7: sin esto
    // validV3Node rechazaba TODO nodo nuevo valido -> el consolidador haria rollback al crear un nodo).
    const hasAll = ['domain', 'status', 'valid_from', 'importance'].every(k => new RegExp(`(^|\\n)\\s*${k}:`).test(fm));
    return nameOk && hasAll;
  } catch { return false; }
}

// lista de archivos untracked (un path por linea) segun git, relativos a MEM
function listUntracked(dir = MEM) {
  try {
    return sh('git', ['-C', dir, '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'])
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Nota: snapshotInbox() y rollback() del flujo viejo (consolidar en el MEM real) se eliminaron al pasar al
// worktree (Pieza 1): el worktree es desechable, asi que no hay nada que revertir en el MEM salvo lo que
// mergeBack aplico (lo cubre el sentinela). reEnqueueInbox se conserva como utilidad (ejercida por los tests).

// re-escribe en inbox/ las notas snapshoteadas que ya no esten presentes (las que el LLM movio fuera y
// git no restauro por estar gitignored). Devuelve cuantas re-encolo. No toca .procesadas/ ni nada externo.
export function reEnqueueInbox(inboxBefore) {
  if (!inboxBefore || !inboxBefore.size) return 0;
  let n = 0;
  try { mkdirSync(INBOX, { recursive: true }); } catch {}
  for (const [name, content] of inboxBefore) {
    const dest = join(INBOX, name);
    if (existsSync(dest)) continue; // git ya la restauro o nunca se movio: no duplicar
    try {
      writeAtomic(dest, content); n++;
      // borrar la copia que el LLM dejo en .procesadas/ para no quedar con un huerfano duplicado (audit#5 #29).
      try { const proc = join(INBOX, '.procesadas', name); if (existsSync(proc)) rmSync(proc); } catch {}
    }
    catch (e) { log('   no pude re-encolar nota', name, '-', (e.message || '').slice(0, 50)); }
  }
  return n;
}
function alert(msg) { try { writeFileSync(join(BRAIN, 'CONSOLIDATOR-ALERT.txt'), `${new Date().toISOString()} ${msg}\n`); } catch {} }

if (process.argv[1] && process.argv[1].endsWith('consolidate.mjs')) main();
