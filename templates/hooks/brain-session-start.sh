#!/bin/bash
# brain-session-start.sh (portable) — health check del cerebro de memoria al iniciar sesion.
# Lee memDir desde ~/.claude/brain.json (escrito por el installer); fallback a auto-detect del slug.
# Corre validate y compara N0 contra el tope blando (7168) y el techo duro (25000) por separado.
# Falla silenciosa (|| true en el wiring del hook).
set +e

CFG="$HOME/.claude/brain.json"
BRAIN="$HOME/projects/claude-brain"
MEM_DIR=""
[ -f "$CFG" ] && MEM_DIR=$(grep -o '"memDir"[^,}]*' "$CFG" | sed -E 's/.*:\s*"([^"]+)".*/\1/')
if [ -z "$MEM_DIR" ]; then
  SLUG=$(echo "$HOME" | sed -E 's#[^a-zA-Z0-9]#-#g')
  MEM_DIR="$HOME/.claude/projects/$SLUG/memory"
fi
SOFT=7168; HARD=25000

echo "[cerebro] health check"
if [ -d "$MEM_DIR/.git" ]; then echo "  [OK] memoria versionada (git)"; else echo "  [!!] memoria sin git: $MEM_DIR"; fi

# validate (lo mas importante: detecta nodos mal formados de inmediato)
if [ -f "$BRAIN/brain.mjs" ] && command -v node >/dev/null 2>&1; then
  VOUT=$(node "$BRAIN/brain.mjs" validate --mem "$MEM_DIR" 2>&1)
  if echo "$VOUT" | grep -q 'VALIDACION OK'; then echo "  [OK] $(echo "$VOUT" | tail -1)";
  else echo "  [!!] validate en ROJO:"; echo "$VOUT" | grep -- ' - ' | head -3 | sed 's/^/      /'; fi
fi

# N0 dual-cap
if [ -f "$MEM_DIR/MEMORY.md" ]; then
  BYTES=$(stat -c%s "$MEM_DIR/MEMORY.md" 2>/dev/null || stat -f%z "$MEM_DIR/MEMORY.md" 2>/dev/null || wc -c < "$MEM_DIR/MEMORY.md" 2>/dev/null || echo 0)
  if [ "$BYTES" -gt "$HARD" ]; then echo "  [!!] N0 $BYTES bytes — SOBRE el techo duro $HARD: el harness TRUNCA. Corre: node $BRAIN/brain.mjs render-index";
  elif [ "$BYTES" -gt "$SOFT" ]; then echo "  [..] N0 $BYTES bytes — sobre el tope blando $SOFT (drena inbox / consolida; aun bajo el techo $HARD)";
  else echo "  [OK] N0: $BYTES bytes (<=$SOFT)"; fi
fi

# alerta de mantenimiento pendiente
[ -f "$BRAIN/MAINTAIN-ALERT.txt" ] && echo "  [..] alerta de mantenimiento: $(tail -1 "$BRAIN/MAINTAIN-ALERT.txt")"
[ -f "$BRAIN/CONSOLIDATOR-ALERT.txt" ] && echo "  [..] alerta de consolidador: $(tail -1 "$BRAIN/CONSOLIDATOR-ALERT.txt")"

if grep -q '"episodic-memory@superpowers-marketplace": true' "$HOME/.claude/settings.json" 2>/dev/null; then echo "  [OK] episodic-memory habilitado"; else echo "  [..] episodic-memory no detectado (capa conversacional opcional)"; fi
echo "[cerebro] done"
exit 0
