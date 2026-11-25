"""Print a readable trace of a compose-test eval run: tools, results, gate messages, final status."""
import json, sys

for line in open(sys.argv[1]):
    if not line.strip():
        continue
    e = json.loads(line)
    t = e["type"]
    if t == "tool_execution_start":
        print("TOOL", e.get("toolName"), json.dumps(e.get("args"))[:220])
    elif t == "tool_execution_end":
        r = e.get("result") or {}
        c = r.get("content") or [{}]
        print("  ->", "ERR" if e.get("isError") else "", (c[0].get("text") or "")[:400].replace("\n", " | "))
    elif t == "entry_appended" and e["entry"].get("type") == "custom_message":
        print("MSG", e["entry"]["customType"], e["entry"]["content"][:900])
    elif t == "message_end" and e["message"].get("role") == "assistant":
        text = "".join(c.get("text", "") for c in e["message"]["content"] if c.get("type") == "text")
        if text.strip():
            print("SAY", text[:500].replace("\n", " "))
