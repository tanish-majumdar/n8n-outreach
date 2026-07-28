import type { Config } from '../config.ts';

export function dashboard(config: Config): string {
  const needsToken = Boolean(config.ADMIN_TOKEN);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>campaign research</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --accent:#2563eb; --ok:#15803d; --warn:#b45309; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0f12; --fg:#e8e8e8; --muted:#8b93a1; --line:#232833; --accent:#60a5fa; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.25rem; background:var(--bg); color:var(--fg); font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:1.15rem; margin:0 0 .25rem; }
  p.sub { color:var(--muted); margin:0 0 1.5rem; }
  section { border:1px solid var(--line); border-radius:8px; padding:1rem; margin-bottom:1rem; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 .75rem; }
  pre { white-space:pre-wrap; word-break:break-word; margin:0; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th,td { text-align:left; padding:.35rem .5rem; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  button,input { font:inherit; padding:.4rem .7rem; border-radius:6px; border:1px solid var(--line); background:transparent; color:inherit; }
  button { cursor:pointer; border-color:var(--accent); color:var(--accent); }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
  .ok{color:var(--ok)} .partial{color:var(--warn)} .failed{color:var(--bad)} .running{color:var(--accent)}
  .scroll { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>campaign research</h1>
  <p class="sub">daily partner research &middot; ${config.SCHEDULE_ENABLED ? `${config.SCHEDULE} ${config.TIMEZONE}` : 'schedule disabled'}</p>

  ${needsToken ? '<section><h2>token</h2><div class="row"><input id="token" type="password" placeholder="admin token" style="flex:1"><button id="save">save</button></div></section>' : ''}

  <section><h2>status</h2><pre id="status">loading…</pre></section>

  <section>
    <h2>trigger</h2>
    <div class="row">
      <label><input type="checkbox" id="dry" checked> dry</label>
      <label>limit <input type="number" id="limit" min="1" max="50" value="2" style="width:5rem"></label>
      <button id="go">run now</button>
      <span id="msg"></span>
    </div>
  </section>

  <section><h2>runs</h2><div class="scroll"><table id="runs"><tbody><tr><td>loading…</td></tr></tbody></table></div></section>
  <section><h2>detail</h2><pre id="detail">select a run</pre></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const store = { get: () => localStorage.getItem('cr_token') || '', set: (v) => localStorage.setItem('cr_token', v) };
if ($('token')) { $('token').value = store.get(); $('save').onclick = () => { store.set($('token').value); load(); }; }

async function api(path, init = {}) {
  const token = store.get();
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(init.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ('HTTP ' + res.status));
  return res.json();
}

function fmt(ms) { return ms == null ? '' : (ms / 1000).toFixed(1) + 's'; }

async function load() {
  try {
    const status = await api('/api/status');
    $('status').textContent = [
      'spreadsheet  ' + status.spreadsheet,
      'model        ' + status.model,
      'schedule     ' + (status.schedule ? status.schedule.cron + ' ' + status.schedule.timezone : 'disabled'),
      'running      ' + (status.running ? status.running.id : 'no'),
      '',
      status.last ? status.last.summary || status.last.error || '' : 'no runs yet',
    ].join('\\n');

    const { runs } = await api('/api/runs');
    $('runs').innerHTML = '<thead><tr><th>id</th><th>status</th><th>trigger</th><th>appended</th><th>took</th></tr></thead><tbody>' +
      (runs.length ? runs.map((r) => '<tr data-id="' + r.id + '" style="cursor:pointer"><td>' + r.id + '</td><td class="' + r.status + '">' + r.status + (r.dry ? ' (dry)' : '') + '</td><td>' + r.trigger + '</td><td>' + (r.appended ?? '') + '</td><td>' + fmt(r.durationMs) + '</td></tr>').join('') : '<tr><td>none yet</td></tr>') +
      '</tbody>';
    for (const tr of $('runs').querySelectorAll('tr[data-id]')) {
      tr.onclick = async () => { $('detail').textContent = JSON.stringify(await api('/api/runs/' + tr.dataset.id), null, 2); };
    }
  } catch (err) { $('status').textContent = 'error: ' + err.message; }
}

$('go').onclick = async () => {
  $('go').disabled = true;
  $('msg').textContent = 'starting…';
  try {
    const body = { dry: $('dry').checked, limit: Number($('limit').value) || null };
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify(body) });
    $('msg').textContent = 'started ' + res.id;
  } catch (err) { $('msg').textContent = err.message; }
  $('go').disabled = false;
  load();
};

load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}
