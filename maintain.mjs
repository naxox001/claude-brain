#!/usr/bin/env node
// maintain.mjs — mantenedor automatico DETERMINISTA del cerebro (sin LLM). Pensado para correr semanal.
// Filosofia: nada se borra, espacio infinito; este job SOLO consolida el camino caliente y respalda.
// Pasos: validate -> secret-scan -> auto-demote cerrados>60d a archivo/ -> render-index (N0) ->
//        graph build + export-3d -> backup a G: -> SYSTEM-STATE.md -> git commit/push si hubo cambios.
// Uso: node maintain.mjs [--dry-run] [--mem <dir>]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, lstatSync, renameSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveMem, BRAIN_DIR, HOME as CFG_HOME, resolveBackupDir, acquireLock, releaseLock } from './brain.config.mjs';
import { parseFrontmatter } from './lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const memIdx = args.indexOf('--mem');
if (memIdx >= 0 && (args[memIdx + 1] === undefined || args[memIdx + 1].startsWith('--'))) { console.error('--mem requiere una ruta'); process.exit(2); }  // audit#6 #7
const HOME = CFG_HOME;
const MEM = resolveMem(memIdx >= 0 ? args[memIdx + 1] : null);
const BRAIN = BRAIN_DIR;
const BACKUP_DIR = resolveBackupDir();
const DEMOTE_DAYS = 60;

// tamano de dir sin depender de 'du' (cross-platform)
function dirSizeMB(dir) {
  let bytes = 0;
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); const s = lstatSync(p); if (s.isSymbolicLink()) continue; if (s.isDirectory()) walk(p); else bytes += s.size; } };
  try { walk(dir); } catch { return null; }
  return (bytes / 1048576).toFixed(0);
}
const log = (...a) => console.log(DRY ? '[dry]' : '[run]', ...a);
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', ...opts });

// ---- secret-scan (redactado; usado tambien como gate) ----
const SECRET_PATTERNS = [
  ['shopify',  /shpat_[a-zA-Z0-9]{20,}/g],
  ['shopify',  /atkn_[a-zA-Z0-9]{20,}/g],
  // OpenAI clasica + project + Anthropic + Stripe + HuggingFace (audit#3: el sk- generico no cubria los guiones)
  ['anthropic', /sk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{20,}/g],
  ['openai',   /sk-proj-[A-Za-z0-9_-]{20,}/g],
  ['openai',   /sk-svcacct-[A-Za-z0-9_-]{20,}/g],   // service-account (audit#5 #30: el guion cortaba el sk- generico)
  ['openai',   /sk-[a-zA-Z0-9]{20,}/g],
  ['stripe',   /[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['huggingface', /\bhf_[A-Za-z0-9]{30,}/g],
  ['resend',   /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{20,}/g],
  ['github',   /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['aws',      /AKIA[0-9A-Z]{16}/g],
  ['slack',    /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['telegram', /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g],
  // hex largo SOLO en contexto de asignacion de secreto (evita falsos positivos con SHA/MD5/hashes de drift)
  ['secret-hex', /(?:token|secret|key|pass(?:word|wd)?|api[_-]?key|aws_secret(?:_access_key)?)\s*[=:]\s*[`"']?[A-Za-z0-9/+]{24,}/gi],
  ['bearer',   /Bearer\s+[A-Za-z0-9._-]{20,}/g],
  ['pem',      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['jwt',      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['connstr',  /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:[^@\s]+@/gi],
  ['google',   /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['google-oauth', /GOCSPX-[A-Za-z0-9_-]{20,}/g],
];
// placeholders SOLO claramente falsos. Endurecido (audit#5 #19): ya NO se descartan los tokens cortos
// 'aaaa|bbbb|cccc|xxxx' porque una clave REAL puede contener por azar 4 chars repetidos -> falso negativo
// (se descartaba la clave). Ahora: palabras-placeholder inequivocas (CI) + un run de 6+ chars identicos
// (RUN6), que la alta entropia de una clave real practicamente nunca produce pero un placeholder de doc si.
const PLACEHOLDER = /EXAMPLE|placeholder|your[_-]?(?:key|token|secret)|dummy|redacted|sample|fake|\.\.\./i;
const RUN6 = /(.)\1{5,}/;  // 6+ del MISMO char seguido = artefacto de documentacion, no una clave real
const redact = s => s.length <= 8 ? s[0] + '***' : s.slice(0, 4) + '***' + s.slice(-2);
function scanText(text, file, hits, viaB64) {
  text.split('\n').forEach((line, i) => {
    for (const [kind, re] of SECRET_PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (/\*\*\*/.test(m[0]) || PLACEHOLDER.test(m[0]) || RUN6.test(m[0])) continue;
        hits.push({ file, line: i + 1, kind: viaB64 ? kind + '(base64)' : kind, sample: redact(m[0]) });
      }
    }
  });
}
export function secretScan(dir) {
  const hits = [];
  const walk = d => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = lstatSync(p);  // lstat: NO seguir symlinks (audit#5 G4: evita ciclos ELOOP y escanear fuera de MEM)
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (f !== '.git' && f !== 'node_modules') walk(p); continue; }
      if (!/\.(md|txt|json|js|mjs|sh|cmd|ya?ml|toml|pem|key|env|ini|conf)$/i.test(f) && !/^\.env/.test(f)) continue;
      const text = readFileSync(p, 'utf8');
      const file = p.replace(dir, '.');  // relativo a la raiz escaneada (dir), no a la const MEM (habilita escanear un worktree, Fase 0)
      scanText(text, file, hits, false);
      // heuristica base64 (audit#3): decodifica blobs >=40 chars y re-escanea (secretos ofuscados)
      for (const m of text.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
        try { const dec = Buffer.from(m[0], 'base64').toString('utf8'); if (/[\x20-\x7e]{12,}/.test(dec)) scanText(dec, file, hits, true); } catch {}
      }
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

// ---- DR de la episodica (audit#4) ----
// La episodica (~1.5GB en ~/.config/superpowers) NO entraba al backup de maintain; su unica copia era un
// tarball frio MANUAL viejo. Aqui generamos/rotamos un tarball comprimido compatible con restore.mjs.
// CADENCIA: maintain corre SEMANAL, pero la episodica es pesada -> solo regeneramos si el ultimo tarball
//           supera EPISODIC_REFRESH_DAYS (no en cada corrida). STALENESS: alertamos si supera EPISODIC_STALE_DAYS
//           o si no existe ninguno. ROTACION: conservamos los EPISODIC_KEEP mas recientes.
const EPISODIC_REFRESH_DAYS = 7;   // regenerar a lo mas 1 vez por semana
const EPISODIC_STALE_DAYS = 14;    // 2 corridas semanales perdidas -> alerta
const EPISODIC_KEEP = 4;           // ~1 mes de tarballs
// Compatible con restore.mjs: nombre matchea /episodic-superpowers/, contenido tiene 'superpowers/' al tope.
function backupEpisodic(destDir, ts) {
  const cfgDir = join(HOME, '.config');
  const src = join(cfgDir, 'superpowers');
  if (!existsSync(src)) { log('episodic backup: no existe ~/.config/superpowers (nada que respaldar)'); return; }
  // tarballs existentes (mas reciente primero por mtime)
  let existing = [];
  try { existing = readdirSync(destDir).filter(f => /episodic-superpowers.*\.tar\.gz$/.test(f))
      .map(f => ({ f, m: statSync(join(destDir, f)).mtimeMs })).sort((a, b) => b.m - a.m); } catch {}
  const ageDays = existing.length ? (Date.now() - existing[0].m) / 86400000 : Infinity;
  // STALENESS: alerta si el ultimo backup es viejo (o no existe). Independiente de si hoy regeneramos.
  if (ageDays > EPISODIC_STALE_DAYS)
    alert(existing.length ? `backup episodica obsoleto: ${ageDays.toFixed(0)}d (>${EPISODIC_STALE_DAYS}d)` : 'no hay backup de la episodica (1.5GB) — sin DR');
  // COSTO: si el tarball mas reciente es suficientemente fresco, no re-comprimimos (es pesado).
  if (ageDays < EPISODIC_REFRESH_DAYS) { log(`episodic backup: fresco (${ageDays.toFixed(1)}d < ${EPISODIC_REFRESH_DAYS}d) — se omite recompresion`); return; }
  const out = join(destDir, `episodic-superpowers-${ts.slice(0, 10)}.tar.gz`).replace(/\\/g, '/');
  try {
    // cwd=cfgDir + miembro 'superpowers' => extrae como 'superpowers/' (lo que espera restore.mjs).
    // SABOR DE TAR (audit#2): el backup va a un path con letra de unidad ('G:/...'). Hay dos tar incompatibles:
    //   - bsdtar (C:\Windows\system32\tar.exe, el del Task Scheduler) RECHAZA --force-local (exit 1) pero
    //     comprime/lista OK sin el flag (no confunde 'G:' con host remoto).
    //   - GNU tar (MSYS/Git en PATH interactivo) SI trata 'G:' como host remoto sin el flag ('Cannot connect to G:')
    //     y NECESITA --force-local para tomarlo como path local.
    // Ningun unico modo sirve para ambos -> intentamos SIN el flag (sirve a bsdtar) y, si falla, reintentamos
    // CON --force-local (sirve a GNU tar). Asi el DR se genera bajo el tar real del scheduler y bajo el de Git.
    try {
      sh('tar', ['-czf', out, 'superpowers'], { cwd: cfgDir });
    } catch (e1) {
      // bare fallo: probablemente GNU tar interpretando 'G:' como host remoto -> reintentar con --force-local.
      sh('tar', ['--force-local', '-czf', out, 'superpowers'], { cwd: cfgDir });
    }
    log('episodic backup ->', out);
    // ROTACION: borra los mas viejos dejando EPISODIC_KEEP (cuenta el recien creado).
    let after = [];
    try { after = readdirSync(destDir).filter(f => /episodic-superpowers.*\.tar\.gz$/.test(f))
        .map(f => ({ f, m: statSync(join(destDir, f)).mtimeMs })).sort((a, b) => b.m - a.m); } catch {}
    for (const old of after.slice(EPISODIC_KEEP)) { try { rmSync(join(destDir, old.f)); log('episodic backup: rotado (borrado)', old.f); } catch {} }
  } catch (e) {
    // tar ausente o fallo: alertar, NO romper el resto del maintain (fallo silencioso prohibido).
    log('episodic backup FALLO:', e.message.slice(0, 80));
    alert('no se pudo respaldar la episodica (tar ausente o error): ' + e.message.slice(0, 100));
  }
}

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

  // 2) secret-scan — en try/catch (audit#5 #9): un walk que lance (symlink/permiso) NO debe tumbar el backup.
  let secrets = [];
  try { secrets = secretScan(MEM); }
  catch (e) { log('secret-scan FALLO (no rompe el backup):', (e.message || '').slice(0, 80)); alert('secret-scan fallo (symlink/permiso?): ' + (e.message || '').slice(0, 100)); }
  report.steps.secretScan = secrets.length;
  if (secrets.length) { log(`secret-scan: ${secrets.length} hallazgo(s) — REVISAR`); secrets.forEach(h => log(`   ${h.kind} ${h.file}:${h.line} ${h.sample}`)); alert(`${secrets.length} secreto(s) en claro en la memoria`); }
  else log('secret-scan: 0 secretos en claro');

  // 2.5) GATE de arbol-limpio: con WIP de otra sesion NO mutamos (demote/render/commit); solo reportamos + respaldamos.
  let treeClean = true, porcelain = '';
  let normalizedStems = [];  // stems que normalize dejo aplicados (para stagear explicito en el commit, audit#5 #11)
  try { porcelain = sh('git', ['-C', MEM, 'status', '--porcelain', '-z']); treeClean = porcelain.trim() === ''; } catch { treeClean = false; }
  if (!treeClean) {
    // heuristica (audit#5 #13): si TODO lo dirty cae bajo digests/ o inbox/ (el scope del consolidador) puede ser
    // una consolidacion ABORTADA (digest integrado sin commit), no WIP humano -> alerta especifica en vez de silencio.
    const dpaths = porcelain.split('\0').map(l => l.slice(3)).filter(Boolean);
    const looksOrphan = dpaths.length > 0 && dpaths.every(p => p.startsWith('digests/') || p.startsWith('inbox/'));
    if (looksOrphan) alert('posible consolidacion ABORTADA: arbol sucio solo en digests/+inbox/ sin commit (revisar: commitear o revertir)');
    log('working tree SUCIO' + (looksOrphan ? ' (posible consolidacion abortada)' : ' (WIP de otra sesion)') + ' — se omiten normalize/drain/demote/render/commit; corren validate+secret+backup');
  }

  // 2.6) NORMALIZE AUTOMATICO (Fase 0): si validate fallo SOLO por nodos no-v3 y el arbol esta limpio, repararlos.
  //      Cierra el lazo de la memoria nativa sin intervencion humana. Nunca toca nodos que el humano edito.
  //      ATOMICO (audit#4): si tras normalize el re-validate sigue rojo (habia errores NO-normalizables:
  //      wikilink roto, sin frontmatter, dominio sin digest, superseded_by colgante, N0 sobre techo),
  //      revertimos EXACTAMENTE los nodos que normalize toco (git checkout --) para no dejar el arbol
  //      sucio a medias (eso wedgea el pipeline: consolidate aborta, maintain salta). El gate de arbol-limpio
  //      garantiza que cualquier cosa dirty tras normalize la produjo normalize -> revertir es seguro.
  if (treeClean && !validateOk && !DRY) {
    try {
      const nout = sh('node', [join(BRAIN, 'brain.mjs'), 'normalize', '--mem', MEM]);
      log('normalize auto:', nout.trim().split('\n')[0]);
      // stems que normalize DECLARO arreglar (parsea su salida "  - <stem> (...)"). Revertimos SOLO estos
      // (interseccion con lo realmente dirty), NO todo el arbol (audit#5 #10: un `git checkout --` de todo lo
      // dirty podia destruir el WIP TRACKED de una sesion interactiva que entrara en la ventana). -z = NUL, sin comillado.
      const fixedStems = nout.split('\n').filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s+/, '').split(' ')[0]).filter(Boolean);
      const touched = sh('git', ['-C', MEM, 'status', '--porcelain', '-z']).split('\0').map(l => l.slice(3)).filter(Boolean);
      const toRevert = touched.filter(p => fixedStems.includes(basename(p, '.md')));
      try { sh('node', [join(BRAIN, 'brain.mjs'), 'validate', '--mem', MEM]); validateOk = true; report.steps.normalized = true; normalizedStems = fixedStems; log('validate OK tras normalize'); }
      catch {
        // re-validate ROJO: habia error(es) no-normalizable(s). Revertir SOLO lo que normalize toco.
        if (toRevert.length) { try { sh('git', ['-C', MEM, 'checkout', '--', ...toRevert]); report.steps.normalizeReverted = toRevert.length; log(`normalize REVERTIDO (${toRevert.length} nodo[s] que normalize toco): el re-validate seguia rojo por errores no-normalizables`); } catch (re) { log('WARN: revert de normalize fallo:', re.message.slice(0, 80)); alert('normalize dejo el arbol sucio y el revert FALLO (revisar manual)'); } }
        else log('validate sigue rojo tras normalize, pero normalize no dejo nodos suyos que revertir (errores no-normalizables)');
        alert('validate en rojo tras normalize (errores no-normalizables; cambios de normalize revertidos)');
      }
    } catch (e) { log('normalize fallo:', e.message.slice(0, 80)); }
  }

  // 2.7) DRENAR INBOX (Fase 0): materializa la seccion Inbox de MEMORY.md a inbox/ (la lee el consolidador).
  if (treeClean && !DRY) {
    try { const dout = sh('node', [join(BRAIN, 'brain.mjs'), 'drain-inbox', '--mem', MEM]); if (!/vacio|no hay/.test(dout)) { log('drain-inbox:', dout.trim()); report.steps.drained = true; } } catch (e) { log('drain-inbox fallo:', e.message.slice(0, 60)); }
  }

  // 3) auto-demote cerrados >60d (solo si limpio)
  const demoted = [];
  if (treeClean) {
    for (const f of readdirSync(MEM)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const full = join(MEM, f);
      if (!lstatSync(full).isFile()) continue;
      // anclado al FRONTMATTER real (audit#5 G2): el regex ad-hoc anterior podia matchear 'status: cerrado'
      // dentro del cuerpo/un bloque de codigo y archivar un nodo vigente por error.
      const parsed = parseFrontmatter(readFileSync(full, 'utf8'));
      const md = parsed && parsed.fm.metadata;
      if (md && md.status === 'cerrado' && md.valid_from && daysSince(String(md.valid_from)) > DEMOTE_DAYS) {
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
    let destOk = true;
    try {
      mkdirSync(dst, { recursive: true });
      // filtro (audit#5 G11): inbox/ es transitorio + gitignored (punteros de sesion). El README promete que NO
      // se respalda; antes el cpSync crudo lo copiaba igual. Lo excluimos para honrar el contrato de backup.
      cpSync(MEM, join(dst, 'memory'), {
        recursive: true,
        filter: (s) => { const rel = s.slice(MEM.length).replace(/\\/g, '/').replace(/^\//, ''); return !(rel === 'inbox' || rel.startsWith('inbox/')); },
      });
      // lib.mjs es ahora nucleo (el parser vive ahi): sin el, brain.mjs/graph.mjs no corren -> entra al DR de codigo.
      for (const f of ['brain.mjs', 'graph.mjs', 'maintain.mjs', 'consolidate.mjs', 'brain.config.mjs', 'lib.mjs', 'restore.mjs', 'install.mjs', 'SYSTEM-STATE.md'])
        if (existsSync(join(BRAIN, f))) cpSync(join(BRAIN, f), join(dst, 'claude-brain', f));
      if (existsSync(join(BRAIN, 'visor', 'index.html'))) cpSync(join(BRAIN, 'visor', 'index.html'), join(dst, 'claude-brain', 'visor', 'index.html'));
      report.steps.backup = dst; log('backup ->', dst);
    } catch (e) { destOk = false; report.steps.backup = 'FALLO'; log('backup FALLO:', (e.message || '').slice(0, 80)); alert(`backup omitido (${e.code || 'error'}): ${(e.message || '').slice(0, 100)}`); }
    // 7b) DR de la episodica (audit#4): tarball rotado + alerta de obsolescencia. Va al BACKUP_DIR raiz
    //     (no al subdir -auto del dia) para que la rotacion cruce corridas y restore.mjs lo halle con --from <BACKUP_DIR>.
    if (destOk) backupEpisodic(BACKUP_DIR, report.ts);
  } else log('backup: (dry)');

  // 8) SYSTEM-STATE.md desde la realidad (incluye validate y tope blando)
  const nodes = readdirSync(MEM).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').length;
  const arch = existsSync(join(MEM, 'archivo')) ? readdirSync(join(MEM, 'archivo')).filter(f => f.endsWith('.md')).length : 0;
  const digs = existsSync(join(MEM, 'digests')) ? readdirSync(join(MEM, 'digests')).filter(f => f.endsWith('.md')).length : 0;
  const n0 = existsSync(join(MEM, 'MEMORY.md')) ? statSync(join(MEM, 'MEMORY.md')).size : 0;
  const stateDoc = `# SYSTEM-STATE (generado por maintain.mjs)\n\nActualizado: ${report.ts}\n\n- validate: ${validateOk ? 'OK' : 'ROJO — ' + String(report.steps.validate).slice(0, 120)}\n- Tree limpio: ${treeClean ? 'si' : 'no (WIP otra sesion)'}\n- Nodos raiz: ${nodes}\n- Digests (dominios): ${digs}\n- Archivados (archivo/): ${arch}\n- N0 (MEMORY.md): ${n0} bytes ${n0 > 7168 ? '(SOBRE tope blando 7168!)' : '(<=7168)'} (techo harness 25000)\n- Secretos en claro: ${secrets.length}\n- Demote esta corrida: ${demoted.length}\n- Backup: ${report.steps.backup || 'n/a'}\n\nFuente de verdad = markdown en este directorio. Grafo (graph.db) y N0 son derivados regenerables.\n`;
  if (!DRY) writeFileSync(join(BRAIN, 'SYSTEM-STATE.md'), stateDoc);
  report.steps.systemState = { nodes, digs, arch, n0, validateOk, treeClean };

  // 9) commit/push — solo si limpio (gate) + validate OK + hubo algun cambio del job (demote/normalize/drain).
  //    Staging EXPLICITO (audit#5 #11/D3): se re-verifica el arbol justo antes y solo se commitean paths del
  //    propio job (MEMORY.md, archivo/, nodos demoted/normalized). Si aparece algo ajeno en la ventana, se aborta.
  const huboCambio = demoted.length || report.steps.normalized || report.steps.drained;
  if (!DRY && treeClean && validateOk && huboCambio) {
    try {
      const now = sh('git', ['-C', MEM, 'status', '--porcelain', '-z']).split('\0').map(l => l.slice(3)).filter(Boolean);
      const demotedStems = demoted.map(f => basename(f, '.md'));
      const allowed = p => p === 'MEMORY.md' || p.startsWith('archivo/') || p.startsWith('inbox/')
        || demotedStems.includes(basename(p, '.md')) || normalizedStems.includes(basename(p, '.md'));
      const foreign = now.filter(p => !allowed(p));
      if (!now.length) { report.steps.git = 'sin cambios netos en el arbol'; }
      else if (foreign.length) {
        report.steps.git = 'omitido (WIP ajeno en la ventana)';
        alert('commit de maintain omitido: cambios inesperados en el arbol (' + foreign.slice(0, 5).join(', ') + ') — preservando posible WIP de otra sesion');
      } else {
        for (const p of now) sh('git', ['-C', MEM, 'add', '--', p]);  // stagea solo lo esperado (incluye borrados por demote)
        const msg = `maintain: ${demoted.length} demote${report.steps.normalized ? ' + normalize' : ''}${report.steps.drained ? ' + drain-inbox' : ''} + N0/grafo (${report.ts.slice(0, 10)})`;
        sh('git', ['-C', MEM, '-c', 'user.name=brain-maintainer', '-c', 'user.email=brain@local', 'commit', '-q', '-m', msg]);
        if (secrets.length) { report.steps.git = `commit local (push BLOQUEADO: ${secrets.length} secreto(s))`; alert(`push bloqueado por ${secrets.length} secretos`); }
        else { try { sh('git', ['-C', MEM, 'push', '-q', 'origin', 'main']); report.steps.git = 'commit+push'; } catch (pe) { report.steps.git = 'commit (push fallo)'; log('push fallo (commit local conservado):', (pe.message || '').slice(0, 60)); } }
      }
      log('git:', report.steps.git);
    } catch (e) { log('git: fallo', e.message.slice(0, 60)); }
  } else log(`git: ${!treeClean ? 'omitido (tree sucio)' : !validateOk ? 'omitido (validate ROJO)' : huboCambio ? '(dry)' : 'sin cambios'}`);

  if (!DRY) writeFileSync(join(BRAIN, 'last-maintain-report.json'), JSON.stringify(report, null, 2));  // dry no escribe (audit#6 #20)
  log('DONE. report -> last-maintain-report.json');
  return report;
}

// si se importa (para tests), no ejecutar main
if (process.argv[1] && process.argv[1].endsWith('maintain.mjs')) main();
