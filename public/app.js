/* ================================
   Config & Utilities
================================ */
const API = {
  report: '/api/report',
  checkout: '/api/create-checkout-session',
  credits: (uid) => `/api/credits/${uid}`,
};

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

/* ================================
   Supabase init (single source)
================================ */
const SB_URL  = window.VITE_SUPABASE_URL  || (typeof process !== 'undefined' ? process?.env?.VITE_SUPABASE_URL  : '') || '';
const SB_ANON = window.VITE_SUPABASE_ANON_KEY || (typeof process !== 'undefined' ? process?.env?.VITE_SUPABASE_ANON_KEY : '') || '';

let supabase = null;
if (window.supabase && SB_URL && SB_ANON) {
  supabase = window.supabase.createClient(SB_URL, SB_ANON);
}

/* Detect Stripe success & capture session_id for guest one-time use */
const urlParams = new URLSearchParams(window.location.search);
const checkoutSuccess = urlParams.get('checkout') === 'success';
const stripeSessionId = urlParams.get('session_id') || null;
if (stripeSessionId) {
  history.replaceState({}, '', window.location.pathname); // clean URL
  if (checkoutSuccess) showToast('Payment confirmed. You can now fetch a report.', 'ok');
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

// Disable/enable create button helper
function setCreateButtonDisabled(disabled) {
  if (doSignupBtn) {
    doSignupBtn.disabled = !!disabled;
    doSignupBtn.classList.toggle('opacity-50', !!disabled);
    doSignupBtn.classList.toggle('cursor-not-allowed', !!disabled);
  }
}

// Check if email already exists (using sign-in attempt without password)
async function emailExists(address) {
  if (!supabase) return false;
  // Try signInWithPassword with impossible password; Supabase returns specific error if user exists
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: address,
      password: '__definitely_wrong_password__',
    });
    if (!error) return true; // somehow signed in (unlikely)
    // "Invalid login credentials" => user exists but wrong pw
    if (error.message && /invalid login credentials/i.test(error.message)) return true;
    // "Email not confirmed" still indicates the user exists
    if (error.message && /email not confirmed/i.test(error.message)) return true;
    return false;
  } catch {
    return false;
  }
}

async function doSignup() {
  if (!supabase) { showToast('Supabase not loaded', 'error'); return; }
  const email = (emailEl.value || '').trim();
  const password = pwEl.value || '';

  if (!email) return showToast('Enter your email', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');

  // Check existence first and block the button if already registered
  setCreateButtonDisabled(true);
  const exists = await emailExists(email);
  if (exists) {
    showToast('An account with this email already exists. Try signing in.', 'error');
    setCreateButtonDisabled(false);
    return;
  }

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) throw error;

    if (!data.session) {
      showToast('Check your email to confirm your account.', 'ok');
    } else {
      showToast('Account created — you are signed in!', 'ok');
      closeLogin();
    }
  } catch (e) {
    showToast(e.message || 'Sign up failed', 'error');
  } finally {
    setCreateButtonDisabled(false);
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

// Hook up buttons
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
   Helper: download Blob as file
================================ */
function downloadBlob(blob, filename = 'AutoVINReveal.pdf') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
================================ */
const HISTORY_KEY = 'reportHistory';
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(list) { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); }
function addToHistory(item) { const list = loadHistory(); list.unshift(item); saveHistory(list.slice(0, 20)); }
function formatTime(ts) { return new Date(ts).toLocaleString(); }

async function replayRequest(item) {
  const data = {
    vin: item.vin && item.vin !== '(from plate)' ? item.vin : '',
    state: item.state || '',
    plate: item.plate || '',
    type: item.type,
    as: item.as,
    allowLive: false
  };
  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(data) });
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }

    if (item.as === 'pdf') {
      const blob = await r.blob();

      let filename = 'AutoVINReveal.pdf';
      const cd = r.headers.get('content-disposition'); // exposed by server
      if (cd) {
        const m = /filename\*?=(?:UTF-8''|")?([^;"']+)/i.exec(cd);
        if (m && m[1]) {
          try { filename = decodeURIComponent(m[1].replace(/"/g, '')); }
          catch { filename = m[1].replace(/"/g, ''); }
        }
      } else {
        const tag = data.vin || (data.state && data.plate ? `${data.state}-${data.plate}` : 'report');
        filename = `${tag}-${data.type}.pdf`;
      }

      downloadBlob(blob, filename);
    } else {
      const html = await r.text();
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
    }
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
      <td class="px-4 py-3" style="text-transform:uppercase">${item.as}</td>
      <td class="px-4 py-3">${formatTime(item.ts)}</td>
      <td class="px-4 py-3">
        <button data-idx="${idx}" class="btn-outline" style="font-size:.8rem">Open</button>
        <button data-idx="${idx}" class="btn-outline" style="font-size:.8rem;margin-left:.5rem;color:#dc2626;border-color:#fecaca">Delete</button>
      </td>`;
    body.appendChild(tr);
  });

  body.querySelectorAll('button.btn-outline').forEach(btn => {
    if (btn.textContent.trim() === 'Open') {
      btn.addEventListener('click', e => {
        const i = +e.currentTarget.dataset.idx; replayRequest(loadHistory()[i]);
      });
    } else {
      btn.addEventListener('click', e => {
        const i = +e.currentTarget.dataset.idx; const list = loadHistory(); list.splice(i,1); saveHistory(list); renderHistory();
      });
    }
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
================================ */
async function startPurchase(user) {
  try {
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
  const { user } = await getSession(); // can be null -> guest
  closeBuyModal();
  startPurchase(user);
});

/* ================================
   Fetch report (main form)
================================ */
const f = $id('f');
const go = $id('go');
const loading = $id('loading');

const looksVin = (v) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(v || '');

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
    as:   formData.as || 'html',
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

  if (supabase) {
    const sess = await getSession();
    currentUser = sess.user;
    token       = sess.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  if (currentUser && currentUser.id) {
    try {
      const r = await fetch(API.credits(currentUser.id));
      const { balance = 0 } = await r.json();
      if (balance <= 0) {
        openBuyModal();
        go.disabled = false; loading.classList.add('hidden');
        return;
      }
    } catch (_) { /* ignore balance errors */ }
  }

  try {
    const body = {
      vin:  data.vin,
      state:data.state,
      plate:data.plate,
      type: data.type,
      as:   data.as,
      allowLive: true
    };

    // Guest + returned from Stripe => attach receipt
    if (!currentUser && stripeSessionId) body.oneTimeSession = stripeSessionId;

    const r = await fetch(API.report, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (r.status === 401 || r.status === 402) { openBuyModal(); return; }
    if (r.status === 409) { showToast('That receipt was already used. Please purchase again.', 'error'); return; }
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }

    if (data.as === 'pdf') {
      const blob = await r.blob();

      let filename = 'AutoVINReveal.pdf';
      const cd = r.headers.get('content-disposition'); // exposed by server
      if (cd) {
        const m = /filename\*?=(?:UTF-8''|")?([^;"']+)/i.exec(cd);
        if (m && m[1]) {
          try { filename = decodeURIComponent(m[1].replace(/"/g, '')); }
          catch { filename = m[1].replace(/"/g, ''); }
        }
      } else {
        const tag = data.vin || (data.state && data.plate ? `${data.state}-${data.plate}` : 'report');
        filename = `${tag}-${data.type}.pdf`;
      }

      downloadBlob(blob, filename);
    } else {
      const html = await r.text();
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
    }

    showToast('Report fetched successfully!', 'ok');
    addToHistory({
      vin: data.vin || '(from plate)',
      type: data.type,
      as:   data.as,
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

/* ================================
   Initialize history
================================ */
renderHistory();
