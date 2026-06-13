#!/usr/bin/env node
// maintain.mjs — mantenedor automatico DETERMINISTA del cerebro (sin LLM). Pensado para correr semanal.
// Filosofia: nada se borra, espacio infinito; este job SOLO consolida el camino caliente y respalda.
// Pasos: validate -> secret-scan -> auto-demote cerrados>60d a archivo/ -> render-index (N0) ->
//        graph build + export-3d -> backup a G: -> SYSTEM-STATE.md -> git commit/push si hubo cambios.
// Uso: node maintain.mjs [--dry-run] [--mem <dir>]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, renameSync, mkdirSync, cpSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMem, BRAIN_DIR, HOME as CFG_HOME, resolveBackupDir, acquireLock, releaseLock } from './brain.config.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const memIdx = args.indexOf('--mem');
const HOME = CFG_HOME;
const MEM = resolveMem(memIdx >= 0 ? args[memIdx + 1] : null);
const BRAIN = BRAIN_DIR;
const BACKUP_DIR = resolveBackupDir();
const DEMOTE_DAYS = 60;

// tamano de dir sin depender de 'du' (cross-platform)
function dirSizeMB(dir) {
  let bytes = 0;
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else bytes += s.size; } };
  try { walk(dir); } catch { return null; }
  return (bytes / 1048576).toFixed(0);
}
const log = (...a) => console.log(DRY ? '[dry]' : '[run]', ...a);
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', ...opts });

// ---- secret-scan (redactado; usado tambien como gate) ----
const SECRET_PATTERNS = [
  ['shopify',  /shpat_[a-zA-Z0-9]{20,}/g],
  ['shopify',  /atkn_[a-zA-Z0-9]{20,}/g],
  ['openai',   /sk-[a-zA-Z0-9]{20,}/g],
  ['github',   /gh[pous]_[A-Za-z0-9]{30,}/g],
  ['aws',      /AKIA[0-9A-Z]{16}/g],
  ['slack',    /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['telegram', /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g],
  // hex largo SOLO en contexto de asignacion de secreto (evita falsos positivos con SHA/MD5/hashes de drift)
  ['secret-hex', /(?:token|secret|key|pass(?:word|wd)?|api[_-]?key)\s*[=:]\s*[`"']?[a-f0-9]{24,}/gi],
  ['bearer',   /Bearer\s+[A-Za-z0-9._-]{20,}/g],
  // expandido (audit 2026-06-13): claves privadas, JWT, connection strings con password
  ['pem',      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['jwt',      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['connstr',  /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:[^@\s]+@/gi],
  ['google',   /\bAIza[0-9A-Za-z_-]{35}\b/g],
];
const redact = s => s.length <= 8 ? s[0] + '***' : s.slice(0, 4) + '***' + s.slice(-2);
export function secretScan(dir) {
  const hits = [];
  const walk = d => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) { if (f !== '.git' && f !== 'node_modules') walk(p); continue; }
      if (!/\.(md|txt|json|js|mjs|sh|cmd|ya?ml|toml|pem|key|env|ini|conf)$/i.test(f) && !/^\.env/.test(f)) continue;
      const text = readFileSync(p, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const [kind, re] of SECRET_PATTERNS) {
          for (const m of line.matchAll(re)) {
            // ignorar lo ya redactado (prefijo***sufijo) y placeholders obvios
            if (/\*\*\*/.test(m[0]) || /aaaa|bbbb|xxxx|EXAMPLE|placeholder/i.test(m[0])) continue;
            hits.push({ file: p.replace(MEM, '.'), line: i + 1, kind, sample: redact(m[0]) });
          }
        }
      });
    }
  };
  walk(dir);
  return hits;
}

function daysSince(iso) {
  const t = Date.parse(iso); if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

function alert(msg) { if (!DRY) { try { writeFileSync(join(BRAIN, 'MAINTAIN-ALERT.txt'), `${new Date().toISOString()} ${msg}\n`); } catch {} } log('ALERTA:', msg); }

function main() {
  const lock = acquireLock();
  if (!lock) { log('otro job tiene el lock (.brain.lock fresco) — abort para no solapar'); return; }
  try { return run(); } finally { releaseLock(lock); }
}

function run() {
  const report = { ts: new Date().toISOString(), steps: {} };

  // 1) validate -> validateOk
  let validateOk = true;
  try { const out = sh('node', [join(BRAIN, 'brain.mjs'), 'validate', '--mem', MEM]); report.steps.validate = out.trim(); log('validate:', out.trim()); }
  catch (e) { validateOk = false; report.steps.validate = 'ERRORES: ' + String(e.stdout || e.stderr || e.message || '').trim().slice(0, 300); log('validate FALLO:', report.steps.validate.slice(0, 160)); alert('validate en ROJO: ' + report.steps.validate.slice(0, 200)); }

  // 2) secret-scan
  const secrets = secretScan(MEM);
  report.steps.secretScan = secrets.length;
  if (secrets.length) { log(`secret-scan: ${secrets.length} hallazgo(s) — REVISAR`); secrets.forEach(h => log(`   ${h.kind} ${h.file}:${h.line} ${h.sample}`)); alert(`${secrets.length} secreto(s) en claro en la memoria`); }
  else log('secret-scan: 0 secretos en claro');

  // 2.5) GATE de arbol-limpio: con WIP de otra sesion NO mutamos (demote/render/commit); solo reportamos + respaldamos.
  let treeClean = true;
  try { treeClean = sh('git', ['-C', MEM, 'status', '--porcelain']).trim() === ''; } catch { treeClean = false; }
  if (!treeClean) log('working tree SUCIO (WIP de otra sesion) — se omiten demote/render/commit; corren validate+secret+backup');

  // 3) auto-demote cerrados >60d (solo si limpio)
  const demoted = [];
  if (treeClean) {
    for (const f of readdirSync(MEM)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const full = join(MEM, f);
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, 'utf8');
      const st = /^\s*status:\s*(\w+)/m.exec(raw);
      const vf = /^\s*valid_from:\s*([\d-]+)/m.exec(raw);
      if (st && st[1] === 'cerrado' && vf && daysSince(vf[1]) > DEMOTE_DAYS) {
        demoted.push(f);
        if (!DRY) { mkdirSync(join(MEM, 'archivo'), { recursive: true }); renameSync(full, join(MEM, 'archivo', f)); }
      }
    }
  }
  report.steps.demoted = demoted;
  log(`demote (cerrados >${DEMOTE_DAYS}d): ${demoted.length}${treeClean ? '' : ' (OMITIDO: tree sucio)'}`);

  // 4) render-index + grafo (solo si limpio; evita pelear con el otro escritor)
  if (treeClean && !DRY) {
    sh('node', [join(BRAIN, 'brain.mjs'), 'render-index', '--mem', MEM]);
    sh('node', [join(BRAIN, 'graph.mjs'), 'build', '--mem', MEM]);
    sh('node', [join(BRAIN, 'graph.mjs'), 'export-3d', '--mem', MEM]);
    log('N0 + grafo + export-3d regenerados');
  } else log('N0/grafo: ' + (DRY ? '(dry)' : treeClean ? 'sin cambios' : '(OMITIDO: tree sucio)'));

  // 6) episodic: reporta tamano (walk node, sin 'du') — no se poda ("espacio infinito")
  const epMB = dirSizeMB(join(HOME, '.config', 'superpowers'));
  if (epMB != null) { report.steps.episodicMB = epMB; log('episodic:', epMB + 'MB (no se poda; se respalda)'); }

  // 7) backup: copia directa (cpSync). Si el destino NO esta disponible -> ALERTA (no skip silencioso).
  if (!DRY) {
    const dst = join(BACKUP_DIR, report.ts.slice(0, 10) + '-auto');
    try {
      mkdirSync(dst, { recursive: true });
      cpSync(MEM, join(dst, 'memory'), { recursive: true });
      for (const f of ['brain.mjs', 'graph.mjs', 'maintain.mjs', 'consolidate.mjs', 'brain.config.mjs', 'SYSTEM-STATE.md'])
        if (existsSync(join(BRAIN, f))) cpSync(join(BRAIN, f), join(dst, 'claude-brain', f));
      if (existsSync(join(BRAIN, 'visor', 'index.html'))) cpSync(join(BRAIN, 'visor', 'index.html'), join(dst, 'claude-brain', 'visor', 'index.html'));
      report.steps.backup = dst; log('backup ->', dst);
    } catch (e) { report.steps.backup = 'FALLO'; log('backup FALLO:', e.message.slice(0, 80)); alert(`backup omitido: destino ${BACKUP_DIR} no disponible`); }
  } else log('backup: (dry)');

  // 8) SYSTEM-STATE.md desde la realidad (incluye validate y tope blando)
  const nodes = readdirSync(MEM).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').length;
  const arch = existsSync(join(MEM, 'archivo')) ? readdirSync(join(MEM, 'archivo')).filter(f => f.endsWith('.md')).length : 0;
  const digs = existsSync(join(MEM, 'digests')) ? readdirSync(join(MEM, 'digests')).filter(f => f.endsWith('.md')).length : 0;
  const n0 = existsSync(join(MEM, 'MEMORY.md')) ? statSync(join(MEM, 'MEMORY.md')).size : 0;
  const stateDoc = `# SYSTEM-STATE (generado por maintain.mjs)\n\nActualizado: ${report.ts}\n\n- validate: ${validateOk ? 'OK' : 'ROJO — ' + String(report.steps.validate).slice(0, 120)}\n- Tree limpio: ${treeClean ? 'si' : 'no (WIP otra sesion)'}\n- Nodos raiz: ${nodes}\n- Digests (dominios): ${digs}\n- Archivados (archivo/): ${arch}\n- N0 (MEMORY.md): ${n0} bytes ${n0 > 7168 ? '(SOBRE tope blando 7168!)' : '(<=7168)'} (techo harness 25000)\n- Secretos en claro: ${secrets.length}\n- Demote esta corrida: ${demoted.length}\n- Backup: ${report.steps.backup || 'n/a'}\n\nFuente de verdad = markdown en este directorio. Grafo (graph.db) y N0 son derivados regenerables.\n`;
  if (!DRY) writeFileSync(join(BRAIN, 'SYSTEM-STATE.md'), stateDoc);
  report.steps.systemState = { nodes, digs, arch, n0, validateOk, treeClean };

  // 9) commit/push — solo si limpio (gate), hubo demote, validate OK y sin secretos. Add file-specifico.
  if (!DRY && treeClean && demoted.length && validateOk) {
    try {
      sh('git', ['-C', MEM, 'add', '--', 'MEMORY.md']);
      if (existsSync(join(MEM, 'archivo'))) sh('git', ['-C', MEM, 'add', '--', 'archivo']);
      for (const f of demoted) { try { sh('git', ['-C', MEM, 'add', '--', f]); } catch {} }
      sh('git', ['-C', MEM, '-c', 'user.name=brain-maintainer', '-c', 'user.email=brain@local', 'commit', '-q', '-m', `maintain: demote ${demoted.length} cerrados + N0/grafo regenerados (${report.ts.slice(0, 10)})`]);
      if (secrets.length) { report.steps.git = `commit local (push BLOQUEADO: ${secrets.length} secreto(s))`; alert(`push bloqueado por ${secrets.length} secretos`); }
      else { try { sh('git', ['-C', MEM, 'push', '-q', 'origin', 'main']); report.steps.git = 'commit+push'; } catch { report.steps.git = 'commit (push fallo)'; } }
      log('git:', report.steps.git);
    } catch (e) { log('git: fallo', e.message.slice(0, 60)); }
  } else log(`git: ${!treeClean ? 'omitido (tree sucio)' : !validateOk ? 'omitido (validate ROJO)' : demoted.length ? '(dry)' : 'sin demote'}`);

  writeFileSync(join(BRAIN, 'last-maintain-report.json'), JSON.stringify(report, null, 2));
  log('DONE. report -> last-maintain-report.json');
  return report;
}

// si se importa (para tests), no ejecutar main
if (process.argv[1] && process.argv[1].endsWith('maintain.mjs')) main();
