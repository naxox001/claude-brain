#!/usr/bin/env node
// restore.mjs — restaura los DATOS del cerebro desde un backup (G: auto o zip frio descomprimido).
// Uso: node restore.mjs --from <backupDir> [--mem <dir>] [--episodic] [--dry-run]
//   <backupDir> debe contener memory/ (y opcionalmente superpowers/ para la episodica).
import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMem, HOME } from './brain.config.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry-run');
const FROM = flag('--from');
const MEM = resolveMem(flag('--mem'));
const DO_EP = args.includes('--episodic');
const log = (...a) => console.log(DRY ? '[dry]' : '[ok]', ...a);

if (!FROM || !existsSync(FROM)) { console.error('--from <backupDir> requerido y debe existir'); process.exit(2); }

// 1) memory
const srcMem = existsSync(join(FROM, 'memory')) ? join(FROM, 'memory') : FROM;
if (existsSync(join(srcMem, 'MEMORY.md')) || existsSync(srcMem)) {
  log(`memory: ${srcMem} -> ${MEM}`);
  if (!DRY) { mkdirSync(MEM, { recursive: true }); cpSync(srcMem, MEM, { recursive: true }); }
} else log('WARN: no se encontro memory/ en el backup');

// 2) episodica (opt-in por tamano)
if (DO_EP) {
  const srcEp = existsSync(join(FROM, 'superpowers')) ? join(FROM, 'superpowers') : null;
  const dstEp = join(HOME, '.config', 'superpowers');
  if (srcEp) { log(`episodica: ${srcEp} -> ${dstEp}`); if (!DRY) { mkdirSync(dstEp, { recursive: true }); cpSync(srcEp, dstEp, { recursive: true }); } }
  else log('WARN: --episodic pedido pero no hay superpowers/ en el backup (descomprime episodic-superpowers.tar.gz primero)');
} else log('episodica: omitida (pasa --episodic para restaurarla)');

console.log('\nrestore done. Siguiente: node install.mjs  (regenera derivados + valida)');
