const api = async (p, m = 'GET', b) => {
  const r = await fetch('/api' + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'bench' }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
  return j;
};
const h = (t, a = {}, ...c) => {
  const e = document.createElement(t);
  for (const [k, v] of Object.entries(a)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  e.append(...c.flat().filter(x => x != null && x !== false)); return e;
};
const fmt = n => Math.round(n).toLocaleString('de-DE');
const view = document.getElementById('view');
const err = e => h('p', { class: 'err' }, e.message);
const table = (head, rows) => h('table', {}, h('thead', {}, h('tr', {}, head.map(x => h('th', {}, x)))), h('tbody', {}, rows.map(r => h('tr', {}, r.map(c => h('td', {}, c))))));
let me = null, last = null;

// ---------- Benchmarks ----------
const runWorker = (ms, onRate) => new Promise((res, rej) => { const w = new Worker('/worker.js'); w.onmessage = e => { if ('r' in e.data) return onRate?.(e.data.r); w.terminate(); res(e.data.ops / ms); }; w.onerror = rej; w.postMessage({ ms }); });
async function cpuBench(say, live) {
  say('CPU Single-Core …', 3); live.phase(0, 1);
  const single = await runWorker(3000, r => live.rate(0, r));
  const n = navigator.hardwareConcurrency || 4; say(`CPU Multi-Core (${n} Threads) …`, 3); live.phase(1, n);
  const multi = (await Promise.all(Array.from({ length: n }, (_, i) => runWorker(3000, r => live.rate(i, r))))).reduce((s, v) => s + v, 0);
  return { single, multi, threads: n };
}
async function gpuBench(say, live) {
  const N = 1024, IT = 300, c = document.createElement('canvas'); c.width = c.height = N;
  const gl = c.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 nicht verfügbar');
  live.canvas(c);
  const x = gl.getExtension('WEBGL_debug_renderer_info');
  const name = (x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || 'Unbekannt';
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, `#version 300 es
void main(){vec2 v=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(v*2.-1.,0,1);}`));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;uniform float t;out vec4 o;
void main(){vec2 z=gl_FragCoord.xy/${N}.-.5;float a=0.;vec2 c=vec2(.3*sin(t),.2*cos(t));
for(int i=0;i<${IT};i++){z=vec2(z.x*z.x-z.y*z.y,2.*z.x*z.y)*.9+c;a+=sin(z.x*z.y)*.001;}o=vec4(a,z,1);}`));
  gl.linkProgram(p); gl.useProgram(p); gl.viewport(0, 0, N, N);
  const tl = gl.getUniformLocation(p, 't'), px = new Uint8Array(4);
  const draw = k => { for (let i = 0; i < k; i++) { gl.uniform1f(tl, performance.now() / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3); } gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  draw(2); say('GPU …', 4);
  live.phase(2, 0);
  let draws = 0, ld = 0; const t0 = performance.now(); let lt = t0;
  while (performance.now() - t0 < 4000) {
    draw(3); draws += 3; await new Promise(r => setTimeout(r));
    const now = performance.now();
    if (now - lt >= 200) { live.gpu((draws - ld) * N * N * IT / ((now - lt) / 1000) / 1e8); lt = now; ld = draws; }
  }
  return { name, score: draws * N * N * IT / ((performance.now() - t0) / 1000) / 1e8 };
}

// ---------- Views ----------
function cleanGpu(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/^ANGLE \((.*)\)$/);
  if (m) { const p = m[1].split(/,\s+/); s = p.length >= 3 ? p.slice(1, -1).join(', ') : (p[1] || p[0]); }
  return s.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+Direct3D.*$/i, '').replace(/^ANGLE Metal Renderer:\s*/i, '')
    .replace(/\/(PCIe|SSE2).*$/i, '').replace(/^Mesa\s+/i, '').replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim();
}

const avgAll = (rows, key) => { const n = rows.reduce((s, r) => s + r.n, 0); return n ? rows.reduce((s, r) => s + r[key] * r.n, 0) / n : null; };
const findModel = (rows, name) => rows.find(r => r.name.toLowerCase() === String(name).trim().toLowerCase());
function chart(title, you, refs) {
  const vals = [['Dein Lauf', you, ''], ...refs.filter(r => r[1] != null).map(r => [r[0], r[1], 'mut'])];
  const max = Math.max(...vals.map(v => v[1]), 1);
  const avg = refs.find(r => r[0] === 'Ø alle User')?.[1];
  const d = avg ? ` (${you >= avg ? '+' : '−'}${Math.abs((you / avg - 1) * 100).toFixed(0)} % ggü. Ø)` : '';
  return h('div', {}, h('h3', {}, title + d),
    vals.map(([l, v, cls]) => h('div', { class: 'row' }, h('span', {}, l), h('div', { class: 'bar' }, h('i', { class: cls, style: `width:${v / max * 100}%` })), h('b', {}, fmt(v)))));
}
async function visualize(box, cpuName, gpuName, c, gScore) {
  box.replaceChildren(h('p', {}, 'Vergleichsdaten werden geladen …'));
  try {
    const [cs, gs, b1, b2, b3] = await Promise.all([api('/stats/cpus'), api('/stats/gpus'), api('/leaderboard?type=cpu_single'), api('/leaderboard?type=cpu_multi'), api('/leaderboard?type=gpu')]);
    const cm = findModel(cs, cpuName), gm = findModel(gs, gpuName);
    box.replaceChildren(...[
      h('h2', {}, 'Dein Ergebnis im Vergleich'),
      chart('CPU Single-Core', c.single, [['Ø CPU-Modell', cm?.single], ['Ø alle User', avgAll(cs, 'single')], ['Bestwert', b1[0]?.score]]),
      chart('CPU Multi-Core', c.multi, [['Ø CPU-Modell', cm?.multi], ['Ø alle User', avgAll(cs, 'multi')], ['Bestwert', b2[0]?.score]]),
      chart('GPU', gScore, [['Ø GPU-Modell', gm?.score], ['Ø alle User', avgAll(gs, 'score')], ['Bestwert', b3[0]?.score]]),
      !b1.length && h('p', {}, 'Noch keine Vergleichsdaten vorhanden – dein Ergebnis wäre der erste Eintrag.')].filter(Boolean));
  } catch { box.replaceChildren(); }
}
function makeLive() {
  const W = 720, H = 170, COL = ['#2563eb', '#16a34a', '#d97706'], NAME = ['CPU Single', 'CPU Multi', 'GPU'];
  const cv = h('canvas', { width: W, height: H, class: 'livechart' }), ctx = cv.getContext('2d');
  const tiles = h('div', { class: 'tiles' }), gpuBox = h('div', { class: 'gpubox' }), label = h('h3', {}, 'Live-Test');
  const el = h('div', { class: 'live' }, label, tiles, gpuBox, cv);
  const T0 = performance.now(), pts = [[], [], []], css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  let ph = 0, rates = [], tileEls = [], peak = 1, raf = 0;
  const draw = () => {
    raf = 0; ctx.clearRect(0, 0, W, H);
    const X = Math.max(11, (performance.now() - T0) / 1000);
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.strokeRect(.5, .5, W - 1, H - 1);
    ctx.font = '13px system-ui'; let lx = 10;
    pts.forEach((p, k) => {
      if (!p.length) return;
      const max = Math.max(...p.map(q => q[1])) * 1.15 || 1;
      ctx.strokeStyle = COL[k]; ctx.lineWidth = 2; ctx.beginPath();
      p.forEach(([t, v], i) => { const x = t / X * W, y = H - 8 - (v / max) * (H - 38); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      const txt = `${NAME[k]} ${fmt(p[p.length - 1][1])}`;
      ctx.fillStyle = COL[k]; ctx.fillRect(lx, 10, 10, 10); ctx.fillStyle = css('--fg'); ctx.fillText(txt, lx + 14, 20);
      lx += ctx.measureText(txt).width + 34;
    });
  };
  const sched = () => { raf = raf || requestAnimationFrame(draw); };
  const now = () => (performance.now() - T0) / 1000;
  return {
    el,
    phase(k, n) {
      ph = k; peak = 1; rates = Array(n).fill(0);
      label.textContent = `Live-Test: ${NAME[k]}${n > 1 ? ` (${n} Threads)` : ''}`;
      tiles.replaceChildren(...rates.map((_, i) => h('div', { class: 'tile', title: 'Thread ' + (i + 1) }, h('i'))));
      tileEls = [...tiles.children];
    },
    rate(i, r) {
      rates[i] = r; peak = Math.max(peak, ...rates);
      tileEls.forEach((t, j) => { t.firstChild.style.height = `${rates[j] / peak * 100}%`; });
      if (i === 0) { pts[ph].push([now(), rates.reduce((s, v) => s + v, 0)]); sched(); }
    },
    canvas(c) { c.className = 'gpucv'; gpuBox.replaceChildren(c); },
    gpu(v) { pts[2].push([now(), v]); sched(); },
    done() { label.textContent = 'Testverlauf (Durchsatz über die Zeit)'; tiles.replaceChildren(); sched(); },
  };
}
function benchView() {
  const cpu = h('input', { list: 'cpus', placeholder: 'CPU-Modell, z. B. Intel Core i7-8700K', maxlength: 80, size: 34 });
  const gpu = h('input', { placeholder: 'GPU (wird erkannt)', maxlength: 80, size: 34 });
  const dl = h('datalist', { id: 'cpus' });
  api('/stats/cpus').then(r => r.forEach(x => dl.append(h('option', { value: x.name })))).catch(() => {});
  const out = h('div'), liveBox = h('div'), btn = h('button', {}, 'Benchmark starten (~15 s)');
  btn.onclick = async () => {
    if (cpu.value.trim().length < 2) return out.replaceChildren(err(new Error('Bitte CPU-Modell angeben – der Browser kann es nicht auslesen.')));
    btn.disabled = true;
    try {
      const say = (t, s) => out.replaceChildren(...[h('p', {}, t), s && h('div', { class: 'bar' }, h('i', { style: `width:0;animation:fill ${s}s linear forwards` }))].filter(Boolean));
      const live = makeLive(); liveBox.replaceChildren(live.el);
      const c = await cpuBench(say, live), g = await gpuBench(say, live);
      live.done();
      if (!gpu.value) gpu.value = cleanGpu(g.name);
      last = { cpu_single: c.single, cpu_multi: c.multi, gpu_score: g.score, threads: c.threads };
      const save = h('button', { onclick: async () => { try { await api('/scores', 'POST', { ...last, cpu_model: cpu.value, gpu_model: gpu.value }); save.replaceWith(h('span', {}, '✓ Gespeichert')); } catch (e) { alert(e.message); } } }, 'Ergebnis speichern');
      const charts = h('div');
      out.replaceChildren(...[
        table(['CPU Single', 'CPU Multi', 'GPU'], [[fmt(c.single), fmt(c.multi), fmt(g.score)]]),
        /swiftshader|llvmpipe|software/i.test(g.name) && h('p', { class: 'warn' }, 'Hinweis: Software-Rendering erkannt – GPU-Wert nicht aussagekräftig.'),
        charts,
        me ? save : h('p', {}, 'Zum Speichern bitte unter „Profil“ anmelden.')].filter(Boolean));
      visualize(charts, cpu.value, gpu.value, c, g.score);
    } catch (e) { out.replaceChildren(err(e)); }
    btn.disabled = false;
  };
  return h('div', {}, h('h2', {}, 'Benchmark'), h('p', {}, 'Tab im Vordergrund lassen, andere Last vermeiden.'), cpu, dl, gpu, btn, liveBox, out);
}
function boardView() {
  const sel = h('select', {}, [['cpu_multi', 'CPU Multi-Core'], ['cpu_single', 'CPU Single-Core'], ['gpu', 'GPU']].map(([v, l]) => h('option', { value: v }, l)));
  const box = h('div');
  const load = async () => { try { const r = await api('/leaderboard?type=' + sel.value); box.replaceChildren(table(['#', 'User', 'Score', 'CPU', 'GPU'], r.map((x, i) => [i + 1, x.username, fmt(x.score), x.cpu_model, x.gpu_model]))); } catch (e) { box.replaceChildren(err(e)); } };
  sel.onchange = load; load();
  return h('div', {}, h('h2', {}, 'Leaderboard (bester Wert pro User)'), sel, box);
}
async function compareView() {
  const [c, g] = await Promise.all([api('/stats/cpus'), api('/stats/gpus')]);
  const bars = (rows, key) => { const max = Math.max(...rows.map(r => r[key]), 1); return table(['Modell', 'Ø Score', '', 'Messungen / User'], rows.map(r => [r.name, fmt(r[key]), h('div', { class: 'bar' }, h('i', { style: `width:${r[key] / max * 100}%` })), `${r.n} / ${r.users}`])); };
  return h('div', {}, h('h2', {}, 'CPUs – Ø Multi-Core'), bars(c, 'multi'), h('h2', {}, 'CPUs – Ø Single-Core'), bars([...c].sort((a, b) => b.single - a.single), 'single'), h('h2', {}, 'GPUs – Ø Score'), bars(g, 'score'));
}
function authView() {
  const u = h('input', { placeholder: 'Benutzername', autocomplete: 'username' }), em = h('input', { type: 'email', placeholder: 'E-Mail (nur für Registrierung)', autocomplete: 'email' }), p = h('input', { type: 'password', placeholder: 'Passwort (min. 10 Zeichen)', autocomplete: 'current-password' }), msg = h('div');
  const step2 = () => { const c = h('input', { placeholder: '6-stelliger Code oder Recovery-Code', autocomplete: 'one-time-code' }); view.replaceChildren(h('h2', {}, 'Zwei-Faktor-Code'), c, h('button', { onclick: async () => { try { me = (await api('/login/2fa', 'POST', { code: c.value })).user; nav(); } catch (e) { alert(e.message); } } }, 'Bestätigen')); };
  const go = async path => { try { const r = await api(path, 'POST', { username: u.value, password: p.value, email: em.value }); if (r.needs2fa) return step2(); me = r.user; nav(); } catch (e) { msg.replaceChildren(err(e)); } };
  return h('div', {}, h('h2', {}, 'Anmelden / Registrieren'), u, em, p, h('button', { onclick: () => go('/login') }, 'Anmelden'), h('button', { class: 'alt', onclick: () => go('/register') }, 'Registrieren'), msg);
}
function twoFaBox() {
  const box = h('div');
  const render = () => {
    if (me.totp) {
      const p = h('input', { type: 'password', placeholder: 'Passwort' }), c = h('input', { placeholder: 'Code' });
      return box.replaceChildren(h('p', {}, '2FA ist aktiv.'), p, c, h('button', { class: 'alt', onclick: async () => { try { await api('/2fa/disable', 'POST', { password: p.value, code: c.value }); me.totp = false; render(); } catch (e) { alert(e.message); } } }, '2FA deaktivieren'));
    }
    box.replaceChildren(h('button', { onclick: async () => {
      try {
        const r = await api('/2fa/setup', 'POST'), c = h('input', { placeholder: 'Code aus der App' });
        box.replaceChildren(h('img', { src: r.qr, width: 200, height: 200, alt: 'QR-Code' }), h('p', {}, 'Secret: ', h('code', {}, r.secret)), c,
          h('button', { onclick: async () => { try { const k = await api('/2fa/enable', 'POST', { code: c.value }); me.totp = true; box.replaceChildren(h('p', {}, '2FA aktiv. Recovery-Codes jetzt sichern – sie werden nur einmal angezeigt:'), h('pre', {}, k.recoveryCodes.join('\n')), h('button', { onclick: render }, 'Fertig')); } catch (e) { alert(e.message); } } }, 'Aktivieren'));
      } catch (e) { alert(e.message); }
    } }, '2FA einrichten'));
  };
  render(); return box;
}
async function profileView() {
  if (!me) return authView();
  const d = await api('/me'), a = d.avg; me = d.user;
  const cur = h('input', { type: 'password', placeholder: 'Aktuelles Passwort' }), nw = h('input', { type: 'password', placeholder: 'Neues Passwort' });
  return h('div', {},
    h('h2', {}, 'Profil: ' + me.username),
    !me.verified && h('p', { class: 'warn' }, `E-Mail ${me.email || ''} noch nicht bestätigt – ohne Bestätigung können keine Ergebnisse gespeichert werden. `, h('button', { class: 'alt', onclick: async () => { try { await api('/verify/resend', 'POST'); alert('Mail gesendet'); } catch (e) { alert(e.message); } } }, 'Mail erneut senden')),
    table(['Messungen', 'Ø Single', 'Ø Multi', 'Ø GPU', 'Best Single', 'Best Multi', 'Best GPU'], [[a.n, ...[a.single, a.multi, a.gpu, a.bestSingle, a.bestMulti, a.bestGpu].map(v => v == null ? '–' : fmt(v))]]),
    h('h3', {}, 'Verlauf'),
    table(['Datum', 'CPU', 'GPU', 'Single', 'Multi', 'GPU-Score', ''], d.scores.map(s => [new Date(s.created_at).toLocaleString('de-DE'), s.cpu_model, s.gpu_model, fmt(s.cpu_single), fmt(s.cpu_multi), fmt(s.gpu_score), h('button', { class: 'alt', onclick: async () => { await api('/scores/' + s.id, 'DELETE'); nav(); } }, '×')])),
    h('h3', {}, 'Zwei-Faktor-Authentifizierung'), twoFaBox(),
    h('h3', {}, 'Passwort ändern'), cur, nw, h('button', { onclick: async () => { try { await api('/password', 'POST', { current: cur.value, next: nw.value }); alert('Passwort geändert'); } catch (e) { alert(e.message); } } }, 'Ändern'),
    h('h3', {}, 'Konto'),
    h('button', { class: 'alt', onclick: async () => { await api('/logout', 'POST'); me = null; nav(); } }, 'Abmelden'),
    h('button', { class: 'alt', onclick: async () => { const pw = prompt('Passwort zur Bestätigung (Konto und alle Daten werden gelöscht):'); if (!pw) return; try { await api('/me', 'DELETE', { password: pw }); me = null; nav(); } catch (e) { alert(e.message); } } }, 'Konto löschen'));
}
async function adminView() {
  if (!me?.admin) return h('p', { class: 'err' }, 'Kein Zugriff');
  const [us, sc] = await Promise.all([api('/admin/users'), api('/admin/scores')]);
  const act = fn => async () => { try { await fn(); nav(); } catch (e) { alert(e.message); } };
  const btn = (t, fn) => h('button', { class: 'alt', onclick: act(fn) }, t);
  return h('div', {},
    h('h2', {}, 'Admin: User'),
    table(['ID', 'User', 'E-Mail', 'Bestätigt', 'Scores', 'Status', ''], us.map(u => [u.id, u.username, u.email || '–', u.verified ? '✓' : '–', u.scores, u.admin ? 'Admin' : u.banned ? 'gesperrt' : 'aktiv',
      u.admin ? '' : [btn(u.banned ? 'Entsperren' : 'Sperren', () => api(`/admin/users/${u.id}/ban`, 'POST', { banned: !u.banned })), btn('Löschen', async () => { if (confirm(`User ${u.username} samt Daten löschen?`)) await api('/admin/users/' + u.id, 'DELETE'); })]])),
    h('h2', {}, 'Admin: Ergebnisse'),
    table(['Datum', 'User', 'CPU', 'GPU', 'Single', 'Multi', 'GPU-Score', 'Status', ''], sc.map(s => [new Date(s.created_at).toLocaleString('de-DE'), s.username, s.cpu_model, s.gpu_model, fmt(s.cpu_single), fmt(s.cpu_multi), fmt(s.gpu_score), s.hidden ? 'ausgeblendet' : 'sichtbar',
      [btn(s.hidden ? 'Einblenden' : 'Ausblenden', () => api(`/admin/scores/${s.id}/hide`, 'POST', { hidden: !s.hidden })), btn('Löschen', () => api('/admin/scores/' + s.id, 'DELETE'))]])));
}
const routes = { bench: benchView, board: boardView, compare: compareView, profile: profileView, admin: adminView };
async function nav() {
  const k = routes[location.hash.slice(1)] ? location.hash.slice(1) : 'bench';
  document.getElementById('adm').hidden = !me?.admin;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.hash === '#' + k));
  try { view.replaceChildren(await routes[k]()); } catch (e) { view.replaceChildren(err(e)); }
}
addEventListener('hashchange', nav);
api('/me').then(r => { me = r.user; }).catch(() => {}).finally(nav);
