/**
 * Wiedza Uploader Plugin
 *
 * Uploads a character's known wiedza entries from the local Arkadia client
 * to the Arkadia CMS.
 *
 * Flow:
 *  1. Reads per-character wiedza progress from IndexedDB
 *     (ArkadiaKnowledgeDetailsDBv2 / knowledge_entries store).
 *  2. Authorizes against the CMS via OAuth Authorization Code + PKCE,
 *     client_id = "wiedza-tracker", scope = "update_own_wiedza".
 *  3. POSTs { entries: string[] } to /wp-json/arkadia/v1/wiedza/me.
 *
 * See README.md for build / host / OAuth-registration details.
 */

import type {PersistentPopupHandle, PluginApi, PluginInfo} from '@arkadia/plugin-types';

const CMS_BASE = 'http://localhost:8000';
const AUTHORIZE_URL = `${CMS_BASE}/wp-json/arkadia/v1/oauth/authorize`;
const TOKEN_URL = `${CMS_BASE}/wp-json/arkadia/v1/oauth/token`;
const WIEDZA_URL = `${CMS_BASE}/wp-json/arkadia/v1/wiedza/me`;
const CLIENT_ID = 'wiedza-tracker';
const SCOPE = 'update_own_wiedza';

const TOKEN_STORAGE_KEY = 'plugin:wiedza-uploader:token';
const AUTO_UPLOAD_STORAGE_KEY = 'plugin:wiedza-uploader:autoCharacter';
const LAST_HASH_STORAGE_KEY = 'plugin:wiedza-uploader:lastHash';
const POPUP_ID = 'wiedzaUploader';

const AUTO_UPLOAD_DEBOUNCE_MS = 5000;

const KNOWLEDGE_DB_NAME = 'ArkadiaKnowledgeDetailsDBv2';
const ENTRIES_STORE = 'knowledge_entries';

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

interface KnowledgeEntryRecord {
  id: string;
  character: string;
  category: string;
  type: 'fight' | 'books' | 'exploration';
  canonical: string;
  updatedAt?: number;
}

interface UploadResponse {
  entries: Record<string, number[]>;
  total: number;
  unmatched: string[];
}

interface OAuthSuccessMessage {
  type: 'arkadia-oauth-callback';
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

function loadToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredToken;
    if (!parsed.accessToken || typeof parsed.expiresAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveToken(token: StoredToken | null): void {
  if (!token) {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
}

function tokenIsValid(token: StoredToken | null): token is StoredToken {
  return !!token && token.expiresAt - 30_000 > Date.now();
}

function loadAutoUploadCharacter(): string | null {
  const value = localStorage.getItem(AUTO_UPLOAD_STORAGE_KEY);
  return value && value.length > 0 ? value : null;
}

function saveAutoUploadCharacter(character: string | null): void {
  if (!character) {
    localStorage.removeItem(AUTO_UPLOAD_STORAGE_KEY);
  } else {
    localStorage.setItem(AUTO_UPLOAD_STORAGE_KEY, character);
  }
}

function loadLastUploadedHash(character: string): string | null {
  return localStorage.getItem(`${LAST_HASH_STORAGE_KEY}:${character}`);
}

function saveLastUploadedHash(character: string, hash: string): void {
  localStorage.setItem(`${LAST_HASH_STORAGE_KEY}:${character}`, hash);
}

function hashEntries(entries: string[]): string {
  const sorted = [...entries].sort();
  let h = 5381;
  for (const entry of sorted) {
    for (let i = 0; i < entry.length; i++) {
      h = ((h << 5) + h + entry.charCodeAt(i)) | 0;
    }
    h = ((h << 5) + h + 0x1f) | 0;
  }
  return (h >>> 0).toString(16) + ':' + sorted.length;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes).slice(0, length);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

function callbackUrl(): string {
  // Resolved against the plugin's own module URL so the callback HTML
  // can live alongside the plugin bundle (wherever it's hosted), instead
  // of being shipped with the main client.
  return new URL('./oauth-callback.html', import.meta.url).toString();
}

function openKnowledgeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KNOWLEDGE_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open ArkadiaKnowledgeDetailsDBv2'));
  });
}

async function readAllEntries(): Promise<KnowledgeEntryRecord[]> {
  const db = await openKnowledgeDb();
  try {
    if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
      return [];
    }
    return await new Promise<KnowledgeEntryRecord[]>((resolve, reject) => {
      const tx = db.transaction(ENTRIES_STORE, 'readonly');
      const store = tx.objectStore(ENTRIES_STORE);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as KnowledgeEntryRecord[]);
      request.onerror = () => reject(request.error ?? new Error('Cannot read knowledge_entries'));
    });
  } finally {
    db.close();
  }
}

function listCharacters(entries: KnowledgeEntryRecord[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    if (entry.character) set.add(entry.character);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function flattenEntriesFor(character: string, all: KnowledgeEntryRecord[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of all) {
    if (entry.character !== character) continue;
    const value = typeof entry.canonical === 'string' ? entry.canonical.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function awaitOAuthCallback(expectedState: string): Promise<OAuthSuccessMessage> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      const data = event.data as OAuthSuccessMessage | undefined;
      if (!data || data.type !== 'arkadia-oauth-callback') return;
      if (data.state !== expectedState) {
        cleanup();
        reject(new Error('OAuth state mismatch'));
        return;
      }
      cleanup();
      resolve(data);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('OAuth login timed out'));
    }, 5 * 60 * 1000);

    function cleanup() {
      window.removeEventListener('message', handler);
      window.clearTimeout(timeout);
    }

    window.addEventListener('message', handler);
  });
}

async function startOAuth(): Promise<StoredToken> {
  const verifier = randomString(64);
  const challenge = await pkceChallenge(verifier);
  const state = randomString(32);
  const redirectUri = callbackUrl();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;
  const popup = window.open(authUrl, 'arkadiaOauth', 'width=520,height=720');
  if (!popup) {
    throw new Error('Nie udalo sie otworzyc okna logowania (popup zablokowany).');
  }

  const message = await awaitOAuthCallback(state);
  if (message.error) {
    throw new Error(message.errorDescription || message.error);
  }
  if (!message.code) {
    throw new Error('Brak kodu autoryzacji w odpowiedzi.');
  }

  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: message.code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Wymiana kodu na token nie powiodla sie: ${tokenResponse.status} ${text}`);
  }

  const payload = await tokenResponse.json() as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };

  const token: StoredToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    scope: payload.scope,
  };
  saveToken(token);
  return token;
}

async function exchangeCodeForToken(code: string, verifier: string, redirectUri: string): Promise<StoredToken | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    const token: StoredToken = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + payload.expires_in * 1000,
      scope: payload.scope,
    };
    saveToken(token);
    return token;
  } catch {
    return null;
  }
}

async function attemptSilentRefresh(): Promise<StoredToken | null> {
  const verifier = randomString(64);
  const challenge = await pkceChallenge(verifier);
  const state = randomString(32);
  const redirectUri = callbackUrl();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'none',
  });
  const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;

  return new Promise<StoredToken | null>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      window.clearTimeout(timeoutId);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    const handler = async (event: MessageEvent) => {
      const data = event.data as OAuthSuccessMessage | undefined;
      if (!data || data.type !== 'arkadia-oauth-callback') return;
      if (data.state !== state) return;
      cleanup();
      if (data.error || !data.code) {
        resolve(null);
        return;
      }
      resolve(await exchangeCodeForToken(data.code, verifier, redirectUri));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 15000);

    window.addEventListener('message', handler);
    iframe.src = authUrl;
    document.body.appendChild(iframe);
  });
}

async function ensureFreshToken(): Promise<StoredToken | null> {
  const existing = loadToken();
  const fiveMin = 5 * 60 * 1000;
  if (existing && existing.expiresAt - Date.now() > fiveMin) {
    return existing;
  }
  const refreshed = await attemptSilentRefresh();
  if (refreshed) return refreshed;
  return tokenIsValid(existing) ? existing : null;
}

async function uploadEntries(token: StoredToken, entries: string[]): Promise<UploadResponse> {
  const response = await fetch(WIEDZA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token.accessToken}`,
    },
    body: JSON.stringify({ entries }),
  });

  if (response.status === 401) {
    saveToken(null);
    throw new Error('Sesja wygasla. Zaloguj sie ponownie.');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload nie powiodl sie: ${response.status} ${text}`);
  }
  return await response.json() as UploadResponse;
}

interface UiState {
  characters: string[];
  selected: string | null;
  entries: KnowledgeEntryRecord[];
  status: string;
  statusKind: 'info' | 'ok' | 'err';
  lastResult: UploadResponse | null;
  busy: boolean;
  autoUploadCharacter: string | null;
}

function createUi(api: PluginApi): {
  root: HTMLDivElement;
  refresh: () => Promise<void>;
  onKnowledgeUpdated: (character: string) => void;
} {
  const state: UiState = {
    characters: [],
    selected: null,
    entries: [],
    status: '',
    statusKind: 'info',
    lastResult: null,
    busy: false,
    autoUploadCharacter: loadAutoUploadCharacter(),
  };

  let autoUploadTimer: number | null = null;
  let autoUploadInFlight = false;

  const root = document.createElement('div');
  root.className = 'p-3';
  root.style.minWidth = '360px';

  const lead = document.createElement('p');
  lead.className = 'text-muted small mb-3';
  lead.textContent = 'Wyslij wiedze postaci na strone Arkadii.';
  root.appendChild(lead);

  const charGroup = document.createElement('div');
  charGroup.className = 'mb-3';
  root.appendChild(charGroup);

  const charLabel = document.createElement('label');
  charLabel.className = 'form-label small mb-1';
  charLabel.textContent = 'Postac';
  charGroup.appendChild(charLabel);

  const select = document.createElement('select');
  select.className = 'form-select form-select-sm';
  charGroup.appendChild(select);

  const summary = document.createElement('div');
  summary.className = 'form-text mt-1';
  charGroup.appendChild(summary);

  const autoUploadWrap = document.createElement('div');
  autoUploadWrap.className = 'form-check form-switch mt-2';
  charGroup.appendChild(autoUploadWrap);

  const autoUploadInput = document.createElement('input');
  autoUploadInput.type = 'checkbox';
  autoUploadInput.className = 'form-check-input';
  autoUploadInput.id = 'wiedza-uploader-auto';
  autoUploadWrap.appendChild(autoUploadInput);

  const autoUploadLabel = document.createElement('label');
  autoUploadLabel.className = 'form-check-label small';
  autoUploadLabel.htmlFor = 'wiedza-uploader-auto';
  autoUploadLabel.textContent = 'Wysylaj automatycznie wiedze tej postaci';
  autoUploadWrap.appendChild(autoUploadLabel);

  const buttons = document.createElement('div');
  buttons.className = 'd-flex flex-wrap gap-2 mb-3';
  root.appendChild(buttons);

  const loginBtn = document.createElement('button');
  loginBtn.type = 'button';
  loginBtn.className = 'btn btn-sm btn-outline-secondary';
  loginBtn.textContent = 'Zaloguj';
  buttons.appendChild(loginBtn);

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'btn btn-sm btn-outline-danger';
  logoutBtn.textContent = 'Wyloguj';
  buttons.appendChild(logoutBtn);

  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'btn btn-sm btn-primary ms-auto';
  uploadBtn.textContent = 'Wyslij wiedze';
  buttons.appendChild(uploadBtn);

  const statusLine = document.createElement('div');
  statusLine.className = 'small mb-2';
  statusLine.style.minHeight = '1.25rem';
  root.appendChild(statusLine);

  const resultBlock = document.createElement('div');
  resultBlock.className = 'small';
  root.appendChild(resultBlock);

  function setStatus(message: string, kind: UiState['statusKind'] = 'info'): void {
    state.status = message;
    state.statusKind = kind;
    statusLine.className = 'small mb-2 ' + (
      kind === 'err' ? 'text-danger'
      : kind === 'ok' ? 'text-success'
      : 'text-muted'
    );
    statusLine.textContent = message;
  }

  function render(): void {
    const token = loadToken();
    const validToken = tokenIsValid(token);

    charGroup.style.display = validToken ? '' : 'none';
    logoutBtn.style.display = validToken ? '' : 'none';
    uploadBtn.style.display = validToken ? '' : 'none';
    lead.textContent = validToken
      ? 'Wyslij wiedze postaci na strone Arkadii.'
      : 'Zaloguj sie do CMS aby wyslac wiedze postaci.';

    loginBtn.textContent = validToken ? 'Zaloguj ponownie' : 'Zaloguj';
    loginBtn.className = validToken
      ? 'btn btn-sm btn-outline-secondary'
      : 'btn btn-sm btn-primary';
    loginBtn.disabled = state.busy;

    select.innerHTML = '';
    if (state.characters.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(brak danych wiedzy)';
      select.appendChild(opt);
      select.disabled = true;
    } else {
      select.disabled = false;
      for (const character of state.characters) {
        const opt = document.createElement('option');
        opt.value = character;
        opt.textContent = character;
        if (character === state.selected) opt.selected = true;
        select.appendChild(opt);
      }
    }

    const count = state.selected
      ? flattenEntriesFor(state.selected, state.entries).length
      : 0;
    summary.textContent = state.selected
      ? `${count} wpisow gotowych do wyslania.`
      : 'Wybierz postac.';

    logoutBtn.disabled = !token || state.busy;
    uploadBtn.disabled = state.busy || !state.selected || count === 0;

    autoUploadInput.checked = !!state.autoUploadCharacter && state.autoUploadCharacter === state.selected;
    autoUploadInput.disabled = !state.selected || state.busy;
    if (state.autoUploadCharacter && state.autoUploadCharacter !== state.selected) {
      autoUploadLabel.textContent = `Auto-upload aktywny dla "${state.autoUploadCharacter}" (wybierz te postac aby zmienic).`;
    } else {
      autoUploadLabel.textContent = 'Wysylaj automatycznie wiedze tej postaci';
    }

    resultBlock.innerHTML = '';
    if (state.lastResult) {
      const r = state.lastResult;
      const alert = document.createElement('div');
      alert.className = r.unmatched.length > 0 ? 'alert alert-warning py-2 px-3 mb-0' : 'alert alert-success py-2 px-3 mb-0';

      const summaryRow = document.createElement('div');
      summaryRow.className = 'fw-semibold mb-1';
      summaryRow.textContent = `Dopasowano: ${r.total} wpisow w ${Object.keys(r.entries).length} kategoriach.`;
      alert.appendChild(summaryRow);

      if (r.unmatched.length > 0) {
        const heading = document.createElement('div');
        heading.className = 'small text-muted mb-1';
        heading.textContent = `Niedopasowane (${r.unmatched.length}):`;
        alert.appendChild(heading);

        const list = document.createElement('ul');
        list.className = 'small mb-0 ps-3';
        for (const entry of r.unmatched.slice(0, 20)) {
          const li = document.createElement('li');
          li.textContent = entry;
          list.appendChild(li);
        }
        if (r.unmatched.length > 20) {
          const li = document.createElement('li');
          li.className = 'text-muted';
          li.textContent = `... i ${r.unmatched.length - 20} wiecej`;
          list.appendChild(li);
        }
        alert.appendChild(list);
      }
      resultBlock.appendChild(alert);
    }
  }

  async function loadData(): Promise<void> {
    try {
      state.entries = await readAllEntries();
      state.characters = listCharacters(state.entries);
      if (!state.selected || !state.characters.includes(state.selected)) {
        state.selected = state.characters[0] ?? null;
      }
      if (state.characters.length === 0) {
        setStatus('Brak zapisanej wiedzy w lokalnej bazie.', 'info');
      } else if (!state.status) {
        setStatus('', 'info');
      }
    } catch (err) {
      setStatus(`Nie udalo sie wczytac wiedzy: ${(err as Error).message}`, 'err');
    }
    render();
  }

  async function performAutoUpload(character: string): Promise<void> {
    if (autoUploadInFlight) {
      return;
    }
    const token = await ensureFreshToken();
    if (!token) {
      setStatus('Auto-upload: sesja wygasla, zaloguj sie ponownie.', 'err');
      render();
      return;
    }
    state.entries = await readAllEntries();
    const entries = flattenEntriesFor(character, state.entries);
    if (entries.length === 0) {
      return;
    }
    const hash = hashEntries(entries);
    if (hash === loadLastUploadedHash(character)) {
      return;
    }
    autoUploadInFlight = true;
    setStatus(`Auto-upload: wysylam ${entries.length} wpisow...`, 'info');
    render();
    try {
      const result = await uploadEntries(token, entries);
      state.lastResult = result;
      saveLastUploadedHash(character, hash);
      setStatus(`Auto-upload: dopasowano ${result.total}/${entries.length}.`, 'ok');
    } catch (err) {
      setStatus(`Auto-upload: ${(err as Error).message}`, 'err');
    } finally {
      autoUploadInFlight = false;
      render();
    }
  }

  function scheduleAutoUpload(character: string): void {
    if (autoUploadTimer !== null) {
      window.clearTimeout(autoUploadTimer);
    }
    autoUploadTimer = window.setTimeout(() => {
      autoUploadTimer = null;
      void performAutoUpload(character);
    }, AUTO_UPLOAD_DEBOUNCE_MS);
  }

  autoUploadInput.addEventListener('change', () => {
    if (autoUploadInput.checked) {
      if (!state.selected) {
        autoUploadInput.checked = false;
        return;
      }
      state.autoUploadCharacter = state.selected;
      saveAutoUploadCharacter(state.selected);
      setStatus(`Auto-upload wlaczony dla "${state.selected}".`, 'ok');
      void performAutoUpload(state.selected);
    } else {
      state.autoUploadCharacter = null;
      saveAutoUploadCharacter(null);
      if (autoUploadTimer !== null) {
        window.clearTimeout(autoUploadTimer);
        autoUploadTimer = null;
      }
      setStatus('Auto-upload wylaczony.', 'info');
    }
    render();
  });

  select.addEventListener('change', () => {
    state.selected = select.value || null;
    state.lastResult = null;
    render();
  });

  loginBtn.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    setStatus('Otwieram okno logowania...', 'info');
    render();
    try {
      await startOAuth();
      setStatus('Zalogowano.', 'ok');
    } catch (err) {
      setStatus(`Blad logowania: ${(err as Error).message}`, 'err');
    } finally {
      state.busy = false;
      render();
    }
  });

  logoutBtn.addEventListener('click', () => {
    saveToken(null);
    setStatus('Wylogowano.', 'info');
    render();
  });

  uploadBtn.addEventListener('click', async () => {
    if (state.busy || !state.selected) return;
    let token = await ensureFreshToken();
    if (!token) {
      try {
        state.busy = true;
        setStatus('Sesja wygasla, loguje ponownie...', 'info');
        render();
        token = await startOAuth();
      } catch (err) {
        setStatus(`Blad logowania: ${(err as Error).message}`, 'err');
        state.busy = false;
        render();
        return;
      } finally {
        state.busy = false;
      }
    }
    const entries = flattenEntriesFor(state.selected, state.entries);
    if (entries.length === 0) {
      setStatus('Brak wpisow do wyslania.', 'err');
      render();
      return;
    }
    state.busy = true;
    setStatus(`Wysylam ${entries.length} wpisow...`, 'info');
    render();
    try {
      const result = await uploadEntries(token!, entries);
      state.lastResult = result;
      setStatus(`Sukces: dopasowano ${result.total}/${entries.length}.`, 'ok');
    } catch (err) {
      setStatus(`Blad wysylania: ${(err as Error).message}`, 'err');
    } finally {
      state.busy = false;
      render();
    }
  });

  render();

  function onKnowledgeUpdated(character: string): void {
    if (!state.autoUploadCharacter) return;
    if (state.autoUploadCharacter !== character) return;
    // Don't check token validity here — performAutoUpload calls ensureFreshToken
    // which silently refreshes the OAuth token if the WP session is still alive.
    scheduleAutoUpload(character);
  }

  return {
    root,
    refresh: loadData,
    onKnowledgeUpdated,
  };
}

export async function init(api: PluginApi): Promise<PluginInfo> {
  let popupHandle: PersistentPopupHandle | null = null;
  const ui = createUi(api);
  void ui.refresh();

  popupHandle = await api.ui.registerPersistentPopup({
    id: POPUP_ID,
    title: 'Wiedza Uploader',
    createContent: () => {
      void ui.refresh();
      return ui.root;
    },
  });

  api.ui.addPopupMenuEntry('Wyslij wiedze do CMS', () => {
    if (!popupHandle) return;
    if (popupHandle.isOpen) {
      popupHandle.close();
    } else {
      void popupHandle.open();
    }
  });

  api.events.on('knowledgeDetailsUpdated', (payload) => {
    if (payload && typeof payload.character === 'string') {
      ui.onKnowledgeUpdated(payload.character);
    }
  });

  return {
    name: 'Wiedza Uploader',
    version: '0.2.0',
    author: 'Arkadia',
    description: 'Wysyla wiedze postaci do CMS przez OAuth (PKCE) z opcja auto-uploadu.',
  };
}

export async function destroy(): Promise<void> {
  // Popup + popup-menu entries are auto-cleaned by the plugin host.
  // Token stays in localStorage on purpose so the user does not need to re-login on reload.
}
