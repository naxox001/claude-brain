#!/usr/bin/env node
// restore.mjs — restaura los DATOS del cerebro desde un backup. Maneja DOS formatos:
//   (a) dir descomprimido con memory/ (los auto-backups de maintain), y
//   (b) backup FRIO en tarballs (.tar.gz: markdown-global, episodic-superpowers, ...) — audit#3: antes no se podia.
// Uso: node restore.mjs --from <backupDir> [--mem <dir>] [--episodic] [--dry-run]
import { existsSync, cpSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveMem, HOME } from './brain.config.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry-run');
const FROM = flag('--from');
const MEM = resolveMem(flag('--mem'));
const DO_EP = args.includes('--episodic');
const log = (...a) => console.log(DRY ? '[dry]' : '[ok]', ...a);
const tars = existsSync(FROM) ? readdirSync(FROM).filter(f => f.endsWith('.tar.gz')) : [];

if (!FROM || !existsSync(FROM)) { console.error('--from <backupDir> requerido y debe existir'); process.exit(2); }

// extrae un tarball a un temp y devuelve el subdir esperado (o null). --force-local: GNU tar no trata 'G:' como host.
function untar(tarName, expectSubdir) {
  const tb = join(FROM, tarName).replace(/\\/g, '/');  // forward-slash: MSYS tar lo maneja mejor
  if (!existsSync(tb)) return null;
  if (DRY) { try { const n = execFileSync('tar', ['--force-local', '-tzf', tb], { encoding: 'utf8' }).split('\n').filter(Boolean).length; log(`extraeria ${tarName} (${n} entradas)`); } catch { log(`extraeria ${tarName}`); } return 'DRY'; }
  const tmp = mkdtempSync(join(tmpdir(), 'brain-restore-'));
  // cwd:tmp en vez de -C (MSYS tar no hace chdir a paths Windows con backslash); extrae en el cwd
  try { execFileSync('tar', ['--force-local', '-xzf', tb], { cwd: tmp, stdio: 'ignore' }); }
  catch (e) { log(`FALLO extrayendo ${tarName}: ${e.message.slice(0, 80)}`); rmSync(tmp, { recursive: true, force: true }); return null; }
  const sub = join(tmp, expectSubdir);
  return existsSync(sub) ? sub : tmp;
}

// --- 1) MEMORY ---
if (tars.some(t => /markdown-global/.test(t))) {
  // backup frio en tarball
  const src = untar(tars.find(t => /markdown-global/.test(t)), 'memory');
  if (src && src !== 'DRY') { log(`memory (tarball): -> ${MEM}`); mkdirSync(MEM, { recursive: true }); cpSync(src, MEM, { recursive: true }); rmSync(join(src, '..'), { recursive: true, force: true }); }
} else if (existsSync(join(FROM, 'memory', 'MEMORY.md')) || existsSync(join(FROM, 'MEMORY.md'))) {
  // dir descomprimido
  const src = existsSync(join(FROM, 'memory')) ? join(FROM, 'memory') : FROM;
  log(`memory (dir): ${src} -> ${MEM}`);
  if (!DRY) { mkdirSync(MEM, { recursive: true }); cpSync(src, MEM, { recursive: true }); }
} else log('WARN: no encontre memory/ ni markdown-global.tar.gz en el backup — nada que restaurar para la memoria');

// --- 2) EPISODICA (opt-in por tamano ~1.5GB) ---
if (DO_EP) {
  const dstEp = join(HOME, '.config', 'superpowers');
  if (tars.some(t => /episodic-superpowers/.test(t))) {
    const src = untar(tars.find(t => /episodic-superpowers/.test(t)), 'superpowers');
    if (src && src !== 'DRY') { log(`episodica (tarball): -> ${dstEp}`); mkdirSync(dstEp, { recursive: true }); cpSync(src, dstEp, { recursive: true }); rmSync(join(src, '..'), { recursive: true, force: true }); }
  } else if (existsSync(join(FROM, 'superpowers'))) {
    log(`episodica (dir): -> ${dstEp}`); if (!DRY) { mkdirSync(dstEp, { recursive: true }); cpSync(join(FROM, 'superpowers'), dstEp, { recursive: true }); }
  } else log('WARN: --episodic pedido pero no hay superpowers/ ni episodic-superpowers.tar.gz');
} else log('episodica: omitida (pasa --episodic para restaurarla)');

console.log('\nrestore done. Siguiente: node install.mjs  (regenera derivados + valida)');
