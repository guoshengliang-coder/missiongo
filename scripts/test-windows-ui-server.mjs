import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../apps/windows/dist/app/", import.meta.url));
const types = { "index.html": "text/html", "renderer.js": "text/javascript", "renderer.css": "text/css", "icon.svg": "image/svg+xml" };
createServer((request, response) => {
  const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1) || "index.html";
  if (!Object.hasOwn(types, name)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": types[name] }); response.end(readFileSync(root + name));
}).listen(4199, "127.0.0.1");
