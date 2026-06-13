#!/usr/bin/env node
// brain.mjs — CLI del cerebro de memoria persistente (E3: render-index + validate)
// Markdown soberano: este script solo DERIVA (genera N0, valida estructura).
// Cero dependencias npm a proposito (portabilidad total).
// Uso: node brain.mjs <render-index|validate> [--mem <dir>] [--dry-run]

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveMem } from './brain.config.mjs';
import { parseFrontmatter, writeAtomic } from './lib.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const memIdx = args.indexOf('--mem');
// guard anti foot-gun (audit#6 #7): '--mem' sin valor caia SILENCIOSAMENTE a la memoria REAL. Abortar.
if (memIdx >= 0 && (args[memIdx + 1] === undefined || args[memIdx + 1].startsWith('--'))) { console.error('--mem requiere una ruta'); process.exit(2); }
const MEM = resolveMem(memIdx >= 0 ? args[memIdx + 1] : null);
const DRY = args.includes('--dry-run');
const N0_CAP = 7168;          // tope duro del indice generado (bytes)
const HARNESS_CAP = 25000;    // techo de truncamiento del harness (referencia)
const INBOX_MARKER = '## Inbox (nuevas entradas — el consolidador las integra)';

// parser de frontmatter v3: ahora vive en lib.mjs (fuente unica, importado arriba).

// --- scan de la capa ---
function scanLayer() {
  const nodes = [];
  const dirs = [[MEM, ''], [join(MEM, 'digests'), 'digests/'], [join(MEM, 'archivo'), 'archivo/']];
  for (const [dir, prefix] of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md' || f === 'audit-scores.md' || f === 'CATALOGO.md') continue;
      const full = join(dir, f);
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, 'utf8');
      const parsed = parseFrontmatter(raw);
      nodes.push({
        file: prefix + f, stem: basename(f, '.md'), raw,
        fm: parsed ? parsed.fm : null, body: parsed ? parsed.body : raw,
      });
    }
  }
  return nodes;
}

// --- render-index: genera MEMORY.md (N0) ---
function renderIndex() {
  const nodes = scanLayer();
  // AVISO de descartados (fix audit 2026-06-13): nodos sin v3 valido NO entran al N0 — hacerlo ruidoso,
  // no silencioso, para que un nodo nuevo mal formado (ej. de la memory-tool nativa) se note.
  const STATUS_OK = ['vigente', 'cerrado', 'pausado'];
  const discarded = nodes.filter(n => !n.fm || !n.fm.metadata.domain || !STATUS_OK.includes(n.fm.metadata.status));
  if (discarded.length) console.error(`[AVISO] render-index: ${discarded.length} nodo(s) con frontmatter v3 invalido NO entran al N0: ${discarded.map(n => n.stem).join(', ')}. Corre 'node brain.mjs validate' o 'node brain.mjs normalize'.`);
  // PISO DE SEGURIDAD: si NO hay nodos v3 VALIDOS pero el dir tiene .md, algo fallo (parser/ruta). No sobreescribir el N0.
  // Cuenta v3-validos (no solo parseables): un dir lleno de nodos rotos-pero-parseables NO debe vaciar el N0 (audit#5 #27).
  const valid = nodes.filter(n => !discarded.includes(n));
  // hay markdown en disco si scanLayer hallo algun .md en raiz/digests/archivo (audit#6 #3: antes solo miraba
  // la raiz, dejando el piso ciego a una memoria con nodos SOLO en digests/ o archivo/).
  const mdOnDisk = nodes.length > 0;
  if (valid.length === 0 && mdOnDisk) {
    console.error('[ABORT] render-index: 0 nodos validos parseados pero hay .md en disco. No se sobreescribe MEMORY.md (posible parser/ruta rota).');
    process.exit(1);
  }
  // Reglas duras: importance>=5 Y vigente (audit#5 G10: una regla cerrada/pausada con importance 5 NO
  // debe presentarse como "siempre vigente" en cada sesion; para retirar una regla basta cambiar su status).
  const reglas = nodes.filter(n => n.fm && Number(n.fm.metadata.importance) >= 5 && !n.fm.metadata.digest && n.fm.metadata.status === 'vigente')
    .sort((a, b) => a.stem.localeCompare(b.stem));
  // digests v3-VALIDOS (excluye los descartados): un digest sin domain/status no debe rendir una linea '**undefined**' (audit#6 #11/#21)
  const digests = nodes.filter(n => !discarded.includes(n) && n.fm.metadata.digest)
    .sort((a, b) => String(a.fm.metadata.domain).localeCompare(String(b.fm.metadata.domain)));
  const porDominio = {};
  for (const n of nodes.filter(n => n.fm && !n.fm.metadata.digest)) {
    const d = n.fm.metadata.domain || 'sin-dominio';
    (porDominio[d] = porDominio[d] || { vig: 0, cer: 0, pau: 0 })[
      n.fm.metadata.status === 'vigente' ? 'vig' : n.fm.metadata.status === 'pausado' ? 'pau' : 'cer'
    ]++;
  }

  // primera linea de "Vigente ahora" del digest como resumen del dominio
  function resumenDigest(n) {
    const m = /## Vigente ahora[^\n]*\n+([^\n#]+)/.exec(n.body);
    return (m ? m[1] : n.fm.description || '').trim().replace(/^[-*]\s+/, '').replace(/\*\*/g, '').slice(0, 170);
  }

  // preservar Inbox actual
  let inbox = '';
  const memPath = join(MEM, 'MEMORY.md');
  if (existsSync(memPath)) {
    const cur = readFileSync(memPath, 'utf8');
    const i = cur.indexOf(INBOX_MARKER);
    if (i >= 0) inbox = cur.slice(i + INBOX_MARKER.length).replace(/^\n+/, '').trimEnd();
  }

  const L = [];
  L.push('<!-- GENERADO por claude-brain/brain.mjs render-index — NO editar a mano (salvo seccion Inbox). Regenerar tras editar frontmatter. -->');
  L.push('');
  L.push('## Reglas duras (siempre vigentes)');
  for (const n of reglas) L.push(`- [${n.fm.name}](${n.file}) — ${String(n.fm.description).slice(0, 220)}`);
  L.push('');
  L.push('## Dominios (cargar digest SOLO si la conversacion lo toca)');
  for (const n of digests) {
    const d = n.fm.metadata.domain;
    const c = porDominio[d] || { vig: 0, cer: 0, pau: 0 };
    L.push(`- **${d}** → [digest](${n.file}) (${c.vig} vivos${c.pau ? `, ${c.pau} pausados` : ''}${c.cer ? `, ${c.cer} cerrados` : ''}) — ${resumenDigest(n)}`);
  }
  L.push('');
  L.push('## Historico');
  L.push('- Catalogo de memorias cerradas: [archivo/CATALOGO.md](archivo/CATALOGO.md). Busqueda: Grep sobre este directorio; conversaciones pasadas: episodic-memory.');
  L.push('');
  L.push(INBOX_MARKER);
  L.push(inbox || '<!-- vacio -->');
  L.push('');

  const out = L.join('\n');
  const bytes = Buffer.byteLength(out, 'utf8');

  // catalogo de cerrados (N1, no inyectado)
  const cerrados = nodes.filter(n => n.fm && !n.fm.metadata.digest && n.fm.metadata.status !== 'vigente')
    .sort((a, b) => String(b.fm.metadata.valid_from).localeCompare(String(a.fm.metadata.valid_from)));
  const C = ['<!-- GENERADO por brain.mjs — catalogo de memorias cerradas/pausadas -->', '# Catalogo historico', ''];
  for (const n of cerrados) C.push(`- [${n.fm.name}](../${n.file}) — [${n.fm.metadata.status}${n.fm.metadata.valid_from ? ' ' + n.fm.metadata.valid_from : ''}] ${String(n.fm.description).slice(0, 200)}`);

  if (DRY) {
    console.log(`[dry-run] N0: ${bytes} bytes (cap ${N0_CAP}) · reglas=${reglas.length} dominios=${digests.length} cerrados=${cerrados.length}`);
    console.log(out);
    return;
  }
  if (bytes > N0_CAP) {
    console.error(`[WARNING] N0 generado = ${bytes} bytes > cap ${N0_CAP}. Escrito igual (harness trunca a ${HARNESS_CAP}); compacta reglas/descriptions y regenera.`);
  }
  writeAtomic(memPath, out);  // atomico (audit#5 G3): un kill-9/ENOSPC a mitad no deja el N0 truncado
  if (!existsSync(join(MEM, 'archivo'))) mkdirSync(join(MEM, 'archivo'));
  writeAtomic(join(MEM, 'archivo', 'CATALOGO.md'), C.join('\n') + '\n');
  console.log(`N0 escrito: ${bytes} bytes (cap ${N0_CAP}, margen ${N0_CAP - bytes}) · reglas=${reglas.length} dominios=${digests.length} · catalogo=${cerrados.length} cerrados`);
}

// --- validate: validador estructural ---
function validate() {
  const nodes = scanLayer();
  const errors = [];
  const stems = new Set(nodes.map(n => n.stem));
  const STATUS = new Set(['vigente', 'cerrado', 'pausado']);

  for (const n of nodes) {
    if (!n.fm) { errors.push(`${n.file}: sin frontmatter`); continue; }
    const expectedName = n.fm.metadata.digest ? `digest-${n.stem}` : n.stem;
    if (n.fm.name !== expectedName) errors.push(`${n.file}: name "${n.fm.name}" != esperado "${expectedName}"`);
    if (!n.fm.description) errors.push(`${n.file}: sin description`);
    if (!n.fm.metadata.domain) errors.push(`${n.file}: sin metadata.domain`);
    if (!STATUS.has(n.fm.metadata.status)) errors.push(`${n.file}: status invalido "${n.fm.metadata.status}"`);
    if (n.fm.metadata.superseded_by && !stems.has(String(n.fm.metadata.superseded_by))) {
      errors.push(`${n.file}: superseded_by apunta a nodo inexistente "${n.fm.metadata.superseded_by}"`);
    }
    // contradiccion (audit#5 G9): un nodo VIGENTE que declara superseded_by deberia estar cerrado/pausado.
    // Esto hace real la deteccion de "contradicciones" que el README promete y la deja como gate del lazo.
    if (n.fm.metadata.superseded_by && n.fm.metadata.status === 'vigente') {
      errors.push(`${n.file}: contradiccion — status vigente pero superseded_by="${n.fm.metadata.superseded_by}" (deberia estar cerrado/pausado)`);
    }
    if (n.fm.metadata.superseded_by && String(n.fm.metadata.superseded_by) === n.stem) {
      errors.push(`${n.file}: superseded_by se apunta a si mismo (audit#6 #34)`);
    }
    for (const m of n.body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const t = m[1].trim();
      if (!stems.has(t) && !stems.has(t.replace(/-/g, '_'))) errors.push(`${n.file}: wikilink roto [[${t}]]`);
    }
  }
  // todo dominio con nodos debe tener digest
  const domains = new Set(nodes.filter(n => n.fm && !n.fm.metadata.digest).map(n => n.fm && n.fm.metadata.domain).filter(Boolean));
  const digestDomains = new Set(nodes.filter(n => n.fm && n.fm.metadata.digest).map(n => n.fm.metadata.domain));
  for (const d of domains) if (!['sin-dominio', 'reglas', 'sin-clasificar'].includes(d) && !digestDomains.has(d)) errors.push(`dominio "${d}" sin digest en digests/`);
  // tope N0
  const memPath = join(MEM, 'MEMORY.md');
  if (existsSync(memPath)) {
    const b = statSync(memPath).size;
    if (b > HARNESS_CAP) errors.push(`MEMORY.md = ${b} bytes > techo harness ${HARNESS_CAP} (TRUNCAMIENTO ACTIVO)`);
  }

  if (errors.length) {
    console.error(`VALIDACION: ${errors.length} errores`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`VALIDACION OK: ${nodes.length} nodos, ${domains.size} dominios, 0 errores`);
}

// --- add: crea un nodo v3 canonico (el camino correcto para agregar memoria sin recordar el frontmatter) ---
function flag(k) { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; }
function today() { return new Date().toISOString().slice(0, 10); }
const STATUS_OK = ['vigente', 'cerrado', 'pausado'];

function addNode() {
  const type = flag('type') || 'reference';
  const domain = flag('domain');
  const status = STATUS_OK.includes(flag('status')) ? flag('status') : 'vigente';
  const importance = flag('importance') || (type === 'feedback' ? '4' : type === 'reference' ? '2' : '3');
  let name = flag('name');
  const desc = flag('desc') || flag('description') || '';
  const valid = flag('valid') || today();
  if (!name || !domain) {
    console.error('Uso: node brain.mjs add --name <slug> --domain <dom> --desc "una linea"');
    console.error('  opcionales: --type project|reference|feedback|user|handoff (def reference) --status vigente|cerrado|pausado (def vigente) --importance 1-5 --valid YYYY-MM-DD');
    process.exit(2);
  }
  name = name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().replace(/^_|_$/g, '');
  if (!name) { console.error('--name quedo vacio tras sanitizar; usa al menos un caracter alfanumerico'); process.exit(2); }
  if (!existsSync(MEM)) { console.error('El dir de memoria no existe: ' + MEM); process.exit(2); }
  const path = join(MEM, name + '.md');
  if (existsSync(path)) { console.error('Ya existe: ' + path); process.exit(1); }
  const d = /[:#"\n\r]/.test(desc) ? JSON.stringify(desc) : desc;  // sanitiza tambien saltos de linea (audit#5 #17)
  const fm = `---\nname: ${name}\ndescription: ${d}\nmetadata:\n  type: ${type}\n  domain: ${domain}\n  status: ${status}\n  valid_from: ${valid}\n  importance: ${importance}\n---\n\n# ${name.replace(/_/g, ' ')}\n\n`;
  writeFileSync(path, fm);
  console.log(`Creado nodo v3: ${path}`);
  console.log(`Edita el cuerpo y luego: node brain.mjs render-index`);
}

// --- normalize: repara nodos con frontmatter no-v3 (ej. los que escribe la memory-tool nativa) ---
function normalize() {
  const dry = args.includes('--dry-run');
  const nodes = scanLayer().filter(n => n.fm);
  const fixed = [];
  for (const n of nodes) {
    const md = n.fm.metadata;
    const expectedName = md.digest ? `digest-${n.stem}` : n.stem;
    const bad = n.fm.name !== expectedName || !md.domain || !STATUS_OK.includes(md.status);
    if (bad && !md.digest) {
      const meta = { ...md };
      meta.type = md.type || 'reference';
      meta.domain = md.domain || 'sin-clasificar';
      meta.status = STATUS_OK.includes(md.status) ? md.status : 'vigente';
      meta.valid_from = md.valid_from || today();
      meta.importance = md.importance || 2;
      const desc = n.fm.description || n.stem.replace(/_/g, ' ');
      const d = /[:#"\n\r]/.test(String(desc)) ? JSON.stringify(desc) : desc;  // sanitiza saltos (audit#5 #17)
      let block = `---\nname: ${expectedName}\ndescription: ${d}\nmetadata:\n`;
      for (const [k, v] of Object.entries(meta)) block += `  ${k}: ${v}\n`;
      block += '---\n';
      const full = join(MEM, n.file);
      if (!dry) writeAtomic(full, block + n.body);
      fixed.push(`${n.stem} (domain=${meta.domain}, status=${meta.status})`);
    }
  }
  console.log(`${dry ? '[dry] ' : ''}normalize: ${fixed.length} nodo(s) ${dry ? 'a reparar' : 'reparados'}`);
  fixed.forEach(f => console.log('  - ' + f));
  if (fixed.length && !dry) console.log('Revisa los domain="sin-clasificar" y reasigna; luego: node brain.mjs render-index');
}

// --- drain-inbox: materializa la seccion Inbox de MEMORY.md como notas reales en inbox/ ---
// Cierra el "doble buzon" (audit#3): lo que se appendea al Inbox del N0 deja de quedarse ahi muerto;
// pasa a inbox/ donde el consolidador SI lo lee. Deterministico, sin LLM. Limpia la seccion del N0.
function drainInbox() {
  const memPath = join(MEM, 'MEMORY.md');
  if (!existsSync(memPath)) { console.log('no hay MEMORY.md'); return; }
  const cur = readFileSync(memPath, 'utf8').replace(/\r\n/g, '\n');
  const i = cur.indexOf(INBOX_MARKER);
  if (i < 0) { console.log('sin seccion Inbox'); return; }
  const body = cur.slice(i + INBOX_MARKER.length).replace(/^\n+/, '').trim();
  if (!body || body === '<!-- vacio -->') { console.log('Inbox vacio — nada que drenar'); return; }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);  // granularidad de SEGUNDOS (audit#5 #37)
  const dst = join(MEM, 'inbox');
  let note = join(dst, `_pending_${stamp}.md`);
  for (let k = 2; existsSync(note); k++) note = join(dst, `_pending_${stamp}_${k}.md`);  // no sobreescribir una nota previa
  if (DRY) { console.log(`[dry] drenaria ${body.length} chars del Inbox -> ${note}`); return; }  // dry NO crea inbox/ (audit#6 #25)
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
  writeAtomic(note, `# Nota cruda drenada del Inbox de N0 (${stamp})\n\n${body}\n`);
  // limpia la seccion Inbox del N0 (render-index la regenera vacia luego)
  writeAtomic(memPath, cur.slice(0, i + INBOX_MARKER.length) + '\n<!-- vacio -->\n');
  console.log(`Inbox drenado -> ${note} (${body.length} chars). Corre el consolidador o render-index.`);
}

// --- capture: productor automatico del lazo (Fase 1). Lo invoca el hook Stop con el JSON del harness en stdin.
// Deposita UN puntero de sesion en inbox/ (idempotente por session_id). NO toca git/N0/nodos. El consolidador lo lee.
// Los depositos van gitignored, asi NO ensucian el arbol ni bloquean los gates.
function capture() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* sin stdin valido: nota minima */ }
  const tp = input.transcript_path || input.transcriptPath || '';
  const cwd = input.cwd || input.workingDirectory || '';
  let sid = (input.session_id || input.sessionId || '').toString().slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, '');
  // sin session_id: derivar un id ESTABLE del transcript (idempotente para la misma sesion) o, en ultimo caso,
  // uno unico por proceso. Asi dos sesiones sin id NO colapsan en _session_desconocida.md perdiendo un puntero (audit#5 #42).
  if (!sid) {
    const basis = tp || (String(process.pid) + '-' + Date.now());
    let h = 5381; for (let k = 0; k < basis.length; k++) h = ((h * 33) ^ basis.charCodeAt(k)) >>> 0;
    sid = 'anon-' + h.toString(36);
  }
  // GUARD anti-auto-ingestion recursiva (audit#4): el consolidador spawnea `claude -p` con BRAIN_CONSOLIDATING
  // seteado; si esa sub-sesion dispara el hook Stop, NO debe auto-depositar un puntero a su propio transcript.
  // Tambien NO-OP si la sesion corre DENTRO de MEM (cwd en la carpeta de memoria = es el propio consolidador).
  if (process.env.BRAIN_CONSOLIDATING) process.exit(0);
  const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const cwdN = norm(cwd), memN = norm(MEM);
  if (cwdN && memN && (cwdN === memN || cwdN.startsWith(memN + '/'))) process.exit(0);
  const inbox = join(MEM, 'inbox'); if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true });
  const note = join(inbox, `_session_${sid}.md`);
  if (existsSync(note)) { process.exit(0); } // idempotente: una sesion, una nota
  const stamp = new Date().toISOString().slice(0, 16);
  writeAtomic(note, `# Sesion ${sid} (${stamp})\n\ncwd: ${cwd}\ntranscript: ${tp}\n\nPendiente: el consolidador debe leer el transcript y extraer SOLO memorias durables (decisiones, lecciones, hechos nuevos); descartar lo efimero.\n`);
  process.exit(0);
}

if (cmd === 'render-index') renderIndex();
else if (cmd === 'validate') validate();
else if (cmd === 'add') addNode();
else if (cmd === 'normalize') normalize();
else if (cmd === 'drain-inbox') drainInbox();
else if (cmd === 'capture') capture();
else { console.error('Uso: node brain.mjs <render-index|validate|add|normalize|drain-inbox|capture> [--mem <dir>] [--dry-run]'); process.exit(2); }
