#!/usr/bin/env node
// restore.mjs — restaura los DATOS del cerebro desde un backup. Maneja DOS formatos:
//   (a) dir descomprimido con memory/ (los auto-backups de maintain), y
//   (b) backup FRIO en tarballs (.tar.gz: markdown-global, episodic-superpowers, ...) — audit#3: antes no se podia.
// Uso: node restore.mjs --from <backupDir> [--mem <dir>] [--episodic] [--episodic-dest <dir>] [--dry-run]
//   --episodic-dest <dir>: dirige la restauracion de la episodica a un dir distinto (p.ej. para ensayar en temp).
//                          default = el real (~/.config/superpowers).
// OJO: cpSync es OVERLAY, no merge limpio — copia encima de lo que ya exista en el destino sin borrar lo previo
//      (archivos con el mismo nombre se sobrescriben; los demas quedan). Si el destino ya tiene datos, se avisa.
// Salida: imprime "restauradas N de M" y sale con codigo 1 si alguna seccion fallo de verdad (no por diseno).
import { existsSync, cpSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveMem, HOME } from './brain.config.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry-run');
const FROM = flag('--from');
const MEM = resolveMem(flag('--mem'));
const DO_EP = args.includes('--episodic');
const EP_DEST = flag('--episodic-dest');  // override del destino de la episodica (default = el real)
const log = (...a) => console.log(DRY ? '[dry]' : '[ok]', ...a);
const tars = existsSync(FROM) ? readdirSync(FROM).filter(f => f.endsWith('.tar.gz')) : [];

if (!FROM || !existsSync(FROM)) { console.error('--from <backupDir> requerido y debe existir'); process.exit(2); }

// contadores de secciones: cuantas se intentaron (no omitidas por diseno) y cuantas fallaron de verdad.
let attempted = 0, restored = 0, failed = 0;
// avisa si el destino de un cpSync overlay ya tiene contenido (no es merge limpio: se sobrescribe encima).
function warnIfPopulated(dst, label) {
  try { if (existsSync(dst) && readdirSync(dst).length > 0) log(`AVISO: ${label} ya tiene datos en ${dst} — cpSync es overlay, no merge limpio (se sobrescribe encima)`); } catch { /* destino ilegible: seguir */ }
}

// extrae un tarball a un temp. Devuelve { tmp, sub } donde:
//   tmp = raiz mkdtemp (SIEMPRE lo que hay que rmSync — nunca su padre), sub = subdir esperado si existe, o null.
// El caller copia (sub || tmp) al destino y SIEMPRE limpia tmp. Antes devolvia un path ambiguo y el caller
// hacia rmSync(join(src,'..')) = borraba el PADRE de mkdtemp (la base de %TEMP%) cuando faltaba el subdir (audit#4).
// Devuelve 'DRY' en dry-run y null si el tarball no existe o falla la extraccion.
// SABOR DE TAR (fix Critical audit#4, igual que maintain): el path lleva letra de unidad ('G:/...').
//   - bsdtar (C:\Windows\system32\tar.exe, el del Task Scheduler) RECHAZA --force-local pero maneja 'G:' OK sin el.
//   - GNU tar (MSYS/Git) trata 'G:' como host remoto sin --force-local y NECESITA el flag.
// Estrategia portable: intentar SIN el flag (bsdtar ok); si falla, reintentar CON --force-local (GNU ok).
function tarTry(args, opts) {
  try { return execFileSync('tar', args, opts); }
  catch { return execFileSync('tar', ['--force-local', ...args], opts); }  // reintento GNU
}
function untar(tarName, expectSubdir) {
  const tb = join(FROM, tarName).replace(/\\/g, '/');  // forward-slash: MSYS tar lo maneja mejor
  if (!existsSync(tb)) return null;
  if (DRY) { try { const n = tarTry(['-tzf', tb], { encoding: 'utf8' }).split('\n').filter(Boolean).length; log(`extraeria ${tarName} (${n} entradas)`); } catch { log(`extraeria ${tarName} (no listable: corrupto?)`); } return 'DRY'; }
  const tmp = mkdtempSync(join(tmpdir(), 'brain-restore-'));
  // cwd:tmp en vez de -C (MSYS tar no hace chdir a paths Windows con backslash); extrae en el cwd
  try { tarTry(['-xzf', tb], { cwd: tmp, stdio: 'ignore' }); }
  catch (e) { log(`FALLO extrayendo ${tarName}: ${e.message.slice(0, 80)}`); rmSync(tmp, { recursive: true, force: true }); return null; }
  const sub = join(tmp, expectSubdir);
  return { tmp, sub: existsSync(sub) ? sub : null };
}

// --- 1) MEMORY ---
if (tars.some(t => /markdown-global/.test(t))) {
  // backup frio en tarball
  attempted++;
  const r = untar(tars.find(t => /markdown-global/.test(t)), 'memory');
  if (r === 'DRY') { restored++; }            // dry-run: no se intenta de verdad, no cuenta como fallo
  else if (!r) { failed++; }                  // tarball ausente o extraccion fallida (untar ya logueo)
  else if (!r.sub) {                          // extrajo OK pero SIN memory/ al tope: tarball invalido, NO copiar (audit#4)
    log(`FALLO restaurando memory: el tarball markdown-global no trae memory/ al tope (no copio basura suelta)`); failed++;
    rmSync(r.tmp, { recursive: true, force: true });  // limpia solo su propio tmp
  }
  else {
    try {
      const src = r.sub;                      // SIEMPRE el subdir memory/; un markdown-global valido lo trae al tope
      log(`memory (tarball): -> ${MEM}`); warnIfPopulated(MEM, 'memory'); mkdirSync(MEM, { recursive: true }); cpSync(src, MEM, { recursive: true }); restored++;
    } catch (e) { log(`FALLO copiando memory: ${e.message.slice(0, 80)}`); failed++; }
    finally { rmSync(r.tmp, { recursive: true, force: true }); }  // SIEMPRE limpia solo su propio tmp
  }
} else if (existsSync(join(FROM, 'memory', 'MEMORY.md')) || existsSync(join(FROM, 'MEMORY.md'))) {
  // dir descomprimido
  attempted++;
  const src = existsSync(join(FROM, 'memory')) ? join(FROM, 'memory') : FROM;
  log(`memory (dir): ${src} -> ${MEM}`);
  if (!DRY) { try { warnIfPopulated(MEM, 'memory'); mkdirSync(MEM, { recursive: true }); cpSync(src, MEM, { recursive: true }); restored++; } catch (e) { log(`FALLO copiando memory: ${e.message.slice(0, 80)}`); failed++; } }
  else restored++;
} else log('WARN: no encontre memory/ ni markdown-global.tar.gz en el backup — nada que restaurar para la memoria');

// --- 2) EPISODICA (opt-in por tamano ~1.5GB) ---
if (DO_EP) {
  const dstEp = EP_DEST || join(HOME, '.config', 'superpowers');  // --episodic-dest la dirige a otro dir (ensayo en temp)
  if (tars.some(t => /episodic-superpowers/.test(t))) {
    attempted++;
    const r = untar(tars.find(t => /episodic-superpowers/.test(t)), 'superpowers');
    if (r === 'DRY') { restored++; }
    else if (!r) { failed++; }
    else if (!r.sub) {                        // extrajo OK pero SIN superpowers/ al tope: tarball invalido, NO copiar (mismo patron que memory, audit#4)
      log(`FALLO restaurando episodica: el tarball episodic-superpowers no trae superpowers/ al tope (no copio basura suelta)`); failed++;
      rmSync(r.tmp, { recursive: true, force: true });  // limpia solo su propio tmp
    }
    else {
      try {
        const src = r.sub;                    // SIEMPRE el subdir superpowers/; un episodic-superpowers valido lo trae al tope
        log(`episodica (tarball): -> ${dstEp}`); warnIfPopulated(dstEp, 'episodica'); mkdirSync(dstEp, { recursive: true }); cpSync(src, dstEp, { recursive: true }); restored++;
      } catch (e) { log(`FALLO copiando episodica: ${e.message.slice(0, 80)}`); failed++; }
      finally { rmSync(r.tmp, { recursive: true, force: true }); }  // SIEMPRE limpia solo su propio tmp
    }
  } else if (existsSync(join(FROM, 'superpowers'))) {
    attempted++;
    log(`episodica (dir): -> ${dstEp}`);
    if (!DRY) { try { warnIfPopulated(dstEp, 'episodica'); mkdirSync(dstEp, { recursive: true }); cpSync(join(FROM, 'superpowers'), dstEp, { recursive: true }); restored++; } catch (e) { log(`FALLO copiando episodica: ${e.message.slice(0, 80)}`); failed++; } }
    else restored++;
  } else log('WARN: --episodic pedido pero no hay superpowers/ ni episodic-superpowers.tar.gz');
} else log('episodica: omitida (pasa --episodic para restaurarla)');

// resumen: cuantas secciones se restauraron de las que se intentaron (las omitidas por diseno no cuentan).
console.log(`\nrestauradas ${restored} de ${attempted}${failed ? ` (${failed} con fallo)` : ''}.`);
console.log('restore done. Siguiente: node install.mjs  (regenera derivados + valida)');
if (failed > 0) process.exit(1);  // fallo real (tarball corrupto / copia fallida) -> exit 1; omitido por diseno -> exit 0
