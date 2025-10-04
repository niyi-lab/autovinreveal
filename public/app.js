/* ================================
   Config & Utilities
================================ */
const SUPABASE_URL  = window.VITE_SUPABASE_URL  || (typeof process !== 'undefined' ? process.env.VITE_SUPABASE_URL  : undefined) || '';
const SUPABASE_ANON = window.VITE_SUPABASE_ANON_KEY || (typeof process !== 'undefined' ? process.env.VITE_SUPABASE_ANON_KEY : undefined) || '';

const API = {
  report: '/api/report',
  checkout: '/api/create-checkout-session',
  credits: (uid) => `/api/credits/${uid}`,
};

let supabase = null;
if (window.supabase && SUPABASE_URL && SUPABASE_ANON) {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
}

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

/* Detect Stripe success & capture session_id for guest one-time use */
const urlParams = new URLSearchParams(window.location.search);
const checkoutSuccess = urlParams.get('checkout') === 'success';
const stripeSessionId = urlParams.get('session_id') || null;
if (stripeSessionId) {
  // Optional: clean URL
  history.replaceState({}, '', window.location.pathname);
  if (checkoutSuccess) {
    showToast('Payment confirmed. You can now fetch a report.', 'ok');
  }
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
   Login modal (magic link)
================================ */
const loginBtn = $id('loginBtn');

function buildLoginModal() {
  if ($id('loginModal')) return;
  const container = document.createElement('div');
  container.id = 'loginModal';
  container.className = 'hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50';

  container.innerHTML = `
    <div class="card max-w-md w-[92%]">
      <h2 class="text-lg font-bold mb-2">Sign in</h2>
      <p class="text-sm" style="color:var(--muted)">
        Use your email to sign in. We’ll send a magic link.
      </p>
      <div class="mt-4">
        <label class="lbl">Email</label>
        <input id="loginEmail" type="email" placeholder="you@example.com" class="input" />
      </div>
      <div class="mt-4 flex gap-2">
        <button id="loginSubmit" class="btn btn-primary w-full">Send Magic Link</button>
        <button id="loginCancel" class="btn-outline w-full">Cancel</button>
      </div>
      <p class="mt-3 text-xs" style="color:var(--muted)">
        You can also buy without signing in — Stripe will just ask for your card.
      </p>
    </div>
  `;
  document.body.appendChild(container);

  $id('loginCancel').addEventListener('click', () => hideLoginModal());
  $id('loginSubmit').addEventListener('click', doLogin);
}
function showLoginModal() { buildLoginModal(); $id('loginModal').classList.remove('hidden'); }
function hideLoginModal() { const el = $id('loginModal'); if (el) el.classList.add('hidden'); }

async function doLogin() {
  if (!supabase) { showToast('Supabase client not loaded.', 'error'); return; }
  const email = ($id('loginEmail').value || '').trim();
  if (!email) { showToast('Enter your email.', 'error'); return; }
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) throw error;
    showToast('Magic link sent. Check your email!', 'ok');
    hideLoginModal();
  } catch (e) {
    showToast(e.message || 'Login failed', 'error');
  }
}

loginBtn?.addEventListener('click', showLoginModal);

/* ================================
   Supabase session helpers
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
    allowLive: false     // reopen from cache only
  };
  const headers = { 'Content-Type': 'application/json' };
  const { token } = await getSession();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const r = await fetch(API.report, {
      method: 'POST',
      headers,
      body: JSON.stringify(data)
    });
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
   Buy Credits modal (existing HTML)
================================ */
const buyModal   = $id('buyCreditsModal');
const buyNowBtn  = $id('buyNowBtn');
const closeBuyBtn= $id('closeModalBtn');
function openBuyModal(){ buyModal?.classList.remove('hidden'); }
function closeBuyModal(){ buyModal?.classList.add('hidden'); }

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
closeBuyBtn?.addEventListener('click', closeBuyModal);

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

  // basic validation
  if (!data.vin && !(data.state && data.plate)) {
    showToast('Enter a VIN or a State + Plate', 'error');
    go.disabled = false; loading.classList.add('hidden'); return;
  }
  if (data.vin && !looksVin(data.vin)) {
    showToast('VIN must be 17 characters (no I/O/Q)', 'error');
    go.disabled = false; loading.classList.add('hidden'); return;
  }

  // if logged-in, add Authorization + (optional) check credits
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

  // proceed request
  try {
    const body = {
      vin:  data.vin,
      state:data.state,
      plate:data.plate,
      type: data.type,
      as:   data.as,
      allowLive: true
    };

    // If GUEST and we just returned from Stripe, attach the receipt
    if (!currentUser && stripeSessionId) {
      body.oneTimeSession = stripeSessionId;
    }

    const r = await fetch(API.report, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (r.status === 401 || r.status === 402) {
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

/* ================================
   Initialize history
================================ */
renderHistory();
