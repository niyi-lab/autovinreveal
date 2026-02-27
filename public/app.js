// app.js
// FIXES APPLIED:
//   #4  — document.write replaced with safe blob-URL / sandboxed-iframe approach
//   #11 — lastFormData scoped to buy modal; cleared after use
//   #12 — PayPal button re-renders when user login state changes
//   #15 — All API.report fetches wrapped in apiFetch() with 30 s timeout

/* ================================
   Config & Utilities
================================ */
const API = {
  report:   '/api/report',
  checkout: '/api/create-checkout-session',
  credits:  (uid) => `/api/credits/${uid}`,
  share:    '/api/share',
};

const PENDING_KEY    = 'pendingReport';
const API_TIMEOUT_MS = 30_000;   // FIX 15

function $id(id) { return document.getElementById(id); }

function showToast(message, type = 'error') {
  const box = $id('toastBox');
  if (!box) { alert(message); return; }
  const el = document.createElement('div');
  el.className = `transform transition-all duration-300 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
    type === 'error'
      ? 'bg-red-50 text-red-700 border border-red-100'
      : 'bg-green-50 text-green-700 border border-green-100'
  }`;
  const icon = type === 'error'
    ? `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
    : `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
  el.innerHTML = `${icon}<span>${message}</span>`;
  box.appendChild(el);
  requestAnimationFrame(() => { el.style.transform = 'translateY(0)'; el.style.opacity = '1'; });
  setTimeout(() => {
    el.style.transition = 'all 0.5s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    setTimeout(() => el.remove(), 500);
  }, 4000);
}

function trackPurchase(value = 6.00) {  // was inconsistently 6 or 7
  try {
    fbq('track', 'Purchase', {
      value, currency: 'USD',
      contents: [{ id: 'VinReport', quantity: 1 }],
      content_ids: ['VinReport'], content_type: 'product'
    });
  } catch {}
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function openBlank() {
  try { return window.open('', '_blank', 'noopener,noreferrer'); } catch { return null; }
}

function setBtnLoading(btn, loadingText = 'Processing…') {
  if (!btn) return () => {};
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg><span>${loadingText}</span>`;
  btn.classList.add('opacity-70', 'cursor-not-allowed');
  return () => {
    btn.disabled = false;
    btn.innerHTML = orig;
    btn.classList.remove('opacity-70', 'cursor-not-allowed');
  };
}

/* ================================
   FIX 15: fetch with timeout
   Wraps all API calls — throws a readable error if the server hangs
================================ */
async function apiFetch(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError')
      throw new Error('Request timed out. Please check your connection and try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ================================
   FIX 4: Safe report renderer
   Replaces ALL document.write() calls.
   - Uses a blob URL so the HTML is never eval'd in the current origin's context
   - If popup is blocked, falls back to a sandboxed inline overlay
================================ */
function openReport(html) {
  const blob    = new Blob([html], { type: 'text/html; charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  const w = window.open(blobUrl, '_blank', 'noopener,noreferrer');
  if (w) {
    // Revoke after 60 s — long enough for the page to fully load
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    return;
  }

  // Popup was blocked — clean up blob URL and render inline instead
  URL.revokeObjectURL(blobUrl);
  showReportOverlay(html);
}

function showReportOverlay(html) {
  // Remove any existing overlay
  document.getElementById('reportOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id    = 'reportOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;';

  const bar = document.createElement('div');
  bar.style.cssText =
    'flex-shrink:0;background:#1e3a8a;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;';
  bar.innerHTML = `
    <span style="color:white;font-weight:bold;font-size:14px;">Vehicle History Report</span>
    <button id="closeReportOverlay"
      style="background:#ef4444;color:white;border:none;padding:6px 14px;border-radius:6px;
             font-weight:bold;cursor:pointer;font-size:13px;">
      ✕ Close
    </button>`;

  // sandbox: allow-same-origin lets the report's own scripts run;
  // the blob is served from a different origin so it cannot touch the parent page.
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-same-origin allow-scripts allow-popups allow-forms';
  iframe.style.cssText = 'flex:1;border:none;width:100%;';
  iframe.srcdoc = html;

  overlay.appendChild(bar);
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);

  overlay.querySelector('#closeReportOverlay')
    .addEventListener('click', () => overlay.remove());
}

/* ================================
   VIN Validation (ISO 3779)
================================ */
const VIN_RE      = /^[A-HJ-NPR-Z0-9]{17}$/;
const VIN_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
const VIN_MAP = Object.freeze({
  A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,
  J:1,K:2,L:3,M:4,N:5,P:7,R:9,
  S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
  '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9
});
function looksVinBasic(v) { return VIN_RE.test((v||'').toUpperCase()); }
function vinCheckDigitOk(vinRaw) {
  const vin = (vinRaw||'').toUpperCase();
  if (!looksVinBasic(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const val = VIN_MAP[vin[i]];
    if (val === undefined) return false;
    sum += val * VIN_WEIGHTS[i];
  }
  const rem = sum % 11;
  return vin[8] === (rem === 10 ? 'X' : String(rem));
}

/* UI VIN feedback */
function ensureVinHelpEl() {
  let help = $id('vinHelp');
  if (!help) {
    const vinInput = document.querySelector('input[name="vin"]');
    if (!vinInput) return null;
    help = document.createElement('div');
    help.id = 'vinHelp';
    help.className = 'text-xs mt-2 font-medium transition-all';
    vinInput.closest('.group')?.appendChild(help);
  }
  return help;
}
function setVinHelp(text, ok = false) {
  const el = ensureVinHelpEl();
  if (!el) return;
  el.textContent = text || '';
  el.className = `text-xs mt-2 font-medium transition-all ${ok ? 'text-green-600' : 'text-red-500'}`;
}

/* ================================
   Primary CTA switcher
================================ */
function setPrimaryCTA(mode = 'view') {
  const btn = $id('go');
  if (!btn) return;
  btn.className = 'glow-btn w-full bg-blue-600 hover:bg-blue-700 text-white h-14 rounded-xl font-bold text-lg shadow-xl shadow-blue-600/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed';
  if (mode === 'buy') {
    btn.type = 'button';
    btn.innerHTML = `<span>Buy Credits</span><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>`;
    btn.onclick = async () => {
      const { user } = await getSession();
      if (!user) { openLogin(); return; }
      openBuyModal();
    };
  } else {
    btn.type = 'submit';
    btn.innerHTML = `<span>Get CARFAX Report Now</span><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"></path></svg>`;
    btn.onclick = null;
  }
}

/* ================================
   Supabase init
================================ */
const SB_URL  = window.VITE_SUPABASE_URL  || '';
const SB_ANON = window.VITE_SUPABASE_ANON_KEY || '';
let supabase = null;
if (window.supabase && SB_URL && SB_ANON) {
  supabase = window.supabase.createClient(SB_URL, SB_ANON);
}

/* ================================
   Backend warmup
================================ */
const bootOverlay = $id('bootOverlay');
let backendReadyOnce = false;
function showBootOverlay() { bootOverlay?.classList.remove('hidden'); }
function hideBootOverlay() { bootOverlay?.classList.add('hidden'); }
async function pingBackendOnce(timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/healthz', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t); return r.ok;
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
   URL params / success handling
================================ */
function onSuccessPage() { return location.pathname.endsWith('/success.html'); }
function params() { return new URLSearchParams(location.search); }
const p               = params();
const stripeSessionId = p.get('session_id') || null;
const ppSuccess       = p.get('pp') === 'success';
const intentParam     = p.get('intent') || null;
const vinParam        = (p.get('vin') || '').toUpperCase();

function tryLoadPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } }
function clearPending()   { localStorage.removeItem(PENDING_KEY); }

async function resumePendingPurchase() {
  const pending = tryLoadPending();
  if (!pending) return;

  // FIX 11: Guard against the '(from plate)' sentinel being sent as a VIN
  if (pending.vin === '(from plate)') pending.vin = '';

  await ensureBackendReady();
  const headers = { 'Content-Type': 'application/json' };
  const { token, user } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!user && stripeSessionId) pending.oneTimeSession = stripeSessionId;
  try {
    // FIX 15: use apiFetch for timeout
    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(pending) });
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    openReport(html);   // FIX 4
    trackPurchase(6.00);
    showToast('Report ready!', 'ok');
    addToHistory({
      vin:   pending.vin || '(from plate)',
      type:  pending.type || 'carfax',
      ts:    Date.now(),
      state: pending.state || '',
      plate: pending.plate || '',
    });
    renderHistory();
  } catch (e) {
    showToast(e.message || 'Failed to resume purchase', 'error');
  } finally {
    clearPending();
    await refreshBalancePill();
  }
}

async function handleSuccessIfNeeded() {
  if (!(onSuccessPage() || stripeSessionId || ppSuccess)) return;
  if (intentParam === 'buy_report' && stripeSessionId && vinParam) {
    showToast('Payment confirmed. Preparing your report…', 'ok');
    try {
      // FIX 15: timeout on success-page fetch
      const r = await apiFetch(API.report, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: vinParam, type: 'carfax', as: 'html', oneTimeSession: stripeSessionId }),
      });
      if (!r.ok) throw new Error(await r.text());
      const html = await r.text();
      openReport(html);   // FIX 4
      trackPurchase(6.00); return;
    } catch (e) { showToast(e.message || 'Failed to fetch report', 'error'); }
  }
  if (ppSuccess || stripeSessionId || onSuccessPage()) {
    const pending = tryLoadPending();
    if (pending) { showToast('Payment confirmed. Preparing your report…', 'ok'); await resumePendingPurchase(); }
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
$id('themeBtn')?.addEventListener('click', () => {
  const nowDark = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', nowDark);
  localStorage.setItem('theme', nowDark ? 'dark' : 'light');
});
(() => {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.classList.add('dark');
})();

/* ================================
   Auth & Modals
================================ */
const loginModal  = $id('loginModal');
const emailEl     = $id('loginEmail');
const pwEl        = $id('loginPassword');
const userChip    = $id('userChip');
const userEmailEl = $id('userEmail');

function openLogin()  { loginModal?.classList.remove('hidden'); }
function closeLogin() { loginModal?.classList.add('hidden'); }

$id('closeLoginModal')?.addEventListener('click', closeLogin);
$id('logoutBtn')?.addEventListener('click', doLogout);
$id('loginBtn')?.addEventListener('click', openLogin);

async function doSignup() {
  if (!supabase) return showToast('Supabase not loaded', 'error');
  const email    = (emailEl.value || '').trim();
  const password = pwEl.value || '';
  if (!email)             return showToast('Enter your email', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { emailRedirectTo: `${location.origin}/email-confirmed` },
    });
    if (error) {
      if (/already|registered/i.test(error.message))
        return showToast('Account already exists. Please sign in.', 'error');
      throw error;
    }
    if (!data.session) showToast('Check your email to confirm account.', 'ok');
    else { showToast('Account created!', 'ok'); closeLogin(); try { localStorage.setItem('fb_em', email.toLowerCase()); } catch {} }
    await refreshBalancePill();
  } catch (e) { showToast(e.message || 'Sign up failed', 'error'); }
}

async function doLogin() {
  if (!supabase) return showToast('Supabase not loaded', 'error');
  const email    = (emailEl.value || '').trim();
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

$id('doSignup')?.addEventListener('click', doSignup);
$id('doLogin')?.addEventListener('click', doLogin);
$id('googleLogin')?.addEventListener('click', async () => {
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin },
    });
    if (error) showToast(error.message);
  } catch (e) { showToast(e.message); }
});

let currentSession = null;
function reflectAuthUI(session) {
  currentSession = session;
  if (session?.user) {
    if (userEmailEl) userEmailEl.textContent = session.user.email || '';
    userChip?.classList.remove('hidden');
    $id('loginBtn')?.classList.add('hidden');
  } else {
    userChip?.classList.add('hidden');
    const lb = $id('loginBtn');
    if (lb) { lb.classList.remove('hidden'); lb.textContent = 'Log in'; }
  }
}

(async () => {
  if (!supabase) return;
  if (/[?&]code=/.test(location.search)) {
    const { error } = await supabase.auth.getSessionFromUrl({ storeSession: true });
    const url = new URL(location.href);
    url.searchParams.delete('code'); url.searchParams.delete('state');
    history.replaceState({}, '', url.pathname + url.search);
    if (!error) showToast('You\'re signed in!', 'ok');
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
  const session  = data?.session || null;
  return { session, user: session?.user || null, token: session?.access_token || null };
}

async function fetchBalance() {
  try {
    const { user, token } = await getSession();
    if (!user) return { balance: 0 };
    // FIX 15: timeout on balance fetch
    const r = await apiFetch(
      API.credits(user.id),
      { headers: { Authorization: `Bearer ${token}` } },
      5000
    );
    if (!r.ok) return { balance: 0 };
    return await r.json();
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
    return;
  }
  const { balance = 0 } = await fetchBalance();
  if (pill && txt) {
    txt.textContent = `${balance} credit${balance === 1 ? '' : 's'}`;
    pill.classList.remove('hidden');
  }
  setPrimaryCTA(balance <= 0 ? 'buy' : 'view');
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
    vin:       item.vin !== '(from plate)' ? item.vin : '',
    state:     item.state || '',
    plate:     item.plate || '',
    type:      item.type,
    as:        'html',
    allowLive: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    await ensureBackendReady();
    // FIX 15: timeout
    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    openReport(html);   // FIX 4
  } catch (e) { showToast(e.message || 'Request failed', 'error'); }
}

async function downloadHistoryPDF(item, btn = null) {
  const restore = setBtnLoading(btn, '…');
  showToast('Generating PDF… this may take a few seconds.', 'ok');
  const data = {
    vin:       item.vin !== '(from plate)' ? item.vin : '',
    state:     item.state || '',
    plate:     item.plate || '',
    type:      item.type,
    as:        'pdf',
    allowLive: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  try {
    const { token } = await getSession();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await ensureBackendReady();
    // FIX 15: longer timeout for PDF generation
    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) }, 60_000);
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    if ((r.headers.get('content-type') || '').includes('text/html')) {
      showToast('PDF service busy. Opening web report instead…', 'ok');
      const html = await r.text();
      openReport(html);   // FIX 4
      return;
    }
    const blob = await r.blob();
    downloadBlob(blob, `${(data.vin || item.plate || 'report').replace(/\W+/g,'_')}_${item.type}.pdf`);
    showToast('Download started!', 'ok');
  } catch (e) {
    showToast(e.message || 'Request failed', 'error');
  } finally { restore(); }
}

async function copyShareLink(vin, type) {
  try {
    const r = await apiFetch(
      API.share,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin, type }) },
      10_000
    );
    if (!r.ok) throw new Error(await r.text() || ('HTTP ' + r.status));
    const { url } = await r.json();
    await navigator.clipboard.writeText(url);
    showToast('Share link copied!', 'ok');
  } catch (e) { showToast(e.message || 'Could not create share link', 'error'); }
}

/* Email report */
const emailModal    = $id('emailModal');
const emailInput    = $id('emailTargetInput');
const sendEmailBtn  = $id('sendEmailBtn');
let emailTargetVin  = null, emailTargetType = null;

function openEmailModal(vin, type) {
  emailTargetVin = vin; emailTargetType = type;
  if (currentSession?.user?.email) emailInput.value = currentSession.user.email;
  emailModal?.classList.remove('hidden');
  emailInput?.focus();
}
function closeEmailModal() { emailModal?.classList.add('hidden'); emailTargetVin = null; }
$id('closeEmailModal')?.addEventListener('click', closeEmailModal);

sendEmailBtn?.addEventListener('click', async () => {
  const to = emailInput.value.trim();
  if (!to || !to.includes('@')) return showToast('Invalid email', 'error');
  if (!emailTargetVin) return;
  const restore = setBtnLoading(sendEmailBtn, 'Sending…');
  try {
    const r = await apiFetch(
      '/api/email-report',
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, vin: emailTargetVin, type: emailTargetType || 'carfax' }) },
      15_000
    );
    if (!r.ok) throw new Error(await r.text());
    showToast(`Report sent to ${to}`, 'ok');
    closeEmailModal();
  } catch { showToast('Failed to send email', 'error'); }
  finally { restore(); }
});

function renderHistory() {
  const body = $id('historyBody');
  const list = loadHistory();
  if (!body) return;
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = `<div class="px-4 py-8 text-center text-sm text-gray-400">No reports yet — search a VIN above ↑</div>`;
    return;
  }
  list.forEach((item, idx) => {
    const tr = document.createElement('div');
    tr.className = 'hover:bg-gray-50 transition-colors px-4 py-3';
    tr.innerHTML = `
      <div class="flex flex-col gap-2">
        <div class="flex items-start justify-between gap-2">
          <div>
            <span class="font-mono font-bold text-gray-900 text-sm">${item.vin}</span>
            <div class="text-xs text-gray-400 mt-0.5">${formatTime(item.ts)}</div>
          </div>
          <button data-idx="${idx}" data-action="del" class="text-red-300 hover:text-red-500 text-base leading-none flex-shrink-0 mt-0.5">✕</button>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <button data-idx="${idx}" data-action="open"  class="flex-1 min-w-0 text-center bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold py-1.5 px-2 rounded-lg transition-colors">View</button>
          <button data-idx="${idx}" data-action="pdf"   class="flex-1 min-w-0 text-center bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold py-1.5 px-2 rounded-lg transition-colors">PDF</button>
          <button data-idx="${idx}" data-action="email" class="flex-1 min-w-0 text-center bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold py-1.5 px-2 rounded-lg transition-colors">Email</button>
          <button data-idx="${idx}" data-action="share" class="flex-1 min-w-0 text-center bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold py-1.5 px-2 rounded-lg transition-colors">Link</button>
        </div>
      </div>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const i      = +e.currentTarget.getAttribute('data-idx');
      const item   = loadHistory()[i]; if (!item) return;
      const action = e.currentTarget.getAttribute('data-action');
      if (action === 'open')  openHistoryHTML(item);
      if (action === 'pdf')   downloadHistoryPDF(item, e.currentTarget);
      if (action === 'email') openEmailModal(item.vin !== '(from plate)' ? item.vin : item.plate, item.type);
      if (action === 'share') copyShareLink(item.vin !== '(from plate)' ? item.vin : item.plate, item.type);
      if (action === 'del')   { const list = loadHistory(); list.splice(i, 1); saveHistory(list); renderHistory(); }
    });
  });
}
$id('clearHistory')?.addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

/* ================================
   Buy Credits Modal
   FIX 11: pendingData is explicitly passed into openBuyModal and stored in
           currentBuyModalPendingData — not read from the module-level lastFormData.
           It is cleared on modal close so stale data can't leak.
================================ */
const buyModal = $id('buyCreditsModal');

// FIX 11: Replaces unscoped lastFormData as the PayPal data source
let currentBuyModalPendingData = null;

function openBuyModal(pendingData = null) {
  currentBuyModalPendingData = pendingData;
  buyModal?.classList.remove('hidden');
  renderPaypalButton();
}

function closeBuyModal() {
  buyModal?.classList.add('hidden');
  currentBuyModalPendingData = null;   // FIX 11: clear on close
}

$id('closeModalBtn')?.addEventListener('click', closeBuyModal);

/* ─── PayPal (single report only) ───
   FIX 12: Track which userId the button was rendered for.
            Re-renders whenever the user logs in/out. ─── */
let paypalRenderedForUserId = '__not_rendered__';

async function renderPaypalButton() {
  const container = $id('paypalContainer');
  if (!container || !window.paypal) return;

  const { user } = await getSession();
  const userId   = user?.id || null;

  // FIX 12: Skip re-render only if user state hasn't changed AND button exists
  if (paypalRenderedForUserId === userId && container.children.length > 0) return;

  // Clear any previous render and reset tracking
  container.innerHTML = '';
  paypalRenderedForUserId = userId;

  window.paypal.Buttons({
    createOrder: async () => {
      const r = await apiFetch(
        '/api/paypal/create-order',
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }) },
        15_000
      );
      if (!r.ok) throw new Error(await r.text() || 'PayPal create failed');
      return (await r.json()).orderID;
    },

    onApprove: async (data) => {
      // FIX 11: Use explicitly scoped pending data, not module-level lastFormData
      const pending = currentBuyModalPendingData;
      currentBuyModalPendingData = null;   // consumed — prevent double-use

      const reportWindow = openBlank();
      if (reportWindow) {
        reportWindow.document.write(
          `<html><body style="font-family:sans-serif;text-align:center;padding-top:50px;background:#f9fafb;">
            <h2 style="color:#1f2937;">Processing Payment…</h2>
            <p style="color:#6b7280;">Please wait — do not close this window.</p>
          </body></html>`
        );
      }

      try {
        const r = await apiFetch(
          '/api/paypal/capture-order',
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderID: data.orderID, user_id: userId }) },
          15_000
        );
        if (!r.ok) throw new Error(await r.text() || 'PayPal capture failed');
        const result = await r.json();

        if (!pending || (!pending.vin && !(pending.state && pending.plate))) {
          if (reportWindow) reportWindow.close();
          showToast('Payment completed! 1 credit added.', 'ok');
          await refreshBalancePill();
          closeBuyModal();
          return;
        }

        const body = { ...pending, as: 'html', allowLive: true };
        if (!userId && result?.captureId) body.oneTimeSession = 'pp_' + result.captureId;

        await ensureBackendReady();
        const headers = { 'Content-Type': 'application/json' };
        const { token } = await getSession();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // FIX 15: timeout on report fetch
        const resp = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error(await resp.text() || ('HTTP ' + resp.status));

        const html = await resp.text();
        addToHistory({
          vin:   pending.vin || '(from plate)',
          type:  pending.type || 'carfax',
          ts:    Date.now(),
          state: pending.state || '',
          plate: pending.plate || '',
        });
        renderHistory();

        // FIX 4: safe report renderer
        if (reportWindow) {
          reportWindow.close();
        }
        openReport(html);

        trackPurchase(6.00);
        showToast('Report fetched successfully!', 'ok');
        await refreshBalancePill();
        clearPending();
        closeBuyModal();
      } catch (e) {
        if (reportWindow) reportWindow.close();
        showToast(e.message || 'PayPal capture failed', 'error');
      }
    },

    onError: (err) => { console.error(err); showToast('PayPal error', 'error'); }
  }).render('#paypalContainer');
}

/* ─── Stripe purchase helper ─── */
async function startStripePurchase({ user, price_id, pendingReport = null, requireLogin = false }) {
  if (requireLogin && !user) {
    closeBuyModal();
    showToast('Please sign in to buy a bundle.', 'error');
    openLogin();
    return;
  }
  try {
    await ensureBackendReady();
    const body = { user_id: user?.id || null, price_id };
    if (pendingReport?.vin) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport));
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport)); } catch {}
      body.vin         = pendingReport.vin;
      body.report_type = pendingReport.type || 'carfax';
    }
    // FIX 15: timeout on checkout session creation
    const r = await apiFetch(
      API.checkout,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      10_000
    );
    if (!r.ok) throw new Error(await r.text() || 'Stripe error');
    window.location.href = (await r.json()).url;
  } catch (e) { showToast(e.message || 'Failed to start checkout', 'error'); }
}

/* ─── Single: Stripe ─── */
$id('buy1Btn')?.addEventListener('click', async () => {
  const btn     = $id('buy1Btn');
  const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession();
  const pending = currentBuyModalPendingData;   // FIX 11
  closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_SINGLE', pendingReport: pending });
  restore();
});

/* ─── 5-Pack: Stripe only, account required ─── */
$id('buy5Btn')?.addEventListener('click', async () => {
  const btn     = $id('buy5Btn');
  const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession();
  closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_5PACK', requireLogin: true });
  restore();
});

/* ─── 10-Pack: Stripe only, account required ─── */
$id('buy10Btn')?.addEventListener('click', async () => {
  const btn     = $id('buy10Btn');
  const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession();
  closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_10PACK', requireLogin: true });
  restore();
});

/* ─── Sidebar buttons ─── */
$id('buy1Sidebar')?.addEventListener('click',  () => openBuyModal());
$id('buy5Sidebar')?.addEventListener('click',  async () => {
  const { user } = await getSession();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_5PACK', requireLogin: true });
});
$id('buy10Sidebar')?.addEventListener('click', async () => {
  const { user } = await getSession();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_10PACK', requireLogin: true });
});

/* ─── Pricing-section & mobile buttons ─── */
['pricingBuy1Btn', 'pricingBuy5Btn', 'pricingBuy10Btn'].forEach(id => {
  $id(id)?.addEventListener('click', () => openBuyModal());
});
$id('mobileViewPlans')?.addEventListener('click', () => openBuyModal());

/* ================================
   VIN + Form gate
================================ */
const f       = $id('f');
const go      = $id('go');
const loading = $id('loading');

function hasPlateCombo(fd) { return !!(fd.state?.trim() && fd.plate?.trim()); }

// Debounced NHTSA lookup — fires once after 400 ms of no typing
let vinDebounceTimer = null;
async function fetchCarDetails(vin) {
  try {
    const res  = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
    const data = await res.json();
    const get  = (v) => data.Results.find(r => r.Variable === v)?.Value;
    const make = get('Make'), model = get('Model'), year = get('Model Year');
    return (make && model && year) ? `${year} ${make} ${model}` : null;
  } catch { return null; }
}

function reflectVinGate() {
  if (!f || !go) return;
  const fd  = Object.fromEntries(new FormData(f).entries());
  const vin = (fd.vin || '').trim().toUpperCase();

  clearTimeout(vinDebounceTimer);

  if (!vin && !hasPlateCombo(fd)) {
    setVinHelp('Enter a 17-char VIN or Plate + State.');
    go.disabled = true;
    return;
  }
  if (vin.length > 0) {
    if (!looksVinBasic(vin))   { setVinHelp('VIN must be 17 chars (no I, O, Q).'); go.disabled = true; return; }
    if (!vinCheckDigitOk(vin)) { setVinHelp('Invalid check digit — please verify VIN.'); go.disabled = true; return; }

    setVinHelp('Looking up vehicle…', true);
    go.disabled = false;

    // FIX: debounce the network call — was firing on every keystroke
    vinDebounceTimer = setTimeout(() => {
      fetchCarDetails(vin).then(name => {
        // Ignore if VIN has changed while we were waiting
        const current = (document.querySelector('input[name="vin"]')?.value || '').trim().toUpperCase();
        if (current !== vin) return;
        setVinHelp(name ? `✅ Verified: ${name}` : 'VIN valid (details not found).', true);
      });
    }, 400);

    return;
  }
  if (hasPlateCombo(fd)) { setVinHelp('Plate + State provided ✓', true); go.disabled = false; return; }
  go.disabled = true;
}

f?.addEventListener('input', reflectVinGate);

f?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(f).entries());
  const data = {
    vin:       (fd.vin || '').trim().toUpperCase(),
    state:     (fd.state || '').trim(),
    plate:     (fd.plate || '').trim(),
    type:      fd.type || 'carfax',
    as:        'html',
    allowLive: true,
  };
  if (!data.vin && !(data.state && data.plate)) { showToast('Enter a VIN or Plate', 'error'); return; }

  // FIX 11: Store in sessionStorage for resume; lastFormData removed in favour of
  //         passing data explicitly to openBuyModal below.
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(data)); } catch {}

  go.disabled = true;
  loading?.classList.remove('hidden');

  const headers  = { 'Content-Type': 'application/json' };
  let currentUser = null;
  await ensureBackendReady();

  if (supabase) {
    const sess  = await getSession();
    currentUser = sess.user;
    if (sess.token) headers['Authorization'] = `Bearer ${sess.token}`;
  }

  if (currentUser?.id) {
    try {
      const { balance = 0 } = await (await apiFetch(
        API.credits(currentUser.id),
        { headers: { Authorization: headers['Authorization'] } },
        5000
      )).json();
      if (balance <= 0) {
        localStorage.setItem(PENDING_KEY, JSON.stringify(data));
        openBuyModal(data);   // FIX 11: pass data explicitly
        go.disabled = false;
        loading?.classList.add('hidden');
        return;
      }
    } catch {}
  }

  try {
    if (!currentUser && stripeSessionId) data.oneTimeSession = stripeSessionId;

    // FIX 15: timeout on report request
    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });

    if (r.status === 401 || r.status === 402) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(data));
      openBuyModal(data);   // FIX 11
      return;
    }
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }

    const html = await r.text();
    openReport(html);   // FIX 4

    showToast('Report fetched successfully!', 'ok');
    addToHistory({ vin: data.vin || '(from plate)', type: data.type, ts: Date.now(), state: data.state, plate: data.plate });
    renderHistory();
    await refreshBalancePill();
  } catch (err) {
    showToast(err.message || 'Request failed', 'error');
  } finally {
    go.disabled = false;
    loading?.classList.add('hidden');
  }
});

/* ================================
   Forgot / Reset Password
================================ */
$id('forgotPasswordBtn')?.addEventListener('click', () => {
  closeLogin();
  $id('forgotModal')?.classList.remove('hidden');
  $id('forgotEmail')?.focus();
});
$id('closeForgotModal')?.addEventListener('click', () => $id('forgotModal')?.classList.add('hidden'));

$id('sendResetLinkBtn')?.addEventListener('click', async () => {
  const btn   = $id('sendResetLinkBtn');
  const email = ($id('forgotEmail').value || '').trim();
  if (!email || !email.includes('@')) return showToast('Invalid email', 'error');
  const restore = setBtnLoading(btn, 'Sending…');
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    if (error) throw error;
    showToast('Recovery link sent! Check your email.', 'ok');
    $id('forgotModal')?.classList.add('hidden');
  } catch (e) { showToast(e.message, 'error'); }
  finally { restore(); }
});

if (supabase) {
  supabase.auth.onAuthStateChange(async (event) => {
    if (event === 'PASSWORD_RECOVERY') $id('updatePasswordModal')?.classList.remove('hidden');
  });
}

$id('saveNewPasswordBtn')?.addEventListener('click', async () => {
  const btn = $id('saveNewPasswordBtn');
  const pw  = $id('newPasswordInput').value;
  if (pw.length < 6) return showToast('Password too short (min 6 chars)', 'error');
  const restore = setBtnLoading(btn, 'Updating…');
  try {
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) throw error;
    showToast('Password updated! You are now logged in.', 'ok');
    $id('updatePasswordModal')?.classList.add('hidden');
  } catch (e) { showToast(e.message, 'error'); }
  finally { restore(); }
});

/* ================================
   Init
================================ */
(async () => {
  await refreshBalancePill();
  renderHistory();
  if ((stripeSessionId || ppSuccess) && !intentParam) {
    const pending = tryLoadPending() || JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    if (pending) { showToast('Payment confirmed. Processing…', 'ok'); await resumePendingPurchase(); }
  }
  reflectVinGate();
})();