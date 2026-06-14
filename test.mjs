#!/usr/bin/env node
// test.mjs — suite del cerebro con node:test (cero dependencias). Correr: node --test
// Cubre: validate (todas las clases de error + contradicciones), determinismo de render-index, piso de
// seguridad y filtro de reglas duras por status, parser unico (lib.mjs), escritura atomica, add/normalize,
// secret-scan (incl. falsos negativos de placeholder), locks (happy + stale), capture, drain-inbox, query,
// grafo (direccion de supersedes + auto-reparo de db), gate diferencial del consolidador, y restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, cpSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { secretScan } from './maintain.mjs';
import { acquireLock, releaseLock, BRAIN_DIR } from './brain.config.mjs';
import { parseFrontmatter, writeAtomic } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
// exec que devuelve {code, out}; nunca lanza
function run(cmdArgs) {
  try { const out = execFileSync(NODE, cmdArgs, { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, out }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}
// como run() pero con env propio (para subprocesos que deben ver HOME/BRAIN_BACKUP de prueba)
function run2(cmdArgs, env) {
  try { const out = execFileSync(NODE, cmdArgs, { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }); return { code: 0, out }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}
function tmpMem() {
  const d = mkdtempSync(join(tmpdir(), 'brain-test-'));
  const mem = join(d, 'mem'); mkdirSync(join(mem, 'digests'), { recursive: true });
  writeFileSync(join(mem, 'digests', 'web.md'), '---\nname: digest-web\ndescription: d\nmetadata: { type: reference, domain: web, status: vigente, valid_from: 2026-01-01, digest: true }\n---\n# D\n## Vigente ahora\nok\n');
  return { d, mem };
}
// helper: frontmatter v3 de un nodo (extraMeta = linea extra de metadata, p.ej. 'superseded_by: x')
const v3 = (name, domain, status, imp, desc, extraMeta = '', body = 'cuerpo') =>
  `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: project\n  domain: ${domain}\n  status: ${status}\n  valid_from: 2026-01-01\n  importance: ${imp}\n${extraMeta ? '  ' + extraMeta + '\n' : ''}---\n${body}\n`;
const readdirInbox = m => existsSync(join(m, 'inbox')) ? readdirSync(join(m, 'inbox')) : [];

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

test('validate detecta las clases de error (name/domain/status/sin-fm/sin-desc/superseded-colgante/dominio-sin-digest)', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_malo.md'), '---\nname: otro-nombre\ndescription: x\nmetadata:\n  type: project\n---\ncuerpo\n');
  writeFileSync(join(mem, 'nofm.md'), 'sin frontmatter aqui\n');
  writeFileSync(join(mem, 'nodesc.md'), '---\nname: nodesc\ndescription:\nmetadata:\n  type: reference\n  domain: web\n  status: vigente\n  valid_from: 2026-01-01\n  importance: 2\n---\n');
  writeFileSync(join(mem, 'dangler.md'), v3('dangler', 'web', 'cerrado', 2, 'd', 'superseded_by: ghost_inexistente'));
  writeFileSync(join(mem, 'domless.md'), v3('domless', 'dominio_sin_digest', 'vigente', 2, 'd'));
  const r = run(['brain.mjs', 'validate', '--mem', mem]);
  assert.equal(r.code, 1);
  assert.match(r.out, /name "otro-nombre" != esperado/);
  assert.match(r.out, /sin metadata\.domain/);
  assert.match(r.out, /status invalido/);
  assert.match(r.out, /sin frontmatter/);
  assert.match(r.out, /sin description/);
  assert.match(r.out, /superseded_by apunta a nodo inexistente/);
  assert.match(r.out, /dominio "dominio_sin_digest" sin digest/);
  rmSync(d, { recursive: true, force: true });
});

test('validate caza wikilink roto', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_a.md'), v3('project_a', 'web', 'vigente', 3, 'x', '', 'ver [[no_existe]]'));
  const r = run(['brain.mjs', 'validate', '--mem', mem]);
  assert.equal(r.code, 1);
  assert.match(r.out, /wikilink roto \[\[no_existe\]\]/);
  rmSync(d, { recursive: true, force: true });
});

test('validate detecta contradiccion: vigente con superseded_by (G9)', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_viejo.md'), v3('project_viejo', 'web', 'vigente', 3, 'd', 'superseded_by: project_nuevo'));
  writeFileSync(join(mem, 'project_nuevo.md'), v3('project_nuevo', 'web', 'vigente', 3, 'd'));
  const r = run(['brain.mjs', 'validate', '--mem', mem]);
  assert.equal(r.code, 1);
  assert.match(r.out, /contradiccion.*vigente.*superseded_by/);
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

test('add sanitiza saltos de linea en --desc (no rompe el frontmatter) (#17)', () => {
  const { d, mem } = tmpMem();
  const r = run(['brain.mjs', 'add', '--mem', mem, '--name', 'multilinea', '--domain', 'web', '--desc', 'linea uno\nlinea dos']);
  assert.equal(r.code, 0, r.out);
  const raw = readFileSync(join(mem, 'multilinea.md'), 'utf8');
  assert.match(raw, /description: "linea uno\\nlinea dos"/, 'la description con \\n debe quedar como escalar JSON de una linea');
  assert.equal(run(['brain.mjs', 'validate', '--mem', mem]).code, 0, 'el nodo debe seguir siendo valido');
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

test('render-index PISO: 0 nodos v3-validos pero hay .md NO pisa el N0 con contenido (#27)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-floor-'));
  const mem = join(d, 'mem'); mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'MEMORY.md'), 'CONTENIDO IMPORTANTE PREVIO\n');
  // parsea frontmatter pero NO es v3-valido (sin domain/status) -> discarded, valid=0
  writeFileSync(join(mem, 'roto.md'), '---\nname: roto\ndescription: x\nmetadata:\n  type: reference\n---\ncuerpo\n');
  const r = run(['brain.mjs', 'render-index', '--mem', mem]);
  assert.equal(r.code, 1, 'debe abortar: ' + r.out);
  assert.match(readFileSync(join(mem, 'MEMORY.md'), 'utf8'), /CONTENIDO IMPORTANTE PREVIO/, 'no debe sobreescribir el N0 con uno vacio');
  rmSync(d, { recursive: true, force: true });
});

test('render-index: reglas duras filtran por status vigente (una regla cerrada no es "siempre vigente") (G10)', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'feedback_viva.md'), v3('feedback_viva', 'web', 'vigente', 5, 'regla viva'));
  writeFileSync(join(mem, 'feedback_muerta.md'), v3('feedback_muerta', 'web', 'cerrado', 5, 'regla retirada'));
  const r = run(['brain.mjs', 'render-index', '--mem', mem, '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /feedback_viva/, 'la regla vigente importance 5 debe estar');
  assert.ok(!/feedback_muerta/.test(r.out), 'la regla cerrada NO debe aparecer en el N0');
  rmSync(d, { recursive: true, force: true });
});

test('parser unico: brain.mjs y graph.mjs importan parseFrontmatter de lib.mjs (no hay copia que diverja)', () => {
  for (const f of ['brain.mjs', 'graph.mjs']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    assert.match(src, /import\s*\{[^}]*parseFrontmatter[^}]*\}\s*from\s*'\.\/lib\.mjs'/, `${f} debe importar parseFrontmatter de lib.mjs`);
    assert.ok(!/function\s+parseFrontmatter\s*\(/.test(src), `${f} no debe redefinir parseFrontmatter (usa lib.mjs)`);
  }
});

test('lib parseFrontmatter acepta indentacion de 1 espacio (D1)', () => {
  const p = parseFrontmatter('---\nname: x\ndescription: d\nmetadata:\n type: project\n domain: web\n status: vigente\n---\nbody\n');
  assert.ok(p, 'debe parsear');
  assert.equal(p.fm.metadata.domain, 'web', 'metadata con 1 espacio de indentacion debe leerse');
  assert.equal(p.fm.metadata.status, 'vigente');
});

test('lib writeAtomic escribe, reemplaza y no deja .tmp (G3)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-atomic-'));
  const f = join(d, 'x.txt');
  writeFileSync(f, 'viejo');
  writeAtomic(f, 'nuevo contenido');
  assert.equal(readFileSync(f, 'utf8'), 'nuevo contenido');
  assert.ok(!existsSync(f + '.tmp'), 'no debe quedar un .tmp colgado');
  rmSync(d, { recursive: true, force: true });
});

test('secret-scan: caza claves modernas/base64/svcacct/run-de-4 y NO se salta reales por placeholder (#6/#19/#30)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-sec-'));
  writeFileSync(join(d, 'a.md'), 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz9_Q\nhf_AbCdEfGhIjKlMnOpQrStUvWxYz901234\n');
  writeFileSync(join(d, 'b.md'), 'x ' + Buffer.from('shpat_abcd1235efgh5678ijkl9012mnop').toString('base64') + '\n');
  writeFileSync(join(d, 'fake.md'), 'sk-ant-api03-your_key_placeholder_token_sample\n'); // placeholder -> 0 hits
  writeFileSync(join(d, 'real4.md'), 'sk-ant-api03-aaaaBcDeFgHiJkLmNoPqRsTuVwXy12\n'); // 4 a's: NO es placeholder
  writeFileSync(join(d, 'svc.md'), 'sk-svcacct-Xk7Tz9Qm2Rv4Bn8Lw1Hs5Pd3Fg6Jc0Yt\n'); // service-account
  writeFileSync(join(d, 'run6.md'), 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa\n'); // 24 a's: placeholder por RUN6 -> 0 hits
  const h = secretScan(d);
  const kinds = h.map(x => x.kind).join(',');
  assert.ok(/anthropic/.test(kinds), 'sk-ant debe cazarse: ' + kinds);
  assert.ok(/huggingface/.test(kinds), 'hf_ debe cazarse');
  assert.ok(/base64/.test(kinds), 'secreto en base64 debe cazarse');
  assert.ok(/openai/.test(kinds), 'sk-svcacct debe cazarse');
  // #6 (assert NO tautologico): el placeholder NO debe producir hallazgos en fake.md
  assert.equal(h.filter(x => /fake\.md$/.test(x.file)).length, 0, 'fake.md (placeholder) no debe tener hallazgos');
  // #19: una clave real con 4 chars repetidos SI debe cazarse; un run de 6+ es placeholder
  assert.ok(h.some(x => /real4\.md$/.test(x.file)), 'una clave real con run de 4 NO debe descartarse');
  assert.equal(h.filter(x => /run6\.md$/.test(x.file)).length, 0, 'un run de 6+ chars iguales es placeholder');
  assert.ok(!h.some(x => /AbCdEfGhIjKlMnOpQrStUvWxYz9_Q|abcd123/.test(x.sample)), 'todo redactado');
  rmSync(d, { recursive: true, force: true });
});

test('acquireLock bloquea concurrencia y libera', () => {
  const l1 = acquireLock(); assert.ok(l1, 'primer lock');
  const l2 = acquireLock(); assert.equal(l2, null, 'segundo lock debe ser null (bloqueado)');
  releaseLock(l1);
  const l3 = acquireLock(); assert.ok(l3, 'lock tras liberar'); releaseLock(l3);
});

test('acquireLock reclama lock STALE (viejo por edad / pid muerto / ilegible) (#15)', () => {
  const name = '.brain-test-stale.lock';
  const lp = join(BRAIN_DIR, name);
  try {
    writeFileSync(lp, JSON.stringify({ pid: process.pid, ts: Date.now() - 9_999_999 }));
    let g = acquireLock(name, 1000); assert.ok(g, 'lock viejo por edad debe reclamarse'); releaseLock(g);
    writeFileSync(lp, JSON.stringify({ pid: 2147483646, ts: Date.now() }));  // pid casi seguro muerto
    g = acquireLock(name, 3_600_000); assert.ok(g, 'lock de pid muerto debe reclamarse'); releaseLock(g);
    // ilegible: se reclama solo si NO es recien creado (un ilegible fresco = otro proceso escribiendolo, audit#6 #14)
    writeFileSync(lp, 'esto no es json'); const oldT = (Date.now() - 60_000) / 1000; utimesSync(lp, oldT, oldT);
    g = acquireLock(name, 3_600_000); assert.ok(g, 'lock ilegible VIEJO debe reclamarse'); releaseLock(g);
  } finally { try { rmSync(lp, { force: true }); } catch {} }
});

test('capture deposita puntero idempotente sin tocar git', () => {
  const { d, mem } = tmpMem();
  execFileSync(NODE, ['brain.mjs', 'capture', '--mem', mem], { cwd: HERE, input: '{"session_id":"sX","transcript_path":"t.jsonl"}', encoding: 'utf8' });
  assert.ok(existsSync(join(mem, 'inbox', '_session_sX.md')), 'crea nota de sesion');
  execFileSync(NODE, ['brain.mjs', 'capture', '--mem', mem], { cwd: HERE, input: '{"session_id":"sX"}', encoding: 'utf8' });
  assert.equal(readdirInbox(mem).length, 1, 'idempotente: una nota por sesion');
  rmSync(d, { recursive: true, force: true });
});

test('capture sin session_id NO colapsa dos sesiones en una sola nota (#42)', () => {
  const { d, mem } = tmpMem();
  execFileSync(NODE, ['brain.mjs', 'capture', '--mem', mem], { cwd: HERE, input: '{"transcript_path":"a.jsonl"}', encoding: 'utf8' });
  execFileSync(NODE, ['brain.mjs', 'capture', '--mem', mem], { cwd: HERE, input: '{"transcript_path":"b.jsonl"}', encoding: 'utf8' });
  assert.equal(readdirInbox(mem).filter(f => f.startsWith('_session_anon')).length, 2, 'dos transcripts distintos sin id -> dos notas');
  rmSync(d, { recursive: true, force: true });
});

test('drain-inbox materializa la seccion Inbox de N0 a inbox/ y preserva su contenido (#34)', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'MEMORY.md'), '## X\n- a\n\n## Inbox (nuevas entradas — el consolidador las integra)\n- nota atrapada IMPORTANTE\n');
  const r = run(['brain.mjs', 'drain-inbox', '--mem', mem]);
  assert.equal(r.code, 0, r.out);
  const pend = readdirInbox(mem).filter(f => f.startsWith('_pending'));
  assert.equal(pend.length, 1, 'crea nota _pending');
  assert.match(readFileSync(join(mem, 'inbox', pend[0]), 'utf8'), /nota atrapada IMPORTANTE/, 'la nota _pending debe contener el texto drenado');
  assert.match(readFileSync(join(mem, 'MEMORY.md'), 'utf8'), /Inbox[^\n]*\n<!-- vacio -->/, 'limpia la seccion');
  rmSync(d, { recursive: true, force: true });
});

test('query usa AND-primero (precision): 2 terminos traen el nodo con ambos', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_pago.md'), v3('project_pago', 'web', 'vigente', 3, 'checkout debito mercadopago activado'));
  writeFileSync(join(mem, 'project_otro.md'), v3('project_otro', 'web', 'vigente', 3, 'checkout de otra cosa sin pagos electronicos'));
  const out = execFileSync(NODE, ['graph.mjs', 'query', 'checkout', 'debito', '--mem', mem, '--out', join(d, 'g')], { cwd: HERE, encoding: 'utf8' });
  const matchLines = out.split('\n').filter(l => l.includes('project_'));
  assert.match(matchLines[0] || '', /project_pago/, 'AND debe traer solo el nodo con ambos terminos: ' + out.slice(0, 200));
  assert.ok(!matchLines.some(l => /project_otro/.test(l)), 'project_otro (solo 1 termino) no debe aparecer con AND');
  rmSync(d, { recursive: true, force: true });
});

test('grafo: arista supersedes va del nuevo al viejo + wikilink en export-3d (#28/#25)', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_a.md'), v3('project_a', 'web', 'cerrado', 3, 'desc a', 'superseded_by: project_b', 've [[project_c]]'));
  writeFileSync(join(mem, 'project_b.md'), v3('project_b', 'web', 'vigente', 3, 'desc b'));
  writeFileSync(join(mem, 'project_c.md'), v3('project_c', 'web', 'vigente', 3, 'desc c'));
  const out = join(d, 'g');
  const r = run(['graph.mjs', 'export-3d', '--mem', mem, '--out', out]);
  assert.equal(r.code, 0, r.out);
  const g = JSON.parse(readFileSync(join(out, 'visor', 'graph.json'), 'utf8'));
  const sup = g.links.find(l => l.rel === 'supersedes');
  assert.ok(sup, 'debe existir arista supersedes');
  assert.equal(sup.source, 'project_b', 'supersedes: el nuevo (B) apunta al viejo (A)');
  assert.equal(sup.target, 'project_a');
  assert.ok(g.links.some(l => l.rel === 'wikilink' && l.source === 'project_a' && l.target === 'project_c'), 'wikilink A->C presente');
  rmSync(d, { recursive: true, force: true });
});

test('grafo: query con graph.db corrupta se auto-reconstruye en vez de crashear (#26)', () => {
  const { d, mem } = tmpMem();
  const out = join(d, 'g');
  run(['graph.mjs', 'build', '--mem', mem, '--out', out]);
  const db = join(out, 'derived', 'graph.db');
  assert.ok(existsSync(db), 'la db debe existir tras build');
  writeFileSync(db, 'esto no es una base sqlite');  // corromper
  const r = run(['graph.mjs', 'query', 'digest', '--mem', mem, '--out', out]);
  assert.equal(r.code, 0, 'query debe auto-reconstruir y salir 0: ' + r.out);
  assert.match(r.out, /MATCH \([1-9]/, 'la reconstruccion debe producir resultados reales, no una db vacia: ' + r.out.slice(0, 200));
  rmSync(d, { recursive: true, force: true });
});

test('consolidate: diffViolations permite digests/nodos-v3 y marca borrado/no-v3/vaciado; reEnqueueInbox restaura y limpia .procesadas (#7/#14/#29)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-cons-'));
  const mem = join(d, 'mem'); mkdirSync(join(mem, 'digests'), { recursive: true });
  const bigDigest = name => `---\nname: digest-${name}\ndescription: d\nmetadata:\n  type: reference\n  domain: ${name}\n  status: vigente\n  valid_from: 2026-01-01\n  digest: true\n---\n# D\n## Vigente ahora\nL1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n`;
  writeFileSync(join(mem, 'digests', 'web.md'), bigDigest('web'));
  writeFileSync(join(mem, 'digests', 'otro.md'), bigDigest('otro'));
  writeFileSync(join(mem, 'digests', 'reseñas.md'), bigDigest('resenas')); // nombre NO-ASCII (#6 core.quotepath)
  writeFileSync(join(mem, 'project_base.md'), v3('project_base', 'web', 'vigente', 3, 'base'));
  const g = (...a) => execFileSync('git', ['-C', mem, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const head = g('rev-parse', 'HEAD').trim();
  // simular cambios del LLM:
  writeFileSync(join(mem, 'digests', 'web.md'), readFileSync(join(mem, 'digests', 'web.md'), 'utf8') + 'L9\nL10\n'); // edita (OK)
  writeFileSync(join(mem, 'digests', 'reseñas.md'), readFileSync(join(mem, 'digests', 'reseñas.md'), 'utf8') + 'L9\nL10\n'); // edita digest no-ASCII (OK, #6)
  writeFileSync(join(mem, 'digests', 'otro.md'), '---\nname: digest-otro\ndescription: d\nmetadata:\n  domain: otro\n  digest: true\n---\n# vacio\n'); // VACIA (viol magnitud)
  rmSync(join(mem, 'project_base.md')); // borra tracked (viol)
  writeFileSync(join(mem, 'basura.md'), 'no soy un nodo v3\n'); // raiz no-v3 (viol)
  writeFileSync(join(mem, 'project_nuevo.md'), v3('project_nuevo', 'web', 'vigente', 3, 'nuevo')); // nodo v3 (OK)
  process.env.BRAIN_MEM = mem;
  const C = await import('./consolidate.mjs');
  delete process.env.BRAIN_MEM;
  const j = C.diffViolations(head, []).join(' | ');
  assert.match(j, /borro project_base/, 'borrar un tracked es violacion: ' + j);
  assert.match(j, /vacio\/recorto.*otro/, 'vaciar un digest es violacion (#14): ' + j);
  assert.match(j, /no-permitido basura/, 'archivo raiz no-v3 es violacion: ' + j);
  assert.ok(!/web\.md/.test(j), 'editar un digest normalmente NO es violacion: ' + j);
  assert.ok(!/rese/.test(j), 'editar un digest con nombre no-ASCII NO debe ser violacion espuria (#6 core.quotepath): ' + j);
  assert.ok(!/project_nuevo/.test(j), 'un nodo v3 nuevo NO es violacion: ' + j);
  // reEnqueueInbox + limpieza de .procesadas (#29)
  mkdirSync(join(mem, 'inbox', '.procesadas'), { recursive: true });
  writeFileSync(join(mem, 'inbox', '.procesadas', '_session_x.md'), 'contenido durable');
  const n = C.reEnqueueInbox(new Map([['_session_x.md', 'contenido durable']]));
  assert.equal(n, 1, 're-encola 1 nota');
  assert.ok(existsSync(join(mem, 'inbox', '_session_x.md')), 'restaura la nota a inbox/');
  assert.ok(!existsSync(join(mem, 'inbox', '.procesadas', '_session_x.md')), 'borra la copia huerfana de .procesadas/');
  rmSync(d, { recursive: true, force: true });
});

// === REGRESION audit#4/#5 ===

test('restore: tarball SIN subdir memory no copia basura ni borra fuera de su temp (audit#4)', () => {
  // restore.mjs YA parchado (audit#4): untar devuelve {tmp, sub} y rmSync limpia SOLO su propio tmp; con un
  // tarball sin memory/ al tope, NO copia los sueltos a MEM y reporta fallo. Test ACTIVO (no skip).
  const d = mkdtempSync(join(tmpdir(), 'brain-restore-test-'));
  const src = join(d, 'src'); mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'random.txt'), 'esto no es memory\n');
  writeFileSync(join(src, 'data.json'), '{"x":1}\n');
  const backup = join(d, 'backup'); mkdirSync(backup, { recursive: true });
  execFileSync('tar', ['--force-local', '-czf', join(backup, 'markdown-global.tar.gz').replace(/\\/g, '/'), '.'], { cwd: src, stdio: 'ignore' });
  const sentinel = join(d, 'CENTINELA.txt'); writeFileSync(sentinel, 'no me borres\n');
  const memDest = join(d, 'memdest');
  const r = run(['restore.mjs', '--from', backup, '--mem', memDest]);
  assert.ok(existsSync(sentinel), 'restore borro fuera de su temp (centinela desaparecio): ' + r.out);
  const memFiles = existsSync(memDest) ? readdirSync(memDest) : [];
  assert.ok(!memFiles.includes('random.txt') && !memFiles.includes('data.json'), 'copio basura del tarball sin subdir memory/: ' + memFiles.join(',') + ' / ' + r.out);
  assert.ok(r.code !== 0 || /FALLO|WARN|no encontre|sin memory|memory\//i.test(r.out), 'tarball sin memory/ debe reportar fallo: code=' + r.code + ' out=' + r.out);
  rmSync(d, { recursive: true, force: true });
});

test('restore: no pisa un destino NO vacio sin --force; con --force si (#12)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-restore-force-'));
  const stage = join(d, 'stage'); mkdirSync(join(stage, 'memory'), { recursive: true });
  writeFileSync(join(stage, 'memory', 'MEMORY.md'), 'BACKUP\n');
  writeFileSync(join(stage, 'memory', 'nodo.md'), 'x\n');
  const backup = join(d, 'backup'); mkdirSync(backup, { recursive: true });
  execFileSync('tar', ['--force-local', '-czf', join(backup, 'markdown-global.tar.gz').replace(/\\/g, '/'), 'memory'], { cwd: stage, stdio: 'ignore' });
  const dest = join(d, 'dest'); mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, 'EXISTENTE.md'), 'no me pises\n');
  const r1 = run(['restore.mjs', '--from', backup, '--mem', dest]);
  assert.notEqual(r1.code, 0, 'sin --force debe fallar sobre destino no vacio: ' + r1.out);
  assert.ok(!existsSync(join(dest, 'MEMORY.md')), 'no debe copiar sin --force');
  assert.ok(existsSync(join(dest, 'EXISTENTE.md')), 'preserva lo existente');
  const r2 = run(['restore.mjs', '--from', backup, '--mem', dest, '--force']);
  assert.equal(r2.code, 0, 'con --force debe restaurar: ' + r2.out);
  assert.ok(existsSync(join(dest, 'MEMORY.md')), 'restaura con --force');
  rmSync(d, { recursive: true, force: true });
});

test('capture: BRAIN_CONSOLIDATING=1 es NO-OP (sin nota); sin la env si crea nota (audit#4)', () => {
  const { d, mem } = tmpMem();
  const inp = '{"session_id":"sGuard"}';
  execFileSync(NODE, ['brain.mjs', 'capture', '--mem', mem], { cwd: HERE, input: inp, encoding: 'utf8', env: { ...process.env, BRAIN_CONSOLIDATING: '1' } });
  assert.equal(readdirInbox(mem).length, 0, 'con BRAIN_CONSOLIDATING no debe crear nota (NO-OP)');
  execFileSync(NODE, ['brain.mjs', 'capture', '--mem', mem], { cwd: HERE, input: inp, encoding: 'utf8' });
  assert.ok(existsSync(join(mem, 'inbox', '_session_sGuard.md')), 'sin la env debe crear la nota de sesion');
  rmSync(d, { recursive: true, force: true });
});

// === REGRESION audit#6 ===

test('consolidate: el spawn de claude -p conserva los flags de seguridad (anti SANDBOX_BREACH) (#1)', () => {
  const src = readFileSync(join(HERE, 'consolidate.mjs'), 'utf8');
  assert.match(src, /--permission-mode/, 'debe acotar el permission-mode');
  assert.match(src, /--allowedTools/, 'debe pasar allowedTools');
  assert.match(src, /--disallowedTools/, 'debe pasar disallowedTools (denylist vinculante)');
  assert.match(src, /Bash,WebFetch,WebSearch/, 'debe denegar Bash/red');
  assert.match(src, /stdio:\s*'ignore'/, "el stdout del LLM no debe heredarse al log");
});

test('acquireLock: lock vacio FRESCO no se reclama (ventana de doble-adquisicion); vacio VIEJO si (#14)', () => {
  const name = '.brain-test-empty.lock';
  const lp = join(BRAIN_DIR, name);
  try {
    writeFileSync(lp, '');  // vacio, mtime = ahora (simula otro proceso a mitad de openSync->writeFileSync)
    assert.equal(acquireLock(name, 3_600_000), null, 'un lock vacio recien creado NO debe reclamarse');
    const old = (Date.now() - 60_000) / 1000; utimesSync(lp, old, old);  // envejecer
    const g = acquireLock(name, 3_600_000); assert.ok(g, 'un lock vacio VIEJO si debe reclamarse'); releaseLock(g);
  } finally { try { rmSync(lp, { force: true }); } catch {} }
});

test('releaseLock no borra un lock de OTRO pid (ownership) (#5)', () => {
  const name = '.brain-test-own.lock';
  const lp = join(BRAIN_DIR, name);
  try {
    writeFileSync(lp, JSON.stringify({ pid: 2147483646, ts: Date.now() }));  // lock ajeno
    releaseLock(lp);
    assert.ok(existsSync(lp), 'releaseLock no debe borrar un lock que no es nuestro');
  } finally { try { rmSync(lp, { force: true }); } catch {} }
});

test('render-index PISO cubre digests/ y archivo/, no solo la raiz (#3)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-floor2-'));
  const mem = join(d, 'mem'); mkdirSync(join(mem, 'digests'), { recursive: true });
  writeFileSync(join(mem, 'MEMORY.md'), 'CONTENIDO PREVIO IMPORTANTE\n');
  // .md SOLO en digests/, parseable pero NO v3-valido (sin domain/status): valid=0
  writeFileSync(join(mem, 'digests', 'roto.md'), '---\nname: digest-roto\ndescription: x\nmetadata:\n  type: reference\n---\nx\n');
  const r = run(['brain.mjs', 'render-index', '--mem', mem]);
  assert.equal(r.code, 1, 'debe abortar aunque el .md viva en digests/: ' + r.out);
  assert.match(readFileSync(join(mem, 'MEMORY.md'), 'utf8'), /CONTENIDO PREVIO/, 'no debe sobreescribir el N0');
  rmSync(d, { recursive: true, force: true });
});

test('render-index: un digest sin domain NO rinde una linea "**undefined**" (#11)', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'digests', 'sindom.md'), '---\nname: digest-sindom\ndescription: x\nmetadata:\n  status: vigente\n  digest: true\n---\nx\n');
  const r = run(['brain.mjs', 'render-index', '--mem', mem, '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!/\*\*undefined\*\*/.test(r.out), 'no debe haber una linea de dominio "**undefined**": ' + r.out.slice(0, 300));
  rmSync(d, { recursive: true, force: true });
});

test('validate detecta superseded_by que se apunta a si mismo (#34)', () => {
  const { d, mem } = tmpMem();
  writeFileSync(join(mem, 'project_loop.md'), v3('project_loop', 'web', 'cerrado', 2, 'd', 'superseded_by: project_loop'));
  const r = run(['brain.mjs', 'validate', '--mem', mem]);
  assert.equal(r.code, 1);
  assert.match(r.out, /superseded_by se apunta a si mismo/);
  rmSync(d, { recursive: true, force: true });
});

test('--mem sin valor aborta (no cae silenciosamente a la memoria real) (#7)', () => {
  const r = run(['brain.mjs', 'validate', '--mem']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--mem requiere una ruta/);
});

test('install.mjs --dry-run corre limpio y --home sin valor aborta (cobertura basica + #8)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-install-'));
  const r = run(['install.mjs', '--home', d, '--mem', join(d, 'mem'), '--skip-tasks', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /MEM=/);
  const r2 = run(['install.mjs', '--home']);  // sin valor -> TypeError-foot-gun, ahora abortado
  assert.notEqual(r2.code, 0, '--home sin valor debe fallar limpio');
  assert.match(r2.out, /--home requiere una ruta/);
  rmSync(d, { recursive: true, force: true });
});

test('install: escribe brainDir en brain.json y asegura el .gitignore del MEM (#13/#19/#23)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-install2-'));
  const mem = join(d, 'mem'); mkdirSync(join(mem, 'digests'), { recursive: true });
  writeFileSync(join(mem, 'digests', 'web.md'), '---\nname: digest-web\ndescription: d\nmetadata: { type: reference, domain: web, status: vigente, valid_from: 2026-01-01, digest: true }\n---\n# D\n## Vigente ahora\nok\n');
  const r = run(['install.mjs', '--home', join(d, 'home'), '--mem', mem, '--skip-tasks']);
  assert.equal(r.code, 0, r.out);
  const cfg = JSON.parse(readFileSync(join(d, 'home', '.claude', 'brain.json'), 'utf8'));
  assert.ok(cfg.brainDir, 'brain.json debe incluir brainDir (portabilidad de los hooks): ' + JSON.stringify(cfg));
  assert.match(readFileSync(join(mem, '.gitignore'), 'utf8'), /inbox\/_\*\.md/, 'el .gitignore del MEM debe cubrir los depositos de inbox/');
  rmSync(d, { recursive: true, force: true });
});

test('maintain: demote mueve cerrados >60d a archivo/ y deja los recientes (#2/G2)', () => {
  const d = mkdtempSync(join(tmpdir(), 'brain-maint-'));
  const mem = join(d, 'mem'); mkdirSync(join(mem, 'digests'), { recursive: true });
  writeFileSync(join(mem, 'digests', 'web.md'), '---\nname: digest-web\ndescription: d\nmetadata: { type: reference, domain: web, status: vigente, valid_from: 2026-01-01, digest: true }\n---\n# D\n## Vigente ahora\nok\n');
  const closed = (name, vf) => `---\nname: ${name}\ndescription: d\nmetadata:\n  type: project\n  domain: web\n  status: cerrado\n  valid_from: ${vf}\n  importance: 2\n---\ncuerpo\n`;
  const hoy = new Date().toISOString().slice(0, 10);
  writeFileSync(join(mem, 'viejo_cerrado.md'), closed('viejo_cerrado', '2020-01-01'));
  writeFileSync(join(mem, 'nuevo_cerrado.md'), closed('nuevo_cerrado', hoy));
  const g = (...a) => execFileSync('git', ['-C', mem, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'i');
  // HOME/USERPROFILE -> temp para que NO toque la episodica real (~1.5GB) ni el brain.json real; backup -> temp.
  const env = { ...process.env, USERPROFILE: d, HOME: d, BRAIN_BACKUP: join(d, 'backup') };
  const r = run2(['maintain.mjs', '--mem', mem], env);
  assert.ok(existsSync(join(mem, 'archivo', 'viejo_cerrado.md')), 'el cerrado VIEJO (>60d) debe moverse a archivo/: ' + r.out.slice(-300));
  assert.ok(existsSync(join(mem, 'nuevo_cerrado.md')) && !existsSync(join(mem, 'archivo', 'nuevo_cerrado.md')), 'el cerrado RECIENTE debe quedarse');
  rmSync(d, { recursive: true, force: true });
});
