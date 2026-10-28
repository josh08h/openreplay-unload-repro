# Tracker loses buffered data (custom events, clicks, DOM changes) when a page is unloaded

## Related

[#3469](https://github.com/openreplay/openreplay/issues/3469) ("Last moments before page is closed not recorded") reported the same symptom on 16.2.1. [#3504](https://github.com/openreplay/openreplay/pull/3504) added the `closing` flush on `pagehide`. This report shows why that flush still does not deliver on unload, quantifies the loss, and tests a fix.

## Summary

`@openreplay/tracker` (reproduced on 19.0.1 and the latest release, 19.0.3) keeps everything captured after a page's initial snapshot in its web worker. The worker uploads that buffer on a 30-second timer, or when the main thread sends `closing` (on `pagehide`, `visibilitychange` to hidden, and `mouseleave`).

When a page is fully unloaded (for example, by a same-URL navigation or a reload), the `closing` flush does not reach the ingest. Everything captured since the last periodic flush is lost, up to 30 seconds of data. That includes `tracker.event()` custom events, clicks and DOM mutations.

When Chrome puts the page in the back/forward cache instead, the flush only survives if the ingest round trip is close to zero. At 20 ms or more it is also lost in our reproduction.

Calling `tracker.forceFlushBatch()` right after `tracker.event()` does not help. `forceFlushBatch()` posts to the worker before the event has been committed from the main thread.

## Impact

- **Custom events are silently missing** for pages that customers leave within 30 seconds. These are often the most important ones, such as "form submitted" or "payment submitted", fired just before a redirect.
- **Replays show stale UI.** A replay shows a page's initial snapshot (for example, loading spinners), then jumps to the next page. The DOM updates and clicks in between were never uploaded.
- **Testing on desktop understates the problem.** Moving the mouse out of the page triggers an early flush, and the back/forward cache sometimes saves the final flush. Real users who leave by tapping a link, submitting a form or reloading lose the data.

We first observed this in a real Chrome session on OpenReplay Cloud, during a multi-page form journey with frequent same-URL reloads. We confirmed the cause there by decoding the uploaded batches. The missing custom events were never in any request; the server indexed everything it received.

## Environment

- `@openreplay/tracker` 19.0.3 (latest at the time of writing); also reproduced on 19.0.1. Default options apart from those in `src/page.js`.
- Google Chrome 156 (macOS); headless and headed both reproduce
- Ingest: a local mock that implements `/v1/web/start`, `/v1/web/tags` and `/v1/web/i` (`server.mjs`). We saw the same behaviour against OpenReplay Cloud.

## Minimal reproduction

The reproduction is a single static page using the unmodified tracker, a mock ingest on another origin, and a Puppeteer script. No OpenReplay account is needed.

On each page load the page starts the tracker and calls `tracker.event("mre_<scenario>_<n>")`. After 2 seconds it navigates. The mock ingest records which `mre_*` event names arrive in uploaded batches. The last page of each run is never left, so only events from pages that were navigated away from are counted.

The mock delays every response, including CORS preflights, by `LATENCY_MS` (default 50 ms) to model a real network. With an instant loopback server, the unload race is sometimes won by luck.

### Run it

```bash
npm install
npm run build                 # bundles src/page.js with the tracker
npm run serve &               # page on :8788, mock ingest on :8789 (LATENCY_MS=50)
npm run repro                 # CHROME_PATH=/path/to/chrome if not on macOS; HEADLESS=0 to watch
```

Scenarios (`run.mjs`, override with `SCENARIOS` and `REPEAT`):

| Scenario | What the page does |
|---|---|
| `baseline-same` | `location.href = location.href` after 2 s (same URL, so never bfcached and fully unloaded) |
| `baseline-different` | navigates to a different URL after 2 s (Chrome bfcaches the page) |
| `workaround-flush-sync` | `tracker.event(...); tracker.forceFlushBatch();` then same-URL navigation |
| `workaround-flush-deferred` | `tracker.event(...); setTimeout(() => tracker.forceFlushBatch(), 50);` then same-URL navigation |
| `fix-interval` | worker periodic flush changed from 30 s to 1 s (see Proposed solution), then same-URL navigation |

### Results

`REPEAT=3`, 3 departed pages per run (9 events per row):

| Scenario | Latency | Previous page bfcached (`pagehide.persisted`) | Events lost |
|---|---|---|---|
| `baseline-same` | 50 ms | false | **9/9** |
| `baseline-different` | 50 ms | true | **9/9** |
| `workaround-flush-sync` | 50 ms | false | **9/9** |
| `workaround-flush-deferred` | 50 ms | false | 0/9 |
| `fix-interval` | 50 ms | false | 0/9 |
| `baseline-same` | 100 ms | false | **9/9** |
| `baseline-different` | 100 ms | true | **9/9** |
| `workaround-flush-deferred` (same / different URL) | 100 ms | false / true | 0/9, 0/9 |
| `fix-interval` (same / different URL) | 100 ms | false / true | 0/9, 0/9 |

Latency sweep for the baselines (`REPEAT=2`, 6 events per row):

| Latency | `baseline-same` lost | `baseline-different` lost |
|---|---|---|
| 0 ms | 6/6 | 0/6 |
| 20 ms | 6/6 | 5/6 |
| 50 ms | 6/6 | 6/6 |

Control: staying 32 s on a page before a same-URL navigation (`SCENARIOS="control-long-dwell:nav=same&dwell=32000&pages=2" REPEAT=1`) loses 0/1. The periodic flush delivers the event, so the data is captured correctly and only the unload path loses it.

## Root cause

1. **Uploads only happen from the worker, and only on flush.** The worker finalises batches every `AUTO_SEND_INTERVAL` (`tracker/tracker/src/webworker/index.ts`, `30 * 1000`; built output `k=setInterval(I,3e4)`) or when it receives `closing` or `forceFlushBatch`.
2. **The unload flush runs too late.** On `pagehide`, the main thread posts `closing`, and the worker then calls `fetch()` (with `keepalive` within the 64 KB budget). For a full unload, the dedicated worker is terminated with the document. Its request is cancelled, often after the CORS preflight but before the POST. `keepalive` does not keep a dedicated worker's request alive in this case.

   `worker-unload-check/` isolates this without the tracker. A single POST is sent at `pagehide` before a full unload, with a 40 ms preflight delay, 5 runs each:

   | Sent from | Preflight | `keepalive` | Delivered |
   |---|---|---|---|
   | Dedicated worker | yes | yes | 0/5 (preflight arrives, POST never does) |
   | Dedicated worker | no | yes | 0/5 |
   | Main thread | yes | yes | 5/5 |
   | Main thread | no | yes | 5/5 |

   Every tracker upload needs a preflight (`Authorization`, `DataType` and `Content-Encoding` headers). The preflight cache never helps, because each batch URL is unique (`?batch=<page>_<seq>_<bytes>_…`).
3. **The back/forward cache does not reliably help.** When the page is bfcached, the worker is frozen. The flush only gets out if the request completes almost immediately.
4. **`forceFlushBatch()` does not commit pending messages first.** `tracker.event()` pushes into the main thread's `messages`, which are committed to the worker on the next ticker cycle (about 30 ms). `App.forceFlushBatch()` (`tracker/tracker/src/main/app/index.ts`) only does `this.worker?.postMessage('forceFlushBatch')`, so a synchronous `event(); forceFlushBatch()` flushes before the event is in the worker. That's why `workaround-flush-sync` loses everything and `workaround-flush-deferred` loses nothing.

## Proposed solution

We tested points 1 and 2 with this reproduction. Point 3 is a suggestion for a complete fix that we have not built.

1. **Flush periodically on a much shorter interval, and make it configurable.** For example, add a `flushInterval` option with a default of a few seconds instead of 30 s. This bounds what a full unload can lose to that interval. The `fix-interval` scenario demonstrates this by rewriting the worker's interval to 1 s before the worker is created: 0/9 lost at 50 ms and 100 ms latency, for both same-URL and different-URL navigation. The cost is more upload requests, but the worker already skips empty builders, so idle pages don't send.

   In a real Chrome session against OpenReplay Cloud, a 1 s interval combined with point 2 delivered 30/30 custom events and all clicks on a journey that previously lost every event on same-URL reloads.
2. **Make `forceFlushBatch()` commit pending messages before flushing**, e.g. `this.commit()` before `postMessage('forceFlushBatch')`, or flush after the next commit. Then applications can safely call `tracker.event(...); tracker.forceFlushBatch()` before a redirect, and could also await an upload acknowledgement. `workaround-flush-deferred` shows that a flush after the commit delivers 9/9 at both 50 ms and 100 ms latency.

   Optionally, the tracker could flush analytics batches (custom events) promptly by default, since they are small and high value.
3. **For a complete fix, send the final flush from the main thread.** Main-thread `fetch(..., { keepalive: true })` survives a full unload even with a CORS preflight (5/5 above), and the worker's requests do not. This needs the not-yet-uploaded encoded data to be available on the main thread synchronously at `pagehide`. For example, the worker could post each finalised or pending batch to the main thread as it's produced, or the main thread could keep the messages committed since the last confirmed upload. We have not implemented or tested this.

## Files

- `src/page.js`: test page (tracker set-up, scenarios, optional interval patch)
- `server.mjs`: page server and mock ingest with configurable latency
- `run.mjs`: Puppeteer runner that prints the results table
- `worker-unload-check/`: tracker-independent check of worker vs main-thread requests at unload (`node server.mjs &` then `N=5 node run.mjs`)
