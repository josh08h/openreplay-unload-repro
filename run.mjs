// Drives Chrome through each scenario and prints which custom events reached the ingest.
// Usage: npm run build && (npm run serve &) && npm run repro
// CHROME_PATH defaults to the macOS Google Chrome location. HEADLESS=0 shows the window.
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = `http://127.0.0.1:${process.env.PAGE_PORT ?? 8788}`;
const INGEST = `http://127.0.0.1:${process.env.INGEST_PORT ?? 8789}`;
const SETTLE_MS = 3000;
const REPEAT = Number(process.env.REPEAT ?? 3); // time after the last page for in-flight uploads to land

const scenarios = (process.env.SCENARIOS ?? [
  "baseline-same:nav=same",
  "baseline-different:nav=different",
  "workaround-flush-sync:nav=same&workaround=flush-sync",
  "workaround-flush-deferred:nav=same&workaround=flush-deferred",
  "fix-interval:nav=same&patch=interval",
].join(",")).split(",");

const browser = await puppeteer.launch({ executablePath: CHROME, headless: process.env.HEADLESS !== "0" });
const results = [];
for (const spec of scenarios) {
  const [scenario, params] = spec.split(":");
  let lostTotal = 0, departedTotal = 0; const persistedAll = [];
  for (let i = 0; i < REPEAT; i++) {
  await fetch(`${INGEST}/mre/reset`);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${PAGE}/?scenario=${scenario}&${params}&ingest=${encodeURIComponent(INGEST)}`);
  const deadline = Date.now() + 60000;
  let state;
  do {
    await new Promise((r) => setTimeout(r, 500));
    state = await (await fetch(`${INGEST}/mre/state`)).json();
  } while (!state.reports.some((r) => r.type === "done") && Date.now() < deadline);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  state = await (await fetch(`${INGEST}/mre/state`)).json();
  await context.close();

  const fired = state.reports.filter((r) => r.type === "event-fired").map((r) => r.name);
  const received = new Set(state.received.map((r) => r.name));
  const persisted = state.reports.filter((r) => r.type === "pagehide").map((r) => r.persisted);
  // The last page is never left, so only the events of pages that were navigated away from count.
  const departed = fired.slice(0, -1);
  const lost = departed.filter((name) => !received.has(name));
  lostTotal += lost.length; departedTotal += departed.length; persistedAll.push(...persisted);
  }
  const unique = [...new Set(persistedAll)];
  results.push({
    scenario,
    runs: REPEAT,
    "previous page bfcached (pagehide.persisted)": unique.length === 1 ? String(unique[0]) : persistedAll.join(","),
    "events lost on departure": `${lostTotal}/${departedTotal}`,
  });
}
console.table(results);
await browser.close();
