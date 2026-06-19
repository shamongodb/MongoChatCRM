import { isAuthenticated, loadStoredAuthState, signInWithGoogle } from './auth.js';

const config = window.__WEB_UX_CONFIG__ || {};
const googleClientId = String(config.googleClientId || '').trim();
const apiBaseUrl = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');

const googleButtonEl = document.getElementById('loginGoogleBtn');
const statusEl = document.getElementById('loginStatus');

function setStatus(message) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
}

async function handleSignInClick() {
  try {
    setStatus('Opening Google account picker...');
    if (googleButtonEl) googleButtonEl.disabled = true;
    await signInWithGoogle(googleClientId, apiBaseUrl);
    window.location.replace('/');
  } catch (err) {
    setStatus(`Authentication failed: ${err?.message || String(err)}`);
  } finally {
    if (googleButtonEl) googleButtonEl.disabled = false;
  }
}

function bindEvents() {
  if (!googleButtonEl) return;
  googleButtonEl.addEventListener('click', handleSignInClick);
}

function initLogin() {
  loadStoredAuthState();
  if (isAuthenticated()) {
    window.location.replace('/');
    return;
  }
  bindEvents();
}

initLogin();
