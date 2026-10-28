// Serves the test page on :8788 and a minimal mock of the OpenReplay ingest API on :8789.
// The mock is a different origin, so uploads need a CORS preflight like the real ingest.
// LATENCY_MS (default 50) delays every ingest response, including preflights, to model a
// real network round trip. With ~0 ms loopback latency the unload race is often won by luck.
// It records which `mre_*` custom event names arrive in uploaded batches.
import http from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";

const PAGE_PORT = Number(process.env.PAGE_PORT ?? 8788);
const INGEST_PORT = Number(process.env.INGEST_PORT ?? 8789);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 50);
const delay = () => new Promise((r) => setTimeout(r, LATENCY_MS));
const state = { received: [], reports: [], batches: [] };

const html = `<!doctype html><meta charset="utf-8"><title>OpenReplay pagehide MRE</title>
<body><h1>OpenReplay pagehide MRE</h1><div id="state">Loading</div>
<p>Some content so the DOM snapshot is not empty.</p><script src="/page.bundle.js"></script></body>`;

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/page.bundle.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(fs.readFileSync(new URL("./public/page.bundle.js", import.meta.url)));
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
}).listen(PAGE_PORT, "127.0.0.1");

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, Content-Encoding, DataType",
  "access-control-max-age": "86400",
};
const json = (res, body) => { res.writeHead(200, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });

const handleControl = async (req, res, url) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (url.pathname === "/mre/report") { state.reports.push({ at: Date.now(), ...JSON.parse((await readBody(req)).toString()) }); return json(res, {}); }
  if (url.pathname === "/mre/state") { return json(res, state); }
  if (url.pathname === "/mre/reset") { state.received = []; state.reports = []; state.batches = []; return json(res, {}); }
  res.writeHead(404, cors); res.end();
};

let sessionSeq = 0;
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/mre/")) { return handleControl(req, res, url); }
  if (req.method === "OPTIONS") { await delay(); res.writeHead(204, cors); return res.end(); }
  const body = await readBody(req);
  // Record arrival before the simulated latency: the request reached the server.

  if (url.pathname === "/v1/web/start") {
    await delay();
    const { token } = JSON.parse(body.toString() || "{}");
    const sessionID = token ? token.replace("token-", "") : String(4000000000000000000n + BigInt(++sessionSeq));
    return json(res, {
      token: `token-${sessionID}`, userUUID: "mre-user-uuid", sessionID, projectID: "1",
      timestamp: Date.now(), startTimestamp: Date.now(), delay: 0,
      beaconSizeLimit: 5000000, compressionThreshold: 24000, protocolVersion: 2,
    });
  }
  if (url.pathname === "/v1/web/tags") { await delay(); return json(res, { tags: [] }); }
  if (url.pathname === "/v1/web/i") {
    const raw = req.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(body) : body;
    const names = [...new Set(raw.toString("latin1").match(/mre_[A-Za-z0-9-]+_\d+/g) ?? [])];
    state.batches.push({ at: Date.now(), batch: url.searchParams.get("batch"), type: req.headers.datatype, bytes: raw.length });
    names.forEach((name) => state.received.push({ at: Date.now(), name }));
    await delay();
    return json(res, {});
  }
  res.writeHead(404, cors); res.end();
}).listen(INGEST_PORT, "127.0.0.1");

console.log(`page: http://127.0.0.1:${PAGE_PORT}/  mock ingest: http://127.0.0.1:${INGEST_PORT}  latency: ${LATENCY_MS} ms`);
