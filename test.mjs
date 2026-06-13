#!/usr/bin/env node
// test.mjs — suite del cerebro con node:test (cero dependencias). Correr: node --test
// Cubre: validate del ejemplo, determinismo de render-index, deteccion de cada clase de error,
// add/normalize, y PARIDAD de los parsers duplicados brain.mjs <-> graph.mjs (invariante verificado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
// exec que devuelve {code, out}; nunca lanza
function run(cmdArgs) {
  try { const out = execFileSync(NODE, cmdArgs, { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, out }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}
function tmpMem() {
  const d = mkdtempSync(join(tmpdir(), 'brain-test-'));
  const mem = join(d, 'mem'); mkdirSync(join(mem, 'digests'), { recursive: true });
  writeFileSync(join(mem, 'digests', 'web.md'), '---\nname: digest-web\ndescription: d\nmetadata: { type: reference, domain: web, status: vigente, valid_from: 2026-01-01, digest: true }\n---\n# D\n## Vigente ahora\nok\n');
  return { d, mem };
}

test('example/memory valida limpio', () => {
  const r = run(['brain.mjs', 'validate', '--mem', 'example/memory']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /VALIDACION OK/);
});

test('render-index es determinista (dos corridas, N0 identico)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-det-'));
  const mem = join(d, 'mem'); cpSync(join(HERE, 'example', 'memory'), mem, { recursive: true });
  run(['brain.mjs', 'render-index', '--mem', mem]);
  const a = readFileSync(join(mem, 'MEMORY.md'), 'utf8');
  run(['brain.mjs', 'render-index', '--mem', mem]);
  const b = readFileSync(join(mem, 'MEMORY.md'), 'utf8');
  assert.equal(a, b, 'N0 deberia ser identico entre corridas');
  rmSync(d, { recursive: true, force: true });
});

test('validate detecta cada clase de error', () => {
  const { d, mem } = tmpMem();
  // name != stem, sin domain, status invalido
  writeFileSync(join(mem, 'project_malo.md'), '---\nname: otro-nombre\ndescription: x\nmetadata:\n  type: project\n---\ncuerpo\n');
  const r = run(['brain.mjs', 'validate', '--mem', mem]);
  assert.equal(r.code, 1);
  assert.match(r.out, /name "otro-nombre" != esperado/);
  assert.match(r.out, /sin metadata\.domain/);
  assert.match(r.out, /status invalido/);
  rmSync(d, { recursive: true, force: true });
});

test('validate caza wikilink roto', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_a.md'), '---\nname: project_a\ndescription: x\nmetadata:\n  type: project\n  domain: web\n  status: vigente\n  valid_from: 2026-01-01\n  importance: 3\n---\nver [[no_existe]]\n');
  const r = run(['brain.mjs', 'validate', '--mem', mem]);
  assert.equal(r.code, 1);
  assert.match(r.out, /wikilink roto \[\[no_existe\]\]/);
  rmSync(d, { recursive: true, force: true });
});

test('add genera nodo v3 valido', () => {
  const { d, mem } = tmpMem();
  const r = run(['brain.mjs', 'add', '--mem', mem, '--name', 'Hola Mundo!!', '--domain', 'web', '--type', 'project', '--desc', 'con: dos puntos']);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(mem, 'hola_mundo.md')), 'debe sanitizar el nombre a hola_mundo');
  assert.equal(run(['brain.mjs', 'validate', '--mem', mem]).code, 0);
  rmSync(d, { recursive: true, force: true });
});

test('normalize repara nodo estilo memory-tool nativa', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_nativo.md'), '---\nname: project-nativo\ndescription: x\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: abc\n---\ncuerpo\n');
  assert.equal(run(['brain.mjs', 'validate', '--mem', mem]).code, 1, 'debe fallar antes');
  const r = run(['brain.mjs', 'normalize', '--mem', mem]);
  assert.equal(r.code, 0, r.out);
  assert.equal(run(['brain.mjs', 'validate', '--mem', mem]).code, 0, 'debe pasar despues');
  assert.match(readFileSync(join(mem, 'project_nativo.md'), 'utf8'), /originSessionId: abc/, 'preserva campos nativos');
  rmSync(d, { recursive: true, force: true });
});

test('PARIDAD: los parsers duplicados de brain.mjs y graph.mjs son identicos', () => {
  const extract = file => {
    const src = readFileSync(join(HERE, file), 'utf8').replace(/\r\n/g, '\n');
    const grab = name => {
      const i = src.indexOf('function ' + name + '(');
      assert.ok(i >= 0, `${name} no encontrado en ${file}`);
      // corta hasta la linea '}' a nivel 0
      let depth = 0, started = false, end = i;
      for (let j = i; j < src.length; j++) { const c = src[j]; if (c === '{') { depth++; started = true; } else if (c === '}') { depth--; if (started && depth === 0) { end = j + 1; break; } } }
      return src.slice(i, end);
    };
    // compara LOGICA: quita comentarios de linea y colapsa espacios (los parsers no tienen '//' en regex)
    const norm = s => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    return norm(grab('parseScalar') + grab('parseFrontmatter'));
  };
  assert.equal(extract('brain.mjs'), extract('graph.mjs'),
    'parseScalar/parseFrontmatter divergieron en LOGICA entre brain.mjs y graph.mjs — re-sincronizar (o extraer a lib comun)');
});
