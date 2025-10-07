/* ================================
   Config & Utilities
================================ */
const API = {
  report: '/api/report',
  checkout: '/api/create-checkout-session',
  credits: (uid) => `/api/credits/${uid}`,
};
const PENDING_KEY = 'pendingReport';

function $id(id) { return document.getElementById(id); }

function showToast(message, type = 'error') {
  const box = $id('toastBox');
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

/* Primary CTA switcher: 'view' | 'buy' */
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
    btn.onclick = null; // handled by <form> submit
  }
}

/* ================================
   Supabase init
================================ */
const SB_URL  = window.VITE_SUPABASE_URL  || (typeof process !== 'undefined' ? process?.env?.VITE_SUPABASE_URL  : '') || '';
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
   Stripe return handling
================================ */
const urlParams = new URLSearchParams(window.location.search);
const checkoutSuccess = urlParams.get('checkout') === 'success';
const stripeSessionId = urlParams.get('session_id') || null;

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
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    showToast('Report ready!', 'ok');
    addToHistory({ vin: pending.vin || '(from plate)', type: pending.type || 'carfax', ts: Date.now(),
                   state: pending.state || '', plate: pending.plate || '' });
    renderHistory();
  } catch (e) {
    showToast(e.message || 'Failed to resume purchase', 'error');
  } finally {
    clearPending();
    await refreshBalancePill(); // reflect new credits
  }
}
if (stripeSessionId) {
  history.replaceState({}, '', window.location.pathname);
  if (checkoutSuccess) showToast('Payment confirmed. Preparing your report…', 'ok');
  resumePendingPurchase();
}

/* ================================
   Theme toggle
================================ */
const themeBtn = $id('themeBtn');
function setTheme(mode) {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  localStorage.setItem('theme', mode);
  const label = themeBtn?.querySelector('.label');
  const icon  = themeBtn?.querySelector('.icon');
  if (label) label.textContent = mode === 'dark' ? 'Light' : 'Dark';
  if (icon) icon.textContent   = mode === 'dark' ? '☀️' : '🌙';
}
themeBtn?.addEventListener('click', () => {
  const nowDark = !document.documentElement.classList.contains('dark');
  setTheme(nowDark ? 'dark' : 'light');
});
(() => {
  const dark  = document.documentElement.classList.contains('dark');
  const label = themeBtn?.querySelector('.label');
  const icon  = themeBtn?.querySelector('.icon');
  if (label) label.textContent = dark ? 'Light' : 'Dark';
  if (icon)  icon.textContent  = dark ? '☀️' : '🌙';
})();

/* ================================
   Auth modal (email + password)
================================ */
const loginBtn         = $id('loginBtn');
const loginModal       = $id('loginModal');
const closeLoginModal  = $id('closeLoginModal');
const emailEl          = $id('loginEmail');
const pwEl             = $id('loginPassword');
const doLoginBtn       = $id('doLogin');
const doSignupBtn      = $id('doSignup');

/* user chip elements (optional if present in HTML) */
const userChip    = $id('userChip');
const userEmailEl = $id('userEmail');
const logoutBtn   = $id('logoutBtn');

function openLogin()  { loginModal?.classList.remove('hidden'); }
function closeLogin() { loginModal?.classList.add('hidden'); }
closeLoginModal?.addEventListener('click', closeLogin);
logoutBtn?.addEventListener('click', doLogout);

// Auto-open login if homepage has ?openLogin=1 (from /email-confirmed link)
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
    // Send confirmation link to a friendly page
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
    else { showToast('Account created — you are signed in!', 'ok'); closeLogin(); }
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

// Optional Google button (binds only if present in HTML)
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
loginBtn?.addEventListener('click', () => {
  if (currentSession?.user) doLogout();
  else openLogin();
});
function reflectAuthUI(session) {
  currentSession = session;

  if (session?.user) {
    if (userEmailEl) userEmailEl.textContent = session.user.email || '';
    userChip?.classList.remove('hidden');
    loginBtn?.classList.add('hidden');
  } else {
    userChip?.classList.add('hidden');
    loginBtn?.classList.remove('hidden');
    if (loginBtn) loginBtn.textContent = '🔑 Login';
  }
}

/* ================================
   Auth callback & listener
================================ */
(async () => {
  if (!supabase) return;

  // Handle magic links / OAuth callbacks if they ever hit the homepage
  const fromAuthLink = /[?&]code=/.test(location.search) || /access_token=/.test(location.hash);
  if (fromAuthLink) {
    const { error } = await supabase.auth.getSessionFromUrl({ storeSession: true });
    const url = new URL(location.href); url.searchParams.delete('code'); url.searchParams.delete('state');
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
    return await r.json(); // { balance }
  } catch { return { balance: 0 }; }
}
async function refreshBalancePill() {
  const pill = $id('balancePill');
  const txt  = $id('balanceText');
  const { user } = await getSession();

  if (!user) {
    pill?.classList.add('hidden');
    setPrimaryCTA('view');           // guest -> show View Report
    reflectAuthUI(null);
    return;
  }

  const { balance = 0 } = await fetchBalance();
  if (pill && txt) {
    txt.textContent = `${balance} credit${balance===1?'':'s'}`;
    pill.classList.remove('hidden');
  }

  // Switch main CTA based on balance
  if (balance <= 0) setPrimaryCTA('buy');  // logged-in with 0 -> Buy Credits
  else setPrimaryCTA('view');              // have credits -> View Report
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
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
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
function renderHistory() {
  const body = $id('historyBody');
  const list = loadHistory();
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
        <div class="flex gap-2">
          <button data-idx="${idx}" data-action="open" class="btn-outline" style="font-size:.8rem">Open HTML</button>
          <button data-idx="${idx}" data-action="pdf" class="btn-outline" style="font-size:.8rem">Download PDF</button>
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
      else if (action === 'del') { const list = loadHistory(); list.splice(i,1); saveHistory(list); renderHistory(); }
    });
  });
}
$id('clearHistory')?.addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

/* ================================
   Buy Credits modal (tiers)
================================ */
const buyModal    = $id('buyCreditsModal');
const buy1Btn     = $id('buy1Btn');   // optional new 1-credit button
const buy10Btn    = $id('buy10Btn');  // optional new 10-pack button
const buyNowBtn   = $id('buyNowBtn'); // legacy single-buy button
const closeBuyBtn = $id('closeModalBtn');
function openBuyModal(){ buyModal?.classList.remove('hidden'); }
function closeBuyModal(){ buyModal?.classList.add('hidden'); }
closeBuyBtn?.addEventListener('click', closeBuyModal);

/* ================================
   Purchase flow
================================ */
async function startPurchase({ user, price_id, pendingReport = null }) {
  try {
    await ensureBackendReady();
    if (pendingReport) localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport));
    const body = { user_id: user?.id || null, price_id }; // symbolic id or real price_...
    const r = await fetch(API.checkout, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text(); throw new Error(t || 'Stripe error'); }
    const { url } = await r.json(); window.location.href = url;
  } catch (e) { showToast(e.message || 'Failed to start checkout', 'error'); }
}
buy1Btn?.addEventListener('click', async () => {
  const { user } = await getSession(); closeBuyModal();
  startPurchase({ user, price_id: 'STRIPE_PRICE_SINGLE', pendingReport: null });
});
buy10Btn?.addEventListener('click', async () => {
  const { user } = await getSession(); closeBuyModal();
  startPurchase({ user, price_id: 'STRIPE_PRICE_10PACK', pendingReport: null });
});
buyNowBtn?.addEventListener('click', async () => {
  const { user } = await getSession(); closeBuyModal();
  startPurchase({ user, price_id: 'STRIPE_PRICE_SINGLE', pendingReport: null });
});

/* ================================
   Main form (fetch report)
================================ */
const f = $id('f');
const go = $id('go');
const loading = $id('loading');

const looksVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(v || '');
let lastFormData = null;

f?.addEventListener('submit', async (e) => {
  e.preventDefault();
  go.disabled = true; loading.classList.remove('hidden');

  const formData = Object.fromEntries(new FormData(f).entries());
  const data = {
    vin: (formData.vin || '').trim().toUpperCase(),
    state: (formData.state || '').trim(),
    plate: (formData.plate || '').trim(),
    type: formData.type || 'carfax',
    as:   'html',
    allowLive: true
  };

  if (!data.vin && !(data.state && data.plate)) {
    showToast('Enter a VIN or a State + Plate', 'error');
    go.disabled = false; loading.classList.add('hidden'); return;
  }
  if (data.vin && !looksVin(data.vin)) {
    showToast('VIN must be 17 characters (no I/O/Q)', 'error');
    go.disabled = false; loading.classList.add('hidden'); return;
  }

  let headers = { 'Content-Type': 'application/json' };
  let currentUser = null;
  let token = null;

  await ensureBackendReady();

  if (supabase) {
    const sess = await getSession();
    currentUser = sess.user; token = sess.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  if (currentUser && currentUser.id) {
    try {
      const r = await fetch(API.credits(currentUser.id));
      const { balance = 0 } = await r.json();
      if (balance <= 0) {
        lastFormData = data; openBuyModal();
        go.disabled = false; loading.classList.add('hidden'); return;
      }
    } catch { /* ignore */ }
  }

  try {
    if (!currentUser && stripeSessionId) data.oneTimeSession = stripeSessionId;

    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (r.status === 401 || r.status === 402) { lastFormData = data; openBuyModal(); return; }
    if (r.status === 409) { showToast('That receipt was already used. Please purchase again.', 'error'); return; }
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }

    const html = await r.text();
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();

    showToast('Report fetched successfully!', 'ok');
    addToHistory({ vin: data.vin || '(from plate)', type: data.type, ts: Date.now(),
                   state: data.state || '', plate: data.plate || '' });
    renderHistory();
    await refreshBalancePill();
  } catch (err) {
    showToast(err.message || 'Request failed', 'error');
  } finally {
    go.disabled = false; loading.classList.add('hidden');
  }
});

/* ================================
   Init
================================ */
(async () => {
  await refreshBalancePill(); // sets CTA accordingly
  renderHistory();
})();
