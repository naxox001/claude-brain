#!/usr/bin/env node
// graph.mjs — grafo derivado del cerebro (nodos/sinapsis) en SQLite embebido (node:sqlite, cero deps).
// DERIVADO y regenerable: si graph.db se borra o corrompe, `node graph.mjs build` lo reconstruye desde markdown.
// El markdown sigue siendo la fuente de verdad; este grafo es solo un indice de consulta + insumo del visor 3D.
// Uso: node graph.mjs <build|query|export-3d> [texto] [--mem <dir>] [--out <dir>]
//
// NOTA DE SINCRONIZACION: parseFrontmatter/parseScalar/scanLayer son copia deliberada de brain.mjs
// (mismo esquema v3). Si cambia el parser alla, reflejarlo aca. Refactor a lib.mjs comun = tarea de cleanup E6.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveMem, BRAIN_DIR } from './brain.config.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const memIdx = args.indexOf('--mem');
const outIdx = args.indexOf('--out');
const MEM = resolveMem(memIdx >= 0 ? args[memIdx + 1] : null);
const BRAIN = BRAIN_DIR;
const OUT = outIdx >= 0 ? args[outIdx + 1] : BRAIN;
const DB_PATH = join(OUT, 'derived', 'graph.db');
const JSON_PATH = join(OUT, 'visor', 'graph.json');

// ---- parser (sync con brain.mjs) ----
function parseScalar(s) {
  s = String(s).trim();
  const dq = s.startsWith('"') && s.endsWith('"');
  s = s.replace(/^["']|["']$/g, '');
  if (dq) s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '') return null;
  return s;
}
function parseFrontmatter(raw) {
  raw = raw.replace(/\r\n/g, '\n');  // CRLF-safe (sync con brain.mjs, fix audit 2026-06-13)
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = raw.slice(3, end);
  const fm = { metadata: {} };
  let inMeta = false;
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const metaChild = /^\s{2,}(\w[\w-]*):\s*(.*)$/.exec(line);
    if (inMeta && metaChild && /^\s/.test(line)) { fm.metadata[metaChild[1]] = parseScalar(metaChild[2]); continue; }
    const top = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      inMeta = top[1] === 'metadata';
      if (!inMeta) fm[top[1]] = parseScalar(top[2]);
      if (inMeta && top[2].trim().startsWith('{')) {
        for (const kv of top[2].replace(/[{}]/g, '').split(',')) {
          const m = /\s*(\w[\w-]*):\s*(.+)\s*/.exec(kv);
          if (m) fm.metadata[m[1]] = parseScalar(m[2].trim());
        }
        inMeta = false;
      }
    }
  }
  return { fm, body: raw.slice(end + 4) };
}
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
    // supersedes (temporal)
    if (md.superseded_by) addEdge(stem, String(md.superseded_by), 'supersedes');
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
  if (!existsSync(DB_PATH)) build();
  const db = new DatabaseSync(DB_PATH);
  let rows;
  try {
    // OR de terminos con prefijo (mejor recall que el AND implicito de FTS5)
    const ftsQuery = text.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ');
    rows = db.prepare(`SELECT n.id, n.domain, n.status, n.description FROM nodes_fts f JOIN nodes n ON n.id=f.id WHERE nodes_fts MATCH ? ORDER BY rank LIMIT 5`).all(ftsQuery);
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
  writeFileSync(JSON_PATH, JSON.stringify(out, null, 0));
  const domains = [...new Set(nodes.map(n => n.domain))].length;
  console.log(`export-3d OK: ${out.nodes.length} nodos, ${out.links.length} links, ${domains} dominios -> ${JSON_PATH}`);
}

if (cmd === 'build') build();
else if (cmd === 'query') query(args.slice(1).filter(a => !a.startsWith('--') && a !== MEM && a !== OUT).join(' '));
else if (cmd === 'export-3d') export3d();
else { console.error('Uso: node graph.mjs <build|query|export-3d> [texto] [--mem <dir>] [--out <dir>]'); process.exit(2); }
