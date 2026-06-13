#!/bin/bash
# brain-session-end.sh — productor automatico del lazo de memoria (hook Stop/SessionEnd).
# Deposita un puntero de la sesion en inbox/ (idempotente por session_id) para que el consolidador
# nocturno lo lea y extraiga memorias durables del transcript. NO toca git/N0/nodos. Falla silenciosa.
# El JSON del harness llega por stdin; brain.mjs capture lo parsea.
set +e
BRAIN="$HOME/projects/claude-brain"
[ -f "$BRAIN/brain.mjs" ] && command -v node >/dev/null 2>&1 && node "$BRAIN/brain.mjs" capture 2>/dev/null
exit 0
