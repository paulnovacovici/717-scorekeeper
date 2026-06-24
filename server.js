const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dbApi = require("./src/db");

const port = Number(process.env.PORT || 7170);
const host = process.env.HOST || "0.0.0.0";
const publicHost = process.env.PUBLIC_HOST || "";
const publicDir = path.join(__dirname, "public");
const db = dbApi.openDatabase();
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

const server = http.createServer(async (request, response) => {
  try {
    if (publicHost && request.headers["x-forwarded-proto"] === "http") {
      response.writeHead(308, { ...securityHeaders, Location: `https://${publicHost}${request.url}` });
      response.end();
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/healthz") return sendJson(response, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    return serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message || "Something went wrong." });
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;
server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));

async function handleApi(request, response, url) {
  const method = request.method;
  if (method === "GET" && url.pathname === "/api/dashboard") return sendJson(response, 200, dbApi.getDashboard(db));
  if (method === "POST" && url.pathname === "/api/groups") return sendJson(response, 201, dbApi.createGroup(db, ...(await groupBody(request))));
  const groupMatch = url.pathname.match(/^\/api\/groups\/(\d+)$/);
  if (method === "GET" && groupMatch) return sendJson(response, 200, dbApi.getGroup(db, groupMatch[1]));
  const startMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/games$/);
  if (method === "POST" && startMatch) return sendJson(response, 201, dbApi.startGame(db, startMatch[1]));
  const gameMatch = url.pathname.match(/^\/api\/games\/(\d+)$/);
  if (method === "GET" && gameMatch) return sendJson(response, 200, dbApi.getGame(db, gameMatch[1]));
  if (method === "DELETE" && gameMatch) { dbApi.deleteGame(db, gameMatch[1]); return sendJson(response, 200, { ok: true }); }
  const callerMatch = url.pathname.match(/^\/api\/games\/(\d+)\/round\/caller$/);
  if (method === "POST" && callerMatch) {
    const body = await readJson(request);
    return sendJson(response, 200, dbApi.setFirstCaller(db, callerMatch[1], body.playerId));
  }
  const completeRoundMatch = url.pathname.match(/^\/api\/games\/(\d+)\/round\/complete$/);
  if (method === "POST" && completeRoundMatch) {
    const body = await readJson(request);
    if (body.roundId === undefined || body.roundId === null) throw Object.assign(new Error("Refresh and try that round again."), { status: 409 });
    return sendJson(response, 200, dbApi.completeRound(db, completeRoundMatch[1], body.bids, body.roundId));
  }
  const undoRoundMatch = url.pathname.match(/^\/api\/games\/(\d+)\/round\/undo$/);
  if (method === "POST" && undoRoundMatch) {
    await readJson(request);
    return sendJson(response, 200, dbApi.undoRound(db, undoRoundMatch[1]));
  }
  sendJson(response, 404, { error: "Route not found." });
}

async function groupBody(request) { const body = await readJson(request); return [body.name, body.players]; }
function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; if (data.length > 100000) reject(Object.assign(new Error("Request too large."), { status: 413 })); });
    request.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error("Invalid JSON."), { status: 400 })); } });
    request.on("error", reject);
  });
}
function sendJson(response, status, value) {
  response.writeHead(status, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
function serveStatic(urlPath, response) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return response.writeHead(403).end("Forbidden");
  fs.readFile(filePath, (error, data) => {
    if (error && !path.extname(requested)) {
      return fs.readFile(path.join(publicDir, "index.html"), (indexError, indexData) => {
        if (indexError) return response.writeHead(500).end("Unable to load app");
        response.writeHead(200, { ...securityHeaders, "Content-Type": mimeTypes[".html"], "Cache-Control": "no-cache" });
        response.end(indexData);
      });
    }
    if (error) return response.writeHead(404).end("Not found");
    response.writeHead(200, { ...securityHeaders, "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(data);
  });
}

server.listen(port, host, () => console.log(`717 Scorekeeper running at http://${host}:${port}`));

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close((error) => {
    try { db.close(); } catch (closeError) { console.error("Database close failed:", closeError); }
    process.exit(error ? 1 : 0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
module.exports = server;
