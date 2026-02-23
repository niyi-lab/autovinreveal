// app.js

/* ================================
   Config & Utilities
================================ */
const API = {
  report:   '/api/report',
  checkout: '/api/create-checkout-session',
  credits:  (uid) => `/api/credits/${uid}`,
  share:    '/api/share',
};

const PENDING_KEY = 'pendingReport';
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

/** Track a purchase event via Facebook Pixel, silently ignoring errors. */
function trackPurchase(value = 7.00) {
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

/** Disable a button and show a loading spinner; returns a restore function. */
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
   VIN Validation (ISO 3779)
================================ */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
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
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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
const p = params();
const stripeSessionId = p.get('session_id') || null;
const ppSuccess       = p.get('pp') === 'success';
const intentParam     = p.get('intent') || null;
const vinParam        = (p.get('vin') || '').toUpperCase();

function tryLoadPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } }
function clearPending()   { localStorage.removeItem(PENDING_KEY); }

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
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else   { document.open(); document.write(html); document.close(); }
    trackPurchase(7.00);
    showToast('Report ready!', 'ok');
    addToHistory({ vin: pending.vin || '(from plate)', type: pending.type || 'carfax', ts: Date.now(), state: pending.state || '', plate: pending.plate || '' });
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
      const r = await fetch(API.report, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: vinParam, type: 'carfax', as: 'html', oneTimeSession: stripeSessionId })
      });
      if (!r.ok) throw new Error(await r.text());
      const html = await r.text();
      document.open(); document.write(html); document.close();
      trackPurchase(7.00); return;
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
const loginModal    = $id('loginModal');
const emailEl       = $id('loginEmail');
const pwEl          = $id('loginPassword');
const userChip      = $id('userChip');
const userEmailEl   = $id('userEmail');

function openLogin()  { loginModal?.classList.remove('hidden'); }
function closeLogin() { loginModal?.classList.add('hidden'); }

$id('closeLoginModal')?.addEventListener('click', closeLogin);
$id('logoutBtn')?.addEventListener('click', doLogout);
$id('loginBtn')?.addEventListener('click', openLogin);

async function doSignup() {
  if (!supabase) return showToast('Supabase not loaded', 'error');
  const email = (emailEl.value || '').trim();
  const password = pwEl.value || '';
  if (!email) return showToast('Enter your email', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');
  try {
    const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/email-confirmed` } });
    if (error) {
      if (/already|registered/i.test(error.message)) return showToast('Account already exists. Please sign in.', 'error');
      throw error;
    }
    if (!data.session) showToast('Check your email to confirm account.', 'ok');
    else { showToast('Account created!', 'ok'); closeLogin(); try { localStorage.setItem('fb_em', email.toLowerCase()); } catch {} }
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

$id('doSignup')?.addEventListener('click', doSignup);
$id('doLogin')?.addEventListener('click', doLogin);
$id('googleLogin')?.addEventListener('click', async () => {
  try {
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
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
  const data = { vin: item.vin !== '(from plate)' ? item.vin : '', state: item.state || '', plate: item.plate || '', type: item.type, as: 'html', allowLive: false };
  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    await ensureBackendReady();
    const viewer = openBlank();
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { if (viewer) viewer.close(); showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    if (viewer) { viewer.document.write(html); viewer.document.close(); }
    else { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } }
  } catch (e) { showToast(e.message || 'Request failed', 'error'); }
}

async function downloadHistoryPDF(item, btn = null) {
  const restore = setBtnLoading(btn, '…');
  showToast('Generating PDF… this may take a few seconds.', 'ok');
  const data = { vin: item.vin !== '(from plate)' ? item.vin : '', state: item.state || '', plate: item.plate || '', type: item.type, as: 'pdf', allowLive: false };
  const headers = { 'Content-Type': 'application/json' };
  try {
    const { token } = await getSession();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await ensureBackendReady();
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    if ((r.headers.get('content-type') || '').includes('text/html')) {
      showToast('PDF service busy. Opening web report instead…', 'ok');
      const html = await r.text();
      const w = window.open('', '_blank');
      if (w) { w.document.write(html); w.document.close(); }
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
    const r = await fetch(API.share, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin, type }) });
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
    const r = await fetch('/api/email-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, vin: emailTargetVin, type: emailTargetType || 'carfax' }) });
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
      const i = +e.currentTarget.getAttribute('data-idx');
      const item = loadHistory()[i]; if (!item) return;
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
================================ */
const buyModal = $id('buyCreditsModal');
function openBuyModal()  { buyModal?.classList.remove('hidden'); renderPaypalButton(); }
function closeBuyModal() { buyModal?.classList.add('hidden'); }
$id('closeModalBtn')?.addEventListener('click', closeBuyModal);

/* ─── PayPal (single report only) ─── */
let paypalRendered = false;
async function renderPaypalButton() {
  if (paypalRendered) return;
  const container = $id('paypalContainer');
  if (!container || !window.paypal) return;
  paypalRendered = true;
  const { user } = await getSession();

  window.paypal.Buttons({
    createOrder: async () => {
      const r = await fetch('/api/paypal/create-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: user?.id || null }) });
      if (!r.ok) throw new Error(await r.text() || 'PayPal create failed');
      return (await r.json()).orderID;
    },
    onApprove: async (data) => {
      const reportWindow = openBlank();
      if (reportWindow) {
        reportWindow.document.write(`<html><body style="font-family:sans-serif;text-align:center;padding-top:50px;background:#f9fafb;">
          <h2 style="color:#1f2937;">Processing Payment…</h2>
          <p style="color:#6b7280;">Please wait — do not close this window.</p>
        </body></html>`);
      }
      try {
        const r = await fetch('/api/paypal/capture-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderID: data.orderID, user_id: user?.id || null }) });
        if (!r.ok) throw new Error(await r.text() || 'PayPal capture failed');
        const result = await r.json();

        let pending = tryLoadPending();
        if (!pending || (!pending.vin && !(pending.state && pending.plate))) pending = lastFormData || null;

        if (!pending || (!pending.vin && !(pending.state && pending.plate))) {
          if (reportWindow) reportWindow.close();
          showToast('Payment completed! 1 credit added.', 'ok');
          await refreshBalancePill();
          closeBuyModal();
          return;
        }

        const body = { ...pending, as: 'html', allowLive: true };
        if (!user && result?.captureId) body.oneTimeSession = 'pp_' + result.captureId;

        await ensureBackendReady();
        const headers = { 'Content-Type': 'application/json' };
        const { token } = await getSession();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error(await resp.text() || ('HTTP ' + resp.status));

        const html = await resp.text();
        addToHistory({ vin: pending.vin || '(from plate)', type: pending.type || 'carfax', ts: Date.now(), state: pending.state || '', plate: pending.plate || '' });
        renderHistory();

        if (reportWindow) { reportWindow.document.open(); reportWindow.document.write(html); reportWindow.document.close(); reportWindow.focus(); }
        else { document.open(); document.write(html); document.close(); }

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
  // Guard: bundles require an account
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
      // Also back up to sessionStorage in case localStorage is cleared
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport)); } catch {}
      body.vin = pendingReport.vin;
      body.report_type = pendingReport.type || 'carfax';
    }
    const r = await fetch(API.checkout, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text() || 'Stripe error');
    window.location.href = (await r.json()).url;
  } catch (e) { showToast(e.message || 'Failed to start checkout', 'error'); }
}

let lastFormData = null;

/* ─── Single: Stripe ─── */
$id('buy1Btn')?.addEventListener('click', async () => {
  const btn = $id('buy1Btn');
  const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession();
  closeBuyModal();
  // No requireLogin — anonymous checkout OK for single report
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_SINGLE', pendingReport: lastFormData || null });
  restore();
});

/* ─── 5-Pack: Stripe only, account required ─── */
$id('buy5Btn')?.addEventListener('click', async () => {
  const btn = $id('buy5Btn');
  const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession();
  closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_5PACK', requireLogin: true });
  restore();
});

/* ─── 10-Pack: Stripe only, account required ─── */
$id('buy10Btn')?.addEventListener('click', async () => {
  const btn = $id('buy10Btn');
  const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession();
  closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_10PACK', requireLogin: true });
  restore();
});

/* ─── Sidebar buttons ─── */
$id('buy1Sidebar')?.addEventListener('click', () => openBuyModal());
$id('buy5Sidebar')?.addEventListener('click', async () => {
  const { user } = await getSession();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_5PACK', requireLogin: true });
});
$id('buy10Sidebar')?.addEventListener('click', async () => {
  const { user } = await getSession();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_10PACK', requireLogin: true });
});

/* ─── Pricing-section buttons ─── */
['pricingBuy1Btn', 'pricingBuy5Btn', 'pricingBuy10Btn'].forEach(id => {
  $id(id)?.addEventListener('click', () => openBuyModal());
});

/* ─── Mobile "Plans" button ─── */
$id('mobileViewPlans')?.addEventListener('click', () => openBuyModal());

/* ================================
   VIN + Form gate
================================ */
const f       = $id('f');
const go      = $id('go');
const loading = $id('loading');

function hasPlateCombo(fd) { return !!(fd.state?.trim() && fd.plate?.trim()); }

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

  if (!vin && !hasPlateCombo(fd)) { setVinHelp('Enter a 17-char VIN or Plate + State.'); go.disabled = true; return; }
  if (vin.length > 0) {
    if (!looksVinBasic(vin))      { setVinHelp('VIN must be 17 chars (no I, O, Q).'); go.disabled = true; return; }
    if (!vinCheckDigitOk(vin))    { setVinHelp('Invalid check digit — please verify VIN.'); go.disabled = true; return; }
    setVinHelp('Checking vehicle details…', true);
    fetchCarDetails(vin).then(name => {
      if (new FormData(f).get('vin')?.trim().toUpperCase() !== vin) return;
      setVinHelp(name ? `✅ Verified: ${name}` : 'VIN valid (details not found).', true);
    });
    go.disabled = false; return;
  }
  if (hasPlateCombo(fd)) { setVinHelp('Plate + State provided ✓', true); go.disabled = false; return; }
  go.disabled = true;
}

f?.addEventListener('input', reflectVinGate);

f?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(f).entries());
  const data = {
    vin:      (fd.vin || '').trim().toUpperCase(),
    state:    (fd.state || '').trim(),
    plate:    (fd.plate || '').trim(),
    type:     fd.type || 'carfax',
    as:       'html',
    allowLive: true
  };
  if (!data.vin && !(data.state && data.plate)) { showToast('Enter a VIN or Plate', 'error'); return; }

  // Persist so PayPal / Stripe can resume
  lastFormData = data;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(data)); } catch {}

  go.disabled = true;
  loading?.classList.remove('hidden');

  const headers = { 'Content-Type': 'application/json' };
  let currentUser = null, token = null;
  await ensureBackendReady();

  if (supabase) {
    const sess = await getSession();
    currentUser = sess.user; token = sess.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  // Check balance for logged-in users
  if (currentUser?.id) {
    try {
      const { balance = 0 } = await (await fetch(API.credits(currentUser.id))).json();
      if (balance <= 0) { localStorage.setItem(PENDING_KEY, JSON.stringify(data)); openBuyModal(); go.disabled = false; loading?.classList.add('hidden'); return; }
    } catch {}
  }

  try {
    if (!currentUser && stripeSessionId) data.oneTimeSession = stripeSessionId;
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (r.status === 401 || r.status === 402) { localStorage.setItem(PENDING_KEY, JSON.stringify(data)); openBuyModal(); return; }
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }

    const html = await r.text();
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else   { document.open(); document.write(html); document.close(); }

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