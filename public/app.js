/* ================================
   Endpoints
================================ */
const API = {
  report: '/api/report',
  checkout: '/api/create-checkout-session',
  credits: (uid) => `/api/credits/${uid}`,
};

/* ================================
   Helpers
================================ */
const $id = (id) => document.getElementById(id);

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
   Supabase (browser env)
================================ */
const SB_URL  = window.VITE_SUPABASE_URL || '';
const SB_ANON = window.VITE_SUPABASE_ANON_KEY || '';

let supabase = null;
if (window.supabase && SB_URL && SB_ANON) {
  supabase = window.supabase.createClient(SB_URL, SB_ANON);
}

/* Stripe success → capture session id for guest one-time use */
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
// set initial button state
(() => {
  const dark  = document.documentElement.classList.contains('dark');
  const label = themeBtn?.querySelector('.label');
  const icon  = themeBtn?.querySelector('.icon');
  if (label) label.textContent = dark ? 'Light' : 'Dark';
  if (icon)  icon.textContent  = dark ? '☀️' : '🌙';
})();

/* ================================
   Auth (email + password)
================================ */
const loginBtn        = $id('loginBtn');
const loginModal      = $id('loginModal');
const closeLoginModal = $id('closeLoginModal');
const emailEl         = $id('loginEmail');
const pwEl            = $id('loginPassword');
const doLoginBtn      = $id('doLogin');
const doSignupBtn     = $id('doSignup');

function openLogin()  { loginModal?.classList.remove('hidden'); }
function closeLogin() { loginModal?.classList.add('hidden'); }
closeLoginModal?.addEventListener('click', closeLogin);

async function doSignup() {
  if (!supabase) { showToast('Supabase not loaded', 'error'); return; }

  const email = (emailEl?.value || '').trim();
  const password = pwEl?.value || '';

  if (!email) return showToast('Enter your email', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin }
    });

    if (error) {
      // Robust “already exists” detection across Supabase error variants
      const msg = (error.message || '').toLowerCase();
      if (
        error.status === 400 || error.status === 409 || error.status === 422 ||
        msg.includes('already') || msg.includes('registered') || msg.includes('exists')
      ) {
        showToast('That email is already registered. Please sign in instead.', 'error');
        // keep the modal open and focus the Sign in flow
        emailEl.value = email;        // keep their email filled
        doLoginBtn?.focus();          // cursor to "Sign in" button
        return;
      }
      throw error;
    }

    // If email confirmations are enabled, Supabase won’t return a session yet
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
  const email = (emailEl?.value || '').trim();
  const password = pwEl?.value || '';
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

/* Hook buttons */
doSignupBtn?.addEventListener('click', doSignup);
doLoginBtn?.addEventListener('click', doLogin);

/* One header button that switches behavior */
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

/* Auth callback & listener */
(async () => {
  if (!supabase) return;

  // Handle email confirmation / reset links
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
================================ */
const HISTORY_KEY = 'reportHistory';
const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
const saveHistory = (list) => localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
const addToHistory = (item) => { const list = loadHistory(); list.unshift(item); saveHistory(list.slice(0, 20)); };
const formatTime = (ts) => new Date(ts).toLocaleString();

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
      const blob = await r.blob(); const url = URL.createObjectURL(blob); window.open(url, '_blank');
    } else {
      const html = await r.text(); const w = window.open('', '_blank'); w.document.write(html); w.document.close();
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
const openBuyModal  = () => buyModal?.classList.remove('hidden');
const closeBuyModal = () => buyModal?.classList.add('hidden');
closeBuyBtn?.addEventListener('click', closeBuyModal);

/* ================================
   Stripe purchase
================================ */
async function startPurchase(user) {
  try {
    const r = await fetch(API.checkout, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user?.id || null }) // null => guest
    });
    if (!r.ok) { const t = await r.text(); throw new Error(t || 'Stripe error'); }
    const { url } = await r.json();
    window.location.href = url;
  } catch (e) {
    showToast(e.message || 'Failed to start checkout', 'error');
  }
}
buyNowBtn?.addEventListener('click', async () => {
  const { user } = await getSession();
  closeBuyModal();
  startPurchase(user);
});

/* ================================
   Fetch report
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

    const r = await fetch(API.report, { method: 'POST', headers, body: JSON.stringify(body) });

    if (r.status === 401 || r.status === 402) { openBuyModal(); return; }
    if (r.status === 409) { showToast('That receipt was already used. Please purchase again.', 'error'); return; }
    if (!r.ok) { const t = await r.text(); showToast(t || ('HTTP ' + r.status), 'error'); return; }

    if (data.as === 'pdf') {
      const blob = await r.blob(); const url = URL.createObjectURL(blob); window.open(url, '_blank');
    } else {
      const html = await r.text(); const w = window.open('', '_blank'); w.document.write(html); w.document.close();
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

/* Init history on load */
renderHistory();
