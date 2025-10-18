// Minimal admin console client
const $ = (id) => document.getElementById(id);

const adminBadge = $('adminBadge');
const loginBtn   = $('loginBtn');
const logoutBtn  = $('logoutBtn');
const checkBtn   = $('checkBtn');
const loginMsg   = $('loginMsg');

const vinEl      = $('vin');
const typeEl     = $('type');
const stateEl    = $('state');
const plateEl    = $('plate');
const openBtn    = $('openBtn');
const openCache  = $('openCacheBtn');
const fetchMsg   = $('fetchMsg');

function setBadge(on) {
  adminBadge.textContent = on ? 'Admin: ON' : 'Admin: OFF';
  adminBadge.className = 'badge ' + (on ? 'ok' : 'no');
}

async function checkAdmin() {
  try {
    const r = await fetch('/api/admin/me', { credentials: 'include' });
    const j = await r.json();
    setBadge(Boolean(j.admin));
    return Boolean(j.admin);
  } catch {
    setBadge(false);
    return false;
  }
}

async function login() {
  loginMsg.textContent = '';
  const password = ($('pwd').value || '').trim();
  if (!password) { loginMsg.innerHTML = '<span class="err">Enter a password.</span>'; return; }
  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // send/receive cookie
      body: JSON.stringify({ password })
    });
    if (!r.ok) {
      const t = await r.text();
      loginMsg.innerHTML = `<span class="err">Login failed:</span> ${t || r.status}`;
      setBadge(false);
      return;
    }
    loginMsg.innerHTML = '<span class="ok">Logged in as admin.</span>';
    await checkAdmin();
  } catch (e) {
    loginMsg.innerHTML = `<span class="err">${e.message || 'Login error'}</span>`;
    setBadge(false);
  }
}

async function logout() {
  try {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
  } catch {}
  setBadge(false);
  loginMsg.innerHTML = 'Signed out.';
}

function validVIN(v) { return /^[A-HJ-NPR-Z0-9]{17}$/i.test(v || ''); }

async function openReport({ allowLive = true } = {}) {
  fetchMsg.textContent = '';

  const vin   = (vinEl.value || '').trim().toUpperCase();
  const state = (stateEl.value || '').trim().toUpperCase();
  const plate = (plateEl.value || '').trim().toUpperCase();
  const type  = (typeEl.value || 'carfax').toLowerCase();

  if (!vin && !(state && plate)) {
    fetchMsg.innerHTML = '<span class="err">Provide VIN or State + Plate.</span>';
    return;
  }
  if (vin && !validVIN(vin)) {
    fetchMsg.innerHTML = '<span class="err">VIN must be 17 chars (no I/O/Q).</span>';
    return;
  }

  try {
    const r = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // include admin cookie
      body: JSON.stringify({
        vin, state, plate,
        type,
        as: 'html',
        allowLive
      })
    });

    if (!r.ok) {
      const t = await r.text();
      fetchMsg.innerHTML = `<span class="err">Error:</span> ${t || ('HTTP ' + r.status)}`;
      return;
    }

    const html = await r.text();
    const w = window.open('', '_blank', 'noopener,noreferrer');
    if (w) { w.document.write(html); w.document.close(); }
    else { document.open(); document.write(html); document.close(); }
    fetchMsg.innerHTML = '<span class="ok">Opened report.</span>';
  } catch (e) {
    fetchMsg.innerHTML = `<span class="err">${e.message || 'Request failed'}</span>`;
  }
}

loginBtn.addEventListener('click', login);
logoutBtn.addEventListener('click', logout);
checkBtn.addEventListener('click', checkAdmin);
openBtn.addEventListener('click', () => openReport({ allowLive: true }));
openCache.addEventListener('click', () => openReport({ allowLive: false }));

// boot
checkAdmin();
