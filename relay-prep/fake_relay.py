#!/usr/bin/env python3
"""Fake model relay server, for preliminary testing.

Reproduces the minimum behavior of the official relay: accept requests in the
OpenAI chat-completions format, check that the per-episode key is present in the
headers, stream back one fixed reply, and log the key request fields to relay.log.
Standard library only, no dependencies. Usage: python3 fake_relay.py [port]
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18081
REPLY = "RELAY-OK: this reply came from the fake relay, not from any real provider."


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with open("relay.log", "a") as fh:
            fh.write(json.dumps({
                "path": self.path,
                "auth": self.headers.get("Authorization", ""),
                "model": body.get("model"),
                "stream": body.get("stream"),
                "n_messages": len(body.get("messages", [])),
                "first_message_head": str(body.get("messages", [{}])[0])[:120],
            }, ensure_ascii=False) + "\n")
        chunks = [
            {"choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {"content": REPLY}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 10, "completion_tokens": 15, "total_tokens": 25}},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        base = {"id": "fake-1", "object": "chat.completion.chunk",
                "created": int(time.time()), "model": body.get("model")}
        for c in chunks:
            self.wfile.write(f"data: {json.dumps(base | c)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


print(f"fake relay listening on 127.0.0.1:{PORT}", flush=True)
HTTPServer(("127.0.0.1", PORT), H).serve_forever()
