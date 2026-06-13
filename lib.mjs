// lib.mjs — utilidades compartidas del cerebro. Fuente UNICA del parser v3 (antes duplicado en
// brain.mjs y graph.mjs con un test de "paridad" que resulto ser falso-verde, audit#5 Critical).
// Al importar ambos desde aca, la paridad es estructural: no hay dos copias que puedan divergir.
import { writeFileSync, renameSync } from 'node:fs';

// parser de frontmatter (subset YAML suficiente para el esquema v3).
export function parseScalar(s) {
  s = String(s).trim();
  const dq = s.startsWith('"') && s.endsWith('"');
  s = s.replace(/^["']|["']$/g, '');
  if (dq) s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\'); // unescape YAML double-quoted
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '') return null;
  return s;
}

export function parseFrontmatter(raw) {
  raw = raw.replace(/\r\n/g, '\n');  // CRLF-safe (Windows/consolidador puede escribir CRLF)
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = raw.slice(3, end);
  const fm = { metadata: {} };
  let inMeta = false;
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    // indentacion de 1+ espacios (audit#5 D1: YAML acepta >=1; antes \s{2,} descartaba metadata con 1 espacio).
    const metaChild = /^\s+(\w[\w-]*):\s*(.*)$/.exec(line);
    if (inMeta && metaChild && /^\s/.test(line)) {
      fm.metadata[metaChild[1]] = parseScalar(metaChild[2]);
      continue;
    }
    const top = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      inMeta = top[1] === 'metadata';
      if (!inMeta) fm[top[1]] = parseScalar(top[2]);
      // metadata inline: metadata: { type: x, ... }
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

// writeAtomic: escribe a <path>.tmp y renombra encima (audit#5 G3). renameSync es atomico en el mismo
// filesystem (POSIX) y reemplaza el destino en Windows (MoveFileEx con REPLACE_EXISTING). Asi un kill-9 /
// ENOSPC a mitad NO deja el N0 / digest / graph.json truncado: o queda el original intacto, o el nuevo completo.
export function writeAtomic(path, data) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
