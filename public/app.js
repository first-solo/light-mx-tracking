'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { oil: [], ad: [], vor: [] };
  let ac = { engines: 1, logs: ['oil'] };
  const pendingDelete = { oil: null, ad: null, vor: null };

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return localDate(d); };
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
  const fmtDate = (s) => { if (!s) return '—'; const [y, m, d] = s.split('-'); return `${m}/${d}/${y.slice(2)}`; };
  const longDate = (s) => parseDate(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fmtQ = (n) => (n == null ? '—' : String(Math.round(n * 100) / 100));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== '/api/login') { showLock(); throw new Error('Enter the PIN to continue.'); }
    if (!res.ok) throw new Error((data && data.error) || 'Couldn’t reach the server. Check your connection and try again.');
    return data;
  }

  // remember the last name used, per device
  function loadWho() { try { return localStorage.getItem('who') || ''; } catch { return ''; } }
  function saveWho(v) { try { localStorage.setItem('who', v); } catch {} }

  // ---------- lock / unlock ----------
  function showLock() {
    $('app').hidden = true;
    $('lock').hidden = false;
    $('pin').value = '';
    setTimeout(() => $('pin').focus(), 50);
  }

  async function showApp(me) {
    ac = me;
    configure();
    $('tail').textContent = me.tail;
    $('model').textContent = me.model || '';
    document.title = `${me.tail} Logs`;
    $('lock').hidden = true;
    $('app').hidden = false;
    document.querySelectorAll('.who').forEach((i) => { if (!i.value) i.value = loadWho(); });
    resetDates();
    route();
    await Promise.all(ac.logs.map(load));
  }

  $('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pinMsg').textContent = '';
    $('pinBtn').disabled = true;
    try {
      const me = await api('/api/login', { method: 'POST', body: { pin: $('pin').value } });
      await showApp(me);
    } catch (err) {
      $('pinMsg').textContent = err.message;
      $('pin').select();
    } finally { $('pinBtn').disabled = false; }
  });

  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    showLock();
  });

  // Shape the page to the signed-in aircraft: which logs it uses, one engine or two.
  function configure() {
    const twin = ac.engines === 2;
    document.querySelectorAll('.tabs a').forEach((a) => { a.hidden = !ac.logs.includes(a.dataset.tab); });
    document.querySelector('.tabs').hidden = ac.logs.length < 2;
    $('oil-e2').hidden = !twin;
    $('oil-e2').disabled = !twin;
    $('oil-e1').classList.toggle('solo', !twin);
    $('oil-e1-name').textContent = twin ? 'Left engine' : 'Engine';
    $('oil-engines').classList.toggle('single', !twin);
    $('oil-sum-2').hidden = !twin;
    $('oil-sum-1').classList.toggle('solo', !twin);
    $('oil-cards').classList.toggle('single', !twin);
    $('oil-head').closest('table').classList.toggle('narrow', !twin);
    $('oil-head').innerHTML = twin
      ? `<tr class="grp"><th colspan="2"></th><th colspan="2" class="l sep">Left</th><th colspan="2" class="r sep">Right</th><th colspan="3" class="sep"></th></tr>
         <tr><th>Date</th><th class="num">Tach</th><th class="num sep">Reading</th><th class="num">Added</th><th class="num sep">Reading</th><th class="num">Added</th><th class="sep">Added by</th><th>Remarks</th><th></th></tr>`
      : `<tr><th>Date</th><th class="num">Tach</th><th class="num sep">Reading</th><th class="num">Added</th><th class="sep">Added by</th><th>Remarks</th><th></th></tr>`;
  }

  // ---------- tabs ----------
  function route() {
    const want = location.hash.slice(1);
    const tab = ac.logs.includes(want) ? want : 'oil';
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + tab; });
    document.querySelectorAll('.tabs a').forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', route);

  function resetDates() {
    ['oil-date', 'ad-date', 'vor-date'].forEach((id) => { $(id).value = localDate(); });
    $('ad-time').value = localTime();
  }

  // ---------- loading ----------
  async function load(log) {
    try { state[log] = await api('/api/' + log); }
    catch (e) { state[log] = state[log] || []; }
    render[log]();
  }

  // ---------- forms ----------
  function bindForm(formId, log, after) {
    const form = $(formId);
    const msg = form.querySelector('.msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg'; msg.textContent = '';
      const body = Object.fromEntries(new FormData(form).entries());
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('/api/' + log, { method: 'POST', body });
        if (body.performed_by) saveWho(body.performed_by);
        form.querySelectorAll('input[type=number], input[name=note]').forEach((i) => { i.value = ''; });
        if (after) after(form);
        resetDates();
        msg.textContent = 'Saved.';
        await load(log);
      } catch (err) {
        msg.className = 'msg err'; msg.textContent = err.message;
      } finally { btn.disabled = false; }
    });
  }
  bindForm('oilForm', 'oil');
  bindForm('adForm', 'ad', (f) => {
    f.querySelector('input[name=left_result][value=clear]').checked = true;
    f.querySelector('input[name=right_result][value=clear]').checked = true;
    f.querySelectorAll('input[name=exposed]').forEach((r) => { r.checked = false; });
    adStep();
  });

  // AD sign-off: the exposure answer decides whether valve results are needed
  // and what the signer is attesting to.
  function adStep() {
    const f = $('adForm');
    const exp = f.querySelector('input[name=exposed]:checked');
    const forFirst = f.querySelector('input[name=trigger]:checked').value === 'first_flight';
    const when = forFirst ? 'before the first flight of the day' : 'after refueling';
    $('ad-results').hidden = !exp || exp.value !== 'yes';
    $('ad-sign').hidden = !exp;
    if (!exp) return;
    const did = exp.value === 'yes';
    $('ad-sign-n').textContent = did ? '4' : '3';
    $('ad-attest').textContent = did
      ? `I performed the fuel selector valve water check per AD 79-12-08 ${when}, with the results recorded above.`
      : `The airplane has not been exposed to below-freezing temperatures, so the AD 79-12-08 check is not required ${when}.`;
    $('ad-submit').textContent = did ? 'Sign off: check performed' : 'Sign off: not required';
  }
  $('adForm').addEventListener('change', (e) => { if (['exposed', 'trigger'].includes(e.target.name)) adStep(); });
  bindForm('vorForm', 'vor', (f) => { f.querySelector('#vor-place').value = ''; });

  // VOR labels change for a dual-system check
  document.querySelectorAll('input[name=method]').forEach((r) => r.addEventListener('change', () => {
    const dual = document.querySelector('input[name=method]:checked').value === 'dual';
    $('vor-1-lbl').textContent = dual ? 'VOR 1 bearing (°)' : 'VOR 1 error (°)';
    $('vor-2-lbl').textContent = dual ? 'VOR 2 bearing (°)' : 'VOR 2 error (°)';
  }));

  // delete with an inline confirm
  function deleteCell(log, id) {
    if (pendingDelete[log] === id) {
      return `<button class="danger" data-log="${log}" data-confirm="${id}">Delete</button> <button class="ghost" data-log="${log}" data-cancel>Keep</button>`;
    }
    return `<button class="ghost" data-log="${log}" data-del="${id}">Remove</button>`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-log]'); if (!b) return;
    const log = b.dataset.log;
    if (b.dataset.del) { pendingDelete[log] = Number(b.dataset.del); render[log](); return; }
    if (b.hasAttribute('data-cancel')) { pendingDelete[log] = null; render[log](); return; }
    if (b.dataset.confirm) {
      pendingDelete[log] = null;
      try { await api(`/api/${log}/${b.dataset.confirm}`, { method: 'DELETE' }); } catch {}
      await load(log);
    }
  });

  const empty = (cols, title, text) => `<tr><td colspan="${cols}" class="empty"><strong>${title}</strong>${text}</td></tr>`;

  // ---------- OIL ----------
  function oilSummary(n) {
    const rk = `e${n}_reading`, ak = `e${n}_added`;
    const list = state.oil; // newest first
    const last = list.find((e) => e[ak] != null || e[rk] != null);
    const total = list.reduce((s, e) => s + (e[ak] || 0), 0);
    // Hours per quart over the logged span. Oil added at the earliest entry
    // replaced oil burned before the span started, so it's left out.
    const withTach = list.filter((e) => e.tach != null && (e[ak] != null || e[rk] != null)).sort((a, b) => a.tach - b.tach);
    let rate = null, span = 0;
    if (withTach.length >= 2) {
      span = withTach[withTach.length - 1].tach - withTach[0].tach;
      const added = withTach.slice(1).reduce((s, e) => s + (e[ak] || 0), 0);
      if (span > 0 && added > 0) rate = span / added;
    }
    return { last, total, rate, span, rk, ak };
  }

  function oilCard(n, label) {
    const s = oilSummary(n);
    const by = s.last && s.last.performed_by ? ' · ' + esc(s.last.performed_by) : '';
    return `
      <h3>${label}</h3>
      <div class="stats">
        <div class="stat"><div class="k">Last reading</div><div class="v">${s.last ? fmtQ(s.last[s.rk]) : '—'}<small> qt</small></div></div>
        <div class="stat"><div class="k">Last added</div><div class="v">${s.last ? fmtQ(s.last[s.ak]) : '—'}<small> qt</small></div></div>
        <div class="stat"><div class="k">Hrs / qt</div><div class="v">${s.rate ? s.rate.toFixed(1) : '—'}</div></div>
      </div>
      <p class="foot">${s.last ? `Last serviced ${fmtDate(s.last.date)}${by}` : 'No entries yet'} · ${fmtQ(s.total)} qt added in all${s.span ? ` · rate over ${s.span.toFixed(1)} tach hrs` : ''}</p>`;
  }

  const render = {};
  render.oil = () => {
    const twin = ac.engines === 2;
    $('oil-sum-1').innerHTML = oilCard(1, twin ? 'Left engine' : 'Engine');
    if (twin) $('oil-sum-2').innerHTML = oilCard(2, 'Right engine');
    const rows = state.oil;
    $('oil-rows').innerHTML = rows.length ? rows.map((e) => `
      <tr>
        <td>${fmtDate(e.date)}</td>
        <td class="num">${e.tach != null ? e.tach.toFixed(1) : '—'}</td>
        <td class="num sep">${fmtQ(e.e1_reading)}</td><td class="num">${fmtQ(e.e1_added)}</td>
        ${twin ? `<td class="num sep">${fmtQ(e.e2_reading)}</td><td class="num">${fmtQ(e.e2_added)}</td>` : ''}
        <td class="sep">${esc(e.performed_by)}</td>
        <td class="note">${esc(e.note)}</td>
        <td>${deleteCell('oil', e.id)}</td>
      </tr>`).join('')
      : empty(twin ? 9 : 7, 'No oil entries yet', 'Log the first servicing above: the dipstick reading before adding, the quarts added, and who did it.');
  };

  // ---------- AD 79-12-08 ----------
  const trig = { first_flight: 'First flight', after_refuel: 'After refuel' };
  const res = (v) => (v === 'water_drained' ? '<span class="pill bad">Water drained</span>' : '<span class="pill ok">No water</span>');

  render.ad = () => {
    const today = localDate();
    const todays = state.ad.filter((c) => c.date === today);
    const first = todays.filter((c) => c.trigger === 'first_flight').sort((a, b) => (a.time || '').localeCompare(b.time || ''))[0];
    const refuels = todays.filter((c) => c.trigger === 'after_refuel');
    const water = todays.some((c) => c.left_result === 'water_drained' || c.right_result === 'water_drained');
    const last = state.ad[0];
    const el = $('ad-status');
    const extra = refuels.length ? ` · ${refuels.length} after-refuel sign-off${refuels.length > 1 ? 's' : ''} today` : '';
    const who = (c) => `${c.time ? c.time + ' · ' : ''}${esc(c.performed_by)}`;
    if (!first) {
      el.className = 'card status bad';
      el.innerHTML = `<p class="headline">No first-flight sign-off today</p>
        <p class="muted">Before the first flight, either do the check or sign off that the airplane hasn’t been exposed to below-freezing temperatures.${last ? ` Last sign-off ${fmtDate(last.date)} by ${esc(last.performed_by)}.` : ''}</p>`;
    } else if (first.exposed) {
      el.className = 'card status ' + (water ? 'warn' : 'ok');
      el.innerHTML = `<p class="headline">Today’s first-flight check is done</p>
        <p>${who(first)}${extra}</p>
        ${water ? '<p><strong>Water was found and drained today.</strong> Check the remarks.</p>' : ''}`;
    } else {
      el.className = 'card status ' + (water ? 'warn' : 'ok');
      el.innerHTML = `<p class="headline">Signed off today: no freezing exposure</p>
        <p>Check not required before the first flight · ${who(first)}${extra}</p>
        ${water ? '<p><strong>Water was found and drained on a later check today.</strong> Check the remarks.</p>' : ''}`;
    }

    $('ad-rows').innerHTML = state.ad.length ? state.ad.map((c) => `
      <tr>
        <td>${fmtDate(c.date)}</td>
        <td class="num">${esc(c.time) || '—'}</td>
        <td>${trig[c.trigger]}</td>
        ${c.exposed
          ? `<td class="sep">Yes</td><td>${res(c.left_result)}</td><td>${res(c.right_result)}</td>`
          : `<td class="sep">No</td><td colspan="2" class="na">Not required</td>`}
        <td class="sep">${esc(c.performed_by)}</td>
        <td class="note">${esc(c.note)}</td>
        <td>${deleteCell('ad', c.id)}</td>
      </tr>`).join('')
      : empty(9, 'No sign-offs yet', 'Sign off above before the first flight of each day and after each refueling.');
  };

  // ---------- VOR ----------
  const methodName = { vot: 'VOT', ground: 'Ground checkpoint', airborne: 'Airborne checkpoint', dual: 'Dual system' };
  const limit = { vot: 4, ground: 4, airborne: 6, dual: 4 };

  function vorPass(c) {
    if (c.method === 'dual') {
      if (c.vor1 == null || c.vor2 == null) return false;
      let d = Math.abs(c.vor1 - c.vor2) % 360; if (d > 180) d = 360 - d;
      return d <= limit.dual;
    }
    return [c.vor1, c.vor2].filter((v) => v != null).every((v) => Math.abs(v) <= limit[c.method]);
  }
  const deg = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}°`);

  render.vor = () => {
    const today = localDate();
    const passing = state.vor.find(vorPass);
    const el = $('vor-status');
    if (!passing) {
      el.className = 'card status bad';
      el.innerHTML = `<p class="headline">No passing VOR check on file</p><p class="muted">Not legal for IFR until a check within tolerance is logged.</p>`;
    } else {
      const due = addDays(passing.date, 30);
      const left = daysBetween(today, due);
      el.className = 'card status ' + (left < 0 ? 'bad' : left <= 5 ? 'warn' : 'ok');
      el.innerHTML = left < 0
        ? `<p class="headline">VOR check overdue</p><p>Last passing check ${longDate(passing.date)} (${methodName[passing.method]}). Expired ${longDate(due)}.</p>`
        : `<p class="headline">IFR-legal through ${longDate(due)}</p>
           <p>${left === 0 ? 'Last day' : `${left} day${left === 1 ? '' : 's'} left`} · last check ${fmtDate(passing.date)}, ${methodName[passing.method]}, ${esc(passing.performed_by)}</p>`;
    }

    $('vor-rows').innerHTML = state.vor.length ? state.vor.map((c) => {
      const ok = vorPass(c);
      const vals = c.method === 'dual' ? [c.vor1 == null ? '—' : c.vor1 + '°', c.vor2 == null ? '—' : c.vor2 + '°'] : [deg(c.vor1), deg(c.vor2)];
      return `
      <tr>
        <td>${fmtDate(c.date)}</td>
        <td>${methodName[c.method]}</td>
        <td>${esc(c.place)}</td>
        <td class="num sep">${vals[0]}</td><td class="num">${vals[1]}</td>
        <td>${ok ? '<span class="pill ok">Within ±' + limit[c.method] + '°</span>' : '<span class="pill bad">Out of tolerance</span>'}</td>
        <td class="sep">${esc(c.performed_by)}</td>
        <td class="note">${esc(c.note)}</td>
        <td>${deleteCell('vor', c.id)}</td>
      </tr>`;
    }).join('')
      : empty(9, 'No VOR checks yet', 'Log a check above. The 30-day clock starts from the most recent check within tolerance.');
  };

  // ---------- start ----------
  (async () => {
    try { await showApp(await api('/api/me')); }
    catch { showLock(); }
  })();
})();
