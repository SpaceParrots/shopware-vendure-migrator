// Every outgoing HTTP call goes through request(): a timeout per attempt, method, URL and status
// in every error, and bounded retries for requests that are safe to repeat.
//
// Only reads and downloads may retry. A create that timed out may still have been applied on the
// server, and sending it again would create a second object that no binding points to.

export const HTTP_DEFAULTS = Object.freeze({ timeoutMs: 30_000, retries: 3, retryDelayMs: 500 });

// 408, 425, 429 and 5xx can clear up on their own; any other status fails the same way again.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BODY_SNIPPET = 300;

export class HttpError extends Error {
    constructor(message, { method, url, status, body, transient = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'HttpError';
        this.method = method;
        this.url = url;
        this.status = status;
        this.body = body;
        this.transient = transient;
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends one HTTP request and returns the parsed body.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {Record<string, string>} [options.headers]
 * @param {string|FormData|Uint8Array} [options.body]
 * @param {'json'|'bytes'|'text'} [options.as='json'] How to read a 2xx body.
 * @param {boolean} [options.retry=false] Repeat after a network error, a timeout or a transient
 *   status. Set it only for reads and downloads.
 * @param {number} [options.timeoutMs] Limit per attempt, including reading the body.
 * @param {number} [options.retries] Extra attempts when `retry` is set.
 * @param {number} [options.retryDelayMs] Wait before the first retry; doubles for each further one.
 * @param {typeof fetch} [options.fetch] Replaces the global fetch, for tests.
 * @returns {Promise<{ status: number, headers: Headers, data: any }>}
 * @throws {HttpError} After the last attempt: on a timeout, a network error, a non-2xx status
 *   (the message holds the start of the response body) or a body that does not parse.
 */
export async function request(url, options = {}) {
    const {
        method = 'GET',
        retry = false,
        timeoutMs = HTTP_DEFAULTS.timeoutMs,
        retries = HTTP_DEFAULTS.retries,
        retryDelayMs = HTTP_DEFAULTS.retryDelayMs,
    } = options;
    const attempts = retry ? retries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
        try {
            return await attemptOnce(url, { ...options, method, timeoutMs });
        } catch (e) {
            if (attempt >= attempts || !e.transient) {
                if (attempt > 1) e.message += ` (after ${attempt} attempts)`;
                throw e;
            }
            await sleep(retryDelayMs * 2 ** (attempt - 1));
        }
    }
}

async function attemptOnce(url, { method, headers, body, as = 'json', timeoutMs, fetch: fetchImpl = globalThis.fetch }) {
    const failed = (e, what) => {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return new HttpError(
            timedOut ? `${method} ${url} timed out after ${timeoutMs} ms${what}` : `${method} ${url} failed${what}: ${e?.message ?? e}`,
            { method, url, transient: true, cause: e },
        );
    };
    let res;
    try {
        res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        throw failed(e, '');
    }
    // Checked before parsing: an error page is HTML, and its JSON parse error would hide the status.
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(`${method} ${url} returned HTTP ${res.status}: ${text.slice(0, BODY_SNIPPET)}`, {
            method, url, status: res.status, body: text, transient: TRANSIENT_STATUS.has(res.status),
        });
    }
    let raw;
    try {
        raw = as === 'bytes' ? new Uint8Array(await res.arrayBuffer()) : await res.text();
    } catch (e) {
        throw failed(e, ' while reading the body');
    }
    if (as !== 'json') return { status: res.status, headers: res.headers, data: raw };
    try {
        return { status: res.status, headers: res.headers, data: JSON.parse(raw) };
    } catch {
        throw new HttpError(`${method} ${url} returned HTTP ${res.status} with a body that is not JSON: ${raw.slice(0, BODY_SNIPPET)}`, {
            method, url, status: res.status, body: raw,
        });
    }
}
