/**
 * Exercises the interceptor against a stand-in XMLHttpRequest that follows the
 * same lifecycle React Native drives: open → setRequestHeader → send →
 * readystatechange(HEADERS_RECEIVED) → readystatechange(DONE) | error/timeout/abort.
 */

import type { NetworkLogEntry } from '../networkLogger';
import {
  clearRequests,
  getRequests,
  getRequestBody,
  getResponseBody,
  startNetworkLogging,
  stopNetworkLogging,
  subscribe,
  toCurl,
} from '../networkLogger';

type Handler = () => void;

class FakeXHR {
  static HEADERS_RECEIVED = 2;
  static DONE = 4;

  readyState = 0;
  status = 0;
  response: unknown = undefined;
  responseType = '';
  responseURL = '';
  timeout = 0;
  HEADERS_RECEIVED = 2;
  DONE = 4;

  private listeners: Record<string, Handler[]> = {};
  private rawHeaders = '';

  open(_method: string, _url: string) {}
  send(_body?: unknown) {}
  setRequestHeader(_h: string, _v: string) {}

  addEventListener(type: string, fn: Handler) {
    (this.listeners[type] ||= []).push(fn);
  }

  fire(type: string) {
    (this.listeners[type] || []).forEach((f) => f());
  }

  getResponseHeader(name: string) {
    const m = new RegExp(`^${name}: (.*)$`, 'im').exec(this.rawHeaders);
    return m ? m[1] : null;
  }

  getAllResponseHeaders() {
    return this.rawHeaders;
  }

  setRawHeaders(raw: string) {
    this.rawHeaders = raw;
  }
}

const originalXHR = global.XMLHttpRequest;

/** Drive a full successful request through the patched prototype. */
const runRequest = (
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: unknown;
    status?: number;
    response?: unknown;
    rawHeaders?: string;
    finishWith?: 'done' | 'error' | 'timeout' | 'abort';
  } = {}
) => {
  const xhr = new (global.XMLHttpRequest as AnyType)() as FakeXHR;
  xhr.open(opts.method ?? 'GET', opts.url ?? 'https://api.test/thing');
  Object.entries(opts.headers ?? {}).forEach(([k, v]) =>
    xhr.setRequestHeader(k, v)
  );
  xhr.send(opts.body);

  xhr.setRawHeaders(
    opts.rawHeaders ?? 'Content-Type: application/json\r\nContent-Length: 42'
  );
  xhr.readyState = FakeXHR.HEADERS_RECEIVED;
  xhr.fire('readystatechange');

  const finish = opts.finishWith ?? 'done';
  if (finish === 'done') {
    xhr.status = opts.status ?? 200;
    xhr.response = opts.response ?? '{"ok":true}';
    xhr.readyState = FakeXHR.DONE;
    xhr.fire('readystatechange');
  } else {
    xhr.fire(finish);
  }
  return xhr;
};

/**
 * The newest entry, asserted to exist. Every capture test needs one, and
 * `getRequests()[0]` is `| undefined` under noUncheckedIndexedAccess — this
 * narrows it and fails with "no request was recorded" rather than a property
 * access on undefined when capture itself is what broke.
 */
const latest = (): NetworkLogEntry => {
  const [r] = getRequests();
  if (!r) throw new Error('no request was recorded');
  return r;
};

beforeEach(() => {
  (global as AnyType).XMLHttpRequest = FakeXHR;
  startNetworkLogging();
  clearRequests();
});

afterEach(() => {
  stopNetworkLogging();
  clearRequests();
  (global as AnyType).XMLHttpRequest = originalXHR;
});

describe('capture', () => {
  it('records method, url, headers and body', () => {
    runRequest({
      method: 'POST',
      url: 'https://api.test/login',
      headers: {
        'Authorization': 'Bearer abc',
        'Content-Type': 'application/json',
      },
      body: '{"email":"a@b.c"}',
    });

    const r = latest();
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://api.test/login');
    expect(r.requestHeaders.Authorization).toBe('Bearer abc');
    expect(r.requestBody).toBe('{"email":"a@b.c"}');
  });

  it('captures response headers, content type and size', () => {
    runRequest({
      rawHeaders:
        'Content-Type: text/html; charset=utf-8\r\nContent-Length: 128\r\nVary: Origin',
    });

    const r = latest();
    expect(r.responseContentType).toBe('text/html');
    expect(r.responseSize).toBe(128);
    expect(r.responseHeaders.Vary).toBe('Origin');
  });

  it('returns newest first', () => {
    runRequest({ url: 'https://api.test/first' });
    runRequest({ url: 'https://api.test/second' });
    expect(getRequests().map((r) => r.url)).toEqual([
      'https://api.test/second',
      'https://api.test/first',
    ]);
  });

  it('still calls through to the original XHR methods', () => {
    const openSpy = jest.spyOn(FakeXHR.prototype, 'open');
    const sendSpy = jest.spyOn(FakeXHR.prototype, 'send');
    runRequest({ url: 'https://api.test/passthrough' });
    expect(openSpy).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalled();
    openSpy.mockRestore();
    sendSpy.mockRestore();
  });
});

describe('duration and pending state', () => {
  it('leaves duration undefined while in flight', () => {
    const xhr = new (global.XMLHttpRequest as AnyType)() as FakeXHR;
    xhr.open('GET', 'https://api.test/slow');
    xhr.send();

    const r = latest();
    expect(r.status).toBeUndefined();
    expect(r.endTime).toBeUndefined();
    // Not endTime - startTime with an unset endTime, which yields a large negative.
    expect(r.duration).toBeUndefined();
  });

  it('never reports a negative duration once complete', () => {
    runRequest();
    const r = latest();
    expect(r.duration).toBeGreaterThanOrEqual(0);
    expect(r.status).toBe(200);
  });
});

describe('transport failures', () => {
  it.each([
    ['error', 'error'],
    ['timeout', 'timeout'],
    ['abort', 'abort'],
  ])('records %s as a failure rather than status 0', (event, expected) => {
    runRequest({ finishWith: event as AnyType });
    const r = latest();
    expect(r.failure).toBe(expected);
    expect(r.status).toBeUndefined();
    expect(r.duration).toBeGreaterThanOrEqual(0);
  });

  it('treats readyState DONE with status 0 as a failure', () => {
    const xhr = new (global.XMLHttpRequest as AnyType)() as FakeXHR;
    xhr.open('GET', 'http://10.0.2.2:8081/symbolicate');
    xhr.send();
    xhr.status = 0;
    xhr.readyState = FakeXHR.DONE;
    xhr.fire('readystatechange');

    const r = latest();
    expect(r.failure).toBe('error');
    expect(r.status).toBeUndefined();
  });

  it('keeps the first outcome when both DONE and error fire', () => {
    const xhr = new (global.XMLHttpRequest as AnyType)() as FakeXHR;
    xhr.open('GET', 'https://api.test/thing');
    xhr.send();
    xhr.status = 200;
    xhr.response = 'ok';
    xhr.readyState = FakeXHR.DONE;
    xhr.fire('readystatechange');
    xhr.fire('error');

    const r = latest();
    expect(r.status).toBe(200);
    expect(r.failure).toBeUndefined();
  });
});

describe('ignore lists', () => {
  it('skips ignored hosts, urls and patterns', () => {
    stopNetworkLogging();
    startNetworkLogging({
      ignoredHosts: ['eu.i.posthog.com'],
      ignoredUrls: ['https://api.test/skip-exact'],
      ignoredPatterns: [/^GET https:\/\/api\.test\/assets\/.*$/],
    });

    runRequest({ url: 'https://eu.i.posthog.com/batch/' });
    runRequest({ url: 'https://api.test/skip-exact' });
    runRequest({ url: 'https://api.test/assets/logo.png' });
    runRequest({ url: 'https://api.test/keep' });

    expect(getRequests().map((r) => r.url)).toEqual(['https://api.test/keep']);
  });

  it('matches an ignored host that carries a port', () => {
    stopNetworkLogging();
    startNetworkLogging({ ignoredHosts: ['10.0.2.2'] });
    runRequest({ url: 'http://10.0.2.2:8081/symbolicate' });
    expect(getRequests()).toHaveLength(0);
  });
});

describe('bounds', () => {
  it('evicts oldest beyond maxRequests', () => {
    stopNetworkLogging();
    startNetworkLogging({ maxRequests: 3 });
    for (let i = 0; i < 5; i++) runRequest({ url: `https://api.test/r${i}` });

    const urls = getRequests().map((r) => r.url);
    expect(urls).toHaveLength(3);
    expect(urls).toEqual([
      'https://api.test/r4',
      'https://api.test/r3',
      'https://api.test/r2',
    ]);
  });
});

describe('body readers', () => {
  it('reads a string response verbatim, with no {data:...} wrapping', async () => {
    runRequest({ response: 'Internal Server Error', status: 500 });
    const r = latest();
    await expect(getResponseBody(r)).resolves.toBe('Internal Server Error');
  });

  it('reads a blob response through FileReader', async () => {
    (global as AnyType).FileReader = class {
      result: string | null = null;
      error: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsText() {
        this.result = '{"Tabs":{}}';
        this.onload?.();
      }
    };

    runRequest({ response: { _data: { blobId: 'abc-123', size: 11 } } });
    const r = latest();
    await expect(getResponseBody(r)).resolves.toBe('{"Tabs":{}}');
  });

  it('serialises FormData request bodies from _parts', () => {
    runRequest({
      body: {
        _parts: [
          ['name', 'ada'],
          ['role', 'eng'],
        ],
      },
    });
    const r = latest();
    expect(JSON.parse(getRequestBody(r))).toEqual({ name: 'ada', role: 'eng' });
  });

  it('builds a curl command with headers, body and quoting', () => {
    runRequest({
      method: 'POST',
      url: "https://api.test/it's",
      headers: { Authorization: 'Bearer x' },
      body: '{"a":1}',
    });
    const curl = toCurl(latest());
    expect(curl).toContain('curl -X POST');
    expect(curl).toContain("-H 'Authorization: Bearer x'");
    expect(curl).toContain(`-d '{"a":1}'`);
    // The apostrophe in the url must be escaped, not left to break the shell.
    expect(curl).toContain(`'\\''`);
  });
});

describe('subscribe', () => {
  it('notifies listeners and stops after unsubscribe', async () => {
    const seen = jest.fn();
    const off = subscribe(seen);

    runRequest();
    await new Promise((res) => setTimeout(res, 5));
    expect(seen).toHaveBeenCalled();

    off();
    seen.mockClear();
    runRequest();
    await new Promise((res) => setTimeout(res, 5));
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('stopNetworkLogging', () => {
  it('restores the original prototype methods', () => {
    const patched = FakeXHR.prototype.open;
    stopNetworkLogging();
    expect(FakeXHR.prototype.open).not.toBe(patched);

    runRequest({ url: 'https://api.test/after-stop' });
    expect(getRequests()).toHaveLength(0);
  });
});
