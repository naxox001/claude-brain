#!/usr/bin/env node
// consolidate.mjs — consolidador nocturno (el "sueño REM" del cerebro). Integra notas crudas de
// memory/inbox/ a los digests de dominio via claude -p headless. Pensado para correr a diario.
//
// SEGURIDAD (cero-regresion):
//  - NO-OP si inbox/ vacio (el caso comun): no invoca al LLM, no commitea.
//  - El LLM SOLO puede tocar digests/ e inbox/ (lo dice el prompt); nunca N0, cuerpos de nodos ni borrar.
//  - AUTO-ROLLBACK: tras el LLM corre `brain.mjs validate`; si falla -> git checkout -- . (descarta) + alerta.
//  - Cada corrida exitosa = 1 commit git (auditable y revertible con git revert).
// Uso: node consolidate.mjs [--dry-run]
import { readdirSync, existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMem, BRAIN_DIR, HOME as CFG_HOME, acquireLock, releaseLock } from './brain.config.mjs';
import { secretScan } from './maintain.mjs';

const DRY = process.argv.includes('--dry-run');
const HOME = CFG_HOME;
const MEM = resolveMem(null);
const BRAIN = BRAIN_DIR;
const INBOX = join(MEM, 'inbox');
const log = (...a) => console.log(DRY ? '[dry]' : '[run]', ...a);
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', ...o });

function main() {
  if (!existsSync(INBOX)) { log('inbox/ no existe — nada que consolidar'); return; }
  const notes = readdirSync(INBOX).filter(f => f.endsWith('.md'));
  if (!notes.length) { log('inbox/ vacio — no-op (no se invoca LLM)'); return; }

  // GATE DE SEGURIDAD (fix Critical audit 2026-06-13): nunca operar sobre un working tree sucio.
  // Puede haber trabajo sin commitear de OTRA sesion en paralelo. reset --hard/clean/add -A lo
  // destruirian o lo pushearian con autoria errada. Si esta sucio, abortamos ANTES de invocar el LLM.
  const dirty = sh('git', ['-C', MEM, 'status', '--porcelain']).trim();
  if (dirty) { log(`working tree sucio (${dirty.split('\n').length} cambios sin commitear) — ABORT (no tocar trabajo ajeno). Reintenta cuando este limpio.`); return; }

  log(`inbox: ${notes.length} nota(s) -> ${notes.join(', ')}`);
  const digests = existsSync(join(MEM, 'digests')) ? readdirSync(join(MEM, 'digests')).filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')) : [];

  const prompt = [
    'Eres el consolidador nocturno del cerebro de memoria (sueno REM). Espanol neutro chileno, nunca voseo.',
    `Hay notas crudas en ${INBOX}. Para cada una: decide a que dominio pertenece (digests disponibles: ${digests.join(', ')}),`,
    'integra su contenido al digest de ese dominio en memory/digests/<dominio>.md (seccion adecuada: Vigente ahora / Pendientes / Detalle), deduplicando.',
    'Si una nota es un PUNTERO DE SESION (_session_*.md con un transcript path): lee ese transcript y extrae SOLO memorias DURABLES (decisiones, lecciones reutilizables, hechos nuevos, cambios de estado de proyecto); descarta lo efimero/conversacional. Si no hay nada durable, no crees nada.',
    'Si una nota amerita un nodo propio, crea memory/<prefijo>_<slug>.md con frontmatter v3 (name==filename, domain, status, valid_from, importance). Usa node brain.mjs add si dudas del formato.',
    'REGLAS DURAS: NO edites MEMORY.md (es generado). NO borres ni reescribas cuerpos de nodos existentes. NO toques nada fuera de memory/digests/ y memory/.',
    'Al terminar, mueve cada nota procesada de inbox/ a inbox/.procesadas/ (crea el dir). No borres las notas.',
    'Se conservador: ante la duda, deja la nota en inbox/ sin tocar y registra por que.',
  ].join(' ');

  if (DRY) { log('DRY: invocaria claude -p con prompt de', prompt.length, 'chars; luego validate + gate-diferencial + commit/rollback'); return; }

  // LOCK (fix audit: serializa con maintain). Si otro job lo tiene, abortar.
  const lock = acquireLock();
  if (!lock) { log('otro job tiene el lock (.brain.lock fresco) — abort para no solapar'); return; }
  try { runConsolidation(notes, prompt); } finally { releaseLock(lock); }
}

function runConsolidation(notes, prompt) {
  const head = sh('git', ['-C', MEM, 'rev-parse', 'HEAD']).trim();
  // Snapshot de untracked PRE-LLM (fix audit#4): el rollback debe limpiar SOLO lo que cree el LLM,
  // preservando archivos que un HUMANO haya creado en MEM durante los ~10min de la corrida.
  const untrackedBefore = listUntracked();
  // Snapshot de las notas de inbox/ PRE-LLM (fix High audit 2026-06-13): el prompt manda mover cada
  // nota a inbox/.procesadas/ al terminar. inbox/_*.md y .procesadas/ estan gitignored, asi que
  // reset --hard NO las restaura y clean -f (sobre listUntracked con --exclude-standard) NO las ve.
  // Si luego un gate falla, el digest se revierte pero la nota ya esta movida -> memoria durable
  // perdida Y fuera de la cola. Capturamos contenido a nivel de archivo (no git) para re-encolarla.
  const inboxBefore = snapshotInbox(notes);
  try {
    log('invocando claude -p (headless)…');
    // P0 PERMISOS (fix audit#4): por defecto 'claude -p' hereda bypassPermissions del settings global
    // (LLM autonomo nocturno con tool-access total). Acotamos:
    //  - --permission-mode default: anula bypassPermissions; lo no-permitido queda en prompt (sin humano => denegado).
    //  - --allowedTools minimo: solo lectura/edicion de archivos. SIN Bash ni red. Coma-separado (sintaxis verificada con `claude --help`).
    //  - --disallowedTools (fix Critical audit 2026-06-13): el allowlist SOLO no es vinculante cuando el
    //    settings global trae defaultMode=bypassPermissions (anula los flags y deja Bash+red ~10min sin
    //    humano -> SANDBOX_BREACH verificado en vivo). La denylist explicita SI da TOOL_DENIED a Bash/red
    //    aunque el permission-mode sea ignorado. Defensa en profundidad: mantenemos ambos (allow + deny).
    // BRAIN_CONSOLIDATING=1 (fix audit#4): marca el spawn para que el hook Stop/capture no ingiera su propio transcript.
    sh('claude', ['--permission-mode', 'default', '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--disallowedTools', 'Bash,WebFetch,WebSearch', '-p', prompt],
      { cwd: MEM, timeout: 600000, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, BRAIN_CONSOLIDATING: '1' } });
  } catch (e) { log('claude -p fallo o timeout:', (e.message || '').slice(0, 80), '— rollback'); rollback(head, untrackedBefore, inboxBefore); return; }

  // 1) validate estructural
  try { sh('node', [join(BRAIN, 'brain.mjs'), 'validate', '--mem', MEM]); }
  catch (e) { log('VALIDATE FALLO tras consolidar — AUTO-ROLLBACK'); rollback(head, untrackedBefore, inboxBefore); alert('consolidador rompio validate; revertido'); return; }

  // 2) GATE DIFERENCIAL (fix audit 2026-06-13): validate es estructural y NO detecta borrados/reescrituras.
  //    El LLM SOLO puede: editar digests/, crear nodos nuevos, mover inbox/. Cualquier otra cosa -> rollback.
  const viol = diffViolations(head, untrackedBefore);
  if (viol.length) {
    log('GATE DIFERENCIAL: el LLM hizo cambios no permitidos — AUTO-ROLLBACK:'); viol.forEach(v => log('   ' + v));
    rollback(head, untrackedBefore, inboxBefore); alert('consolidador violo el contrato (borrado/MEMORY.md/cuerpo de nodo); revertido: ' + viol.slice(0, 3).join(' | ')); return;
  }

  // 3) gate de secretos
  const secrets = secretScan(MEM);
  if (secrets.length) {
    log(`SECRETOS en claro tras consolidar (${secrets.length}) — AUTO-ROLLBACK`);
    secrets.forEach(h => log(`   ${h.kind} ${h.file}:${h.line} ${h.sample}`));
    rollback(head, untrackedBefore, inboxBefore); alert(`consolidador integro ${secrets.length} secreto(s); revertido`); return;
  }

  // 4) regenerar derivados + commit (add -A seguro: tree limpio pre-LLM por el gate de main + gate diferencial)
  sh('node', [join(BRAIN, 'brain.mjs'), 'render-index', '--mem', MEM]);
  sh('node', [join(BRAIN, 'graph.mjs'), 'build', '--mem', MEM]);
  sh('node', [join(BRAIN, 'graph.mjs'), 'export-3d', '--mem', MEM]);
  try {
    sh('git', ['-C', MEM, 'add', '-A']);
    sh('git', ['-C', MEM, '-c', 'user.name=brain-consolidator', '-c', 'user.email=brain@local', 'commit', '-q', '-m', `consolidate: ${notes.length} nota(s) de inbox integradas (${new Date().toISOString().slice(0, 10)})`]);
    try { sh('git', ['-C', MEM, 'push', '-q', 'origin', 'main']); } catch {}
    log('consolidacion commiteada + validate + gate diferencial OK');
  } catch (e) { log('nada que commitear o git fallo:', (e.message || '').slice(0, 60)); }
}

// detecta cambios FUERA del contrato del consolidador (vs HEAD pre-LLM)
// Fix audit#4 (P1 gate ciego a untracked): 'git diff HEAD' (sin --cached) NO ve archivos nuevos
// (untracked) que el LLM haya creado fuera de digests/ e inbox/. SIN mutar el index (no 'git add':
// stagear absorberia los untracked del humano y un reset --hard posterior los destruiria), unimos:
//   - 'git diff --name-status HEAD' -> cambios sobre archivos TRACKED (D/M/R).
//   - 'git ls-files --others --exclude-standard' menos untrackedBefore -> archivos NUEVOS del LLM (A).
// Un .md nuevo en raiz sin frontmatter v3 valido tambien es violacion.
function diffViolations(head, untrackedBefore) {
  const viol = [];
  const classifyPath = (p) => {
    const inInbox = p.startsWith('inbox/');
    const inDigests = p.startsWith('digests/');
    // nodo valido en raiz: <prefijo>_<slug>.md con frontmatter v3 (name/domain/status/valid_from/importance)
    const isRootMd = p.endsWith('.md') && !p.includes('/');
    return { inInbox, inDigests, isRootMd };
  };
  // 1) cambios sobre archivos tracked
  const out = sh('git', ['-C', MEM, 'diff', '--name-status', head]);
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [st, ...rest] = line.split('\t');
    const p = rest.join('\t');
    const { inInbox, inDigests } = classifyPath(p);
    if (p === 'MEMORY.md') viol.push('toco MEMORY.md (generado)');
    else if (st.startsWith('D') && !inInbox) viol.push('borro ' + p);
    else if (st.startsWith('M') && !inDigests && !inInbox) viol.push('reescribio cuerpo de ' + p);
    else if (st.startsWith('R') && !inInbox) viol.push('renombro ' + p);
  }
  // 2) archivos nuevos (untracked) que cree el LLM (excluyendo los que ya tenia el humano)
  const before = new Set(untrackedBefore || []);
  for (const p of listUntracked()) {
    if (before.has(p)) continue; // del humano: no es del LLM, no se evalua aqui
    const { inInbox, inDigests, isRootMd } = classifyPath(p);
    if (inInbox || inDigests) continue; // permitido: nuevas notas movidas / nuevos digests
    if (isRootMd && validV3Node(p)) continue; // permitido: nodo nuevo con frontmatter v3 valido
    viol.push('creo archivo no-permitido ' + p);
  }
  return viol;
}

// valida frontmatter v3 minimo de un nodo nuevo en raiz (name==filename + claves obligatorias)
function validV3Node(p) {
  try {
    const txt = readFileSync(join(MEM, p), 'utf8');
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return false;
    const fm = m[1];
    const expectedName = p.replace(/\.md$/, '');
    const nameOk = new RegExp(`(^|\\n)name:\\s*["']?${expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*(\\r?\\n|$)`).test(fm);
    const hasAll = ['domain', 'status', 'valid_from', 'importance'].every(k => new RegExp(`(^|\\n)${k}:`).test(fm));
    return nameOk && hasAll;
  } catch { return false; }
}

// lista de archivos untracked (un path por linea) segun git, relativos a MEM
function listUntracked() {
  try {
    return sh('git', ['-C', MEM, 'ls-files', '--others', '--exclude-standard'])
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

// snapshot a nivel de archivo (no git) del contenido de las notas top-level de inbox/ PRE-LLM.
// Necesario porque inbox/_*.md suele estar gitignored: git reset/clean NO las restaura tras un gate-fail.
// Map<nombreArchivo, contenido>. Si una nota no se puede leer, se omite (no podemos re-encolar lo que no vimos).
function snapshotInbox(notes) {
  const snap = new Map();
  for (const n of notes || []) {
    try { snap.set(n, readFileSync(join(INBOX, n), 'utf8')); } catch { /* ilegible: omitir */ }
  }
  return snap;
}

function rollback(head, untrackedBefore, inboxBefore) {
  // Fix audit#4 (rollback seguro): reset --hard descarta cambios sobre archivos TRACKED pero NO toca
  // untracked. El antiguo 'git clean -fd' global SI borraba TODO untracked, incluidos archivos que un
  // HUMANO haya creado en MEM durante los ~10min de la corrida. Aqui limpiamos SOLO los untracked
  // NUEVOS (presentes despues del LLM y no antes), preservando los del humano. El gate diferencial no
  // muta el index, asi que tras el reset los untracked del LLM siguen en disco y los recalculamos.
  try {
    sh('git', ['-C', MEM, 'reset', '--hard', head]);
    const before = new Set(untrackedBefore || []);
    const newOnes = listUntracked().filter(p => !before.has(p));
    for (const p of newOnes) {
      // -f forzado, ruta exacta del LLM; sin -d global para no arrastrar nada del humano.
      try { sh('git', ['-C', MEM, 'clean', '-f', '--', p]); } catch (e) { log('   no pude limpiar untracked', p, '-', (e.message || '').slice(0, 50)); }
    }
    // Fix High audit 2026-06-13: re-encolar las notas de inbox/ que el LLM movio a .procesadas/ y que
    // git NO restauro (gitignored => reset/clean no las ve). Se hace al FINAL para que el clean previo
    // no las vuelva a borrar. Solo reescribimos las que YA no estan en inbox/<nombre> (idempotente: si
    // git ya las restauro o nunca se movieron, el archivo existe y no tocamos nada). Solo inbox/, nada mas.
    const restored = reEnqueueInbox(inboxBefore);
    log('rollback OK a', head.slice(0, 8), `(untracked nuevos limpiados: ${newOnes.length}, preservados del humano: ${before.size}, notas re-encoladas: ${restored})`);
  } catch (e) { log('ROLLBACK FALLO:', e.message.slice(0, 80)); }
}

// re-escribe en inbox/ las notas snapshoteadas que ya no esten presentes (las que el LLM movio fuera y
// git no restauro por estar gitignored). Devuelve cuantas re-encolo. No toca .procesadas/ ni nada externo.
function reEnqueueInbox(inboxBefore) {
  if (!inboxBefore || !inboxBefore.size) return 0;
  let n = 0;
  try { mkdirSync(INBOX, { recursive: true }); } catch {}
  for (const [name, content] of inboxBefore) {
    const dest = join(INBOX, name);
    if (existsSync(dest)) continue; // git ya la restauro o nunca se movio: no duplicar
    try { writeFileSync(dest, content); n++; }
    catch (e) { log('   no pude re-encolar nota', name, '-', (e.message || '').slice(0, 50)); }
  }
  return n;
}
function alert(msg) { try { writeFileSync(join(BRAIN, 'CONSOLIDATOR-ALERT.txt'), `${new Date().toISOString()} ${msg}\n`); } catch {} }

if (process.argv[1] && process.argv[1].endsWith('consolidate.mjs')) main();
