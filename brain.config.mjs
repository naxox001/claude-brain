// brain.config.mjs — resolucion portable de rutas (sin hardcodear el slug de la maquina).
// Prioridad: --mem CLI > $BRAIN_MEM > ~/.claude/brain.json {memDir} > auto-detect del slug del HOME.
// El installer escribe ~/.claude/brain.json en cada maquina; asi el codigo publicado no tiene rutas personales.
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const HOME = process.env.USERPROFILE || process.env.HOME || '';
export const BRAIN_DIR = join(HOME, 'projects', 'claude-brain');

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

// lock simple inter-proceso (serializa maintain/consolidate). Vive en BRAIN_DIR (no en MEM, no ensucia el arbol).
export function acquireLock(name = '.brain.lock', maxAgeMs = 3600000) {
  const lockPath = join(BRAIN_DIR, name);
  if (existsSync(lockPath)) {
    try { const { ts } = JSON.parse(readFileSync(lockPath, 'utf8')); if (Date.now() - ts < maxAgeMs) return null; } catch { /* ilegible: tratar como stale */ }
    try { rmSync(lockPath); } catch {}
  }
  try { const fd = openSync(lockPath, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); closeSync(fd); return lockPath; }
  catch { return null; }
}
export function releaseLock(lockPath) { if (lockPath) { try { rmSync(lockPath); } catch {} } }
