// Minimal page for reproducing lost data when a page is unloaded without entering the
// back/forward cache. Each page load starts the tracker, sends one custom event
// (`mre_<scenario>_<n>`), waits `dwell` ms, then navigates according to `nav`:
//   nav=same       -> location.href = location.href  (same URL: never bfcached, full unload)
//   nav=different  -> next page has a different URL (may be bfcached by Chrome)
//
// Optional `workaround` (application-level, public API only):
//   flush-sync      -> tracker.event(); tracker.forceFlushBatch()
//   flush-deferred  -> tracker.event(); setTimeout(() => tracker.forceFlushBatch(), 50)
//
// Optional `patch=interval` rewrites the worker's 30 s periodic flush to 1 s before the
// worker is created, to demonstrate the proposed SDK change without rebuilding the SDK.
import Tracker from "@openreplay/tracker";

const q = new URLSearchParams(location.search);
const scenario = q.get("scenario") ?? "default";
const nav = q.get("nav") ?? "same";
const dwell = Number(q.get("dwell") ?? 2000);
const pages = Number(q.get("pages") ?? 4);
const workaround = q.get("workaround") ?? "none";
const ingest = q.get("ingest") ?? "http://127.0.0.1:8789";

if (q.get("patch") === "interval") {
  const RealBlob = window.Blob;
  window.Blob = function (parts, opts) {
    if (Array.isArray(parts) && typeof parts[0] === "string" && parts[0].includes("OR WebWorker")) {
      parts = [parts[0].replace("setInterval(I,3e4)", "setInterval(I,1e3)")];
    }
    return new RealBlob(parts, opts);
  };
  window.Blob.prototype = RealBlob.prototype;
}

const key = `mre_page_${scenario}`;
const n = Number(sessionStorage.getItem(key) ?? 0);
sessionStorage.setItem(key, String(n + 1));

// Report how the *previous* page was left (persisted=true means it entered the bfcache).
const previous = sessionStorage.getItem("mre_last_pagehide");
sessionStorage.removeItem("mre_last_pagehide");
addEventListener("pagehide", (e) => {
  sessionStorage.setItem("mre_last_pagehide", JSON.stringify({ n, persisted: e.persisted }));
});

const report = (body) => fetch(`${ingest}/mre/report`, {
  method: "POST", body: JSON.stringify({ scenario, ...body }), keepalive: true,
}).catch(() => {});
if (previous) { report({ type: "pagehide", ...JSON.parse(previous) }); }

document.querySelector("#state").textContent = `scenario ${scenario}, page ${n}`;

const tracker = new Tracker({
  projectKey: "mre-project-key",
  ingestPoint: ingest,
  __DISABLE_SECURE_MODE: true, // plain http on 127.0.0.1 for the reproduction only
  consoleMethods: [],
  captureExceptions: false,
  network: { disabled: true },
});

tracker.start({ userID: `mre-${scenario}` }).then((result) => {
  if (!result.success) { report({ type: "start-failed", reason: result.reason }); return; }
  const name = `mre_${scenario}_${n}`;
  tracker.event(name, { n: String(n) });
  report({ type: "event-fired", name, n });
  if (workaround === "flush-sync") { tracker.forceFlushBatch(); }
  if (workaround === "flush-deferred") { setTimeout(() => tracker.forceFlushBatch(), 50); }

  if (n + 1 < pages) {
    setTimeout(() => {
      if (nav === "same") {
        location.href = location.href;
      } else {
        const next = new URL(location.href);
        next.searchParams.set("p", String(n + 1));
        location.href = next.toString();
      }
    }, dwell);
  } else {
    report({ type: "done", n });
  }
});
