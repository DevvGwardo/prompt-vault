#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook → forwards prompt to local Prompt Vault app.
# Install by adding to ~/.claude/settings.json:
#   "hooks": {
#     "UserPromptSubmit": [
#       { "matcher": "", "hooks": [{ "type": "command",
#         "command": "/Users/devgwardo/prompt-vault-app/hook/prompt-vault-hook.sh" }] }
#     ]
#   }
#
# Hook receives a JSON payload on stdin. We extract the prompt and POST it.
# Always exits 0 so a stopped vault never blocks Claude Code.

PAYLOAD=$(cat)
PROMPT=$(printf '%s' "$PAYLOAD" | /usr/bin/python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("prompt") or d.get("user_prompt") or d.get("text") or "", end="")
except Exception:
    pass
')

if [ -z "$PROMPT" ]; then
  exit 0
fi

BODY=$(/usr/bin/python3 -c '
import json, sys, os
print(json.dumps({
    "prompt": sys.argv[1],
    "source": "claude-code",
    "cwd": os.getcwd()
}))
' "$PROMPT")

/usr/bin/curl -s -m 1 -X POST \
  -H "Content-Type: application/json" \
  --data "$BODY" \
  http://127.0.0.1:8765/prompt >/dev/null 2>&1 || true

exit 0
