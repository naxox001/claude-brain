// brain.config.mjs — resolucion portable de rutas (sin hardcodear el slug de la maquina).
// Prioridad: --mem CLI > $BRAIN_MEM > ~/.claude/brain.json {memDir} > auto-detect del slug del HOME.
// El installer escribe ~/.claude/brain.json en cada maquina; asi el codigo publicado no tiene rutas personales.
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.USERPROFILE || process.env.HOME || '';
// BRAIN_DIR = el dir REAL de este modulo (no derivado de HOME). Asi el lock y los derivados funcionan aunque
// el repo se clone en otra ruta (audit#5 #18: antes join(HOME,'projects','claude-brain') daba ENOENT y acquireLock
// devolvia null = falso 'lock ocupado' -> maintain/consolidate abortaban para siempre en instalaciones no estandar).
export const BRAIN_DIR = dirname(fileURLToPath(import.meta.url));

// Claude Code codifica el path como nombre de proyecto reemplazando CADA caracter no-alfanumerico
// por '-' (cada uno, sin colapsar): C:\Users\alex_p -> C--Users-alex-p (':'->'-', '\'->'-', '_'->'-').
function slugFromHome(home) {
  return home.replace(/[^a-zA-Z0-9]/g, '-');
}

function cfg() {
  const p = join(HOME, '.claude', 'brain.json');
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* corrupta */ } }
  return {};
}

export function resolveMem(cliMem) {
  if (cliMem) return cliMem;
  if (process.env.BRAIN_MEM) return process.env.BRAIN_MEM;
  const j = cfg();
  if (j.memDir) return j.memDir;
  return join(HOME, '.claude', 'projects', slugFromHome(HOME), 'memory');
}

// destino de backup configurable (brain.json backupDir > env > G: legacy). null si no aplica.
export function resolveBackupDir() {
  return process.env.BRAIN_BACKUP || cfg().backupDir || 'G:/respaldo-memoria-claude';
}

// pidAlive: senal 0 = solo chequea existencia del proceso (no lo mata). EPERM = existe pero sin permiso (vivo).
// Usado para reclamar al instante un lock huerfano de un proceso ya muerto (kill -9 / crash) sin esperar maxAgeMs.
// Limitacion conocida: reuso de PID podria dar un falso 'vivo' -> en ese caso se cae al vencimiento por edad.
function pidAlive(pid) {
  if (pid == null) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// lock simple inter-proceso (serializa maintain/consolidate). Vive en BRAIN_DIR (no en MEM, no ensucia el arbol).
// Reclamacion de stale endurecida (audit#5 #3/#31):
//   - openSync('wx') es la EXCLUSION MUTUA real y atomica (crear-si-no-existe).
//   - si ya existe, se reclama solo si es STALE: viejo por edad, pid muerto, o ilegible.
//   - antes de borrar el stale se RE-CONFIRMA que sigue siendo el mismo (mismo ts/pid); si cambio,
//     otro proceso ya lo reclamo -> no se toca su lock fresco (cierra el TOCTOU del rmSync ciego anterior).
export function acquireLock(name = '.brain.lock', maxAgeMs = 3600000) {
  const lockPath = join(BRAIN_DIR, name);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');  // atomico: solo un proceso lo crea
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;  // no pude crearlo por otra razon (permisos, etc.)
    }
    // existe: decidir si es stale
    let info = null;
    try { info = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* ilegible -> stale */ }
    const stale = !info || (Date.now() - info.ts >= maxAgeMs) || !pidAlive(info.pid);
    if (!stale) return null;  // lock vivo de otro proceso: no tocar
    // re-confirmar que sigue siendo el MISMO lock stale antes de borrar (cierra TOCTOU practico)
    try {
      const again = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (info && (again.ts !== info.ts || again.pid !== info.pid)) return null;  // otro lo reclamo recien
    } catch { /* desaparecio o ilegible: el retry de openSync resolvera */ }
    try { rmSync(lockPath); } catch { /* otro lo borro: el retry de openSync resolvera */ }
    // vuelve al tope del loop: openSync('wx') decide atomicamente quien gana
  }
  return null;
}
export function releaseLock(lockPath) { if (lockPath) { try { rmSync(lockPath); } catch {} } }
