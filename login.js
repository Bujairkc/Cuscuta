if (typeof window.DEBUG_DOWNLOADS === 'undefined') {
  window.DEBUG_DOWNLOADS = false;
}

if (typeof window.dlog !== 'function') {
  window.dlog = (...args) => {
    if (window.DEBUG_DOWNLOADS) console.log(...args);
  };
}

// ─── COUNTRIES handled in js/login/countries.js ───────────

// ─── PROFILE MENU ─────────────────────────────────────────
function toggleProfileMenu(e){
  e.stopPropagation();
  const pm = document.getElementById('profile-menu');
  if(!pm) return;
  const open = pm.classList.contains('open');
  if(open) {
    closeProfileMenu();
  } else {
    const nameEl = document.getElementById('user-profile-name');
    const userEl = document.getElementById('user-profile-username');
    const avatarEl = document.getElementById('user-profile-avatar');
    if(nameEl) {
      const name = localStorage.getItem('sv_user_name');
      const username = localStorage.getItem('sv_user_username');
      if (name) {
        nameEl.textContent = name;
        if (userEl) userEl.textContent = username || '';
        if (avatarEl) {
          const initials = name.split(' ').map(n => n[0]).join('').substring(0,2).toUpperCase();
          avatarEl.textContent = initials || '?';
        }
      } else {
        nameEl.textContent = 'Loading...';
      }
    }
    pm.classList.add('open');
    if (tdClient && currentAuthState === 'authorizationStateReady' && !userInfoLoaded) {
      userInfoLoaded = true;
      fetchUserInfo();
    }
  }
}
function closeProfileMenu(){
  const pm = document.getElementById('profile-menu');
  if(pm) pm.classList.remove('open');
}

document.addEventListener('click',e=>{
  if(!e.target.closest('.phone-field-wrap'))closeDropdown();
  if(!e.target.closest('.profile-menu') && !e.target.closest('.profile-toggle-btn')) closeProfileMenu();
});

// ─── STEP NAV ─────────────────────────────────────────────
let currentPage=0;
const TOTAL_DOTS=4;
function goPage(n){
  const allPages = document.querySelectorAll('.auth-page');
  allPages.forEach(p => p.classList.remove('active'));
  const nextEl = document.getElementById('page-'+n);
  if(nextEl) nextEl.classList.add('active');
  currentPage=n;
  updateDots(n);
}
function updateDots(n){
  const map={0:0,1:1,2:2,3:2,4:3};
  const dotIdx=map[n]??n;
  for(let i=0;i<TOTAL_DOTS;i++){
    const d=document.getElementById('dot-'+i);
    if(!d)continue;
    d.className='step-dot';
    if(i<dotIdx)d.classList.add('done');
    else if(i===dotIdx)d.classList.add('active');
  }
  const dots = document.getElementById('step-dots');
  if(dots) dots.style.display=n>=4?'none':'flex';
}

// ─── TDLib Logic ──────────────────────────────────────────
let apiId = localStorage.getItem('sv_api_id') || '';
let apiHash = localStorage.getItem('sv_api_hash') || '';
let tdClient = null;

// Initialize the bridge immediately so it's available to other scripts
window.tdClient = {
  send: (request) => window.electronAPI.send(request)
};
tdClient = window.tdClient;

let currentAuthState = '';
let isAuthorized = false;
let userInfoLoaded = false;

let bridgeInitialized = false;

async function initTDLib() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;

  dlog("[AUTH] INITIALIZING NATIVE BRIDGE");

  // Hook updates from Native TDLib
  window.electronAPI.onUpdate((update) => {
    handleUpdate(update);
  });

  // If we have credentials, trigger native init
  const savedId = localStorage.getItem('sv_api_id');
  const savedHash = localStorage.getItem('sv_api_hash');
  if (savedId && savedHash) {
    window.electronAPI.init({
      apiId: parseInt(savedId),
      apiHash: savedHash
    });
  }
}

function handleUpdate(update) {
  if (!update) return;

  // Dispatch global event for other modules (like sources.js)
  window.dispatchEvent(new CustomEvent('tdlib-update', { detail: update }));

  if (update['@type'] === 'updateNewMessage') {
      const msg = update.message;
      if (msg && msg.content) {
          dlog("[NEW MESSAGE RECEIVED]", msg);
          let file = null;
          if (msg.content['@type'] === 'messageVideo') file = msg.content.video.video;
          else if (msg.content['@type'] === 'messageDocument') file = msg.content.document.document;
          else if (msg.content['@type'] === 'messagePhoto') file = msg.content.photo.sizes?.slice(-1)[0]?.photo;

          if (file && file.id) {
              const fileName = msg.content.video?.file_name || msg.content.document?.file_name || "unknown";
              // log removed to avoid confusion with sources.js filtering
          }
      }
  }

  if (update['@type'] === 'updateFile') {
      const f = update.file;
      dlog("[FILE UPDATE]", {
          id: f.id,
          downloaded: f.local.downloaded_size,
          total: f.size,
          active: f.local.is_downloading_active
      });
  }

  if (update['@type'] !== 'updateFile') {
    dlog("[AUTH] Update received:", update['@type'], update.authorization_state ? update.authorization_state['@type'] : '');
  }

  if (typeof window.handleFileUpdate === 'function' && update['@type'] === 'updateFile') {
    window.handleFileUpdate(update);
    return;
  }

  if (update['@type'] === 'updateFatalError') {
    window.tdlibFatalError = true;
    const err = update.error || {};
    const msg = err.message || "";
    console.error("[FATAL ERROR FULL]", update);
    console.error("[TDLIB ERROR] FATAL:", msg);
    console.error("[ACTIVE CLIENT]", window.tdClient);

    if (msg.includes("binlog") || msg.includes("CRC mismatch") || msg.includes("Failed to validate")) {
      console.warn("[TDLIB] Database corruption detected. Please restart the app.");
    }
    return;
  }

  if (update['@type'] === 'updateAuthorizationState') {
    const state = update.authorization_state['@type'];
    console.log(`[TDLIB AUTH] state=${state}`);
    dlog("[AUTH] State received:", state, update.authorization_state);
    currentAuthState = state;

    if (isAuthorized && state !== 'authorizationStateReady') {
      dlog("[AUTH] Already authorized, ignoring state:", state);
      return;
    }

    switch(state) {
      case 'authorizationStateWaitTdlibParameters':
        console.log(`[TDLIB AUTH] Sending setTdlibParameters`);
        sendTdlibParameters();
        break;
      case 'authorizationStateWaitEncryptionKey':
        dlog("[AUTH] Waiting for encryption key");
        tdClient.send({ '@type': 'checkDatabaseEncryptionKey', encryption_key: '' });
        break;
      case 'authorizationStateWaitPhoneNumber':
        dlog("[AUTH] authorizationStateWaitPhoneNumber");
        if (!localStorage.getItem('sv_session')) document.getElementById('login-page').classList.add('active');
        setLoading('btn-phone-next', false, 'Send Code');
        showStatus('phone-status','','');
        break;
      case 'authorizationStateWaitCode':
        dlog("[AUTH] authorizationStateWaitCode");
        document.getElementById('login-page').classList.add('active');
        if (currentPage !== 2) {
          dlog("[AUTH] Transitioning to OTP page (page-2)");
          goPage(2);
        }
        setupOtpBoxes('otp-row');
        document.querySelector('#otp-row .otp-box').focus();
        setLoading('btn-otp-next', false, 'Verify');
        showStatus('otp-status','','');
        break;
      case 'authorizationStateWaitPassword':
        dlog("[AUTH] TDLib requested Telegram 2FA password", update.authorization_state);
        if (currentPage !== 3 && !isAuthorized) {
          dlog("[AUTH] Transitioning to 2FA page (page-3)");
          document.getElementById('login-page').classList.add('active');
          goPage(3);
          setTimeout(() => { const tfa = document.getElementById('tfa-input'); if (tfa) tfa.focus(); }, 100);
        }
        setLoading('btn-tfa-next', false, 'Sign In');
        showStatus('tfa-status','','');
        break;
      case 'authorizationStateReady':
        dlog("[AUTH] READY");
        isAuthorized = true;
        localStorage.setItem('sv_session', 'true');
        if (!userInfoLoaded) {
          userInfoLoaded = true;
          fetchUserInfo();
          if (typeof window.refreshSavedMessages === 'function') window.refreshSavedMessages();
        }
        break;
      case 'authorizationStateClosed':
        dlog("[AUTH] authorizationStateClosed");
        // Don't nullify tdClient here, it's a bridge
        break;
    }
  }
}

async function fetchUserInfo() {
  if (fetchUserInfo._inProgress) return;
  fetchUserInfo._inProgress = true;
  try {
    const me = await tdClient.send({ '@type': 'getMe' });
    if (me && me['@type'] === 'user') {
      const name = [me.first_name, me.last_name].filter(Boolean).join(' ');
      localStorage.setItem('sv_user_name', name);
      if (me.username) localStorage.setItem('sv_user_username', '@' + me.username);
      else localStorage.removeItem('sv_user_username');
    }
  } catch (e) {
    console.error("[PROFILE] Error fetching user info:", e);
    userInfoLoaded = false;
  } finally {
    fetchUserInfo._inProgress = false;
  }
}

function sendTdlibParameters() {
  if (sendTdlibParameters._done) return;

  // Guard: Only send if we're in the correct authorization state
  if (currentAuthState !== 'authorizationStateWaitTdlibParameters') {
    console.log(`[TDLIB AUTH] BLOCKED setTdlibParameters: invalid state = ${currentAuthState}`);
    return;
  }

  const id = parseInt(apiId);
  if (isNaN(id) || !apiHash) return;
  const params = {
    '@type': 'setTdlibParameters',
    'use_message_database': true,
    'use_secret_chats': false,
    'api_id': id,
    'api_hash': apiHash,
    'system_language_code': 'en',
    'device_model': 'Desktop',
    'application_version': '1.0'
  };
  console.log(`[TDLIB AUTH] Sending setTdlibParameters`);
  tdClient.send(params).then(res => {
      if (res['@type'] !== 'error') {
        sendTdlibParameters._done = true;
        console.log(`[TDLIB AUTH] setTdlibParameters OK`);
      }
  });
}

function submitAPI(){
  const id=document.getElementById('api-id-input').value.trim();
  const hash=document.getElementById('api-hash-input').value.trim();
  if(!id || !hash) return alert('Enter API ID and Hash');
  apiId=id; apiHash=hash;
  localStorage.setItem('sv_api_id', apiId);
  localStorage.setItem('sv_api_hash', apiHash);
  goPage(1);

  initTDLib();
  // Also ensure native init is called with the new credentials
  window.electronAPI.init({
    apiId: parseInt(apiId),
    apiHash: apiHash
  });
}

async function sendCode(){
  const p=document.getElementById('phone-input').value.trim();
  if(p.length<6) return;
  const fp = selectedCountry.code.replace('+','') + p;
  setLoading('btn-phone-next', true);
  showStatus('phone-status','connecting','Connecting to Telegram…');

  initTDLib();

  if (currentAuthState === 'authorizationStateWaitPhoneNumber') {
    tdClient.send({ '@type': 'setAuthenticationPhoneNumber', phone_number: fp }).then(res => {
      if (res['@type'] === 'error') {
        showStatus('phone-status', 'error-badge', res.message);
        setLoading('btn-phone-next', false, 'Send Code');
      } else {
        document.getElementById('phone-display').textContent=selectedCountry.code+' '+p;
      }
    });
  } else if (currentAuthState === 'authorizationStateWaitCode') {
    dlog("[AUTH] sendCode: already in WaitCode, navigating to page-2");
    goPage(2);
  } else if (currentAuthState === 'authorizationStateWaitPassword') {
    dlog("[AUTH] sendCode: already in WaitPassword, navigating to page-3");
    goPage(3);
  }
}

async function submitCode(){
  const boxes=document.querySelectorAll('#otp-row .otp-box');
  const code=Array.from(boxes).map(b=>b.value).join('');
  if(code.length<5) return;
  setLoading('btn-otp-next', true);
  showStatus('otp-status','connecting','Verifying code…');
  tdClient.send({ '@type': 'checkAuthenticationCode', code: code }).then(res => {
    if (res['@type'] === 'error') {
      showError('otp-err', res.message);
      setLoading('btn-otp-next', false, 'Verify');
      showStatus('otp-status','','');
    }
  });
}

async function submit2FA(){
  const input = document.getElementById('tfa-input');
  if (!input) return;
  const pwd = input.value;
  if(!pwd) return showError('tfa-err', 'Please enter your password');
  setLoading('btn-tfa-next', true);
  showStatus('tfa-status','connecting','Checking password…');
  try {
    dlog("[AUTH] Sending checkAuthenticationPassword");
    const res = await tdClient.send({ '@type': 'checkAuthenticationPassword', 'password': String(pwd) });
    if (res['@type'] === 'error') {
      console.error("[AUTH] Password error:", res.message);
      showError('tfa-err', res.message);
      setLoading('btn-tfa-next', false, 'Sign In');
      showStatus('tfa-status','','');
    } else {
      dlog("[AUTH] Password accepted");
    }
  } catch (err) {
    console.error("[AUTH] 2FA crash:", err);
    showError('tfa-err', err.message);
    setLoading('btn-tfa-next', false, 'Sign In');
    showStatus('tfa-status','','');
  }
}

function resendCode(){
  if (currentAuthState === 'authorizationStateWaitCode') {
    tdClient.send({ '@type': 'resendAuthenticationCode' });
  }
}

function logout(){
  if(!confirm('Logout from StreamVault?')) return;
  tdClient.send({ '@type': 'logOut' }).then(() => {
    localStorage.removeItem('sv_session');
    location.reload();
  });
}

function setupOtpBoxes(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const boxes = row.querySelectorAll('.otp-box');
  boxes.forEach((b, idx) => {
    b.oninput = () => {
      if (b.value && idx < boxes.length - 1) boxes[idx+1].focus();
    };
    b.onkeydown = (e) => {
      if (e.key === 'Backspace' && !b.value && idx > 0) boxes[idx-1].focus();
    };
  });
}

function setLoading(btnId, loading, text) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<div class="player-spinner" style="width:16px;height:16px;margin:0"></div>';
  } else {
    btn.disabled = false;
    btn.innerHTML = text + ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
  }
}

function showStatus(id, type, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'auth-status ' + type;
  el.textContent = msg;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}

// ─── INITIALIZE ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTDLib();
});
