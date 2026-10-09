#!/usr/bin/env python3
"""Local protocol fixture. Never contacts a model or reads real credentials."""
import json
import os
import sys

args = sys.argv[1:]
flag = "--resume" if "--resume" in args else "--session-id"
ref = args[args.index(flag) + 1]
assert os.environ["ANTHROPIC_BASE_URL"] == "https://gateway.invalid"
assert os.environ["ANTHROPIC_AUTH_TOKEN"] == "synthetic-secret"
assert "--remote-control" not in args
initialized = False


def emit(value):
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    value = json.loads(line)
    if value["type"] == "control_request":
        assert value["request"]["subtype"] == "initialize", "Unexpected official control request"
        emit({"type": "control_response", "response": {"request_id": value["request_id"], "subtype": "success", "response": {"remote_control_available": True}}})
    elif value["type"] == "user":
        if not initialized:
            native = "00000000-0000-4000-8000-000000000000" if os.environ.get("MOCK_CLAUDE_CASE") == "wrong-id" else ref
            emit({"type": "system", "subtype": "init", "session_id": native, "model": "company-alias"})
            initialized = True
        text = value["message"]["content"][0]["text"]
        if text != "unacknowledged":
            emit({**value, "origin": {"kind": "human"}})
        if text == "permission":
            emit({"type": "control_request", "request_id": "permission-1", "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "synthetic command"}}})
        else:
            emit({"type": "assistant", "uuid": "answer-" + value["uuid"], "message": {"content": [{"type": "text", "text": "Result: " + text + " synthetic-secret https://gateway.invalid"}]}})
            emit({"type": "result", "subtype": "success"})
    elif value["type"] == "control_response":
        assert value["response"]["request_id"] == "permission-1"
        emit({"type": "result", "subtype": "success"})
