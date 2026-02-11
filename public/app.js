// app.js

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
  if (!box) { alert(message); return; }
  const el = document.createElement('div');
  el.className = `transform transition-all duration-300 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${type === 'error' ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-green-50 text-green-700 border border-green-100'}`;
  
  const icon = type === 'error' 
    ? `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
    : `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;

  el.innerHTML = `${icon}<span>${message}</span>`;
  box.appendChild(el);
  
  requestAnimationFrame(() => {
    el.style.transform = 'translateY(0)';
    el.style.opacity = '1';
  });

  setTimeout(() => {
    el.style.transition = 'all 0.5s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
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

/* ================================
   VIN Validation (ISO 3779)
================================ */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/; 
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
  return vin[8] === expected;
}
function looksVin(v) {
  const vin = (v||'').toUpperCase().trim();
  if (!looksVinBasic(vin)) return false;
  return vinCheckDigitOk(vin);
}

/* UI Helpers */
function ensureVinHelpEl() {
  let help = $id('vinHelp');
  if (!help) {
    const vinInput = document.querySelector('input[name="vin"]');
    if (!vinInput) return null;
    const container = vinInput.closest('.group'); 
    help = document.createElement('div');
    help.id = 'vinHelp';
    help.className = 'text-xs mt-2 font-medium transition-all';
    container.appendChild(help);
  }
  return help;
}
function setVinHelp(text, ok=false) {
  const el = ensureVinHelpEl();
  if (!el) return;
  el.textContent = text || '';
  el.className = `text-xs mt-2 font-medium transition-all ${ok ? 'text-green-600' : 'text-red-500'}`;
}

/* ================================
   Primary CTA switcher: 'view' | 'buy'
================================ */
function setPrimaryCTA(mode = 'view') {
  const btn = $id('go');
  if (!btn) return;

  btn.className = "glow-btn w-full bg-blue-600 hover:bg-blue-700 text-white h-14 rounded-xl font-bold text-lg shadow-xl shadow-blue-600/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed";

  if (mode === 'buy') {
    btn.type = 'button';
    btn.innerHTML = `
      <span>Buy Credits</span>
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    `;
    btn.onclick = async () => {
      const { user } = await getSession();
      if (!user) { openLogin(); return; }
      openBuyModal();
    };
  } else {
    btn.type = 'submit';
    btn.innerHTML = `
      <span>Get CARFAX Report Now</span>
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"></path></svg>
    `;
    btn.onclick = null;
  }
}

/* ================================
   Supabase init
================================ */
const SB_URL = window.VITE_SUPABASE_URL || '';
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
   Success Handling (Stripe/PayPal)
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

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else { document.open(); document.write(html); document.close(); }

    try {
      fbq('track', 'Purchase', { value: 7.00, currency: 'USD', contents: [{ id: 'VinReport', quantity: 1 }], content_ids: ['VinReport'], content_type: 'product' });
    } catch {}

    showToast('Report ready!', 'ok');

    addToHistory({
      vin: pending.vin || '(from plate)', type: pending.type || 'carfax', ts: Date.now(),
      state: pending.state || '', plate: pending.plate || ''
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
}
themeBtn?.addEventListener('click', () => {
  const nowDark = !document.documentElement.classList.contains('dark');
  setTheme(nowDark ? 'dark' : 'light');
});
(() => {
  const saved = localStorage.getItem('theme');
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'dark' || (!saved && prefersDark)) document.documentElement.classList.add('dark');
})();

/* ================================
   Auth & Modals
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
      if (msg.includes('already') || msg.includes('registered')) {
        showToast('Account already exists. Please sign in.', 'error');
        return;
      }
      throw error;
    }

    if (!data.session) showToast('Check your email to confirm account.', 'ok');
    else {
      showToast('Account created!', 'ok'); closeLogin();
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
    if (error) showToast(error.message);
  } catch (e) { showToast(e.message); }
});

let currentSession = null;
function reflectAuthUI(session) {
  currentSession = session;
  if (session?.user) {
    if (userEmailEl) userEmailEl.textContent = session.user.email || '';
    userChip?.classList.remove('hidden');
    loginBtn?.classList.add('hidden');
  } else {
    userChip?.classList.add('hidden');
    loginBtn?.classList.remove('hidden');
    if (loginBtn) loginBtn.textContent = 'Log in';
  }
}

(async () => {
  if (!supabase) return;
  const fromAuthLink = /[?&]code=/.test(location.search);
  if (fromAuthLink) {
    const { error } = await supabase.auth.getSessionFromUrl({ storeSession: true });
    const url = new URL(location.href);
    url.searchParams.delete('code'); url.searchParams.delete('state');
    history.replaceState({}, '', url.pathname + url.search);
    if (!error) showToast('You’re signed in!', 'ok');
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
    return;
  }

  const { balance = 0 } = await fetchBalance();
  if (pill && txt) {
    txt.textContent = `${balance} credit${balance === 1 ? '' : 's'}`;
    pill.classList.remove('hidden');
  }

  if (balance <= 0) setPrimaryCTA('buy');
  else setPrimaryCTA('view');
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
async function downloadHistoryPDF(item, btn = null) {
  let originalText = '';
  if (btn) {
    originalText = btn.textContent;
    btn.textContent = '...'; 
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
  }

  showToast('Generating PDF... this may take a few seconds.', 'ok');

  const data = {
    vin: item.vin && item.vin !== '(from plate)' ? item.vin : '',
    state: item.state || '', plate: item.plate || '',
    type: item.type, as: 'pdf', allowLive: false
  };

  const headers = { 'Content-Type': 'application/json' };
  
  try {
    const { token } = await getSession();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    await ensureBackendReady();
    
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    
    if (!r.ok) { 
      const t = await r.text(); 
      showToast(t || ('HTTP ' + r.status), 'error'); 
      return; 
    }

    // Check if server fell back to HTML because PDF failed
    const contentType = r.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
        showToast('PDF service busy. Opening web report instead...', 'ok');
        const html = await r.text();
        const w = window.open('', '_blank');
        if (w) { w.document.write(html); w.document.close(); }
        return; 
    }
    
    const blob = await r.blob();
    const nameBase = (data.vin || item.plate || 'report').replace(/\W+/g, '_');
    downloadBlob(blob, `${nameBase}_${item.type}.pdf`);
    
    showToast('Download started!', 'ok');

  } catch (e) { 
    showToast(e.message || 'Request failed', 'error'); 
  } finally {
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  }
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

/* ================================
   Email Report Logic (NEW)
================================ */
const emailModal = $id('emailModal');
const emailInput = $id('emailTargetInput');
const sendEmailBtn = $id('sendEmailBtn');
const closeEmailModalBtn = $id('closeEmailModal');
let emailTargetVin = null;
let emailTargetType = null;

function openEmailModal(vin, type) {
  emailTargetVin = vin;
  emailTargetType = type;
  emailModal?.classList.remove('hidden');
  if (currentSession?.user?.email) {
    emailInput.value = currentSession.user.email;
  }
  emailInput?.focus();
}

function closeEmailModal() {
  emailModal?.classList.add('hidden');
  emailTargetVin = null;
}

closeEmailModalBtn?.addEventListener('click', closeEmailModal);

sendEmailBtn?.addEventListener('click', async () => {
  const to = emailInput.value.trim();
  if (!to || !to.includes('@')) return showToast('Invalid email', 'error');
  if (!emailTargetVin) return;

  sendEmailBtn.disabled = true;
  sendEmailBtn.textContent = 'Sending...';

  try {
    const r = await fetch('/api/email-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, vin: emailTargetVin, type: emailTargetType || 'carfax' })
    });

    if (!r.ok) throw new Error(await r.text());
    
    showToast(`Report sent to ${to}`, 'ok');
    closeEmailModal();
  } catch (e) {
    showToast('Failed to send email', 'error');
  } finally {
    sendEmailBtn.disabled = false;
    sendEmailBtn.textContent = 'Send Now';
  }
});

function renderHistory() {
  const body = $id('historyBody');
  const list = loadHistory();
  if (!body) return;
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="5" class="px-6 py-6 text-center text-sm text-gray-400">No reports generated yet.</td></tr>`;
    return;
  }
  list.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.className = "hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors border-b border-gray-100 dark:border-gray-700";
    tr.innerHTML = `
      <td class="px-6 py-4">
        <div class="flex flex-col">
          <span class="font-mono font-bold text-gray-900 dark:text-white">${item.vin}</span>
          <span class="text-xs text-gray-500 dark:text-gray-400">${formatTime(item.ts)}</span>
        </div>
      </td>
      <td class="px-6 py-4 text-right">
        <div class="flex justify-end gap-3">
           <button data-idx="${idx}" data-action="open" class="text-blue-600 dark:text-blue-400 hover:text-blue-800 text-xs font-bold uppercase">View</button>
           <button data-idx="${idx}" data-action="pdf" class="text-blue-600 dark:text-blue-400 hover:text-blue-800 text-xs font-bold uppercase">PDF</button>
           <button data-idx="${idx}" data-action="email" class="text-gray-500 dark:text-gray-400 hover:text-gray-800 text-xs font-bold uppercase">Email</button>
           <button data-idx="${idx}" data-action="share" class="text-gray-400 hover:text-gray-600 text-xs">Link</button>
           <button data-idx="${idx}" data-action="del" class="text-red-300 hover:text-red-500 text-xs">✕</button>
        </div>
      </td>`;
    body.appendChild(tr);
  });
  
  body.querySelectorAll('button').forEach(btn => {
    const action = btn.getAttribute('data-action');
    btn.addEventListener('click', async (e) => {
      const i = +e.currentTarget.getAttribute('data-idx');
      const item = loadHistory()[i]; if (!item) return;
      
      if (action === 'open') openHistoryHTML(item);
      else if (action === 'pdf') downloadHistoryPDF(item, e.currentTarget);
      else if (action === 'email') openEmailModal(item.vin.replace('(from plate)', '').trim() || item.plate, item.type);
      else if (action === 'share') copyShareLink(item.vin.replace('(from plate)', '').trim() || item.plate, item.type);
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
  return r.json(); 
}

/* ================================
   FIXED: PayPal Button Logic
================================ */
let paypalRendered = false;
async function renderPaypalButton() {
  if (paypalRendered) return;
  const container = document.getElementById('paypalContainer');
  if (!container) return;
  if (!window.paypal) return;
  
  paypalRendered = true;
  const { user } = await getSession();

  window.paypal.Buttons({
    createOrder: () => createPaypalOrder(user),
    
    onApprove: async (data) => {
      const reportWindow = openBlank();
      
      if (reportWindow) {
        reportWindow.document.write(`
          <html><body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#f9fafb;">
            <h2 style="color:#1f2937;">Processing Payment...</h2>
            <p style="color:#6b7280;">Please wait while we generate your report.</p>
            <p><strong>Do not close this window.</strong></p>
          </body></html>
        `);
      }

      try {
        const result = await capturePaypalOrder(data.orderID, user);
        
        let pending = tryLoadPending();
        if (!pending || (!pending.vin && !(pending.state && pending.plate))) pending = lastFormData || null;

        if (!pending || (!pending.vin && !(pending.state && pending.plate))) {
          if (reportWindow) reportWindow.close();
          showToast('Payment completed! 1 credit added.', 'ok');
          await refreshBalancePill();
          closeBuyModal?.();
          return;
        }

        const body = { ...pending, as: 'html', allowLive: true };
        if (!user && result?.captureId) body.oneTimeSession = 'pp_' + result.captureId;

        await ensureBackendReady();
        const headers = { 'Content-Type': 'application/json' };
        const sess = await getSession();
        if (sess.token) headers['Authorization'] = `Bearer ${sess.token}`;

        const resp = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) { 
            const t = await resp.text(); 
            throw new Error(t || ('HTTP ' + resp.status)); 
        }
        
        const html = await resp.text();

        addToHistory({
          vin: pending.vin || '(from plate)', type: pending.type || 'carfax', ts: Date.now(),
          state: pending.state || '', plate: pending.plate || ''
        });
        renderHistory();

        if (reportWindow) {
          reportWindow.document.open(); 
          reportWindow.document.write(html);
          reportWindow.document.close();
          reportWindow.focus();
        } else {
          document.open(); document.write(html); document.close();
        }

        showToast('Report fetched successfully!', 'ok');
        await refreshBalancePill();
        clearPending?.();
        closeBuyModal?.();

      } catch (e) {
        if (reportWindow) reportWindow.close();
        console.error(e);
        showToast(e.message || 'PayPal capture failed', 'error');
      }
    },
    onError: (err) => { console.error(err); showToast('PayPal error', 'error'); }
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
    showToast('Please sign in to buy a bundle.', 'error');
    openLogin();
    return;
  }
  closeBuyModal();
  startPurchase({ user, price_id: 'STRIPE_PRICE_10PACK', pendingReport: null });
});

/* ================================
   VIN + Form Gate
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

// 1. HELPER: Fetch Car Details (NHTSA) - Defined OUTSIDE reflectVinGate
async function fetchCarDetails(vin) {
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
    const data = await res.json();
    const make = data.Results.find(r => r.Variable === "Make")?.Value;
    const model = data.Results.find(r => r.Variable === "Model")?.Value;
    const year = data.Results.find(r => r.Variable === "Model Year")?.Value;
    if (make && model && year) return `${year} ${make} ${model}`;
  } catch (e) { return null; }
}

// 2. Main Validation Function
function reflectVinGate() {
  if (!f || !go) return;
  const formData = Object.fromEntries(new FormData(f).entries());
  const vin = (formData.vin || '').trim().toUpperCase();

  if (typeGroup) typeGroup.classList.add('hidden');

  if (vin.length === 0 && !hasPlateCombo(formData)) {
    setVinHelp('Enter a 17-char VIN or Plate+State.');
    go.disabled = true;
    return;
  }

  // Check VIN
  if (vin.length > 0) {
    if (!looksVinBasic(vin)) {
      setVinHelp('VIN must be 17 chars (no I, O, Q).');
      go.disabled = true;
      return;
    }
    if (!vinCheckDigitOk(vin)) {
      setVinHelp('Invalid VIN Check Digit. Verify VIN.', false);
      go.disabled = true;
      return;
    }

    // --- NHTSA Lookup Success Logic ---
    setVinHelp('Checking vehicle details...', true); 
    
    // Call the helper (This was missing in your previous file)
    fetchCarDetails(vin).then(carName => {
       const currentVin = new FormData(f).get('vin').trim().toUpperCase();
       if (currentVin === vin) {
           if (carName) {
              setVinHelp(`✅ Verified: ${carName}`, true);
           } else {
              setVinHelp('VIN valid (Details not found).', true);
           }
       }
    });

    go.disabled = false;
    return;
  }

  // Check Plate
  if (hasPlateCombo(formData)) {
    setVinHelp('Plate + State provided ✓', true);
    go.disabled = false;
    return;
  }
  go.disabled = true;
}

f?.addEventListener('input', () => { reflectVinGate(); });

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

  if (!data.vin && !(data.state && data.plate)) {
    showToast('Enter a VIN or Plate', 'error');
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

  // Check credits
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
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }

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
    await refreshBalancePill();
  } catch (err) {
    showToast(err.message || 'Request failed', 'error');
  } finally {
    go.disabled = false;
    loading?.classList.add('hidden');
  }
});

// Sidebar & Compare listeners
document.getElementById('buy5Sidebar')?.addEventListener('click', async () => {
  const { user } = await getSession();
  if (!user) {
    showToast('Please sign in to buy a bundle.', 'error');
    openLogin();
    return;
  }
  startPurchase({ user, price_id: 'STRIPE_PRICE_10PACK', pendingReport: null });
});

/* ================================
   Forgot / Reset Password Logic
================================ */
const forgotBtn = $id('forgotPasswordBtn');
const forgotModal = $id('forgotModal');
const closeForgotBtn = $id('closeForgotModal');
const sendResetBtn = $id('sendResetLinkBtn');
const forgotEmailInput = $id('forgotEmail');

const updatePassModal = $id('updatePasswordModal');
const newPassInput = $id('newPasswordInput');
const savePassBtn = $id('saveNewPasswordBtn');

// 1. Open "Forgot" Modal (closes login first)
forgotBtn?.addEventListener('click', () => {
  closeLogin();
  forgotModal?.classList.remove('hidden');
  forgotEmailInput.focus();
});

// 2. Close Modal
closeForgotBtn?.addEventListener('click', () => {
  forgotModal?.classList.add('hidden');
});

// 3. Send the Reset Email
sendResetBtn?.addEventListener('click', async () => {
  const email = (forgotEmailInput.value || '').trim();
  if (!email || !email.includes('@')) return showToast('Invalid email', 'error');

  sendResetBtn.disabled = true;
  sendResetBtn.textContent = 'Sending...';

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin, // Sends them back to your homepage
    });
    if (error) throw error;
    
    showToast('Recovery link sent! Check your email.', 'ok');
    forgotModal?.classList.add('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    sendResetBtn.disabled = false;
    sendResetBtn.textContent = 'Send Link';
  }
});

// 4. Handle the "Recovery" Event (When user clicks email link)
if (supabase) {
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      // User clicked the email link. Show the "New Password" modal.
      updatePassModal?.classList.remove('hidden');
    }
  });
}

// 5. Save the New Password
savePassBtn?.addEventListener('click', async () => {
  const newPassword = newPassInput.value;
  if (newPassword.length < 6) return showToast('Password too short (min 6 chars)', 'error');

  savePassBtn.disabled = true;
  savePassBtn.textContent = 'Updating...';

  try {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;

    showToast('Password updated! You are now logged in.', 'ok');
    updatePassModal?.classList.add('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    savePassBtn.disabled = false;
    savePassBtn.textContent = 'Update Password';
  }
});

/* ================================
   Init
================================ */
(async () => {
  await refreshBalancePill();
  renderHistory();
  if (stripeSessionId || ppSuccess) {
    if (!intentParam || intentParam !== 'buy_report') {
      const pending = tryLoadPending();
      if (pending) {
        showToast('Payment confirmed. Processing...', 'ok');
        await resumePendingPurchase();
      }
    }
  }
  reflectVinGate();
})();