// /public/admin.js
console.info('admin.js version: 2025-10-18-2');

/* ------------------------------
   Tiny helpers
------------------------------ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jfetch(url, opts = {}) {
  const headers = opts.headers || {};
  // Only set JSON header if there's a body (e.g., POST login)
  const final = {
    credentials: 'include',
    ...(opts.body ? { headers: { 'Content-Type': 'application/json', ...headers } } : { headers }),
    ...opts
  };
  const res = await fetch(url, final);
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      if (ct.includes('application/json')) {
        const j = await res.json();
        if (j?.error) msg = j.error;
      } else {
        const t = await res.text();
        if (t) msg = t;
      }
    } catch {}
    throw new Error(msg);
  }
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const k = 1024, u = ['B','KB','MB','GB'];
  let i = 0; while (n >= k && i < u.length - 1) { n /= k; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function formatTs(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function toast(msg, type = 'ok') {
  const bar = $('#toast');
  if (!bar) return alert(msg);
  bar.textContent = msg;
  bar.dataset.type = type;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 2400);
}

/* ------------------------------
   Elements
------------------------------ */
const loginView   = $('#loginView');
const appView     = $('#appView');
const loginForm   = $('#adminLoginForm');
const loginPwd    = $('#adminPassword');
const loginMsg    = $('#adminMsg');
const logoutBtn   = $('#logoutBtn');

const tabCacheBtn   = $('#tabCache');
const tabHistoryBtn = $('#tabHistory');
const viewCache     = $('#viewCache');
const viewHistory   = $('#viewHistory');

const cacheBody       = $('#cacheBody');
const refreshCacheBtn = $('#refreshCache');

const fetchForm = $('#fetchForm');
const fetchVin  = $('#fetchVin');
const fetchType = $('#fetchType');
const fetchAs   = $('#fetchAs');
const fetchLive = $('#fetchLive');

const historyBody     = $('#historyBody');
const refreshHistBtn  = $('#refreshHistory');

/* ------------------------------
   Auth
------------------------------ */
async function whoami() {
  try {
    const me = await jfetch('/api/admin/whoami');
    return me?.admin === true;
  } catch { return false; }
}

async function ensureAuthUI() {
  const authed = await whoami();
  if (authed) {
    hide(loginView);
    show(appView);
    await Promise.all([loadCache(), loadHistory()]);
  } else {
    show(loginView);
    hide(appView);
  }
}

loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginMsg.textContent = '';
  try {
    const pwd = (loginPwd.value || '').trim();
    if (!pwd) throw new Error('Enter admin password');
    await jfetch('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: pwd }) });
    loginPwd.value = '';
    await ensureAuthUI();
  } catch (err) {
    loginMsg.textContent = err.message || 'Login failed';
  }
});

logoutBtn?.addEventListener('click', async () => {
  try { await jfetch('/api/admin/logout', { method: 'POST' }); } catch {}
  await ensureAuthUI();
});

/* ------------------------------
   Tabs
------------------------------ */
function makeActive(btn) {
  [tabCacheBtn, tabHistoryBtn].forEach(b => b?.classList.remove('active'));
  btn?.classList.add('active');
}
tabCacheBtn?.addEventListener('click', () => {
  makeActive(tabCacheBtn);
  show(viewCache); hide(viewHistory);
});
tabHistoryBtn?.addEventListener('click', () => {
  makeActive(tabHistoryBtn);
  show(viewHistory); hide(viewCache);
});

/* ------------------------------
   Cache listing
------------------------------ */
async function loadCache() {
  try {
    const data = await jfetch('/api/admin/cache');
    renderCache(data?.items || []);
  } catch (e) {
    cacheBody.innerHTML = `<tr><td colspan="6" class="muted">Failed to load cache: ${e.message}</td></tr>`;
  }
}

function renderCache(items) {
  if (!items.length) {
    cacheBody.innerHTML = `<tr><td colspan="6" class="muted">No cached reports yet.</td></tr>`;
    return;
  }
  cacheBody.innerHTML = '';
  items.sort((a,b) => (b.mtime||'').localeCompare(a.mtime||''));
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${it.vin}</code></td>
      <td>${it.type}</td>
      <td>${formatTs(it.mtime)}</td>
      <td>${formatBytes(it.size)}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="open-html" data-vin="${it.vin}" data-type="${it.type}">Open HTML</button>
        <button class="btn btn-sm" data-act="open-pdf"  data-vin="${it.vin}" data-type="${it.type}">Open PDF</button>
      </td>
      <td class="actions">
        <button class="btn btn-sm outline" data-act="dl-html" data-vin="${it.vin}" data-type="${it.type}">Download HTML</button>
        <button class="btn btn-sm outline" data-act="dl-pdf"  data-vin="${it.vin}" data-type="${it.type}">Download PDF</button>
      </td>
    `;
    cacheBody.appendChild(tr);
  }
}

// Attach ONE delegated click handler so we don’t stack listeners on refresh
cacheBody.onclick = onCacheAction;

async function onCacheAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act  = btn.dataset.act;
  const vin  = btn.dataset.vin;
  const type = btn.dataset.type || 'carfax';
  const as = act.endsWith('pdf') ? 'pdf' : 'html';
  const download = act.startsWith('dl-');

  try {
    await adminOpen(vin, type, as, /*fetch*/0, /*download*/ download);
  } catch (err) {
    toast(err.message || 'Failed', 'err');
  }
}

refreshCacheBtn?.addEventListener('click', loadCache);




/* ------------------------------
   Open/Download via admin endpoint
   GET /api/admin/open?vin=&type=&as=html|pdf&fetch=0|1
------------------------------ */
async function adminOpen(vin, type, as = 'html', fetchLive = 0, download = false) {
  const params = new URLSearchParams({ vin: vin.toUpperCase(), type, as });
  if (fetchLive) params.set('fetch', '1');

  const url = `/api/admin/open?${params.toString()}`;

  // Use navigation for PDFs (lets browser handle Content-Disposition)
  if (as === 'pdf' && !download) {
    window.open(url, '_blank', 'noopener');
    return;
  }

  // Otherwise fetch and control (for HTML open/saving or forced PDF download)
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const t = await res.text(); if (t) msg = t; } catch {}
    throw new Error(msg);
  }

  if (as === 'html') {
    const html = await res.text();
    if (download) {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${vin}-${type}.html`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
    } else {
      const w = window.open('', '_blank', 'noopener');
      if (w) { w.document.write(html); w.document.close(); }
      else { document.open(); document.write(html); document.close(); }
    }
  } else {
    // PDF download path
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${vin}-${type}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  }
}

/* ------------------------------
   Fetch live (no cost) form
------------------------------ */
fetchForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const vin  = (fetchVin.value || '').trim().toUpperCase();
  const type = (fetchType.value || 'carfax').toLowerCase();
  const as   = (fetchAs.value || 'html').toLowerCase();
  const doFetch = fetchLive.checked ? 1 : 0;

  if (!vin || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    toast('Enter a valid 17-character VIN (no I/O/Q)', 'err');
    return;
  }

  try {
    await adminOpen(vin, type, as, doFetch, /*download*/ false);
    toast(doFetch ? 'Fetched + opened' : 'Opened from cache', 'ok');
    await sleep(400);
    await loadCache();
  } catch (err) {
    toast(err.message || 'Failed to open', 'err');
  }
});

/* ------------------------------
   History
------------------------------ */
async function loadHistory() {
  try {
    const data = await jfetch('/api/admin/history');
    renderHistory(data?.rows || []);
  } catch (e) {
    historyBody.innerHTML = `<tr><td colspan="6" class="muted">Failed to load history: ${e.message}</td></tr>`;
  }
}

function renderHistory(rows) {
  if (!rows.length) {
    historyBody.innerHTML = `<tr><td colspan="6" class="muted">No history yet.</td></tr>`;
    return;
  }
  historyBody.innerHTML = '';
  for (const r of rows) {
    const email = r.email || r.user_email || r.user || r.user_id || '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatTs(r.created_at)}</td>
      <td>${email ? `<span class="muted">${email}</span>` : ''}</td>
      <td><code>${r.vin}</code></td>
      <td>${r.success ? '✅' : '❌'}</td>
      <td>${r.result_url ? `<a href="${r.result_url}" target="_blank" rel="noopener">link</a>` : ''}</td>
      <td class="actions">
        <button class="btn btn-sm outline" data-act="open-history" data-vin="${r.vin}" data-type="${(r.type||'carfax')}">Open</button>
      </td>
    `;
    historyBody.appendChild(tr);
  }
}

// Single delegated listener (no stacking)
historyBody.onclick = async (e) => {
  const b = e.target.closest('button[data-act="open-history"]');
  if (!b) return;
  const vin  = b.dataset.vin;
  const type = b.dataset.type || 'carfax';
  try {
    await adminOpen(vin, type, 'html', 0, false);
  } catch (err) {
    toast(err.message || 'Open failed', 'err');
  }
};

refreshHistBtn?.addEventListener('click', loadHistory);

/* ------------------------------
   Boot
------------------------------ */
(async () => {
  await ensureAuthUI();
  makeActive(tabCacheBtn);
  show(viewCache); hide(viewHistory);
})();
