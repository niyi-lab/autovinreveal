/* ================================
   Config & Utilities
================================ */
const API = {
  report: '/api/report',
  checkout: '/api/create-checkout-session',
  credits: (uid) => `/api/credits/${uid}`,
};

const PENDING_KEY = 'pendingReport'; // what report to open after Stripe success

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
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ================================
   Supabase init (single source)
================================ */
const SB_URL  = window.VITE_SUPABASE_URL  || (typeof process !== 'undefined' ? process?.env?.VITE_SUPABASE_URL  : '') || '';
const SB_ANON = window.VITE_SUPABASE_ANON_KEY || (typeof process !== 'undefined' ? process?.env?.VITE_SUPABASE_ANON_KEY : '') || '';

let supabase = null;
if (window.supabase && SB_URL && SB_ANON) {
  supabase = window.supabase.createClient(SB_URL, SB_ANON);
}

/* ================================
   Backend warmup overlay + ping
   (helps when Render free service wakes up)
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
  } catch {
    clearTimeout(t);
    return false;
  }
}

async function ensureBackendReady({ timeoutMs = 2000, maxWaitMs = 60000 } = {}) {
  if (backendReadyOnce) return true;

  // quick probe (avoid flashing overlay if it's already up)
  let ok = await pingBackendOnce(timeoutMs);
  if (ok) { backendReadyOnce = true; return true; }

  // show overlay & poll with backoff
  showBootOverlay();
  const start = Date.now();
  let delay = 700;
  while (Date.now() - start < maxWaitMs) {
    ok = await pingBackendOnce(timeoutMs);
    if (ok) {
      backendReadyOnce = true;
      hideBootOverlay();
      return true;
    }
    await new Promise(res => setTimeout(res, delay));
    delay = Math.min(Math.round(delay * 1.7), 4000);
  }
  hideBootOverlay();
  return false;
}

// small warm ping on load (doesn't show overlay unless truly slow)
ensureBackendReady({ timeoutMs: 800, maxWaitMs: 3000 });

/* ================================
   Stripe return handling (guest use)
================================ */
const urlParams = new URLSearchParams(window.location.search);
const checkoutSuccess = urlParams.get('checkout') === 'success';
const stripeSessionId = urlParams.get('session_id') || null;

function tryLoadPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); }
  catch { return null; }
}
function clearPending() { localStorage.removeItem(PENDING_KEY); }

async function resumePendingPurchase() {
  const pending = tryLoadPending();
  if (!pending) return;

  await ensureBackendReady();

  const headers = { 'Content-Type': 'application/json' };
  const { token, user } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // guests must attach the Stripe receipt, logged-in users rely on credits
  if (!user && stripeSessionId) {
    pending.oneTimeSession = stripeSessionId;
  }

  try {
    const r = await fetch(API.report, {
      method: 'POST',
      headers,
      body: JSON.stringify(pending),
    });

    if (!r.ok) {
      const t = await r.text();
      showToast(t || ('HTTP ' + r.status), 'error');
      return;
    }

    // Always open HTML immediately after purchase; history lets them grab PDF too
    const html = await r.text();
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();

    showToast('Report ready!', 'ok');

    // Record to history (format not stored; actions provide both HTML/PDF)
    addToHistory({
      vin: pending.vin || '(from plate)',
      type: pending.type || 'carfax',
      ts: Date.now(),
      state: pending.state || '',
      plate: pending.plate || ''
    });
    renderHistory();
  } catch (e) {
    showToast(e.message || 'Failed to resume purchase', 'error');
  } finally {
    clearPending();
  }
}

// If we returned from Stripe with a session, clean URL and resume
if (stripeSessionId) {
  history.replaceState({}, '', window.location.pathname);
  if (checkoutSuccess) {
    showToast('Payment confirmed. Preparing your report…', 'ok');
  }
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
   Login modal (email + password)
================================ */
const loginBtn         = $id('loginBtn');
const loginModal       = $id('loginModal');
const closeLoginModal  = $id('closeLoginModal');
const emailEl          = $id('loginEmail');
const pwEl             = $id('loginPassword');
const doLoginBtn       = $id('doLogin');
const doSignupBtn      = $id('doSignup');

function openLogin()  { loginModal?.classList.remove('hidden'); }
function closeLogin() { loginModal?.classList.add('hidden'); }

closeLoginModal?.addEventListener('click', closeLogin);

// Disable/enable "Create account" while we validate inputs
function setSignupDisabled(disabled) {
  if (!doSignupBtn) return;
  doSignupBtn.disabled = disabled;
  doSignupBtn.style.opacity = disabled ? '0.6' : '1';
  doSignupBtn.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

// basic enable/disable by input completeness
function reflectSignupAvailability() {
  const email = (emailEl?.value || '').trim();
  const pw = pwEl?.value || '';
  // must have valid-ish email and 6+ chars password
  const enabled = !!email && pw.length >= 6;
  setSignupDisabled(!enabled);
}
emailEl?.addEventListener('input', reflectSignupAvailability);
pwEl?.addEventListener('input', reflectSignupAvailability);
reflectSignupAvailability();

async function doSignup() {
  if (!supabase) { showToast('Supabase not loaded', 'error'); return; }
  const email = (emailEl.value || '').trim();
  const password = pwEl.value || '';

  if (!email) return showToast('Enter your email', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin }
    });

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      // Common supabase error message for existing users
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        showToast('An account with this email already exists. Please sign in instead.', 'error');
        // Lock create button to prevent repeated attempts
        setSignupDisabled(true);
        return;
      }
      throw error;
    }

    if (!data.session) {
      showToast('Check your email to confirm your account.', 'ok');
    } else {
      showToast('Account created — you are signed in!', 'ok');
      closeLogin();
    }
  } catch (e) {
    showToast(e.message || 'Sign up failed', 'error');
  }
}

async function doLogin() {
  if (!supabase) { showToast('Supabase not loaded', 'error'); return; }
  const email = (emailEl.value || '').trim();
  const password = pwEl.value || '';
  if (!email || !password) return showToast('Enter email and password', 'error');

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    showToast('Signed in!', 'ok');
    closeLogin();
  } catch (e) {
    showToast(e.message || 'Sign in failed', 'error');
  }
}

async function doLogout() {
  if (!supabase) return;
  await supabase.auth.signOut();
  showToast('Signed out', 'ok');
}

doSignupBtn?.addEventListener('click', doSignup);
doLoginBtn?.addEventListener('click', doLogin);

/* Toggle header button using a single click handler */
let currentSession = null;
loginBtn?.addEventListener('click', () => {
  if (currentSession?.user) doLogout();
  else openLogin();
});

function reflectAuthUI(session) {
  currentSession = session;
  if (!loginBtn) return;
  loginBtn.textContent = session?.user ? 'Sign out' : '🔑 Login';
}

/* ================================
   Auth callback & listener
================================ */
(async () => {
  if (!supabase) return;

  // Handle email confirmation / reset links
  const fromAuthLink = /[?&]code=/.test(location.search) || /access_token=/.test(location.hash);
  if (fromAuthLink) {
    const { error } = await supabase.auth.getSessionFromUrl({ storeSession: true });
    // Clean URL
    const url = new URL(location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    history.replaceState({}, '', url.pathname + url.search);
    if (error) showToast(error.message || 'Auth callback failed', 'error');
    else showToast('You’re signed in!', 'ok');
  }

  const { data } = await supabase.auth.getSession();
  reflectAuthUI(data.session);
  supabase.auth.onAuthStateChange((_event, session) => reflectAuthUI(session));
})();

/* ================================
   Supabase session helper
================================ */
async function getSession() {
  if (!supabase) return { session: null, user: null, token: null };
  const { data } = await supabase.auth.getSession();
  const session = data?.session || null;
  return { session, user: session?.user || null, token: session?.access_token || null };
}

/* ================================
   History (localStorage)
   (No format stored; actions provide HTML/PDF)
================================ */
const HISTORY_KEY = 'reportHistory';
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(list) { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); }
function addToHistory(item) { const list = loadHistory(); list.unshift(item); saveHistory(list.slice(0, 20)); }
function formatTime(ts) { return new Date(ts).toLocaleString(); }

async function openHistoryHTML(item) {
  const data = {
    vin: item.vin && item.vin !== '(from plate)' ? item.vin : '',
    state: item.state || '',
    plate: item.plate || '',
    type: item.type,
    as: 'html',
    allowLive: false
  };
  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    await ensureBackendReady();
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
  } catch (e) { showToast(e.message || 'Request failed', 'error'); }
}

async function downloadHistoryPDF(item) {
  const data = {
    vin: item.vin && item.vin !== '(from plate)' ? item.vin : '',
    state: item.state || '',
    plate: item.plate || '',
    type: item.type,
    as: 'pdf',
    allowLive: false
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
      const item = loadHistory()[i];
      if (!item) return;

      if (action === 'open') {
        openHistoryHTML(item);
      } else if (action === 'pdf') {
        downloadHistoryPDF(item);
      } else if (action === 'del') {
        const list = loadHistory(); list.splice(i,1); saveHistory(list); renderHistory();
      }
    });
  });
}
$id('clearHistory')?.addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

/* ================================
   Buy Credits modal
================================ */
const buyModal    = $id('buyCreditsModal');
const buyNowBtn   = $id('buyNowBtn');
const closeBuyBtn = $id('closeModalBtn');
function openBuyModal(){ buyModal?.classList.remove('hidden'); }
function closeBuyModal(){ buyModal?.classList.add('hidden'); }
closeBuyBtn?.addEventListener('click', closeBuyModal);

/* ================================
   Purchase flow (guest or user)
   - If we were blocked for credits, we stash the intended report in localStorage
   - After Stripe success, we auto-open that report
================================ */
async function startPurchase(user, pendingReport = null) {
  try {
    await ensureBackendReady();
    if (pendingReport) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport));
    }
    const body = { user_id: user?.id || null }; // null => guest checkout
    const r = await fetch(API.checkout, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) { const t = await r.text(); throw new Error(t || 'Stripe error'); }
    const { url } = await r.json();
    window.location.href = url;
  } catch (e) {
    showToast(e.message || 'Failed to start checkout', 'error');
  }
}
buyNowBtn?.addEventListener('click', async () => {
  const { user } = await getSession(); // may be null -> guest
  closeBuyModal();
  // No specific pending report here; it’s a generic top-up
  startPurchase(user, null);
});

/* ================================
   Fetch report (main form)
   - No "format" dropdown; default open HTML
   - If credits required -> open modal and remember desired report
================================ */
const f = $id('f');
const go = $id('go');
const loading = $id('loading');

const looksVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(v || '');

let lastFormData = null; // to remember intent if we prompt purchase

f?.addEventListener('submit', async (e) => {
  e.preventDefault();
  go.disabled = true;
  loading.classList.remove('hidden');

  const formData = Object.fromEntries(new FormData(f).entries());
  const data = {
    vin: (formData.vin || '').trim().toUpperCase(),
    state: (formData.state || '').trim(),
    plate: (formData.plate || '').trim(),
    type: formData.type || 'carfax',
    as:   'html',        // default open HTML immediately
    allowLive: true
  };

  // basic validation
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

  // Make sure backend is up before credit checks or requests
  await ensureBackendReady();

  if (supabase) {
    const sess = await getSession();
    currentUser = sess.user;
    token       = sess.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  // If logged-in, check credits (non-blocking errors ignored)
  if (currentUser && currentUser.id) {
    try {
      const r = await fetch(API.credits(currentUser.id));
      const { balance = 0 } = await r.json();
      if (balance <= 0) {
        lastFormData = data;
        openBuyModal();
        go.disabled = false; loading.classList.add('hidden');
        return;
      }
    } catch (_) { /* ignore balance errors */ }
  }

  try {
    // If GUEST and we just returned from Stripe, attach the receipt
    if (!currentUser && stripeSessionId) {
      data.oneTimeSession = stripeSessionId;
    }

    const r = await fetch(API.report, {
      method: 'POST',
      headers,
      body: JSON.stringify(data)
    });

    if (r.status === 401 || r.status === 402) {
      // need purchase; remember desired report and prompt buy
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

    // Open HTML immediately
    const html = await r.text();
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();

    showToast('Report fetched successfully!', 'ok');
    addToHistory({
      vin: data.vin || '(from plate)',
      type: data.type,
      ts: Date.now(),
      state: data.state || '',
      plate: data.plate || ''
    });
    renderHistory();

  } catch (err) {
    showToast(err.message || 'Request failed', 'error');
  } finally {
    go.disabled = false;
    loading.classList.add('hidden');
  }
});

/* If user clicks “Buy Now” from the modal after a blocked attempt,
   store the intended report so we can auto-open after Stripe returns. */
buyNowBtn?.addEventListener('click', async () => {
  const { user } = await getSession();
  closeBuyModal();
  const pending = lastFormData
    ? { ...lastFormData, as: 'html', allowLive: true } // ensure HTML open
    : null;
  startPurchase(user, pending);
});

/* ================================
   Initialize history
================================ */
renderHistory();
