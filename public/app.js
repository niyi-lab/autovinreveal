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
//   FIX-6 — trackPurchase hardcoded 5.99 fixed in resumePendingPurchase() and handleSuccessIfNeeded()
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

// Turn a server /api/report error response into a clean, reassuring message.
// The server replies with JSON like { error: "invalid_vin"|"provider_error", message }.
// A wrong/unknown VIN must read as "VIN not found, you were not charged" — never
// surface the raw "provider_error" token to the user.
async function friendlyReportError(res) {
  let body = {};
  try { body = await res.clone().json(); }
  catch { try { const t = await res.text(); body = t ? JSON.parse(t) : {}; } catch { body = {}; } }
  const code = body.error || '';
  if (code === 'report_unavailable') {
    return body.message || 'This report isn’t available for this VIN right now. You were not charged — please try again in a few minutes.';
  }
  if (code === 'invalid_vin') {
    return 'VIN not found — please double-check it. You were not charged.';
  }
  if (code === 'insufficient_credits') return 'You’re out of credits.';
  if (code === 'provider_error') {
    return 'We couldn’t pull that report right now. If you were charged, you’ve been refunded — please try again shortly.';
  }
  if (res.status === 422) {
    return 'VIN not found — please double-check it. You were not charged.';
  }
  return body.message || ('HTTP ' + res.status);
}
const API_TIMEOUT_MS = 30_000;

function $id(id) { return document.getElementById(id); }

function showToast(message, type = 'error') {
  let box = $id('toastBox');
  if (!box) {
    // No container on this page (e.g. success.html) — create one so we never use alert().
    box = document.createElement('div');
    box.id = 'toastBox';
    box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:340px;';
    document.body.appendChild(box);
  }
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

function trackPurchase(value = 5.99) {
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
  // CARFAX reports are React SPAs — innerHTML into a div won't render them.
  // We must open a real browser window so React mounts and scripts execute,
  // then inject html2pdf.js into THAT window and convert from the live DOM.
  const win = window.open('', '_blank', 'width=900,height=700,top=-4000,left=-4000');
  if (!win) throw new Error('Pop-up blocked — please allow pop-ups and try again');

  win.document.open();
  win.document.write(htmlContent);
  win.document.close();

  // Wait for the page to fully load (fonts, images, React render)
  await new Promise(r => {
    if (win.document.readyState === 'complete') { r(); return; }
    win.addEventListener('load', r, { once: true });
  });
  // Extra time for React to mount and render the report body
  await new Promise(r => setTimeout(r, 2500));

  // Inject html2pdf.js into the new window's context
  await new Promise((resolve, reject) => {
    const s = win.document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    s.onload = resolve;
    s.onerror = reject;
    win.document.head.appendChild(s);
  });

  // Convert from within that window — html2canvas sees the fully rendered DOM
  try {
    await win.html2pdf(win.document.body, {
      margin:      [8, 8, 8, 8],
      filename,
      image:       { type: 'jpeg', quality: 0.92 },
      html2canvas: { scale: 1.5, useCORS: true, logging: false, allowTaint: true },
      jsPDF:       { unit: 'mm', format: 'letter', orientation: 'portrait' },
      pagebreak:   { mode: ['avoid-all', 'css', 'legacy'] },
    });
  } finally {
    try { win.close(); } catch (_) {}
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
     allow-same-origin — REMOVED: causes CARFAX scripts to navigate iframe away (blank page)
     allow-popups      — needed for "open in new tab" report links
     allow-forms       — needed for any forms inside the report
   Top-level navigation is NOT in the list — the report cannot escape.
================================ */
// Read the owner/age/vehicle hints the server attaches to a delivered report
// (X-Report-Owned / X-Report-Age-Days / X-Report-Vehicle).
function ownerOptsFromRes(res, isUser) {
  let vehicle = '';
  try { vehicle = decodeURIComponent(res.headers.get('X-Report-Vehicle') || ''); }
  catch { vehicle = res.headers.get('X-Report-Vehicle') || ''; }
  const ageRaw = res.headers.get('X-Report-Age-Days');
  return {
    owned:   res.headers.get('X-Report-Owned') === '1' && !!isUser,
    ageDays: ageRaw != null ? parseInt(ageRaw, 10) : null,
    vehicle,
  };
}

function openReport(html, vin, opts = {}) {
  showReportOverlay(html, vin, opts);
}

function showReportOverlay(html, vin, opts = {}) {
  document.getElementById('reportOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id    = 'reportOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;';

  const bar = document.createElement('div');
  bar.style.cssText =
    'flex-shrink:0;background:#1e3a8a;padding:8px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;';
  const titleText  = (opts.vehicle || '').replace(/[<>&"]/g, '') || 'Vehicle History Report';
  const ageNote    = (opts.owned && opts.ageDays != null && opts.ageDays >= 20)
    ? `<span style="color:rgba(255,255,255,0.7);font-size:11px;white-space:nowrap;">Saved · ${opts.ageDays}d old</span>` : '';
  const refreshBtn = (opts.owned && vin && vin !== '(from plate)')
    ? `<button id="overlayRefreshBtn" data-stage="0"
        style="background:transparent;color:white;border:1px solid rgba(255,255,255,0.4);padding:5px 12px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;">
        🔄 Get updated report
      </button>` : '';
  bar.innerHTML = `
    <span style="color:white;font-weight:bold;font-size:14px;flex-shrink:0;max-width:52vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${titleText}</span>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      ${ageNote}
      ${refreshBtn}
      <button id="overlayPrintBtn"
        style="background:transparent;color:white;border:1px solid rgba(255,255,255,0.4);padding:5px 12px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;">
        🖨 Print / PDF
      </button>
      <button id="overlayDownloadBtn"
        style="background:#16a34a;color:white;border:none;padding:5px 12px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;">
        ⬇ Download PDF
      </button>
      <button id="closeReportOverlay"
        style="background:#ef4444;color:white;border:none;padding:5px 14px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:13px;">
        ✕ Close
      </button>
    </div>`;

  // Guest email-capture — only when a guest (no logged-in user) just bought this
  // report and we have its VIN. Lets them send a personal copy to any email.
  if (opts.guest && vin) {
    const cap = document.createElement('div');
    cap.style.cssText =
      'flex-basis:100%;display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;';
    cap.innerHTML = `
      <span style="color:#fde68a;font-size:12px;font-weight:700;">💾 Save your report —</span>
      <span style="color:rgba(255,255,255,0.9);font-size:12px;">download it above (it won't be saved to an account), or email yourself a copy:</span>
      <input id="guestEmailInput" type="email" inputmode="email" autocomplete="email"
        placeholder="you@example.com"
        style="flex:1;min-width:160px;max-width:260px;padding:5px 10px;border-radius:6px;border:none;font-size:12px;" />
      <button id="guestEmailBtn"
        style="background:#16a34a;color:white;border:none;padding:5px 12px;border-radius:6px;
               font-weight:bold;cursor:pointer;font-size:12px;">
        Email me a copy
      </button>`;
    bar.appendChild(cap);
  }

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'flex:1;border:none;width:100%;';
  // Use blob URL instead of srcdoc — Chrome blocks many things in srcdoc context
  const _blob = new Blob([html], { type: 'text/html' });
  const _blobUrl = URL.createObjectURL(_blob);
  iframe.src = _blobUrl;
  // Revoke after load to free memory
  iframe.addEventListener('load', () => setTimeout(() => URL.revokeObjectURL(_blobUrl), 60000), { once: true });

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

  // Guest email-capture handler — POST { to, vin, type, oneTimeSession } to the
  // unauth guest path of /api/email-report. Reuses showToast for feedback.
  if (opts.guest && vin) {
    overlay.querySelector('#guestEmailBtn')?.addEventListener('click', async () => {
      const input = overlay.querySelector('#guestEmailInput');
      const btn   = overlay.querySelector('#guestEmailBtn');
      const to    = (input?.value || '').trim();
      if (!to || !to.includes('@')) { showToast('Enter a valid email', 'error'); input?.focus(); return; }
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = '⏳ Sending…';
      try {
        const r = await apiFetch('/api/email-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, vin, type: 'carfax', oneTimeSession: opts.oneTimeSession || null }),
        }, 30_000);
        if (!r.ok) { showToast('Could not send — please try again', 'error'); return; }
        showToast(`Report sent to ${to}`, 'ok');
        if (input) input.value = '';
      } catch {
        showToast('Could not send — please try again', 'error');
      } finally {
        btn.disabled = false; btn.innerHTML = orig;
      }
    });
  }

  // Owner "Get updated report" — voluntary re-pull for newer data (uses 1 credit).
  // Two-click confirm avoids an ugly browser dialog and an accidental charge.
  if (opts.owned && vin && vin !== '(from plate)') {
    overlay.querySelector('#overlayRefreshBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const reset = () => { btn.dataset.stage = '0'; btn.disabled = false; btn.innerHTML = '🔄 Get updated report'; btn.style.background = 'transparent'; };
      if (btn.dataset.stage === '0') {
        btn.dataset.stage = '1';
        btn.innerHTML = '🔄 Uses 1 credit — confirm';
        btn.style.background = '#16a34a';
        setTimeout(() => { if (btn.dataset.stage === '1') reset(); }, 4000);
        return;
      }
      btn.disabled = true; btn.innerHTML = '⏳ Fetching latest…';
      try {
        const { token } = await getSession();
        if (!token) { showToast('Please sign in', 'error'); reset(); return; }
        const r = await apiFetch(API.report, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ vin, type: opts.type || 'carfax', as: 'html', allowLive: true, refresh: true }),
        }, 60_000);
        if (!r.ok) { showToast(await friendlyReportError(r), 'error'); reset(); return; }
        const freshHtml = await r.text();
        const o2 = ownerOptsFromRes(r, true);
        showToast('Updated report loaded', 'ok');
        try { await refreshBalancePill?.(); } catch (_) {}
        showReportOverlay(freshHtml, vin, { owned: true, ageDays: o2.ageDays != null ? o2.ageDays : 0, vehicle: o2.vehicle || opts.vehicle, type: opts.type || 'carfax' });
      } catch {
        showToast('Could not refresh — please try again', 'error'); reset();
      }
    });
  }

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
    btn.innerHTML = `<span>Get Vehicle History Report Now</span><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"></path></svg>`;
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
    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(pending) }, 60_000);
    if (!r.ok) { showToast(await friendlyReportError(r), 'error'); return; }
    const html = await r.text();
    clearPending();
    openReport(html, pending.vin || '', (!user && stripeSessionId && pending.vin) ? { guest: true, oneTimeSession: stripeSessionId } : {});
    trackPurchase(pending.amount || 5.99);
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
      }, 60_000);
      if (!r.ok) throw new Error(await r.text());
      const html = await r.text();
      const { user } = await getSession();
      openReport(html, vinParam, user ? {} : { guest: true, oneTimeSession: stripeSessionId });
      trackPurchase(5.99);
      return;
    } catch (e) {
      console.error('[report] post-payment fetch failed:', e.message);
      showToast('Payment received — your report is taking longer than usual. Your purchase is safe; please wait a moment, then refresh. Still stuck? Email support@autovinreveal.com.', 'error');
    }
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

// Show/hide password eye toggle (shared by login + update-password fields)
document.querySelectorAll('[data-pw-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $id(btn.getAttribute('data-pw-toggle'));
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.querySelector('[data-pw-eye]')?.classList.toggle('hidden', show);
    btn.querySelector('[data-pw-eye-off]')?.classList.toggle('hidden', !show);
  });
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
    const oc  = $id('ownerChatBtn');
    const ocm = $id('ownerChatBtnMobile');
    if (ob)  ob.style.display  = owner ? 'flex' : 'none';
    if (obm) obm.style.display = owner ? 'flex' : 'none';
    if (oc)  oc.style.display  = owner ? 'flex' : 'none';
    if (ocm) ocm.style.display = owner ? 'flex' : 'none';
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
  const vin  = item.vin !== '(from plate)' ? item.vin : '';
  const type = item.type || 'carfax';
  if (!vin) { showToast('No VIN available for this report', 'error'); return; }

  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  showToast('Loading report…', 'ok');
  try {
    await ensureBackendReady();
    let r = await apiFetch(API.report, {
      method: 'POST', headers,
      // allowLive: false — serve the owner's stored copy, never charge a credit
      body: JSON.stringify({ vin, type, as: 'html', allowLive: false }),
    });

    if (r.status === 404) {
      const json = await r.json().catch(() => ({}));
      if (json.can_refetch) {
        // Owner's saved copy isn't loadable right now — re-pull it for FREE (they
        // own it). No prompt: viewing what you bought should never be a chore.
        showToast('Refreshing your saved report…', 'ok');
        r = await apiFetch(API.report, {
          method: 'POST', headers,
          body: JSON.stringify({ vin, type, as: 'html', allowLive: true }),
        }, 60_000);
        if (!r.ok) { showToast(await friendlyReportError(r), 'error'); return; }
      } else { showToast('Report not found.', 'error'); return; }
    }

    if (!r.ok) { showToast(await friendlyReportError(r), 'error'); return; }

    const html = await r.text();
    openReport(html, vin, { ...ownerOptsFromRes(r, !!token), type });
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
    const { token } = await getSession();
    if (!token) { showToast('Please sign in to share reports.', 'error'); return; }
    const r = await apiFetch(
      API.share,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ vin, type }) },
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

  const { token } = await getSession();
  if (!token) { showToast('Please sign in to email reports.', 'error'); return; }

  const restore = setBtnLoading(sendEmailBtn, 'Sending…');
  try {
    const r = await apiFetch(
      '/api/email-report',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
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
        <!-- report-type badge hidden for now (restore: <span class="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-semibold uppercase flex-shrink-0">VEHICLE&nbsp;HISTORY</span>) -->
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
      <button data-vin="${vin}" data-type="${type}" data-action="copylink"
        class="flex items-center gap-1 text-[11px] font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 px-2.5 py-1 rounded-lg transition-colors">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 11-5.656-5.656l1.5-1.5m6.828-1.828a4 4 0 010-5.656l3-3a4 4 0 115.656 5.656l-1.5 1.5"/></svg>
        Copy link
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
      if (action === 'view')     openHistoryHTML({ vin, type });
      if (action === 'savepdf') {
        const headers = { 'Content-Type': 'application/json' };
        const { token } = await getSession();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify({ vin, type, as: 'html', allowLive: false }) });
        if (r.ok) {
          const html = await r.text();
          const win = window.open('', '_blank');
          if (win) { win.document.open(); win.document.write(html); win.document.close(); win.addEventListener('load', () => setTimeout(() => win.print(), 600)); }
        } else { showToast('Could not load report', 'error'); }
      }
      if (action === 'download') downloadHistoryPDF(item, btn);
      if (action === 'email')    openEmailModal(item);
      if (action === 'copylink') copyShareLink(vin, type);
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

    // Get Turnstile token if widget is present
    const turnstileEl = document.querySelector('.cf-turnstile');
    if (turnstileEl) {
      // Wait up to 3s for turnstile to be ready
      let token = window.turnstile?.getResponse();
      if (!token) {
        await new Promise(r => setTimeout(r, 1500));
        token = window.turnstile?.getResponse();
      }
      if (token) body.turnstile_token = token;
      window.turnstile?.reset();
    }

    const r = await apiFetch(
      API.checkout,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      10_000
    );
    if (!r.ok) {
      let errMsg = 'Stripe error';
      try { const j = await r.json(); errMsg = j.message || j.error || errMsg; }
      catch { errMsg = await r.text() || errMsg; }
      throw new Error(errMsg);
    }
    window.location.href = (await r.json()).url;
  } catch (e) { showToast(e.message || 'Failed to start checkout', 'error'); }
}

/* ── Whop checkout (card / Apple Pay / Google Pay) — replaces Stripe ──
   Sends the buyer to Whop's hosted checkout with their Supabase user_id +
   credit amount as metadata, so /api/whop-webhook credits the right account. */
const WHOP_PLANS = {
  single: { plan: 'plan_DvE2Z32UAeyTl', credits: 1  },
  pack5:  { plan: 'plan_N1GiRFY8AGfpH', credits: 5  },
  pack20: { plan: 'plan_0f5gjPm3KD8YO', credits: 20 },
};
async function startWhopPurchase({ user, key, pendingReport = null }) {
  const cfg = WHOP_PLANS[key];
  if (!cfg) { showToast('Unknown plan', 'error'); return; }
  const params = [];
  if (user) {
    // Logged in → credits posted to this account by the webhook.
    params.push(`metadata%5Buser_id%5D=${encodeURIComponent(user.id)}`);
    params.push(`metadata%5Bcredits%5D=${cfg.credits}`);
    if (pendingReport?.vin) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport)); } catch {} }
  } else if (key === 'single' && pendingReport?.vin) {
    // Guest single report → no login; the report is emailed after payment.
    params.push(`metadata%5Bvin%5D=${encodeURIComponent(pendingReport.vin)}`);
    params.push(`metadata%5Btype%5D=${encodeURIComponent(pendingReport.type || 'carfax')}`);
    params.push(`metadata%5Bguest%5D=1`);
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReport)); } catch {}
  } else {
    // Credit packs need an account.
    closeBuyModal();
    showToast('Please sign in to buy a bundle.', 'error');
    openLogin();
    return;
  }
  window.location.href = `https://whop.com/checkout/${cfg.plan}?` + params.join('&');
}

$id('buy1Btn')?.addEventListener('click', async () => {
  const { user } = await getSession();
  let pending = currentBuyModalPendingData;
  // A single report is tied to one VIN — fall back to the VIN input if needed.
  if (!pending?.vin) {
    const v = (document.querySelector('input[name="vin"]')?.value || '').trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, '');
    if (v.length === 17) pending = { vin: v, type: 'carfax' };
  }
  if (!pending?.vin) {
    closeBuyModal();
    showToast('Enter a VIN first — a single report is for one specific vehicle.', 'error');
    const vinInput = document.querySelector('input[name="vin"]');
    if (vinInput) { vinInput.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    return;
  }
  const btn = $id('buy1Btn'); const restore = setBtnLoading(btn, 'Redirecting…');
  closeBuyModal();
  await startWhopPurchase({ user, key: 'single', pendingReport: pending });
  restore();
});
$id('buy5Btn')?.addEventListener('click', async () => {
  const btn = $id('buy5Btn'); const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession(); closeBuyModal();
  await startWhopPurchase({ user, key: 'pack5' });
  restore();
});
$id('buy20Btn')?.addEventListener('click', async () => {
  const btn = $id('buy20Btn'); const restore = setBtnLoading(btn, 'Redirecting…');
  const { user } = await getSession(); closeBuyModal();
  await startWhopPurchase({ user, key: 'pack20' });
  restore();
});

$id('buy1Sidebar')?.addEventListener('click',  () => openBuyModal());
$id('buy5Sidebar')?.addEventListener('click',  async () => {
  const { user } = await getSession();
  await startWhopPurchase({ user, key: 'pack5' });
});
$id('buy20Sidebar')?.addEventListener('click', async () => {
  const { user } = await getSession();
  await startWhopPurchase({ user, key: 'pack20' });
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
    amount:    5.99,
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

    const r = await apiFetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) }, 60_000);

    if (r.status === 401 || r.status === 402) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(data));
      resetFormUI(); // FIX-S2: spinner was stuck behind modal without this
      openBuyModal(data);
      return;
    }
    if (!r.ok) { showToast(await friendlyReportError(r), 'error'); return; }

    const html = await r.text();
    const isGuest = !currentUser && stripeSessionId;
    openReport(html, data.vin || '', isGuest
      ? { guest: true, oneTimeSession: stripeSessionId }
      : { ...ownerOptsFromRes(r, !!currentUser), type: data.type || 'carfax' });
    showToast('Report fetched successfully!', 'ok');
    addToHistory({ vin: data.vin, type: data.type, ts: Date.now() });
    renderHistory();
    renderRecentChecksBar(); // update mini history immediately
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
   Crypto payment (NOWPayments / USDT) — sign-in required
================================ */
let selectedCryptoPlan = 'single';
let cryptoPollTimer    = null;
let cryptoExpiryTimer  = null;

$id('cryptoToggle')?.addEventListener('click', () => {
  const panel = $id('cryptoPanel');
  const chev  = $id('cryptoChevron');
  if (!panel) return;
  const nowOpen = panel.classList.toggle('hidden') === false;
  if (chev) chev.style.transform = nowOpen ? 'rotate(180deg)' : '';
});

document.querySelectorAll('.crypto-plan').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedCryptoPlan = btn.dataset.cplan || 'single';
    document.querySelectorAll('.crypto-plan').forEach(b => {
      const on = b === btn;
      b.classList.toggle('border-blue-500', on);
      b.classList.toggle('bg-blue-50', on);
      b.classList.toggle('border-gray-200', !on);
    });
    resetCryptoBox();
  });
});

function resetCryptoBox() {
  $id('cryptoPayBox')?.classList.add('hidden');
  stopCryptoPoll();
  if (cryptoExpiryTimer) { clearInterval(cryptoExpiryTimer); cryptoExpiryTimer = null; }
}

window.copyCryptoAddress = async function () {
  const addr = $id('cryptoAddress')?.textContent?.trim();
  if (!addr) return;
  try { await navigator.clipboard.writeText(addr); showToast('Address copied!', 'ok'); }
  catch { showToast('Could not copy — select manually', 'error'); }
};

$id('cryptoPayBtn')?.addEventListener('click', async () => {
  const btn = $id('cryptoPayBtn');
  const { user, token } = await getSession();
  if (!user || !token) {
    showToast('Please sign in to pay with crypto.', 'error');
    closeBuyModal();
    openLogin();
    return;
  }
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Creating payment…';
  try {
    const r = await apiFetch('/api/crypto/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ price_key: selectedCryptoPlan }),
    }, 20_000);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.message || e.error || 'Payment creation failed');
    }
    const payment = await r.json();

    $id('cryptoAddress').textContent = payment.pay_address || '';
    // Round UP to 2 decimals so it's easy to type and never underpays (overpay settles fine).
    const _pa = Number(payment.pay_amount);
    const payAmt = isFinite(_pa) ? (Math.ceil(_pa * 100) / 100).toFixed(2) : payment.pay_amount;
    $id('cryptoAmount').textContent  = `${payAmt} ${(payment.pay_currency || 'USDT').toUpperCase()}`;

    if (cryptoExpiryTimer) { clearInterval(cryptoExpiryTimer); cryptoExpiryTimer = null; }
    if (payment.expiration_estimate_date) {
      const exp = new Date(payment.expiration_estimate_date);
      const upd = () => {
        const m  = Math.max(0, Math.round((exp - Date.now()) / 60000));
        const el = $id('cryptoExpiry');
        if (el) el.textContent = m > 0 ? `Expires in ${m}m` : 'Expired';
      };
      upd();
      cryptoExpiryTimer = setInterval(upd, 30000);
    }

    const qrEl = $id('cryptoQR');
    if (qrEl && payment.pay_address) {
      const img = document.createElement('img');
      img.src = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(payment.pay_address)}&margin=2`;
      img.width = 120; img.height = 120; img.style.display = 'block'; img.alt = 'Payment QR';
      qrEl.innerHTML = ''; qrEl.appendChild(img);
    }

    $id('cryptoPayBox').classList.remove('hidden');
    setCryptoStatus('waiting');
    startCryptoPoll(payment.payment_id);
  } catch (e) {
    showToast(e.message || 'Crypto payment failed', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
});

function startCryptoPoll(paymentId) {
  stopCryptoPoll();
  let attempts = 0;
  cryptoPollTimer = setInterval(async () => {
    if (++attempts > 80) { stopCryptoPoll(); setCryptoStatus('expired'); return; } // ~6.5 min
    try {
      const r = await fetch(`/api/crypto/status/${paymentId}`);
      if (!r.ok) return;
      const s = (await r.json()).payment_status;
      if (s === 'waiting')        setCryptoStatus('waiting');
      if (s === 'sending')        setCryptoStatus('confirming');
      if (s === 'confirming')     setCryptoStatus('confirming');
      if (s === 'partially_paid') { stopCryptoPoll(); setCryptoStatus('underpaid'); }
      if (s === 'finished' || s === 'confirmed') {
        stopCryptoPoll();
        setCryptoStatus('done');
        setTimeout(async () => {
          closeBuyModal();
          showToast('🎉 Crypto payment confirmed! Credits added.', 'ok');
          await refreshBalancePill();
          resetCryptoBox();
        }, 2000);
      }
      if (s === 'failed' || s === 'refunded' || s === 'expired') { stopCryptoPoll(); setCryptoStatus('failed'); }
    } catch (_) { /* silent poll error */ }
  }, 5000);
}

function stopCryptoPoll() {
  if (cryptoPollTimer) { clearInterval(cryptoPollTimer); cryptoPollTimer = null; }
}

function setCryptoStatus(state) {
  const el = $id('cryptoStatus');
  if (!el) return;
  const cfg = {
    waiting:    { cls: 'bg-amber-50 border-amber-200 text-amber-700', spin: true,  text: 'Waiting for payment…' },
    confirming: { cls: 'bg-blue-50 border-blue-200 text-blue-700',    spin: true,  text: 'Payment detected — confirming on-chain…' },
    done:       { cls: 'bg-green-50 border-green-200 text-green-700', spin: false, text: '✓ Confirmed! Credits added…' },
    underpaid:  { cls: 'bg-red-50 border-red-200 text-red-700',       spin: false, text: '✗ Underpaid — email support@autovinreveal.com with your payment ID to finish or get a refund.' },
    failed:     { cls: 'bg-red-50 border-red-200 text-red-700',       spin: false, text: '✗ Payment failed. Contact support.' },
    expired:    { cls: 'bg-red-50 border-red-200 text-red-700',       spin: false, text: '✗ Payment window expired. Please start again.' },
  }[state] || {};
  el.className = `mt-3 px-3 py-2.5 rounded-lg border text-xs font-semibold flex items-center gap-2 ${cfg.cls || ''}`;
  el.innerHTML = (cfg.spin ? `<span class="w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin"></span>` : '') + `<span>${cfg.text || ''}</span>`;
}

/* ================================
   Init
================================ */
(async () => {
  await refreshBalancePill();
  renderHistory();
  renderRecentChecksBar();
  reflectVinGate();
})();