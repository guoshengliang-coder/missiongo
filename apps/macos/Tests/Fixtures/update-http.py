"""Loopback-only byte-stream fixture; never installs or serves a real app."""
import http.server
import time

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        kind = self.path.strip('/')
        self.send_response(503 if kind == '503' else 200)
        if kind not in ('unknown', 'overflow', 'truncated'):
            self.send_header('Content-Length', '7' if kind == 'wrong-length' else '6')
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            if kind in ('stall', 'first-byte'):
                if kind == 'stall':
                    self.wfile.write(b'a')
                    self.wfile.flush()
                time.sleep(8)
            elif kind == 'trickle':
                for byte in b'abcdef':
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.5)
            else:
                body = b'abcdefg' if kind == 'overflow' else b'abc' if kind == 'truncated' else b'abcdef'
                for i in range(0, len(body), 2):
                    self.wfile.write(body[i:i+2])
                    self.wfile.flush()
                    time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
