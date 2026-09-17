import { inspect } from 'node:util';

/** A server rejection. Conflict snapshots stay available without appearing in logs. */
export class CloudError extends Error {
  constructor(status, message, data = {}, code = 'HTTP_ERROR') {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    Object.defineProperty(this, 'data', { value: data, enumerable: false });
  }
  toJSON() { return { name: this.name, status: this.status, code: this.code, message: this.message }; }
  [inspect.custom]() { return this.toJSON(); }
}

/** HTTP transport only: callers own save revisions, leases and conflict resolution. */
export class CloudClient {
  #cookie = '';
  #csrf = '';
  #fetch;

  constructor({ baseUrl, timeoutMs = 15_000, session, fetchImpl = globalThis.fetch } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      throw new TypeError('baseUrl 必須是沒有帳密或路徑的 HTTP(S) 伺服器網址');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs 必須是正整數');
    if (typeof fetchImpl !== 'function') throw new TypeError('需要 fetch 函式');
    Object.defineProperty(this, 'baseUrl', { value: url.origin, enumerable: true });
    this.timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
    if (session) {
      if (session.baseUrl && new URL(session.baseUrl).origin !== this.baseUrl) {
        throw new TypeError('登入資料屬於不同伺服器');
      }
      if (typeof session.cookie !== 'string' || !/^idle_session=[\w-]+$/.test(session.cookie) ||
          typeof session.csrf !== 'string' || !/^[\w-]+$/.test(session.csrf)) {
        throw new TypeError('登入資料格式不正確');
      }
      this.#cookie = session.cookie;
      this.#csrf = session.csrf;
    }
  }

  get authenticated() { return !!(this.#cookie && this.#csrf); }
  toJSON() { return { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, authenticated: this.authenticated }; }
  [inspect.custom]() { return this.toJSON(); }

  /** Sensitive: save this only in the private CLI profile; never print it. */
  exportSession() {
    return this.authenticated ? { baseUrl: this.baseUrl, cookie: this.#cookie, csrf: this.#csrf } : null;
  }

  register(username, password) { return this.#request('/api/auth/register', { username, password }, false); }
  login(username, password) { return this.#request('/api/auth/login', { username, password }, false); }
  me() { return this.#request('/api/me'); }
  bootstrap() { return this.#request('/api/bootstrap'); }
  acquireLease(lease, { takeover = false } = {}) { return this.#request('/api/lease', { lease, takeover: takeover === true }); }
  sync({ lease, revision, changes, presence = {} }) { return this.#request('/api/sync', { lease, revision, changes, presence }); }
  world() { return this.#request('/api/world'); }
  chat(text) { return this.#request('/api/chat', { text }); }
  async logout() {
    const result = await this.#request('/api/auth/logout', {});
    this.#cookie = '';
    this.#csrf = '';
    return result;
  }

  async #request(path, body, csrfRequired = true) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const headers = { Accept: 'application/json' };
    if (this.#cookie) headers.Cookie = this.#cookie;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.Origin = this.baseUrl;
      if (csrfRequired) headers['X-CSRF-Token'] = this.#csrf;
    }
    let response, data;
    try {
      response = await this.#fetch(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', cache: 'no-store', signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new CloudError(response.status, '伺服器重新導向已拒絕，請確認伺服器網址', {}, 'REDIRECT_REFUSED');
      }
      try { data = await response.json(); }
      catch (error) {
        if (signal.aborted) throw error;
        throw new CloudError(response.status, '伺服器未回傳有效的 JSON', {}, 'INVALID_RESPONSE');
      }
    } catch (error) {
      if (error instanceof CloudError) throw error;
      // Native fetch errors can contain request details; expose a safe diagnostic only.
      throw new CloudError(0, signal.aborted ? '伺服器連線逾時' : '無法連線到遊戲伺服器', {},
        signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CloudError(response.status, '伺服器回應格式不正確', {}, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      if (response.status === 401) { this.#cookie = ''; this.#csrf = ''; }
      const message = typeof data.error === 'string' ? data.error : '伺服器拒絕請求';
      throw new CloudError(response.status, message, data,
        response.status === 409 ? 'SAVE_CONFLICT' : response.status === 423 ? 'LEASE_CONFLICT' : 'HTTP_ERROR');
    }
    const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || ''];
    for (const cookie of setCookies) {
      const match = /^idle_session=([\w-]*)(?:;|$)/.exec(cookie);
      if (match) this.#cookie = match[1] ? `idle_session=${match[1]}` : '';
    }
    if (typeof data.csrf === 'string') this.#csrf = data.csrf;
    return data;
  }
}
