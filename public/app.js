// app.js
console.info('app.js version: 2025-11-01-vin-validate');

/* ================================
   Config & Utilities
================================ */
const API = {
  report: '/api/report',
  checkout: '/api/create-checkout-session',
  credits: (uid) => `/api/credits/${uid}`,
  share: '/api/share',
  // NOTE: Server doesn't expose a "validate VIN" endpoint without cost.
  // We enforce ISO-3779 VIN check digit locally to block bad VINs up front.
};

const PENDING_KEY = 'pendingReport';
function $id(id) { return document.getElementById(id); }

function showToast(message, type = 'error') {
  const box = $id('toastBox');
  if (!box) { alert(message); return; }
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : 'ok'} animate-fadeIn`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .5s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 500);
  }, 4000);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function openBlank() {
  try { return window.open('', '_blank', 'noopener,noreferrer'); }
  catch { return null; }
}

function setUseCreditVisible(show) {
  const el = $id('useCreditBtn');
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

/* ================================
   VIN Validation (ISO 3779)
   - Blocks I, O, Q
   - Enforces length 17
   - Validates check digit (position 9)
================================ */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/; // excludes I,O,Q
const VIN_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const VIN_MAP = Object.freeze({
  A:1, B:2, C:3, D:4, E:5, F:6, G:7, H:8,
  J:1, K:2, L:3, M:4, N:5, P:7, R:9,
  S:2, T:3, U:4, V:5, W:6, X:7, Y:8, Z:9,
  '0':0, '1':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9
});
function looksVinBasic(v) { return VIN_RE.test((v||'').toUpperCase()); }
function vinCheckDigitOk(vinRaw) {
  const vin = (vinRaw || '').toUpperCase();
  if (!looksVinBasic(vin)) return false;

  let sum = 0;
  for (let i=0;i<17;i++){
    const ch = vin[i];
    const val = VIN_MAP[ch];
    const w = VIN_WEIGHTS[i];
    if (val === undefined) return false;
    sum += val * w;
  }
  const remainder = sum % 11;
  const expected = (remainder === 10) ? 'X' : String(remainder);
  const actual = vin[8]; // position 9 (0-index 8)
  return actual === expected;
}
function looksVin(v) {
  const vin = (v||'').toUpperCase().trim();
  if (!looksVinBasic(vin)) return false;
  return vinCheckDigitOk(vin);
}

/* Inline VIN validation UI helpers */
function ensureVinHelpEl() {
  let help = $id('vinHelp');
  if (!help) {
    const vinInput = document.querySelector('input[name="vin"]');
    if (!vinInput) return null;
    help = document.createElement('div');
    help.id = 'vinHelp';
    help.className = 'text-xs mt-1';
    help.style.color = 'var(--muted)';
    vinInput.insertAdjacentElement('afterend', help);
  }
  return help;
}
function setVinHelp(text, ok=false) {
  const el = ensureVinHelpEl();
  if (!el) return;
  el.textContent = text || '';
  el.style.color = ok ? 'var(--brand)' : 'var(--muted)';
}

/* ================================
   Primary CTA switcher: 'view' | 'buy'
================================ */
function setPrimaryCTA(mode = 'view') {
  const btn = $id('go');
  if (!btn) return;

  if (mode === 'buy') {
    btn.type = 'button';
    btn.innerHTML = `
      <svg class="w-5 h-5 opacity-90" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M3 3h2l.4 2M7 13h10l3-8H6.4M7 13L5.4 5M7 13l-2 7m12-7l2 7M10 21a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z"/>
      </svg>
      Buy Credits
    `;
    btn.onclick = async () => {
      const { user } = await getSession();
      if (!user) { openLogin(); return; }
      openBuyModal();
    };
  } else {
    btn.type = 'submit';
    btn.innerHTML = `
      <svg class="w-5 h-5 opacity-90" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m6-6H6" />
      </svg>
      View Report
    `;
    btn.onclick = null;
  }
}

/* ================================
   Supabase init
================================ */
const SB_URL = window.VITE_SUPABASE_URL || (typeof process !== 'undefined' ? process?.env?.VITE_SUPABASE_URL : '') || '';
const SB_ANON = window.VITE_SUPABASE_ANON_KEY || (typeof process !== 'undefined' ? process?.env?.VITE_SUPABASE_ANON_KEY : '') || '';
let supabase = null;
if (window.supabase && SB_URL && SB_ANON) {
  supabase = window.supabase.createClient(SB_URL, SB_ANON);
}

/* ================================
   Backend warmup overlay + ping
================================ */
const bootOverlay = $id('bootOverlay');
let backendReadyOnce = false;
function showBootOverlay() { bootOverlay?.classList.remove('hidden'); }
function hideBootOverlay() { bootOverlay?.classList.add('hidden'); }
async function pingBackendOnce(timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/healthz', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { clearTimeout(t); return false; }
}
async function ensureBackendReady({ timeoutMs = 2000, maxWaitMs = 60000 } = {}) {
  if (backendReadyOnce) return true;
  let ok = await pingBackendOnce(timeoutMs);
  if (ok) { backendReadyOnce = true; return true; }
  showBootOverlay();
  const start = Date.now(); let delay = 700;
  while (Date.now() - start < maxWaitMs) {
    ok = await pingBackendOnce(timeoutMs);
    if (ok) { backendReadyOnce = true; hideBootOverlay(); return true; }
    await new Promise(res => setTimeout(res, delay));
    delay = Math.min(Math.round(delay * 1.7), 4000);
  }
  hideBootOverlay(); return false;
}
ensureBackendReady({ timeoutMs: 800, maxWaitMs: 3000 });

/* ================================
   Stripe/PayPal success handling
================================ */
function onSuccessPage() { return location.pathname.endsWith('/success.html'); }
function params() { return new URLSearchParams(location.search); }
const p = params();
const stripeSessionId = p.get('session_id') || null;
const ppSuccess = p.get('pp') === 'success';
const intentParam = p.get('intent') || null;
const vinParam = (p.get('vin') || '').toUpperCase();
const oneParam = p.get('one') || null;
const stateParam = p.get('state') || '';
const plateParam = p.get('plate') || '';
const typeParam = p.get('type') || '';

function tryLoadPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } }
function clearPending() { localStorage.removeItem(PENDING_KEY); }

async function resumePendingPurchase() {
  const pending = tryLoadPending();
  if (!pending) return;
  await ensureBackendReady();

  const headers = { 'Content-Type': 'application/json' };
  const { token, user } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!user && stripeSessionId) pending.oneTimeSession = stripeSessionId;

  try {
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(pending) });
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else { document.open(); document.write(html); document.close(); }

    try {
      fbq('track', 'Purchase', {
        value: 7.00, currency: 'USD',
        contents: [{ id: 'VinReport', quantity: 1 }],
        content_ids: ['VinReport'], content_type: 'product'
      });
    } catch {}

    showToast('Report ready!', 'ok');

    addToHistory({
      vin: pending.vin || '(from plate)', type: pending.type || 'carfax', ts: Date.now(),
      state: pending.state || '', plate: pending.plate || ''
    });
    renderHistory();

    try {
      const resp = await fetch(API.share, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: pending.vin || pending.plate, type: pending.type || 'carfax' })
      });
      if (resp.ok) {
        const { url } = await resp.json();
        await navigator.clipboard.writeText(url);
        showToast('Share link copied to clipboard!', 'ok');
      }
    } catch {}
  } catch (e) {
    showToast(e.message || 'Failed to resume purchase', 'error');
  } finally {
    clearPending();
    await refreshBalancePill();
  }
}

async function handleSuccessIfNeeded() {
  const isSuccessContext = onSuccessPage() || stripeSessionId || ppSuccess;
  if (!isSuccessContext) return;

  if (intentParam === 'buy_report' && stripeSessionId && vinParam) {
    showToast('Payment confirmed. Preparing your report…', 'ok');
    try {
      const r = await fetch(API.report, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: vinParam, type: 'carfax', as: 'html', oneTimeSession: stripeSessionId })
      });
      if (!r.ok) throw new Error(await r.text());
      const html = await r.text();
      document.open(); document.write(html); document.close();
      try { fbq('track', 'Purchase', { value: 7.00, currency: 'USD', contents: [{ id: 'VinReport', quantity: 1 }], content_ids: ['VinReport'], content_type: 'product' }); } catch {}
      return;
    } catch (e) { showToast(e.message || 'Failed to fetch report', 'error'); }
  }

  if (ppSuccess && oneParam && (vinParam || (stateParam && plateParam))) {
    showToast('Payment confirmed. Preparing your report…', 'ok');
    try {
      const body = {
        vin: vinParam || '',
        state: stateParam || '',
        plate: plateParam || '',
        type: typeParam || 'carfax',
        as: 'html',
        oneTimeSession: oneParam
      };
      const r = await fetch(API.report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
      const html = await r.text();
      document.open(); document.write(html); document.close();
      try { fbq('track', 'Purchase', { value: 7.00, currency: 'USD', contents: [{ id: 'VinReport', quantity: 1 }], content_ids: ['VinReport'], content_type: 'product' }); } catch {}
      return;
    } catch (e) { showToast(e.message || 'Failed to fetch report', 'error'); }
  }

  if (ppSuccess || stripeSessionId || onSuccessPage()) {
    const pending = tryLoadPending();
    if (pending) {
      showToast('Payment confirmed. Preparing your report…', 'ok');
      await resumePendingPurchase();
    }
  }

  await refreshBalancePill();

  if (onSuccessPage()) {
    setTimeout(() => { window.location.href = '/'; }, 1200);
  } else {
    const url = new URL(location.href);
    ['session_id','intent','vin','pp','one','state','plate','type'].forEach(k => url.searchParams.delete(k));
    history.replaceState({}, '', url.pathname + url.search);
  }
}
handleSuccessIfNeeded();

/* ================================
   Theme toggle
================================ */
const themeBtn = $id('themeBtn');
function setTheme(mode) {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  localStorage.setItem('theme', mode);
  const label = themeBtn?.querySelector('.label');
  const icon = themeBtn?.querySelector('.icon');
  if (label) label.textContent = mode === 'dark' ? 'Light' : 'Dark';
  if (icon) icon.textContent = mode === 'dark' ? '☀️' : '🌙';
}
themeBtn?.addEventListener('click', () => {
  const nowDark = !document.documentElement.classList.contains('dark');
  setTheme(nowDark ? 'dark' : 'light');
});
(() => {
  const dark = document.documentElement.classList.contains('dark');
  const label = themeBtn?.querySelector('.label');
  const icon = themeBtn?.querySelector('.icon');
  if (label) label.textContent = dark ? 'Light' : 'Dark';
  if (icon) icon.textContent = dark ? '☀️' : '🌙';
})();

/* ================================
   Auth modal (email + password)
   + Show/Hide password button
================================ */
const loginBtn = $id('loginBtn');
const loginModal = $id('loginModal');
const closeLoginModal = $id('closeLoginModal');
const emailEl = $id('loginEmail');
const pwEl = $id('loginPassword');
const doLoginBtn = $id('doLogin');
const doSignupBtn = $id('doSignup');
const userChip = $id('userChip');
const userEmailEl = $id('userEmail');
const logoutBtn = $id('logoutBtn');

function openLogin() { loginModal?.classList.remove('hidden'); }
function closeLogin() { loginModal?.classList.add('hidden'); }
closeLoginModal?.addEventListener('click', closeLogin);
logoutBtn?.addEventListener('click', doLogout);
loginBtn?.addEventListener('click', () => openLogin());

// Add a minimal "Show" button for password if not present
(function ensureShowPassword() {
  if (!pwEl) return;
  // If HTML doesn't include a toggle, inject one after the field
  if (!document.getElementById('pwToggle')) {
    const toggle = document.createElement('button');
    toggle.id = 'pwToggle';
    toggle.type = 'button';
    toggle.className = 'btn-outline text-xs mt-1';
    toggle.textContent = 'Show password';
    pwEl.insertAdjacentElement('afterend', toggle);
    toggle.addEventListener('click', () => {
      const isPwd = pwEl.type === 'password';
      pwEl.type = isPwd ? 'text' : 'password';
      toggle.textContent = isPwd ? 'Hide password' : 'Show password';
    });
  }
})();

(() => {
  const p = new URLSearchParams(window.location.search);
  if (p.get('openLogin') === '1') {
    history.replaceState({}, '', window.location.pathname);
    openLogin();
  }
})();

function setSignupDisabled(disabled) {
  if (!doSignupBtn) return;
  doSignupBtn.disabled = disabled;
  doSignupBtn.style.opacity = disabled ? '0.6' : '1';
  doSignupBtn.style.cursor = disabled ? 'not-allowed' : 'pointer';
}
function reflectSignupAvailability() {
  const email = (emailEl?.value || '').trim();
  const pw = pwEl?.value || '';
  setSignupDisabled(!(email && pw.length >= 6));
}
emailEl?.addEventListener('input', reflectSignupAvailability);
pwEl?.addEventListener('input', reflectSignupAvailability);
reflectSignupAvailability();

async function doSignup() {
  if (!supabase) return showToast('Supabase not loaded', 'error');
  const email = (emailEl.value || '').trim();
  const password = pwEl.value || '';
  if (!email) return showToast('Enter your email', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');

  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { emailRedirectTo: `${window.location.origin}/email-confirmed` }
    });

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        showToast('An account with this email already exists. Please sign in instead.', 'error');
        setSignupDisabled(true);
        return;
      }
      throw error;
    }

    if (!data.session) showToast('Check your email to confirm your account.', 'ok');
    else {
      showToast('Account created — you are signed in!', 'ok'); closeLogin();
      try { localStorage.setItem('fb_em', (email || '').trim().toLowerCase()); } catch {}
    }
    await refreshBalancePill();
  } catch (e) { showToast(e.message || 'Sign up failed', 'error'); }
}

async function doLogin() {
  if (!supabase) return showToast('Supabase not loaded', 'error');
  const email = (emailEl.value || '').trim();
  const password = pwEl.value || '';
  if (!email || !password) return showToast('Enter email and password', 'error');
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    showToast('Signed in!', 'ok'); closeLogin();
    await refreshBalancePill();
  } catch (e) { showToast(e.message || 'Sign in failed', 'error'); }
}

async function doLogout() {
  if (!supabase) return;
  await supabase.auth.signOut();
  showToast('Signed out', 'ok');
  await refreshBalancePill();
}

doSignupBtn?.addEventListener('click', doSignup);
doLoginBtn?.addEventListener('click', doLogin);

document.getElementById('googleLogin')?.addEventListener('click', async () => {
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
    if (error) showToast(error.message || 'Google sign-in failed');
  } catch (e) {
    showToast(e.message || 'Google sign-in failed');
  }
});

let currentSession = null;
function reflectAuthUI(session) {
  currentSession = session;
  if (session?.user) {
    if (userEmailEl) userEmailEl.textContent = session.user.email || '';
    userChip?.classList.remove('hidden');
    loginBtn?.classList.add('hidden');
    setUseCreditVisible(true);
  } else {
    userChip?.classList.add('hidden');
    loginBtn?.classList.remove('hidden');
    if (loginBtn) loginBtn.textContent = '🔑 Login';
    setUseCreditVisible(false);
  }
}

/* ================================
   Auth callback & listener
================================ */
(async () => {
  if (!supabase) return;

  const fromAuthLink = /[?&]code=/.test(location.search) || /access_token=/.test(location.hash);
  if (fromAuthLink) {
    const { error } = await supabase.auth.getSessionFromUrl({ storeSession: true });
    const url = new URL(location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    history.replaceState({}, '', url.pathname + url.search);
    if (error) showToast(error.message || 'Auth callback failed', 'error');
    else showToast('You’re signed in!', 'ok');
  }

  const { data } = await supabase.auth.getSession();
  reflectAuthUI(data.session);
  await refreshBalancePill();

  supabase.auth.onAuthStateChange((_event, session) => {
    reflectAuthUI(session);
    refreshBalancePill();
  });
})();

/* ================================
   Session helper + Balance
================================ */
async function getSession() {
  if (!supabase) return { session: null, user: null, token: null };
  const { data } = await supabase.auth.getSession();
  const session = data?.session || null;
  return { session, user: session?.user || null, token: session?.access_token || null };
}
async function fetchBalance() {
  try {
    const { user } = await getSession();
    if (!user) return { balance: 0 };
    const r = await fetch(API.credits(user.id));
    if (!r.ok) return { balance: 0 };
    return await r.json();
  } catch { return { balance: 0 }; }
}
async function refreshBalancePill() {
  const pill = $id('balancePill');
  const txt = $id('balanceText');
  const { user } = await getSession();

  if (!user) {
    pill?.classList.add('hidden');
    setPrimaryCTA('view');
    reflectAuthUI(null);
    setUseCreditVisible(false);
    return;
  }

  const { balance = 0 } = await fetchBalance();
  if (pill && txt) {
    txt.textContent = `${balance} credit${balance === 1 ? '' : 's'}`;
    pill.classList.remove('hidden');
  }

  if (balance <= 0) setPrimaryCTA('buy');
  else setPrimaryCTA('view');

  setUseCreditVisible(true);
}

/* ================================
   History (localStorage)
================================ */
const HISTORY_KEY = 'reportHistory';
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(list) { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); }
function addToHistory(item) { const list = loadHistory(); list.unshift(item); saveHistory(list.slice(0, 20)); }
function formatTime(ts) { return new Date(ts).toLocaleString(); }

async function openHistoryHTML(item) {
  const data = {
    vin: item.vin && item.vin !== '(from plate)' ? item.vin : '',
    state: item.state || '', plate: item.plate || '',
    type: item.type, as: 'html', allowLive: false
  };
  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    await ensureBackendReady();
    const viewer = openBlank();
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { const t = await r.text(); if (viewer) viewer.close(); showToast(t || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    if (viewer) { viewer.document.write(html); viewer.document.close(); }
    else { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } }
  } catch (e) { showToast(e.message || 'Request failed', 'error'); }
}
async function downloadHistoryPDF(item) {
  const data = {
    vin: item.vin && item.vin !== '(from plate)' ? item.vin : '',
    state: item.state || '', plate: item.plate || '',
    type: item.type, as: 'pdf', allowLive: false
  };
  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    await ensureBackendReady();
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }
    const blob = await r.blob();
    const nameBase = (data.vin || item.plate || 'report').replace(/\W+/g, '_');
    downloadBlob(blob, `${nameBase}_${item.type}.pdf`);
  } catch (e) { showToast(e.message || 'Request failed', 'error'); }
}

async function copyShareLink(vin, type) {
  try {
    const r = await fetch(API.share, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vin, type })
    });
    if (!r.ok) { const t = await r.text(); throw new Error(t || ('HTTP ' + r.status)); }
    const { url } = await r.json();
    await navigator.clipboard.writeText(url);
    showToast('Share link copied to clipboard!', 'ok');
  } catch (e) {
    showToast(e.message || 'Could not create share link', 'error');
  }
}

/* Email a report from history */
async function emailHistoryReport(item) {
  const to = prompt('Send report to which email address?');
  if (!to) return;

  const trimmed = to.trim();
  if (!trimmed || !trimmed.includes('@')) {
    showToast('Please enter a valid email address.', 'error');
    return;
  }

  try {
    const body = {
      to: trimmed,
      vin: item.vin && item.vin !== '(from plate)' ? item.vin : '',
      plate: item.plate || '',
      state: item.state || '',
      type: item.type || 'carfax'
    };

    const r = await fetch('/api/email-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || ('HTTP ' + r.status));
    }

    showToast('Email sent successfully ✅', 'ok');
  } catch (e) {
    showToast(e.message || 'Could not send email', 'error');
  }
}

function renderHistory() {
  const body = $id('historyBody');
  const list = loadHistory();
  if (!body) return;
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="5" class="px-4 py-3" style="color:var(--muted)">No reports yet.</td></tr>`;
    return;
  }
  list.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="px-4 py-3" style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace">${item.vin}</td>
      <td class="px-4 py-3">${item.type}</td>
      <td class="px-4 py-3">${formatTime(item.ts)}</td>
      <td class="px-4 py-3">
        <div class="flex flex-wrap gap-2">
          <button data-idx="${idx}" data-action="open" class="btn-outline" style="font-size:.8rem">Open HTML</button>
          <button data-idx="${idx}" data-action="pdf" class="btn-outline" style="font-size:.8rem">Download PDF</button>
          <button data-idx="${idx}" data-action="share" class="btn-outline" style="font-size:.8rem">Copy Link</button>
          <button data-idx="${idx}" data-action="email" class="btn-outline" style="font-size:.8rem">Email</button>
          <button data-idx="${idx}" data-action="del" class="btn-outline" style="font-size:.8rem;color:#dc2626;border-color:#fecaca">Delete</button>
        </div>
      </td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('button.btn-outline').forEach(btn => {
    const action = btn.getAttribute('data-action');
    btn.addEventListener('click', async (e) => {
      const i = +e.currentTarget.getAttribute('data-idx');
      const item = loadHistory()[i]; if (!item) return;
      if (action === 'open') openHistoryHTML(item);
      else if (action === 'pdf') downloadHistoryPDF(item);
      else if (action === 'share') copyShareLink(item.vin.replace('(from plate)', '').trim() || item.plate, item.type);
      else if (action === 'email') emailHistoryReport(item);
      else if (action === 'del') { const list = loadHistory(); list.splice(i, 1); saveHistory(list); renderHistory(); }
    });
  });
}
$id('clearHistory')?.addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

/* ================================
   Buy Credits modal (tiers) + PayPal
================================ */
const buyModal = $id('buyCreditsModal');
const buy1Btn = $id('buy1Btn');
const buy10Btn = $id('buy10Btn');
const closeBuyBtn = $id('closeModalBtn');
function openBuyModal() { buyModal?.classList.remove('hidden'); renderPaypalButton(); }
function closeBuyModal() { buyModal?.classList.add('hidden'); }
closeBuyBtn?.addEventListener('click', closeBuyModal);

async function createPaypalOrder(user) {
  const r = await fetch('/api/paypal/create-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: user?.id || null })
  });
  if (!r.ok) throw new Error(await r.text() || 'PayPal create failed');
  const { orderID } = await r.json();
  return orderID;
}
async function capturePaypalOrder(orderID, user) {
  const r = await fetch('/api/paypal/capture-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderID, user_id: user?.id || null })
  });
  if (!r.ok) throw new Error(await r.text() || 'PayPal capture failed');
  return r.json(); // { ok, captureId }
}

let paypalRendered = false;
async function renderPaypalButton() {
  if (paypalRendered) return;
  const container = document.getElementById('paypalContainer');
  if (!container) return;
  if (!window.paypal) { showToast('PayPal is unavailable right now.', 'error'); return; }
  paypalRendered = true;

  const { user } = await getSession();
  window.paypal.Buttons({
    createOrder: () => createPaypalOrder(user),
    onApprove: async (data) => {
      try {
        const result = await capturePaypalOrder(data.orderID, user);

        let pending = tryLoadPending();
        if (!pending || (!pending.vin && !(pending.state && pending.plate))) {
          pending = lastFormData || null;
        }
        if (!pending || (!pending.vin && !(pending.state && pending.plate))) {
          showToast('Payment completed, but we lost the VIN/Plate input. Please enter it again.', 'error');
          window.location.href = '/';
          return;
        }

        let one = '';
        if (!user && result?.captureId) {
          one = 'pp_' + result.captureId;
          pending.oneTimeSession = one;
        }

        localStorage.setItem(PENDING_KEY, JSON.stringify(pending));

        const url = new URL('/success.html', 'https://www.autovinreveal.com');
        url.searchParams.set('pp', 'success');
        if (one) url.searchParams.set('one', one);
        const vin = (pending.vin || '').toUpperCase();
        if (vin) url.searchParams.set('vin', vin);
        if (pending.state) url.searchParams.set('state', pending.state);
        if (pending.plate) url.searchParams.set('plate', pending.plate);
        url.searchParams.set('type', pending.type || 'carfax');

        window.location.href = url.toString();
      } catch (e) {
        showToast(e.message || 'PayPal capture failed', 'error');
      }
    },
    onError: (err) => {
      console.error(err);
      showToast('PayPal error', 'error');
    }
  }).render('#paypalContainer');
}

/* ================================
   Purchase flow (Stripe)
================================ */
async function startPurchase({ user, price_id, pendingReport = null }) {
  try {
    await ensureBackendReady();

    const body = { user_id: user?.id || null, price_id };
    if (pendingReport?.vin) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport));
      body.vin = pendingReport.vin;
      body.report_type = pendingReport.type || 'carfax';
    }

    const r = await fetch(API.checkout, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (r.status === 409) {
      const pr = pendingReport || tryLoadPending();
      if (!pr?.vin) { showToast('Report already available.', 'ok'); return; }
      const headers = { 'Content-Type': 'application/json' };
      const { token } = await getSession();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const viewer = openBlank();
      const data = { vin: pr.vin, state: pr.state || '', plate: pr.plate || '', type: pr.type || 'carfax', as: 'html', allowLive: false };
      const rr = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
      if (!rr.ok) { const t = await rr.text(); if (viewer) viewer.close(); throw new Error(t || 'Failed to open archived report'); }
      const html = await rr.text();
      if (viewer) { viewer.document.write(html); viewer.document.close(); }
      else { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } }
      showToast('Opened your previously purchased report from archive.', 'ok');
      return;
    }

    if (!r.ok) { const t = await r.text(); throw new Error(t || 'Stripe error'); }
    const { url } = await r.json();
    window.location.href = url;
  } catch (e) { showToast(e.message || 'Failed to start checkout', 'error'); }
}

let lastFormData = null;

buy1Btn?.addEventListener('click', async () => {
  const { user } = await getSession();
  closeBuyModal();
  startPurchase({ user, price_id: 'STRIPE_PRICE_SINGLE', pendingReport: lastFormData || null });
});
buy10Btn?.addEventListener('click', async () => {
  const { user } = await getSession();
  if (!user) {
    closeBuyModal();
    showToast('Please sign in to buy a 5-pack of credits.', 'error');
    openLogin();
    return;
  }
  closeBuyModal();
  startPurchase({ user, price_id: 'STRIPE_PRICE_10PACK', pendingReport: null });
});

/* ================================
   “Use 1 Credit & View”
================================ */
const useCreditBtn = $id('useCreditBtn');
async function updateUseCreditBtn() {
  if (!useCreditBtn || !f) return;
  const { user } = await getSession();
  if (!user) { setUseCreditVisible(false); return; }
  setUseCreditVisible(true);

  const formData = Object.fromEntries(new FormData(f).entries());
  const vin = (formData.vin || '').trim().toUpperCase();
  const state = (formData.state || '').trim();
  const plate = (formData.plate || '').trim();
  const hasInput = (vin && looksVin(vin)) || (state && plate);

  let enable = false;
  if (hasInput) {
    try {
      const r = await fetch(API.credits(user.id));
      const { balance = 0 } = await r.json();
      enable = balance > 0;
    } catch {}
  }
  useCreditBtn.disabled = !enable;
}
useCreditBtn?.addEventListener('click', async () => {
  if (!f) return;
  const formData = Object.fromEntries(new FormData(f).entries());
  const data = {
    vin: (formData.vin || '').trim().toUpperCase(),
    state: (formData.state || '').trim(),
    plate: (formData.plate || '').trim(),
    type: formData.type || 'carfax',
    as: 'html',
    allowLive: true
  };
  try {
    await ensureBackendReady();
    const headers = { 'Content-Type': 'application/json' };
    const { token } = await getSession();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const viewer = openBlank();
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { const t = await r.text(); if (viewer) viewer.close(); throw new Error(t); }
    const html = await r.text();
    if (viewer) { viewer.document.write(html); viewer.document.close(); }
    else { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } }
    showToast('Report fetched using 1 credit.', 'ok');
    await refreshBalancePill();
  } catch (e) {
    showToast(e.message || 'Could not fetch using credit', 'error');
  }
});

/* ================================
   VIN + Form: Realtime gating (A, YES)
   - Disables "View Report" unless:
     a) VIN passes ISO-3779 check, OR
     b) State & Plate present
================================ */
const f = $id('f');
const go = $id('go');
const loading = $id('loading');
const typeGroup = $id('typeGroup');

function hasPlateCombo(formData) {
  const state = (formData.state || '').trim();
  const plate = (formData.plate || '').trim();
  return !!(state && plate);
}

function reflectVinGate() {
  if (!f || !go) return;
  const formData = Object.fromEntries(new FormData(f).entries());
  const vin = (formData.vin || '').trim().toUpperCase();

  // Default: hide type until we know input is valid
  if (typeGroup) typeGroup.classList.add('hidden');

  if (vin.length === 0 && !hasPlateCombo(formData)) {
    setVinHelp('Enter a 17-char VIN (no I/O/Q) or select State & Plate.');
    go.disabled = true;
    return;
  }

  if (vin.length > 0) {
    if (!looksVinBasic(vin)) {
      setVinHelp('VIN must be 17 chars and cannot contain I, O, or Q.');
      go.disabled = true;
      return;
    }
    if (!vinCheckDigitOk(vin)) {
      setVinHelp('VIN check digit failed. Please double-check the VIN.', false);
      go.disabled = true;
      return;
    }
    setVinHelp('VIN looks valid ✓', true);
    go.disabled = false;
    if (typeGroup) typeGroup.classList.remove('hidden');
    return;
  }

  // No VIN, but plate combo ok → allow
  if (hasPlateCombo(formData)) {
    setVinHelp('State + Plate provided ✓', true);
    go.disabled = false;
    if (typeGroup) typeGroup.classList.remove('hidden');
    return;
  }

  // Fallback block
  go.disabled = true;
  if (typeGroup) typeGroup.classList.add('hidden');
}

f?.addEventListener('input', () => {
  reflectVinGate();
  updateUseCreditBtn();
});

/* ================================
   Main form (fetch report)
================================ */
f?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = Object.fromEntries(new FormData(f).entries());
  const data = {
    vin: (formData.vin || '').trim().toUpperCase(),
    state: (formData.state || '').trim(),
    plate: (formData.plate || '').trim(),
    type: formData.type || 'carfax',
    as: 'html',
    allowLive: true
  };

  // Final guard (button is already gated)
  if (!data.vin && !(data.state && data.plate)) {
    showToast('Enter a VIN or a State + Plate', 'error');
    reflectVinGate();
    return;
  }
  if (data.vin && !looksVin(data.vin)) {
    showToast('That VIN appears invalid (ISO-3779 check failed).', 'error');
    reflectVinGate();
    return;
  }

  go.disabled = true;
  loading?.classList.remove('hidden');

  let headers = { 'Content-Type': 'application/json' };
  let currentUser = null;
  let token = null;

  await ensureBackendReady();

  if (supabase) {
    const sess = await getSession();
    currentUser = sess.user; token = sess.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  if (currentUser?.id) {
    try {
      const r = await fetch(API.credits(currentUser.id));
      const { balance = 0 } = await r.json();
      if (balance <= 0) {
        lastFormData = data;
        openBuyModal();
        go.disabled = false; loading?.classList.add('hidden');
        return;
      }
    } catch {}
  }

  try {
    if (!currentUser && stripeSessionId) data.oneTimeSession = stripeSessionId;

    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });

    if (r.status === 401 || r.status === 402) {
      lastFormData = data;
      openBuyModal();
      return;
    }
    if (r.status === 409) {
      showToast('That receipt was already used. Please purchase again.', 'error');
      return;
    }
    if (!r.ok) {
      const t = await r.text();
      showToast(t || ('HTTP ' + r.status), 'error');
      return;
    }

    const html = await r.text();
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else { document.open(); document.write(html); document.close(); }

    showToast('Report fetched successfully!', 'ok');
    addToHistory({
      vin: data.vin || '(from plate)', type: data.type, ts: Date.now(),
      state: data.state || '', plate: data.plate || ''
    });
    renderHistory();

    try {
      const resp = await fetch(API.share, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: data.vin || data.plate, type: data.type })
      });
      if (resp.ok) {
        const { url } = await resp.json();
        await navigator.clipboard.writeText(url);
        showToast('Share link copied to clipboard!', 'ok');
      }
    } catch {}

    await refreshBalancePill();
  } catch (err) {
    showToast(err.message || 'Request failed', 'error');
  } finally {
    go.disabled = false;
    loading?.classList.add('hidden');
  }
});


// Sidebar 5-pack CTA (public site)
document.getElementById('buy5Sidebar')?.addEventListener('click', async () => {
  const { user } = await getSession();
  if (!user) {
    showToast('Please sign in to buy a 5-pack of credits.', 'error');
    openLogin();
    return;
  }
  // TODO: replace with your real Stripe Price ID for the 5-pack
  startPurchase({ user, price_id: 'STRIPE_PRICE_10PACK', pendingReport: null });
});

document.getElementById('comparePlans')?.addEventListener('click', () => {
  openBuyModal();
});

/* ================================
   Init
================================ */
(async () => {
  setUseCreditVisible(false);
  await refreshBalancePill();
  renderHistory();

  if (stripeSessionId || ppSuccess) {
    if (!intentParam || intentParam !== 'buy_report') {
      const pending = tryLoadPending();
      if (pending) {
        showToast('Payment confirmed. Preparing your report…', 'ok');
        await resumePendingPurchase();
      }
    }
  }

  reflectVinGate();        // <- enforce gating on load
  updateUseCreditBtn();
})();
