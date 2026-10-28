// Page origin :8871 and a cross-origin collector :8872 that logs every OPTIONS/POST it receives.
// PRE_DELAY (ms, default 40) delays preflight responses to model network latency.
import http from 'node:http';
const log = [];
const PRE_DELAY = Number(process.env.PRE_DELAY ?? 40);
const NAV_DELAY = Number(process.env.NAV_DELAY ?? 0);
const page = (id, mode, when) => `<!doctype html><meta charset=utf-8><title>src</title><body><button id=go>go</button><script>
const C='http://127.0.0.1:8872/c?id=${id}&mode=${mode}';
const [where, pre, ka] = '${mode}'.split('-'); // where: w|m, pre: pre|simple, ka: ka|noka
const opts = (tag) => ({method:'POST', body: 'x'.repeat(2000), keepalive: ka==='ka',
  headers: pre==='pre' ? {'Authorization':'Bearer t','DataType':'analytics','Content-Type':'application/octet-stream'} : {'Content-Type':'text/plain'}});
let w;
if (where==='w') {
  const src = 'const opts='+opts.toString()+';const pre='+JSON.stringify(pre)+',ka='+JSON.stringify(ka)+';onmessage=e=>{fetch("'+C+'&tag="+e.data, opts(e.data)).catch(()=>{})}';
  w = new Worker(URL.createObjectURL(new Blob([src],{type:'text/javascript'})));
}
const send = (tag) => where==='w' ? w.postMessage(tag) : fetch(C+'&tag='+tag, opts(tag)).catch(()=>{});
addEventListener('pagehide', (e) => send(e.persisted ? 'pagehide-persisted' : 'pagehide'));
if (location.search.includes('unload=1')) addEventListener('unload', () => {});
window.go = () => { ${when==='click' ? "send('click');" : ''} location.href='/dst.html?id=${id}'; };
</script>`;
const app = (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/src.html') { res.writeHead(200,{'content-type':'text/html', ...({'cache-control':'no-store'})}); return res.end(page(u.searchParams.get('id'), u.searchParams.get('mode'), u.searchParams.get('when'))); }
  if (u.pathname === '/dst.html') { return setTimeout(()=>{res.writeHead(200,{'content-type':'text/html'}); res.end('<title>dst</title>dst');}, NAV_DELAY); }
  res.writeHead(404); res.end();
};
const collector = (req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = {'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'Content-Type, Authorization, DataType','access-control-max-age':'1728000'};
  if (u.pathname === '/log') { res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify(log)); }
  if (u.pathname === '/reset') { log.length = 0; res.writeHead(200); return res.end(); }
  const rec = {t: Date.now(), m: req.method, id: u.searchParams.get('id'), mode: u.searchParams.get('mode'), tag: u.searchParams.get('tag')};
  if (req.method === 'OPTIONS') { log.push(rec); return setTimeout(()=>{res.writeHead(204,cors); res.end();}, PRE_DELAY); }
  let n=0; req.on('data',d=>n+=d.length); req.on('end',()=>{ rec.bytes=n; log.push(rec); res.writeHead(200,cors); res.end('ok'); });
};
http.createServer(app).listen(8871,'127.0.0.1');
http.createServer(collector).listen(8872,'127.0.0.1');
console.log('up', {PRE_DELAY, NAV_DELAY});
