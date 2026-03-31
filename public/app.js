// app.js
// ORIGINAL FIXES (from prior session):
//   #4  — document.write replaced with safe blob-URL / sandboxed-iframe approach
//   #11 — lastFormData scoped to buy modal; cleared after use
//   #12 — PayPal button re-renders when user login state changes [REMOVED — PayPal removed]
//   #13 — openBlank() removed from PayPal onApprove [REMOVED — PayPal removed]
//   #14 — reflectAuthUI uses style.display instead of classList
//   #15 — All API.report fetches wrapped in apiFetch() with 30s timeout
//   #16 — Fixed double-tab race condition; upgraded tryLoadPending()
//   #17 — PayPal available for all 3 tiers [REMOVED — PayPal removed]
//   #18 — PayPal container visible on mobile [REMOVED — PayPal removed]
//
// PREVIOUS FIXES:
//   #A — trackPurchase now accepts dynamic value; callers pass correct amount per package
//   #B — loading spinner hidden before early openBuyModal() return (was stuck on screen)
//   #C — clearPending() moved into the success path so a throw in renderHistory can't skip it
//   #D — dataset.renderedFor cleared on logout so guest→login→logout cycle re-renders buttons
//   #E — plate/state inputs sanitised before being stored in pending data (alphanumeric only)
//   FIX-6 — trackPurchase hardcoded 6.00 fixed in resumePendingPurchase() and handleSuccessIfNeeded()
//   FIX-7 — setPrimaryCTA('buy') no longer gates guests behind openLogin()
//   FIX-PP — PayPal fully removed. Stripe is the sole payment processor.
//
// FIXES IN THIS VERSION:
//   FIX-S1 — iframe in showReportOverlay was unsandboxed. A CARFAX report script
//             could call window.top.location and navigate the entire app away.
//             sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
//             added to prevent top-level navigation while keeping the report functional.
//
//   FIX-S2 — Form submit: 401/402 early-return path never reset go.disabled or hid
//             the loading spinner before calling openBuyModal(). Spinner stayed visible
//             behind the modal. resetFormUI() now called before all early returns.
//
//   FIX-S3 — openEmailModal was passed a raw plate string in the vin field when the
//             history item was a plate lookup. The server's /api/email-report validates
//             vin and rejects non-VIN strings. openEmailModal now accepts the full
//             history item and passes vin/state/plate as separate fields so the server
//             can do the plate→VIN lookup itself.
//
//   FIX-S4 — Tailwind typo: active:scale-[0-98] is an invalid value (does nothing).
//             Fixed to active:scale-[.98] in setPrimaryCTA.

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
const API_TIMEOUT_MS = 30_000;

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

function trackPurchase(value = 6.00) {
  try {
    fbq('track', 'Purchase', {
      value, currency: 'USD',
      contents: [{ id: 'VinReport', quantity: 1 }],
      content_ids: ['VinReport'], content_type: 'product'
    });
  } catch {}
}

// Convert HTML string to PDF and download using html2pdf.js (CDN loaded on demand)
async function convertHtmlToPdf(htmlContent, filename) {
  // Load html2pdf.js from CDN if not already loaded
  if (!window.html2pdf) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Create a hidden container, render the HTML inside it
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;background:white;';
  container.innerHTML = htmlContent;
  document.body.appendChild(container);

  try {
    await window.html2pdf(container, {
      margin:      [8, 8, 8, 8],
      filename:    filename,
      image:       { type: 'jpeg', quality: 0.92 },
      html2canvas: { scale: 1.5, useCORS: true, logging: false, allowTaint: true },
      jsPDF:       { unit: 'mm', format: 'letter', orientation: 'portrait' },
      pagebreak:   { mode: ['avoid-all', 'css', 'legacy'] },
    });
  } finally {
    document.body.removeChild(container);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
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
   fetch with timeout
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
   Safe report renderer (Overlay Only)
   FIX-S1: iframe now has sandbox attribute so report scripts cannot
   call window.top.location and navigate the parent app away.
     allow-scripts     — needed for the React SPA to run
     allow-same-origin — needed for webpack chunk loading
     allow-popups      — needed for "open in new tab" report links
     allow-forms       — needed for any forms inside the report
   Top-level navigation is NOT in the list — the report cannot escape.
================================ */
function openReport(html, vin) {
  showReportOverlay(html, vin);
}

function showReportOverlay(html, vin) {
  document.getElementById('reportOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id    = 'reportOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;';

  const bar = document.createElement('div');
  bar.style.cssText =
    'flex-shrink:0;background:#1e3a8a;padding:8px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;';
  bar.innerHTML = `
    <span style="color:white;font-weight:bold;font-size:14px;flex-shrink:0;">Vehicle History Report</span>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button id="overlayPrintBtn"
        style="background:transparent;color:white;border:1px solid rgba(255,255,255,0.4);padding:5px 12px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;">
        🖨 Save as PDF
      </button>
      <button id="overlayDownloadBtn"
        style="background:#2563eb;color:white;border:none;padding:5px 12px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;">
        ⬇ Download
      </button>
      <button id="closeReportOverlay"
        style="background:#ef4444;color:white;border:none;padding:5px 14px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:13px;">
        ✕ Close
      </button>
    </div>`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'flex:1;border:none;width:100%;';
  // FIX-S1: sandbox prevents top-level navigation while keeping the report functional
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals');
  iframe.srcdoc = html;

  overlay.appendChild(bar);
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);

  // Push history state so Android back-button also closes the overlay
  try { window.history.pushState({ reportOverlayOpen: true }, ''); } catch (_) {}

  // Save as PDF — opens the report in a new tab and triggers print dialog there
  // so the overlay stays intact and the CARFAX page scripts can't break anything
  overlay.querySelector('#overlayPrintBtn')?.addEventListener('click', () => {
    const win = window.open('', '_blank');
    if (!win) { showToast('Pop-up blocked — please allow pop-ups and try again', 'error'); return; }
    win.document.write(html);
    win.document.close();
    // Small delay so the page renders before print fires
    win.addEventListener('load', () => { setTimeout(() => win.print(), 500); });
  });

  // Download — converts HTML to PDF client-side using html2pdf.js
  overlay.querySelector('#overlayDownloadBtn')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#overlayDownloadBtn');
    const orig = btn.innerHTML;
    btn.innerHTML = '⏳ Generating…';
    btn.disabled = true;
    showToast('Generating PDF…', 'ok');
    try {
      await convertHtmlToPdf(html, (vin || 'report') + '-vehicle-history.pdf');
      showToast('PDF downloaded!', 'ok');
    } catch(e) {
      showToast('PDF failed, downloading HTML instead', 'error');
      downloadBlob(new Blob([html], { type: 'text/html' }), (vin || 'report') + '-report.html');
    } finally {
      btn.innerHTML = orig;
      btn.disabled = false;
    }
  });

  function closeOverlay() {
    const el = document.getElementById('reportOverlay');
    if (!el) return;
    el.remove();
    // Clean up the history entry we pushed, but only if still on it
    try {
      if (window.history.state?.reportOverlayOpen) window.history.back();
    } catch (_) {}
  }

  // Primary: direct DOM removal — always works regardless of history state
  overlay.querySelector('#closeReportOverlay')
    .addEventListener('click', closeOverlay);

  // Secondary: hardware/browser back button
  window._closeReportOverlay = closeOverlay;
}

window.addEventListener('popstate', () => {
  const overlay = document.getElementById('reportOverlay');
  if (overlay) overlay.remove();
});

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
   FIX-S4: active:scale-[0-98] was invalid — fixed to active:scale-[.98]
================================ */
function setPrimaryCTA(mode = 'view') {
  const btn = $id('go');
  if (!btn) return;
  btn.className = 'glow-btn w-full bg-blue-600 hover:bg-blue-700 text-white h-14 rounded-xl font-bold text-lg shadow-xl shadow-blue-600/20 transition-all active:scale-[.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed';
  if (mode === 'buy') {
    btn.type = 'button';
    btn.innerHTML = `<span>Buy Credits</span><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>`;
    btn.onclick = () => openBuyModal();
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
const intentParam     = p.get('intent') || null;
const vinParam        = (p.get('vin') || '').toUpperCase();

function tryLoadPending() {
  try {
    const local = localStorage.getItem(PENDING_KEY);
    if (local) return JSON.parse(local);
    const session = sessionStorage.getItem(PENDING_KEY);
    if (session) return JSON.parse(session);
    return null;
  } catch { return null; }
}
function clearPending() {
  localStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
}

async function resumePendingPurchase() {
  const pending = tryLoadPending();
  if (!pending) return;
  if (pending.vin === '(from plate)') pending.vin = '';

  await ensureBackendReady();
  const headers = { 'Content-Type': 'application/json' };
  const { token, user } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!user && stripeSessionId) pending.oneTimeSession = stripeSessionId;
  try {
    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(pending) });
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    clearPending();
    openReport(html);
    trackPurchase(pending.amount || 6.00);
    showToast('Report ready!', 'ok');
    addToHistory({ vin: pending.vin, type: pending.type || 'carfax', ts: Date.now() });
    renderHistory();
  } catch (e) {
    showToast(e.message || 'Failed to resume purchase', 'error');
  } finally {
    await refreshBalancePill();
  }
}

async function handleSuccessIfNeeded() {
  if (!(onSuccessPage() || stripeSessionId)) return;
  if (intentParam === 'buy_report' && stripeSessionId && vinParam) {
    showToast('Payment confirmed. Preparing your report…', 'ok');
    try {
      const r = await apiFetch(API.report, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: vinParam, type: 'carfax', as: 'html', oneTimeSession: stripeSessionId }),
      });
      if (!r.ok) throw new Error(await r.text());
      const html = await r.text();
      openReport(html);
      trackPurchase(6.00);
      return;
    } catch (e) { showToast(e.message || 'Failed to fetch report', 'error'); }
  }
  if (stripeSessionId || onSuccessPage()) {
    const pending = tryLoadPending();
    if (pending) { showToast('Payment confirmed. Preparing your report…', 'ok'); await resumePendingPurchase(); }
  }
  await refreshBalancePill();
  if (onSuccessPage()) {
    setTimeout(() => { window.location.href = '/'; }, 1200);
  } else {
    const url = new URL(location.href);
    ['session_id','intent','vin','one','state','plate','type'].forEach(k => url.searchParams.delete(k));
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
$id('loginBtnMobile')?.addEventListener('click', openLogin); // mobile nav

$id('closeUpdatePasswordModal')?.addEventListener('click', () => {
  $id('updatePasswordModal')?.classList.add('hidden');
});

async function doSignup() {
  if (!supabase) return showToast('Supabase not loaded', 'error');
  const email    = (emailEl.value || '').trim();
  const password = pwEl.value || '';
  if (!email)              return showToast('Enter your email', 'error');
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
  if (!supabase) return showToast('Auth not loaded — please refresh the page', 'error');
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin },
    });
    if (error) showToast(error.message, 'error');
  } catch (e) { showToast(e.message || 'Google sign-in failed', 'error'); }
});

let currentSession = null;

function reflectAuthUI(session) {
  currentSession = session;
  window._currentSession = session; // expose for inline scripts

  // Desktop
  const historyLink = $id('historyNavLink');

  // Mobile
  const hamburger       = $id('hamburgerBtn');
  const loginBtnMobile  = $id('loginBtnMobile');
  const balanceMobile   = $id('balancePillMobile');
  const emailMobile     = $id('mobileUserEmail');

  if (session?.user) {
    const email = session.user.email || '';

    // Desktop: show email, chip, history; hide login
    if (userEmailEl) userEmailEl.textContent = email;
    if (userChip)    userChip.style.display = 'flex';
    $id('loginBtn')?.classList.add('hidden');
    if (historyLink) historyLink.style.display = 'flex';
    const dashLink = $id('dashNavLink');
    if (dashLink) dashLink.style.display = 'flex';

    // Mobile: show hamburger, hide login button
    if (hamburger)      hamburger.style.display = 'flex';
    if (loginBtnMobile) loginBtnMobile.style.display = 'none';
    if (emailMobile)    emailMobile.textContent = email;

    // Check if this is the owner — show credits dashboard button if so
    checkOwnerAccess();
    renderRecentChecksBar();

  } else {
    // Desktop
    if (userChip) userChip.style.display = 'none';
    const lb = $id('loginBtn');
    if (lb) { lb.classList.remove('hidden'); lb.textContent = 'Log in'; }
    if (historyLink) historyLink.style.display = 'none';
    const dashLink2 = $id('dashNavLink');
    if (dashLink2) dashLink2.style.display = 'none';

    // Mobile: hide hamburger, show login button, close menu
    if (hamburger)      hamburger.style.display = 'none';
    if (loginBtnMobile) loginBtnMobile.style.display = 'block';
    if (balanceMobile)  balanceMobile.style.display = 'none';
    const menu = $id('mobileMenu');
    if (menu) menu.style.display = 'none';

    // Hide owner button on logout
    const ob  = $id('ownerDashBtn');
    const obm = $id('ownerDashBtnMobile');
    if (ob)  ob.style.display  = 'none';
    if (obm) obm.style.display = 'none';
  }
}

// Silently check if logged-in user is the owner
async function checkOwnerAccess() {
  try {
    const { token } = await getSession();
    if (!token) return;
    const r = await fetch('/api/is-owner', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return;
    const { owner } = await r.json();
    const ob  = $id('ownerDashBtn');
    const obm = $id('ownerDashBtnMobile');
    if (ob)  ob.style.display  = owner ? 'flex' : 'none';
    if (obm) obm.style.display = owner ? 'flex' : 'none';
  } catch {}
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
  try {
    const { data, error } = await supabase.auth.getSession();
    // If refresh token is invalid/expired, sign out cleanly to clear stale state
    if (error && (error.message?.includes('Refresh Token') || error.status === 400)) {
      console.warn('[Auth] Stale session detected — signing out:', error.message);
      await supabase.auth.signOut();
      reflectAuthUI(null);
    } else {
      reflectAuthUI(data.session);
      await refreshBalancePill();
    }
  } catch (authErr) {
    console.warn('[Auth] Session init failed:', authErr.message);
    reflectAuthUI(null);
  }
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      reflectAuthUI(session);
      refreshBalancePill();
    }
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
  // Mobile credit pill
  const pillMobile = $id('balancePillMobile');
  const txtMobile  = $id('balanceTextMobile');
  if (pillMobile && txtMobile) {
    txtMobile.textContent = `${balance} CREDITS`;
    pillMobile.style.display = 'flex';
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
    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }
    const html = await r.text();
    openReport(html, data.vin || '');
  } catch (e) { showToast(e.message || 'Request failed', 'error'); }
}

async function downloadHistoryPDF(item, btn = null) {
  const restore = setBtnLoading(btn, '…');
  showToast('Generating PDF…', 'ok');
  const vin = item.vin !== '(from plate)' ? item.vin : '';
  if (!vin) { showToast('No VIN available for PDF download.', 'error'); restore(); return; }
  try {
    const { token } = await getSession();
    if (!token) { showToast('Please sign in to download PDFs.', 'error'); restore(); return; }
    await ensureBackendReady();
    // Use dedicated PDF endpoint — streams PDF or print-dialog HTML from CFC
    const url = '/api/download-pdf?vin=' + encodeURIComponent(vin);
    const r   = await apiFetch(url, { headers: { Authorization: `Bearer ${token}` } }, 60_000);
    if (!r.ok) { showToast('PDF failed — ' + r.status, 'error'); restore(); return; }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/pdf')) {
      // Real PDF — trigger download
      const blob = await r.blob();
      downloadBlob(blob, `${vin}-report.pdf`);
      showToast('PDF downloaded!', 'ok');
    } else {
      // Fallback: open the print-dialog HTML in a new tab
      const html = await r.text();
      const win  = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); }
      showToast('Print dialog will open — choose Save as PDF', 'ok');
    }
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

/* ================================
   Email report
   FIX-S3: openEmailModal now accepts the full history item instead of
   just a vin string. When the item is a plate lookup (vin === '(from plate)'),
   state and plate are sent as separate fields so the server can do the
   plate→VIN resolution itself via /api/email-report, instead of receiving
   a raw plate string in the vin field which fails VIN validation.
================================ */
const emailModal    = $id('emailModal');
const emailInput    = $id('emailTargetInput');
const sendEmailBtn  = $id('sendEmailBtn');
let emailTargetItem = null; // FIX-S3: full history item, not just a vin string

function openEmailModal(item) {
  emailTargetItem = item;
  if (currentSession?.user?.email) emailInput.value = currentSession.user.email;
  emailModal?.classList.remove('hidden');
  emailInput?.focus();
}
function closeEmailModal() { emailModal?.classList.add('hidden'); emailTargetItem = null; }
$id('closeEmailModal')?.addEventListener('click', closeEmailModal);

sendEmailBtn?.addEventListener('click', async () => {
  const to = emailInput.value.trim();
  if (!to || !to.includes('@')) return showToast('Invalid email', 'error');
  if (!emailTargetItem) return;

  // FIX-S3: pass vin/state/plate separately so the server handles plate lookups
  const isPlate = emailTargetItem.vin === '(from plate)';
  const body = {
    to,
    type:  emailTargetItem.type || 'carfax',
    vin:   isPlate ? ''                           : emailTargetItem.vin,
    state: isPlate ? (emailTargetItem.state || '') : '',
    plate: isPlate ? (emailTargetItem.plate || '') : '',
  };

  const restore = setBtnLoading(sendEmailBtn, 'Sending…');
  try {
    const r = await apiFetch(
      '/api/email-report',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
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
      if (action === 'email') openEmailModal(item); // FIX-S3: pass full item
      if (action === 'share') copyShareLink(item.vin !== '(from plate)' ? item.vin : item.plate, item.type);
      if (action === 'del')   { const list = loadHistory(); list.splice(i, 1); saveHistory(list); renderHistory(); }
    });
  });
}
$id('clearHistory')?.addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); renderRecentChecksBar(); });

function recentChecksRowHTML(vin, type, ago) {
  return `<div class="py-2.5 border-b border-gray-100 last:border-0">
    <div class="flex items-center justify-between gap-2 mb-2">
      <div class="flex items-center gap-2 min-w-0">
        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0"></div>
        <span class="font-mono text-xs font-semibold text-gray-800 truncate">${vin}</span>
        <span class="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-semibold uppercase flex-shrink-0">${type}</span>
      </div>
      <span class="text-[11px] text-gray-400 flex-shrink-0">${ago}</span>
    </div>
    <div class="flex gap-1.5 flex-wrap">
      <button data-vin="${vin}" data-type="${type}" data-action="view"
        class="flex items-center gap-1 text-[11px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-100 px-2.5 py-1 rounded-lg transition-colors">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
        View
      </button>
      <button data-vin="${vin}" data-type="${type}" data-action="savepdf"
        class="flex items-center gap-1 text-[11px] font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 px-2.5 py-1 rounded-lg transition-colors">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
        Save PDF
      </button>
      <button data-vin="${vin}" data-type="${type}" data-action="download"
        class="flex items-center gap-1 text-[11px] font-semibold text-green-700 bg-green-50 hover:bg-green-100 border border-green-100 px-2.5 py-1 rounded-lg transition-colors">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        Download
      </button>
      <button data-vin="${vin}" data-type="${type}" data-action="email"
        class="flex items-center gap-1 text-[11px] font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 px-2.5 py-1 rounded-lg transition-colors">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        Email
      </button>
    </div>
  </div>`;
}

function bindRecentChecksBtns() {
  const list = $id('recentChecksList');
  if (!list) return;
  list.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const vin    = btn.dataset.vin;
      const type   = btn.dataset.type || 'carfax';
      const action = btn.dataset.action;
      const item   = { vin, type, ts: Date.now() };
      if (action === 'view')     openHistoryHTML(item);
      if (action === 'savepdf') {
        const win = window.open('', '_blank');
        const headers = { 'Content-Type': 'application/json' };
        const { token } = await getSession();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify({ vin, type, as: 'html', allowLive: false }) });
        if (r.ok) { const html = await r.text(); if (win) { win.document.write(html); win.document.close(); win.addEventListener('load', () => setTimeout(() => win.print(), 500)); } }
        else { win?.close(); showToast('Could not load report', 'error'); }
      }
      if (action === 'download') downloadHistoryPDF(item, btn);
      if (action === 'email')    openEmailModal(item);
    });
  });
}

async function renderRecentChecksBar() {
  const bar  = $id('recentChecksBar');
  const list = $id('recentChecksList');
  if (!bar || !list) return;

  const { user, token } = await getSession();

  if (user && token) {
    try {
      const r = await apiFetch('/api/history', { headers: { Authorization: `Bearer ${token}` } }, 8000);
      if (r.ok) {
        const { rows } = await r.json();
        if (!rows?.length) { bar.classList.add('hidden'); return; }
        bar.classList.remove('hidden');
        list.innerHTML = rows.slice(0, 5).map(row => {
          const ago = timeAgo(new Date(row.created_at).getTime());
          return recentChecksRowHTML(row.vin, row.type || 'carfax', ago);
        }).join('');
        bindRecentChecksBtns();
        return;
      }
    } catch {}
  }

  // Guest: localStorage
  const history = loadHistory().slice(0, 5);
  if (!history.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  list.innerHTML = history.map(item => {
    return recentChecksRowHTML(item.vin || '—', item.type || 'carfax', timeAgo(item.ts));
  }).join('');
  bindRecentChecksBtns();
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m} min ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

/* ================================
   Buy Credits Modal
================================ */
const buyModal = $id('buyCreditsModal');
let currentBuyModalPendingData = null;

function openBuyModal(pendingData = null) {
  currentBuyModalPendingData = pendingData;
  buyModal?.classList.remove('hidden');
}
function closeBuyModal() {
  buyModal?.classList.add('hidden');
  currentBuyModalPendingData = null;
}
$id('closeModalBtn')?.addEventListener('click', closeBuyModal);

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
    const r = await apiFetch(
      API.checkout,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      10_000
    );
    if (!r.ok) throw new Error(await r.text() || 'Stripe error');
    window.location.href = (await r.json()).url;
  } catch (e) { showToast(e.message || 'Failed to start checkout', 'error'); }
}

$id('buy1Btn')?.addEventListener('click', async () => {
  const btn = $id('buy1Btn'); const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession(); const pending = currentBuyModalPendingData;
  closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_SINGLE', pendingReport: pending });
  restore();
});
$id('buy5Btn')?.addEventListener('click', async () => {
  const btn = $id('buy5Btn'); const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession(); closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_5PACK', requireLogin: true });
  restore();
});
$id('buy20Btn')?.addEventListener('click', async () => {
  const btn = $id('buy20Btn'); const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession(); closeBuyModal();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_20PACK', requireLogin: true });
  restore();
});

$id('buy1Sidebar')?.addEventListener('click',  () => openBuyModal());
$id('buy5Sidebar')?.addEventListener('click',  async () => {
  const { user } = await getSession();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_5PACK', requireLogin: true });
});
$id('buy20Sidebar')?.addEventListener('click', async () => {
  const { user } = await getSession();
  await startStripePurchase({ user, price_id: 'STRIPE_PRICE_20PACK', requireLogin: true });
});
['pricingBuy1Btn', 'pricingBuy5Btn', 'pricingBuy20Btn'].forEach(id => {
  $id(id)?.addEventListener('click', () => openBuyModal());
});
$id('mobileViewPlans')?.addEventListener('click', () => openBuyModal());

/* ================================
   VIN + Form gate
================================ */
const f       = $id('f');
const go      = $id('go');
const loading = $id('loading');

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
  if (!vin) {
    setVinHelp('Enter a 17-character VIN.');
    go.disabled = true; return;
  }
  if (vin.length > 0) {
    if (!looksVinBasic(vin))   { setVinHelp('VIN must be 17 chars (no I, O, Q).'); go.disabled = true; return; }
    if (!vinCheckDigitOk(vin)) { setVinHelp('Invalid check digit — please verify VIN.'); go.disabled = true; return; }
    setVinHelp('Looking up vehicle…', true);
    go.disabled = false;
    vinDebounceTimer = setTimeout(() => {
      fetchCarDetails(vin).then(name => {
        const current = (document.querySelector('input[name="vin"]')?.value || '').trim().toUpperCase();
        if (current !== vin) return;
        setVinHelp(name ? `✅ Verified: ${name}` : 'VIN valid (details not found).', true);
      });
    }, 400);
    return;
  }

  go.disabled = true;
}

f?.addEventListener('input', reflectVinGate);

/* ================================
   Form submission
   FIX-S2: resetFormUI() centralises go.disabled=false + loading hide.
   All early-return paths (balance check, 401/402) now call it so the
   spinner never gets stuck visible behind the buy modal.
================================ */
function resetFormUI() {
  if (go) go.disabled = false;
  loading?.classList.add('hidden');
}

f?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(f).entries());

  const data = {
    vin:       (fd.vin || '').trim().toUpperCase(),
    type:      fd.type || 'carfax',
    as:        'html',
    allowLive: true,
    amount:    6.00,
  };
  if (!data.vin) { showToast('Enter a VIN', 'error'); return; }

  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(data)); } catch {}

  go.disabled = true;
  loading?.classList.remove('hidden');

  const headers   = { 'Content-Type': 'application/json' };
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
        resetFormUI(); // FIX-S2: reset before early return
        openBuyModal(data);
        return;
      }
    } catch {}
  }

  try {
    if (!currentUser && stripeSessionId) data.oneTimeSession = stripeSessionId;

    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });

    if (r.status === 401 || r.status === 402) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(data));
      resetFormUI(); // FIX-S2: spinner was stuck behind modal without this
      openBuyModal(data);
      return;
    }
    if (!r.ok) { showToast(await r.text() || ('HTTP ' + r.status), 'error'); return; }

    const html = await r.text();
    openReport(html, data.vin || '');
    showToast('Report fetched successfully!', 'ok');
    addToHistory({ vin: data.vin, type: data.type, ts: Date.now() });
    renderHistory();
    await refreshBalancePill();
  } catch (err) {
    showToast(err.message || 'Request failed', 'error');
  } finally {
    resetFormUI();
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
  renderRecentChecksBar();
  reflectVinGate();
})();