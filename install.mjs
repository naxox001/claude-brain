#!/usr/bin/env node
// install.mjs — instalador idempotente del cerebro de memoria en una maquina.
// Reconstruye CODIGO+CONFIG+AUTOMATIZACION. Los DATOS (memory/ + episodic) se traen por git/copy (ver data-manifest.json).
// Uso: node install.mjs [--home <dir>] [--mem <dir>] [--skip-tasks] [--dry-run]
//   --home       HOME destino (default: USERPROFILE/HOME). Permite ensayo en sandbox.
//   --mem        ruta de la capa markdown (default: <home>/.claude/projects/<slug>/memory)
//   --skip-tasks no crea tareas programadas (util en ensayo / CI / no-Windows)
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const DRY = args.includes('--dry-run');
const SKIP_TASKS = args.includes('--skip-tasks');
const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = flag('--home') || process.env.USERPROFILE || process.env.HOME;
const slug = HOME.replace(/[^a-zA-Z0-9]/g, '-');  // igual que brain.config.slugFromHome (cada no-alfanumerico -> '-')
const MEM = flag('--mem') || join(HOME, '.claude', 'projects', slug, 'memory');
const log = (...a) => console.log(DRY ? '[dry]' : '[ok]', ...a);
const node = process.execPath;
const W = (p, c) => { if (DRY) { log('escribiria', p); return; } mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };

console.log(`\n=== install claude-brain ===\nHOME=${HOME}\nMEM=${MEM}\n`);

// 1) preflight
const ver = process.versions.node.split('.').map(Number);
if (ver[0] < 22) { console.error(`Node ${process.versions.node} < 22 (se necesita node:sqlite + fs.cpSync)`); process.exit(1); }
try { await import('node:sqlite'); log('preflight: node', process.versions.node, '+ node:sqlite OK'); }
catch { console.error('node:sqlite no disponible en este Node'); process.exit(1); }

// 2) config
W(join(HOME, '.claude', 'brain.json'), JSON.stringify({ memDir: MEM.replace(/\\/g, '/'), note: 'Config del cerebro. memDir = capa markdown soberana.' }, null, 2) + '\n');
log('config -> ~/.claude/brain.json');

// 3) hook portable
const hookSrc = join(HERE, 'templates', 'hooks', 'brain-session-start.sh');
const hookDst = join(HOME, '.claude', 'hooks', 'brain-session-start.sh');
if (existsSync(hookSrc)) { if (!DRY) { mkdirSync(dirname(hookDst), { recursive: true }); copyFileSync(hookSrc, hookDst); } log('hook -> ~/.claude/hooks/brain-session-start.sh'); }
else log('WARN: template del hook ausente', hookSrc);

// 4) wire settings.json (idempotente, aditivo)
const setPath = join(HOME, '.claude', 'settings.json');
let settings = {};
if (existsSync(setPath)) { try { settings = JSON.parse(readFileSync(setPath, 'utf8')); } catch { log('WARN: settings.json ilegible, se respeta y no se toca'); settings = null; } }
if (settings) {
  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];
  const hookCmd = 'bash "$HOME/.claude/hooks/brain-session-start.sh" 2>/dev/null || true';
  const already = JSON.stringify(settings.hooks.SessionStart).includes('brain-session-start.sh');
  if (!already) {
    settings.hooks.SessionStart.push({ matcher: '.*', hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] });
    W(setPath, JSON.stringify(settings, null, 2) + '\n');
    log('settings.json: SessionStart hook agregado');
  } else log('settings.json: hook ya presente (idempotente)');
}

// 5) datos presentes?
const memOk = existsSync(join(MEM, 'MEMORY.md')) || existsSync(MEM);
if (!existsSync(MEM)) {
  log('AVISO: ' + MEM + ' no existe aun. Trae los datos: git clone <repo memoria> a esa ruta (ver data-manifest.json), luego re-corre install.');
} else {
  // 6) derivados
  if (!DRY) {
    try {
      execFileSync(node, [join(HERE, 'brain.mjs'), 'render-index', '--mem', MEM], { stdio: 'inherit' });
      // --out HERE: derivados al dir de ESTA instalacion (fix audit: aisla ensayos con --home, no pisa otro repo)
      execFileSync(node, [join(HERE, 'graph.mjs'), 'build', '--mem', MEM, '--out', HERE], { stdio: 'inherit' });
      execFileSync(node, [join(HERE, 'graph.mjs'), 'export-3d', '--mem', MEM, '--out', HERE], { stdio: 'inherit' });
      execFileSync(node, [join(HERE, 'brain.mjs'), 'validate', '--mem', MEM], { stdio: 'inherit' });
      log('derivados generados + validate OK');
    } catch (e) { console.error('fallo generando derivados:', e.message.slice(0, 100)); }
  } else log('derivados: (dry)');
}

// 6.5) GENERAR run-*.cmd con el node path de ESTA maquina (fix audit 2026-06-13: no versionar rutas ajenas) + logs/
if (!DRY && process.platform === 'win32') {
  mkdirSync(join(HOME, '.claude'), { recursive: true });
  mkdirSync(join(HERE, 'logs'), { recursive: true });
  const cmd = (script, logf) => `@echo off\r\n"${node}" "${join(HERE, script)}" >> "${join(HERE, 'logs', logf)}" 2>&1\r\n`;
  writeFileSync(join(HERE, 'run-maintain.cmd'), cmd('maintain.mjs', 'maintain.log'));
  writeFileSync(join(HERE, 'run-consolidate.cmd'), cmd('consolidate.mjs', 'consolidate.log'));
  log('run-*.cmd generados (node local) + logs/ creado');
} else if (DRY) log('run-*.cmd + logs/: (dry)');

// 7) tareas programadas (Windows)
if (!SKIP_TASKS && !DRY && process.platform === 'win32') {
  const cmds = [
    ['ClaudeBrain-Maintain', join(HERE, 'run-maintain.cmd'), ['/SC', 'WEEKLY', '/D', 'SUN', '/ST', '05:00']],
    ['ClaudeBrain-Consolidate', join(HERE, 'run-consolidate.cmd'), ['/SC', 'DAILY', '/ST', '04:00']],
  ];
  for (const [tn, tr, sc] of cmds) {
    try { execFileSync('schtasks.exe', ['/Create', '/TN', tn, '/TR', tr, ...sc, '/F'], { stdio: 'ignore' }); log('tarea:', tn); }
    catch (e) { log('WARN tarea', tn, 'fallo:', (e.message || '').slice(0, 50)); }
  }
} else log('tareas programadas: ' + (SKIP_TASKS ? 'omitidas (--skip-tasks)' : DRY ? '(dry)' : 'no-Windows'));

console.log('\n=== install done ===');
console.log('Pendiente manual (solo 1ra vez en maquina nueva):');
console.log('  - Datos: git clone <repo memoria> -> ' + MEM);
console.log('  - Episodica (opcional): copiar ~/.config/superpowers desde backup');
console.log('  - Reiniciar Claude Code para cargar el hook SessionStart\n');
