// Sends one POST at pagehide from either a dedicated worker (w) or the main thread (m),
// with or without a CORS preflight (pre|simple) and keepalive (ka|noka), then navigates.
// The page has an unload listener so Chrome fully unloads it instead of bfcaching it.
import puppeteer from 'puppeteer-core';
const exe = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const modes = (process.env.MODES ?? 'w-pre-ka,w-simple-ka,m-pre-ka,m-simple-ka').split(',');
const when = process.env.WHEN ?? 'pagehide';
const N = Number(process.env.N ?? 5);
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-first-run','--no-default-browser-check'] });
await fetch('http://127.0.0.1:8872/reset');
const ids = [];
for (const mode of modes) for (let i=0;i<N;i++) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  const id = `${mode}-${i}`; ids.push([mode,id]);
  await p.goto(`http://127.0.0.1:8871/src.html?id=${id}&mode=${mode}&when=${when}${process.env.UNLOAD === '0' ? '' : '&unload=1'}`);
  await new Promise(r=>setTimeout(r,150));
  await Promise.all([p.waitForNavigation({waitUntil:'load'}), p.evaluate(()=>window.go())]);
  await new Promise(r=>setTimeout(r,Number(process.env.HOLD ?? 2000)));
  await ctx.close();
}
await new Promise(r=>setTimeout(r,1500));
const log = await (await fetch('http://127.0.0.1:8872/log')).json();
const res = {};
for (const [mode,id] of ids) {
  const r = res[mode] ??= {runs:0, options:0, post:0};
  r.runs++; const L = log.filter(x=>x.id===id);
  if (L.some(x=>x.m==='OPTIONS')) r.options++;
  if (L.some(x=>x.m==='POST')) r.post++;
}
console.log(when, JSON.stringify(res, null, 0).replaceAll('},', '},\n'));
await browser.close();
