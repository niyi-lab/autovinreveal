/* ================================
   Config & Utilities
================================ */
const API = {
  report: '/api/report',
  checkout: '/api/create-checkout-session',
  credits: (uid) => `/api/credits/${uid}`,
  share: '/api/share',
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

/* Open a blank tab immediately on user gesture to avoid popup blockers */
function openBlank() {
  try { return window.open('', '_blank', 'noopener,noreferrer'); }
  catch { return null; }
}

function setUseCreditVisible(show) {
  const el = $id('useCreditBtn');
  if (!el) return;
  el.classList.toggle('hidden', !show);
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
   Stripe/PayPal success handling
================================ */
function onSuccessPage() { return location.pathname.endsWith('/success.html'); }
function params() { return new URLSearchParams(location.search); }
const p = params();
const stripeSessionId = p.get('session_id') || null;
const ppSuccess = p.get('pp') === 'success';
const intentParam = p.get('intent') || null;
const vinParam = (p.get('vin') || '').toUpperCase();

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

    // Not a user gesture, popup may be blocked — fallback to same-tab render
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else { document.open(); document.write(html); document.close(); }

    // Meta Pixel: Purchase after successful PayPal resume
    try {
      fbq('track', 'Purchase', {
        value: 7.00,
        currency: 'USD',
        contents: [{ id: 'VinReport', quantity: 1 }],
        content_ids: ['VinReport'],
        content_type: 'product'
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

  // Direct “buy_report” (guest) -> fetch via one-time receipt
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

      // Meta Pixel: Purchase after successful Stripe guest buy_report
      try {
        fbq('track', 'Purchase', {
          value: 7.00,
          currency: 'USD',
          contents: [{ id: 'VinReport', quantity: 1 }],
          content_ids: ['VinReport'],
          content_type: 'product'
        });
      } catch {}

      return;
    } catch (e) {
      showToast(e.message || 'Failed to fetch report', 'error');
    }
  }

  if (ppSuccess) showToast('Payment confirmed.', 'ok');
  await refreshBalancePill();

  // If we’re on /success.html, bounce back to home
  if (onSuccessPage()) {
    setTimeout(() => { window.location.href = '/'; }, 1200);
  } else {
    const url = new URL(location.href);
    ['session_id','intent','vin','pp'].forEach(k => url.searchParams.delete(k));
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
  const icon  = themeBtn?.querySelector('.icon');
  if (label) label.textContent = mode === 'dark' ? 'Light' : 'Dark';
  if (icon)  icon.textContent  = mode === 'dark' ? '☀️' : '🌙';
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
const userChip         = $id('userChip');
const userEmailEl      = $id('userEmail');
const logoutBtn        = $id('logoutBtn');

function openLogin()  { loginModal?.classList.remove('hidden'); }
function closeLogin() { loginModal?.classList.add('hidden'); }
closeLoginModal?.addEventListener('click', closeLogin);
logoutBtn?.addEventListener('click', doLogout);

// Always open the modal on button click
loginBtn?.addEventListener('click', () => openLogin());

// Auto-open login if homepage has ?openLogin=1
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

// Optional Google button
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
    url.searchParams.delete('state'); // ← fixed: removed stray ]
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
    setPrimaryCTA('view');
    reflectAuthUI(null);
    setUseCreditVisible(false);
    return;
  }

  const { balance = 0 } = await fetchBalance();
  if (pill && txt) {
    txt.textContent = `${balance} credit${balance===1?'':'s'}`;
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

    // Pre-open viewer in user gesture to beat popup blockers
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
          <button data-idx="${idx}" data-action="share" class="btn-outline" style="font-size:.8rem">Copy Link</button>
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
      else if (action === 'share') copyShareLink(item.vin.replace('(from plate)','').trim() || item.plate, item.type);
      else if (action === 'del') { const list = loadHistory(); list.splice(i,1); saveHistory(list); renderHistory(); }
    });
  });
}
$id('clearHistory')?.addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

/* ================================
   Buy Credits modal (tiers) + PayPal
================================ */
const buyModal    = $id('buyCreditsModal');
const buy1Btn     = $id('buy1Btn');   // 1-credit button (Stripe)
const buy10Btn    = $id('buy10Btn');  // 10-pack button (Stripe)
const closeBuyBtn = $id('closeModalBtn');
function openBuyModal(){ buyModal?.classList.remove('hidden'); renderPaypalButton(); }
function closeBuyModal(){ buyModal?.classList.add('hidden'); }
closeBuyBtn?.addEventListener('click', closeBuyModal);

// PayPal helpers
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

// Render PayPal smart button once (guard container + SDK)
let paypalRendered = false;
async function renderPaypalButton() {
  if (paypalRendered) return;
  const container = document.getElementById('paypalContainer');
  if (!container) return;
  if (!window.paypal) {
    showToast('PayPal is unavailable right now.', 'error');
    return;
  }
  paypalRendered = true;

  const { user } = await getSession();

  window.paypal.Buttons({
    createOrder: () => createPaypalOrder(user),
    onApprove: async (data) => {
      try {
        const result = await capturePaypalOrder(data.orderID, user);
        if (!user && result?.captureId) {
          const pending = tryLoadPending() || lastFormData || {};
          pending.oneTimeSession = 'pp_' + result.captureId;
          localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
        }
        const url = new URL('/success.html', window.location.origin);
        url.searchParams.set('pp', 'success');
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
   — handles 409 “already purchased” by opening archive
   — only stores pending when we have a VIN
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

// Buttons (use existing consts; don't redeclare)
buy1Btn?.addEventListener('click', async () => {
  const { user } = await getSession(); 
  closeBuyModal();
  startPurchase({ user, price_id: 'STRIPE_PRICE_SINGLE', pendingReport: lastFormData || null });
});
buy10Btn?.addEventListener('click', async () => {
  const { user } = await getSession();
  if (!user) { 
    closeBuyModal();
    showToast('Please sign in to buy a 10-pack of credits.', 'error');
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
   Main form (fetch report)
================================ */
const f = $id('f');
const go = $id('go');
const loading = $id('loading');

const looksVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(v || '');

f?.addEventListener('input', updateUseCreditBtn);

f?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const viewer = openBlank();

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
    if (viewer) viewer.close();
    showToast('Enter a VIN or a State + Plate', 'error');
    go.disabled = false; loading.classList.add('hidden'); return;
  }
  if (data.vin && !looksVin(data.vin)) {
    if (viewer) viewer.close();
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
        if (viewer) viewer.close();
        go.disabled = false; loading.classList.add('hidden'); return;
      }
    } catch {}
  }

  try {
    if (!currentUser && stripeSessionId) data.oneTimeSession = stripeSessionId;

    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (r.status === 401 || r.status === 402) { lastFormData = data; openBuyModal(); if (viewer) viewer.close(); return; }
    if (r.status === 409) { showToast('That receipt was already used. Please purchase again.', 'error'); if (viewer) viewer.close(); return; }
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); if (viewer) viewer.close(); return; }

    const html = await r.text();
    if (viewer) { viewer.document.write(html); viewer.document.close(); }
    else { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } }

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
    go.disabled = false; loading.classList.add('hidden');
  }
});

/* ================================
   Init
================================ */
(async () => {
  setUseCreditVisible(false); // hidden by default for guests
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

  updateUseCreditBtn();
})();
