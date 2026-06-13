#!/usr/bin/env node
// graph.mjs — grafo derivado del cerebro (nodos/sinapsis) en SQLite embebido (node:sqlite, cero deps).
// DERIVADO y regenerable: si graph.db se borra o corrompe, `node graph.mjs build` lo reconstruye desde markdown.
// El markdown sigue siendo la fuente de verdad; este grafo es solo un indice de consulta + insumo del visor 3D.
// Uso: node graph.mjs <build|query|export-3d> [texto] [--mem <dir>] [--out <dir>]
//
// El parser v3 (parseFrontmatter/parseScalar) vive en lib.mjs (fuente UNICA, compartida con brain.mjs):
// ya no hay copia que pueda divergir (audit#5: el viejo test de "paridad" entre copias era falso-verde).

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveMem, BRAIN_DIR } from './brain.config.mjs';
import { parseFrontmatter, writeAtomic } from './lib.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const memIdx = args.indexOf('--mem');
const outIdx = args.indexOf('--out');
const MEM = resolveMem(memIdx >= 0 ? args[memIdx + 1] : null);
const BRAIN = BRAIN_DIR;
const OUT = outIdx >= 0 ? args[outIdx + 1] : BRAIN;
const DB_PATH = join(OUT, 'derived', 'graph.db');
const JSON_PATH = join(OUT, 'visor', 'graph.json');

function scanLayer(mem) {
  const nodes = [];
  for (const [dir, prefix] of [[mem, ''], [join(mem, 'digests'), 'digests/'], [join(mem, 'archivo'), 'archivo/']]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md' || f === 'audit-scores.md' || f === 'CATALOGO.md') continue;
      const full = join(dir, f);
      if (!statSync(full).isFile()) continue;
      const parsed = parseFrontmatter(readFileSync(full, 'utf8'));
      nodes.push({ file: prefix + f, stem: basename(f, '.md'), fm: parsed ? parsed.fm : null, body: parsed ? parsed.body : '' });
    }
  }
  return nodes;
}

// ---- construir nodos + aristas en memoria ----
function buildModel() {
  const raw = scanLayer(MEM).filter(n => n.fm);
  const byStem = new Map(raw.map(n => [n.stem, n]));
  // digest por dominio
  const digestOf = {};
  for (const n of raw) if (n.fm.metadata.digest) digestOf[n.fm.metadata.domain] = n.stem;

  const nodes = raw.map(n => ({
    id: n.stem,
    name: n.fm.name || n.stem,
    domain: n.fm.metadata.domain || 'sin-dominio',
    status: n.fm.metadata.status || (n.fm.metadata.digest ? 'vigente' : 'cerrado'),
    importance: Number(n.fm.metadata.importance) || (n.fm.metadata.digest ? 4 : 1),
    type: n.fm.metadata.type || 'reference',
    isDigest: !!n.fm.metadata.digest,
    description: n.fm.description || '',
    body: n.body || '',
  }));

  const edges = [];
  const seen = new Set();
  const addEdge = (src, dst, rel) => {
    if (!src || !dst || src === dst || !byStem.has(dst)) return;
    const k = `${src}|${dst}|${rel}`;
    if (seen.has(k)) return; seen.add(k);
    edges.push({ src, dst, rel });
  };
  for (const n of raw) {
    const stem = n.stem, md = n.fm.metadata;
    // member: nodo -> digest de su dominio (estructura de lobulos)
    if (!md.digest && digestOf[md.domain]) addEdge(stem, digestOf[md.domain], 'member');
    // supersedes (temporal): A con `superseded_by: B` significa "B reemplaza a A" -> arista B --supersedes--> A.
    // (audit#5 #28: antes A->B, direccion invertida respecto a la etiqueta). byStem.has guarda que el src exista.
    if (md.superseded_by && byStem.has(String(md.superseded_by))) addEdge(String(md.superseded_by), stem, 'supersedes');
    // relates (lista inline [a, b])
    if (md.relates) for (const r of String(md.relates).replace(/[[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)) addEdge(stem, r, 'relates');
    // wikilinks del cuerpo (sinapsis cross-dominio = lo interesante)
    for (const m of (n.body || '').matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      let t = m[1].trim();
      if (!byStem.has(t) && byStem.has(t.replace(/-/g, '_'))) t = t.replace(/-/g, '_');
      addEdge(stem, t, 'wikilink');
    }
  }
  return { nodes, edges };
}

function build() {
  const { nodes, edges } = buildModel();
  mkdirSync(join(OUT, 'derived'), { recursive: true });
  try { rmSync(DB_PATH); } catch {}
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE nodes(id TEXT PRIMARY KEY, name TEXT, domain TEXT, status TEXT, importance INT, type TEXT, is_digest INT, description TEXT);
    CREATE TABLE edges(src TEXT, dst TEXT, rel TEXT);
    CREATE INDEX idx_edges_src ON edges(src);
    CREATE INDEX idx_edges_dst ON edges(dst);
  `);
  let fts = false;
  try { db.exec(`CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, name, description, body)`); fts = true; }
  catch { /* SQLite sin FTS5: query cae a LIKE */ }
  const ni = db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)`);
  for (const n of nodes) ni.run(n.id, n.name, n.domain, n.status, n.importance, n.type, n.isDigest ? 1 : 0, n.description);
  const ei = db.prepare(`INSERT INTO edges VALUES (?,?,?)`);
  for (const e of edges) ei.run(e.src, e.dst, e.rel);
  if (fts) { const fi = db.prepare(`INSERT INTO nodes_fts VALUES (?,?,?,?)`); for (const n of nodes) fi.run(n.id, n.name, n.description, n.body); }
  db.close();
  console.log(`build OK: ${nodes.length} nodos, ${edges.length} aristas, FTS5=${fts} -> ${DB_PATH}`);
  return { nodes: nodes.length, edges: edges.length, fts };
}

function query(text) {
  if (!text) { console.error('query requiere texto'); process.exit(2); }
  // db DERIVADA: si falta o esta CORRUPTA (corte a mitad de build, disco lleno) se reconstruye (audit#5 #26),
  // igual que el caso ausente; antes una db corrupta crasheaba toda consulta y exigia borrarla a mano.
  if (!existsSync(DB_PATH)) build();
  let db;
  try { db = new DatabaseSync(DB_PATH); db.prepare('SELECT 1 FROM nodes LIMIT 1').get(); }
  catch { try { db && db.close(); } catch {} try { rmSync(DB_PATH, { force: true }); } catch {} build(); db = new DatabaseSync(DB_PATH); }
  let rows;
  try {
    // PRECISION (audit#3): BM25 con peso por campo (name >> description >> body) + AND-primero, OR como fallback.
    // El OR-de-prefijos viejo inflaba recall y destruia precision (devolvia ruido por prefijos comunes).
    const terms = text.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '')}"*`);
    const sel = `SELECT n.id, n.domain, n.status, n.description FROM nodes_fts f JOIN nodes n ON n.id=f.id WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts, 0.0, 10.0, 5.0, 1.0) LIMIT 5`;
    rows = db.prepare(sel).all(terms.join(' AND '));               // AND: alta precision
    if (!rows.length && terms.length > 1) rows = db.prepare(sel).all(terms.join(' OR ')); // fallback: recall
  } catch {
    const like = `%${text.replace(/\s+/g, '%')}%`;
    rows = db.prepare(`SELECT id, domain, status, description FROM nodes WHERE name LIKE ? OR description LIKE ? LIMIT 5`).all(like, like);
  }
  console.log(`\nMATCH (${rows.length}):`);
  for (const r of rows) console.log(`  [${r.domain}/${r.status}] ${r.id} — ${(r.description || '').slice(0, 90)}`);
  // expansion 1 salto (recuerdo asociativo)
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const ph = ids.map(() => '?').join(',');
    const neigh = db.prepare(`SELECT DISTINCT CASE WHEN src IN (${ph}) THEN dst ELSE src END AS nb, rel FROM edges WHERE src IN (${ph}) OR dst IN (${ph})`).all(...ids, ...ids, ...ids);
    const extra = neigh.filter(x => !ids.includes(x.nb));
    if (extra.length) { console.log(`\nVECINDARIO (1 salto):`); for (const x of extra.slice(0, 12)) console.log(`  -(${x.rel})-> ${x.nb}`); }
  }
  db.close();
}

function export3d() {
  const { nodes, edges } = buildModel();
  const out = {
    generated: 'brain graph.mjs export-3d',
    nodes: nodes.map(n => ({ id: n.id, name: n.name, domain: n.domain, status: n.status, type: n.type, isDigest: n.isDigest, val: n.isDigest ? 8 : (n.importance * n.importance) / 2 + 1 })),
    links: edges.map(e => ({ source: e.src, target: e.dst, rel: e.rel })),
  };
  mkdirSync(join(OUT, 'visor'), { recursive: true });
  writeAtomic(JSON_PATH, JSON.stringify(out, null, 0));  // atomico (audit#5 G3)
  const domains = [...new Set(nodes.map(n => n.domain))].length;
  console.log(`export-3d OK: ${out.nodes.length} nodos, ${out.links.length} links, ${domains} dominios -> ${JSON_PATH}`);
}

if (cmd === 'build') build();
else if (cmd === 'query') query(args.slice(1).filter(a => !a.startsWith('--') && a !== MEM && a !== OUT).join(' '));
else if (cmd === 'export-3d') export3d();
else { console.error('Uso: node graph.mjs <build|query|export-3d> [texto] [--mem <dir>] [--out <dir>]'); process.exit(2); }
