#!/bin/bash
# brain-session-end.sh — productor automatico del lazo de memoria (hook Stop/SessionEnd).
# Deposita un puntero de la sesion en inbox/ (idempotente por session_id) para que el consolidador
# nocturno lo lea y extraiga memorias durables del transcript. NO toca git/N0/nodos. Falla silenciosa.
# El JSON del harness llega por stdin; brain.mjs capture lo parsea.
set +e
CFG="$HOME/.claude/brain.json"
BRAIN="$HOME/projects/claude-brain"
# BRAIN portable (audit#6 #13/#19): leer brainDir de brain.json con fallback al default.
[ -f "$CFG" ] && B=$(grep -o '"brainDir"[^,}]*' "$CFG" | sed -E 's/.*"brainDir"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/') && [ -n "$B" ] && BRAIN="$B"
[ -f "$BRAIN/brain.mjs" ] && command -v node >/dev/null 2>&1 && node "$BRAIN/brain.mjs" capture 2>/dev/null
exit 0
