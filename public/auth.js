function makeId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const authState = {
  authToken: null,
  authUser: null,
  userId: null
};

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch (_err) {
    return null;
  }
}

export function isAuthTokenExpired(token = authState.authToken, skewSeconds = 30) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  return Date.now() / 1000 >= Number(payload.exp) - skewSeconds;
}

export function loadStoredAuthState() {
  const token = localStorage.getItem('webUxAuthToken');
  const userRaw = localStorage.getItem('webUxAuthUser');
  authState.authToken = token && String(token).trim() ? String(token).trim() : null;
  if (userRaw) {
    try {
      authState.authUser = JSON.parse(userRaw);
    } catch (_err) {
      authState.authUser = null;
    }
  } else {
    authState.authUser = null;
  }
  authState.userId = authState.authUser?.userId ? String(authState.authUser.userId).trim() : null;
  if (authState.authToken && isAuthTokenExpired(authState.authToken)) {
    authState.authToken = null;
    authState.authUser = null;
    authState.userId = null;
    localStorage.removeItem('webUxAuthToken');
    localStorage.removeItem('webUxAuthUser');
  }
  return getAuthState();
}

export function getAuthState() {
  return {
    authToken: authState.authToken,
    authUser: authState.authUser,
    userId: authState.userId
  };
}

export function isAuthenticated() {
  if (!authState.authToken || !authState.userId) return false;
  if (isAuthTokenExpired(authState.authToken)) return false;
  return true;
}

export function persistAuthState(token, user) {
  authState.authToken = token && String(token).trim() ? String(token).trim() : null;
  authState.authUser = user && typeof user === 'object' ? user : null;
  authState.userId = authState.authUser?.userId ? String(authState.authUser.userId).trim() : null;
  if (authState.authToken) {
    localStorage.setItem('webUxAuthToken', authState.authToken);
  } else {
    localStorage.removeItem('webUxAuthToken');
  }
  if (authState.authUser) {
    localStorage.setItem('webUxAuthUser', JSON.stringify(authState.authUser));
  } else {
    localStorage.removeItem('webUxAuthUser');
  }
  return getAuthState();
}

export function clearAuthState() {
  persistAuthState(null, null);
  localStorage.removeItem('webUxConversationId');
}

function parseOAuthRedirect(urlLike) {
  const raw = String(urlLike || '');
  const hash = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : '';
  const params = new URLSearchParams(hash);
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description');
    throw new Error(description ? String(description).trim() : String(error));
  }
  const idToken = params.get('id_token');
  return idToken ? String(idToken).trim() : '';
}

async function postJson(apiBaseUrl, pathname, body) {
  const url = apiBaseUrl ? `${apiBaseUrl}${pathname}` : pathname;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    throw new Error('Server returned non-JSON response.');
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function exchangeGoogleIdToken(idToken, apiBaseUrl) {
  const out = await postJson(apiBaseUrl, '/api/auth/google/exchange', { idToken });
  if (!out || !out.token || !out.user) {
    throw new Error('Auth exchange response is missing required fields.');
  }
  persistAuthState(out.token, out.user);
  return out;
}

export async function signInWithGoogle(googleClientId, apiBaseUrl = '') {
  const clientId = String(googleClientId || '').trim();
  if (!clientId) throw new Error('Google Sign-In is not configured (missing GOOGLE_CLIENT_ID).');

  const normalizedApiBaseUrl = String(apiBaseUrl || '').trim().replace(/\/+$/, '');
  // Use /login so the OAuth popup does not load index.html, which redirects
  // unauthenticated users and strips the #id_token hash before we can read it.
  const redirectUri = `${window.location.origin}/login`;
  const nonce = makeId('nonce');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'id_token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('prompt', 'select_account');

  const width = 520;
  const height = 640;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  const popup = window.open(
    authUrl.toString(),
    'googleSignIn',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );
  if (!popup) throw new Error('Popup blocked. Allow popups for this site and try again.');

  const idToken = await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > 120000) {
        window.clearInterval(timer);
        try { popup.close(); } catch (_err) { /* ignore */ }
        reject(new Error('Google sign-in timed out.'));
        return;
      }
      if (popup.closed) {
        window.clearInterval(timer);
        reject(new Error('Google sign-in was canceled.'));
        return;
      }
      let href = '';
      try {
        href = String(popup.location.href || '');
      } catch (_err) {
        return;
      }
      if (!href.startsWith(redirectUri)) return;
      if (!href.includes('#')) return;
      let token = '';
      try {
        token = parseOAuthRedirect(href);
      } catch (err) {
        window.clearInterval(timer);
        popup.close();
        reject(err);
        return;
      }
      window.clearInterval(timer);
      popup.close();
      if (!token) {
        reject(new Error('Google sign-in did not return an ID token.'));
        return;
      }
      resolve(token);
    }, 250);
  });

  await exchangeGoogleIdToken(idToken, normalizedApiBaseUrl);
  return getAuthState();
}

export function getAuthTokenOrThrow() {
  if (!authState.authToken || !authState.userId) {
    throw new Error('Sign in with Google to continue.');
  }
  if (isAuthTokenExpired(authState.authToken)) {
    clearAuthState();
    throw new Error('Your session expired. Please sign in again.');
  }
  return authState.authToken;
}

export function buildAuthFailureMessage(res, data) {
  if (Number(res?.status) !== 401) return null;
  const detail = String(data?.details?.message || '').toLowerCase();
  if (detail.includes('expired')) return 'Your session expired. Please sign in again.';
  if (detail.includes('invalid signature') || detail.includes('malformed')) {
    return 'Your session is invalid. Please sign in again.';
  }
  return 'Please sign in again to continue.';
}

export function authHeaders(extraHeaders = {}) {
  const token = getAuthTokenOrThrow();
  return {
    ...extraHeaders,
    Authorization: `Bearer ${token}`
  };
}
