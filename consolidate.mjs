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
    'Si una nota amerita un nodo propio, crea memory/<prefijo>_<slug>.md con frontmatter v3 (name==filename, domain, status, valid_from, importance).',
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
  try {
    log('invocando claude -p (headless)…');
    sh('claude', ['-p', prompt], { cwd: MEM, timeout: 600000, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) { log('claude -p fallo o timeout:', (e.message || '').slice(0, 80), '— rollback'); rollback(head); return; }

  // 1) validate estructural
  try { sh('node', [join(BRAIN, 'brain.mjs'), 'validate', '--mem', MEM]); }
  catch (e) { log('VALIDATE FALLO tras consolidar — AUTO-ROLLBACK'); rollback(head); alert('consolidador rompio validate; revertido'); return; }

  // 2) GATE DIFERENCIAL (fix audit 2026-06-13): validate es estructural y NO detecta borrados/reescrituras.
  //    El LLM SOLO puede: editar digests/, crear nodos nuevos, mover inbox/. Cualquier otra cosa -> rollback.
  const viol = diffViolations(head);
  if (viol.length) {
    log('GATE DIFERENCIAL: el LLM hizo cambios no permitidos — AUTO-ROLLBACK:'); viol.forEach(v => log('   ' + v));
    rollback(head); alert('consolidador violo el contrato (borrado/MEMORY.md/cuerpo de nodo); revertido: ' + viol.slice(0, 3).join(' | ')); return;
  }

  // 3) gate de secretos
  const secrets = secretScan(MEM);
  if (secrets.length) {
    log(`SECRETOS en claro tras consolidar (${secrets.length}) — AUTO-ROLLBACK`);
    secrets.forEach(h => log(`   ${h.kind} ${h.file}:${h.line} ${h.sample}`));
    rollback(head); alert(`consolidador integro ${secrets.length} secreto(s); revertido`); return;
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
function diffViolations(head) {
  const out = sh('git', ['-C', MEM, 'diff', '--name-status', head]);
  const viol = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [st, ...rest] = line.split('\t');
    const p = rest.join('\t');
    const inInbox = p.startsWith('inbox/');
    const inDigests = p.startsWith('digests/');
    if (p === 'MEMORY.md') viol.push('toco MEMORY.md (generado)');
    else if (st.startsWith('D') && !inInbox) viol.push('borro ' + p);
    else if (st.startsWith('M') && !inDigests && !inInbox) viol.push('reescribio cuerpo de ' + p);
    else if (st.startsWith('R') && !inInbox) viol.push('renombro ' + p);
  }
  return viol;
}

function rollback(head) {
  // reset tracked + clean de TODO untracked (fix audit: clean -fd sin pathspec; seguro porque el tree
  // estaba limpio antes del LLM, asi que todo lo untracked es del LLM, incluidos nodos nuevos en la raiz).
  try { sh('git', ['-C', MEM, 'reset', '--hard', head]); sh('git', ['-C', MEM, 'clean', '-fd']); log('rollback OK a', head.slice(0, 8)); }
  catch (e) { log('ROLLBACK FALLO:', e.message.slice(0, 80)); }
}
function alert(msg) { try { writeFileSync(join(BRAIN, 'CONSOLIDATOR-ALERT.txt'), `${new Date().toISOString()} ${msg}\n`); } catch {} }

if (process.argv[1] && process.argv[1].endsWith('consolidate.mjs')) main();
