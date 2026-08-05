/**
 * Network logger — an XHR interceptor.
 *
 * Patches the three XMLHttpRequest.prototype methods that carry request data and
 * accumulates one record per request. Only the public XHR DOM API is used
 * (open / setRequestHeader / send / readystatechange), never a react-native
 * internal module path, so a RN upgrade can't move the ground under us.
 *
 * `fetch` needs no separate handling — RN implements it on top of
 * XMLHttpRequest, so patching XHR captures both.
 *
 * Three deliberate properties of the recorded shape:
 *   - `duration` is undefined until the response lands, never a negative number
 *   - transport failures are a distinct state, not status 0/-1 masquerading as one
 *   - response bodies are stored verbatim, with no {data: ...} re-wrapping
 */

/**
 * Local logger, kept inline so this file stays free of internal imports and can
 * be pulled in anywhere without dragging a dependency tree along.
 */
const warn = (...args: unknown[]) => {
  if (__DEV__) console.warn('[networkLogger]', ...args);
};

export type NetworkLogMethod =
  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | string;

/** Why a request ended without an HTTP status. */
export type NetworkFailure = 'error' | 'timeout' | 'abort';

export type NetworkLogEntry = {
  id: string;
  method: NetworkLogMethod;
  url: string;
  /** Set once the request completes; undefined while in flight. */
  status?: number;
  /** Set instead of `status` when the request never reached the protocol layer. */
  failure?: NetworkFailure;
  startTime: number;
  endTime?: number;
  /** Milliseconds, only once complete. Never negative. */
  duration?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Verbatim request body as passed to send(). */
  requestBody?: unknown;
  /** Verbatim response — may be a string, an object, or a Blob handle. */
  response?: unknown;
  responseType?: string;
  responseURL?: string;
  responseContentType?: string;
  responseSize?: number;
  timeout?: number;
};

type Listener = () => void;

const DEFAULT_MAX_REQUESTS = 500;

/** Fields XHR exposes that we stash on the request object to correlate callbacks. */
const TAG = '__netLogId';

type TaggedXHR = XMLHttpRequest & { [TAG]?: string };

let entries: NetworkLogEntry[] = [];
let byId = new Map<string, NetworkLogEntry>();
const listeners = new Set<Listener>();

let enabled = false;
let maxRequests = DEFAULT_MAX_REQUESTS;
let ignoredHosts: Set<string> | undefined;
let ignoredUrls: Set<string> | undefined;
let ignoredPatterns: RegExp[] | undefined;

let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/* ------------------------------------------------------------------ *
 * Notification is coalesced to one microtask-ish tick: a burst of
 * parallel requests would otherwise re-render the list once per
 * callback, and each callback fires up to 4x per request.
 * ------------------------------------------------------------------ */
let notifyScheduled = false;

const notify = () => {
  if (notifyScheduled) return;
  notifyScheduled = true;
  setTimeout(() => {
    notifyScheduled = false;
    listeners.forEach((l) => {
      try {
        l();
      } catch (e) {
        warn('listener threw', e);
      }
    });
  }, 0);
};

const hostOf = (url: string): string => {
  // Deliberately not `new URL()` — it throws on the relative and scheme-less
  // urls that show up in dev, and this runs on every single request.
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return m?.[1] ?? '';
};

const isIgnored = (method: string, url: string) => {
  if (ignoredUrls?.has(url)) return true;
  if (ignoredHosts?.size) {
    const host = hostOf(url);
    // Strip credentials/port so 'api.example.com' matches 'api.example.com:443'.
    const bare = host.replace(/^.*@/, '').replace(/:\d+$/, '');
    if (ignoredHosts.has(host) || ignoredHosts.has(bare)) return true;
  }
  if (ignoredPatterns?.length) {
    const target = `${method} ${url}`;
    if (ignoredPatterns.some((re) => re.test(target))) return true;
  }
  return false;
};

/** Oldest-first eviction, so the list stays bounded on a long session. */
const push = (entry: NetworkLogEntry) => {
  entries.push(entry);
  byId.set(entry.id, entry);
  while (entries.length > maxRequests) {
    const dropped = entries.shift();
    if (dropped) byId.delete(dropped.id);
  }
};

/** `a: 1\r\nb: 2` → {a: '1', b: '2'} */
const parseHeaderBlock = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
};

const complete = (entry: NetworkLogEntry, patch: Partial<NetworkLogEntry>) => {
  // Guard against a double-finish (e.g. error firing after readyState DONE):
  // the first outcome wins, so a real status is never overwritten by an abort.
  if (entry.endTime !== undefined) return;
  const endTime = Date.now();
  Object.assign(entry, patch, {
    endTime,
    duration: Math.max(0, endTime - entry.startTime),
  });
  notify();
};

/* ------------------------------------------------------------------ *
 * Prototype patching
 * ------------------------------------------------------------------ */

type Originals = {
  open: XMLHttpRequest['open'];
  send: XMLHttpRequest['send'];
  setRequestHeader: XMLHttpRequest['setRequestHeader'];
};

let originals: Originals | undefined;

export const startNetworkLogging = (options?: {
  maxRequests?: number;
  ignoredHosts?: string[];
  ignoredUrls?: string[];
  ignoredPatterns?: RegExp[];
}) => {
  if (enabled) return;

  if (options?.maxRequests !== undefined) {
    if (typeof options.maxRequests !== 'number' || options.maxRequests < 1) {
      warn('maxRequests must be a number > 0; ignoring');
    } else {
      maxRequests = options.maxRequests;
    }
  }
  ignoredHosts = options?.ignoredHosts?.length
    ? new Set(options.ignoredHosts)
    : undefined;
  ignoredUrls = options?.ignoredUrls?.length
    ? new Set(options.ignoredUrls)
    : undefined;
  ignoredPatterns = options?.ignoredPatterns?.length
    ? options.ignoredPatterns
    : undefined;

  const proto = XMLHttpRequest.prototype;
  originals = {
    open: proto.open,
    send: proto.send,
    setRequestHeader: proto.setRequestHeader,
  };
  const {
    open: originalOpen,
    send: originalSend,
    setRequestHeader: originalSetRequestHeader,
  } = originals;

  proto.open = function (
    this: TaggedXHR,
    method: string,
    url: string,
    ...rest: AnyType[]
  ) {
    try {
      if (!isIgnored(method, url)) {
        const entry: NetworkLogEntry = {
          id: nextId(),
          method,
          url,
          startTime: Date.now(),
          requestHeaders: {},
          responseHeaders: {},
        };
        this[TAG] = entry.id;
        push(entry);
        notify();
      } else {
        // An XHR object can be reused across requests; clear any prior tag so a
        // later ignored call doesn't write into the previous entry.
        delete this[TAG];
      }
    } catch (e) {
      warn('open hook failed', e);
    }
    return (originalOpen as AnyType).call(this, method, url, ...rest);
  };

  proto.setRequestHeader = function (
    this: TaggedXHR,
    header: string,
    value: string
  ) {
    try {
      const entry = this[TAG] ? byId.get(this[TAG]!) : undefined;
      if (entry) entry.requestHeaders[header] = value;
    } catch (e) {
      warn('setRequestHeader hook failed', e);
    }
    return originalSetRequestHeader.call(this, header, value);
  };

  proto.send = function (this: TaggedXHR, body?: AnyType) {
    try {
      const entry = this[TAG] ? byId.get(this[TAG]!) : undefined;
      if (entry) {
        entry.requestBody = body ?? undefined;
        entry.timeout = this.timeout || undefined;
        attachListeners(this, entry);
        notify();
      }
    } catch (e) {
      warn('send hook failed', e);
    }
    return (originalSend as AnyType).call(this, body);
  };

  enabled = true;
};

/**
 * Listen via addEventListener rather than assigning onreadystatechange, so we
 * never clobber a handler the caller (axios, fetch) has already installed.
 */
const attachListeners = (xhr: TaggedXHR, entry: NetworkLogEntry) => {
  if (!xhr.addEventListener) return;

  xhr.addEventListener('readystatechange', () => {
    if (!enabled) return;
    try {
      if (xhr.readyState === xhr.HEADERS_RECEIVED) {
        const contentType = xhr.getResponseHeader('Content-Type');
        const contentLength = xhr.getResponseHeader('Content-Length');
        entry.responseContentType = contentType
          ? contentType.split(';')[0]
          : undefined;
        entry.responseSize = contentLength
          ? parseInt(contentLength, 10)
          : undefined;
        entry.responseHeaders = parseHeaderBlock(xhr.getAllResponseHeaders());
        notify();
      } else if (xhr.readyState === xhr.DONE) {
        // status 0 here means the transport failed; the error/timeout/abort event
        // may or may not also fire, and `complete` keeps whichever lands first.
        if (xhr.status > 0) {
          complete(entry, {
            status: xhr.status,
            response: xhr.response,
            responseType: xhr.responseType,
            responseURL: xhr.responseURL,
          });
        } else {
          complete(entry, { failure: 'error' });
        }
      }
    } catch (e) {
      warn('readystatechange failed', e);
    }
  });

  // Explicit outcomes give a precise failure reason where readyState cannot.
  xhr.addEventListener('timeout', () =>
    complete(entry, { failure: 'timeout' })
  );
  xhr.addEventListener('abort', () => complete(entry, { failure: 'abort' }));
  xhr.addEventListener('error', () => complete(entry, { failure: 'error' }));
};

export const stopNetworkLogging = () => {
  if (!enabled || !originals) return;
  const proto = XMLHttpRequest.prototype;
  proto.open = originals.open;
  proto.send = originals.send;
  proto.setRequestHeader = originals.setRequestHeader;
  originals = undefined;
  enabled = false;
};

export const isNetworkLoggingEnabled = () => enabled;

/** Newest first — the list wants most-recent at the top. */
export const getRequests = (): NetworkLogEntry[] => entries.slice().reverse();

export const clearRequests = () => {
  entries = [];
  byId = new Map();
  notify();
};

/** Subscribe to changes; returns an unsubscribe. Replaces polling getRequests(). */
export const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/* ------------------------------------------------------------------ *
 * Body readers
 * ------------------------------------------------------------------ */

const isBlob = (v: unknown): boolean =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as AnyType)._data?.blobId === 'string';

/**
 * Resolve a response body to text. A `responseType: 'blob'` response keeps its
 * bytes in native memory, so it must be read back through FileReader.
 */
export const getResponseBody = async (
  entry: NetworkLogEntry
): Promise<string> => {
  const body = entry.response;
  if (body == null) return '';
  if (isBlob(body)) {
    const reader = new FileReader();
    return new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () =>
        reject(reader.error ?? new Error('could not read blob'));
      reader.onabort = () => reject(new Error('blob read aborted'));
      reader.readAsText(body as AnyType);
    });
  }
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body, null, 2) ?? String(body);
  } catch {
    return String(body);
  }
};

export const getRequestBody = (entry: NetworkLogEntry): string => {
  const body = entry.requestBody;
  if (body == null) return '';
  if (typeof body === 'string') return body;
  // FormData keeps its fields in _parts.
  const parts = (body as AnyType)?._parts;
  if (Array.isArray(parts)) {
    try {
      return JSON.stringify(Object.fromEntries(parts), null, 2);
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.stringify(body, null, 2) ?? String(body);
  } catch {
    return String(body);
  }
};

const shellQuote = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;

export const toCurl = (entry: NetworkLogEntry): string => {
  const parts = [`curl -X ${entry.method}`];
  for (const [k, v] of Object.entries(entry.requestHeaders)) {
    parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }
  const body = getRequestBody(entry);
  if (body) parts.push(`-d ${shellQuote(body)}`);
  parts.push(shellQuote(entry.url));
  return parts.join(' ');
};
