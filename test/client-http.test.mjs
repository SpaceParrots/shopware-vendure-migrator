// request() and VendureClient against a stubbed fetch: timeouts, status in errors, and retries
// only where repeating the request cannot create a second object.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, HttpError } from '../src/lib/http.mjs';
import { VendureClient, isMutation } from '../src/lib/vendure-client.mjs';

const FAST = { retries: 2, retryDelayMs: 1, timeoutMs: 1000 };

/** A fetch stub that answers from a list of responders in order and records every call. */
function stubFetch(...responders) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
        const next = responders[Math.min(calls.length - 1, responders.length - 1)];
        return next(url, init);
    };
    return { fetch, calls };
}
const json = (body, status = 200, headers = {}) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (body, status) => () => new Response(body, { status });
const networkDown = () => { throw new TypeError('fetch failed'); };

test('a non-2xx status is reported with method, URL and status before any JSON parse', async () => {
    const { fetch } = stubFetch(text('<html>Bad Gateway</html>', 502));
    const err = await request('http://x/api', { method: 'POST', fetch, ...FAST }).catch(e => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 502);
    assert.match(err.message, /POST http:\/\/x\/api returned HTTP 502: <html>Bad Gateway/);
});

test('a hanging server is cut off by the timeout', async () => {
    // AbortSignal.timeout() is unref'd, and a stub holds no socket, so without this timer the event
    // loop empties before the abort fires and node:test cancels the file.
    const hang = (url, init) => new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 10_000);
        init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
    });
    const { fetch } = stubFetch(hang);
    await assert.rejects(request('http://x/slow', { fetch, timeoutMs: 20 }), /GET http:\/\/x\/slow timed out after 20 ms/);
});

test('reads retry transient failures with backoff and then succeed', async () => {
    const { fetch, calls } = stubFetch(networkDown, text('busy', 503), json({ ok: 1 }));
    const res = await request('http://x/read', { fetch, retry: true, ...FAST });
    assert.deepEqual(res.data, { ok: 1 });
    assert.equal(calls.length, 3);
});

test('retries are bounded', async () => {
    const { fetch, calls } = stubFetch(text('busy', 503));
    await assert.rejects(request('http://x/read', { fetch, retry: true, ...FAST }), /HTTP 503.*after 3 attempts/);
    assert.equal(calls.length, 3);
});

test('a 4xx other than 408/429 is not retried', async () => {
    const { fetch, calls } = stubFetch(text('nope', 404));
    await assert.rejects(request('http://x/img.png', { fetch, retry: true, as: 'bytes', ...FAST }), /HTTP 404/);
    assert.equal(calls.length, 1);
});

test('a body that is not JSON names the URL and status', async () => {
    const { fetch } = stubFetch(text('<html>login</html>', 200));
    await assert.rejects(request('http://x/api', { fetch }), /http:\/\/x\/api returned HTTP 200 with a body that is not JSON/);
});

test('isMutation tells queries from mutations', () => {
    assert.equal(isMutation('mutation($a: ID!) { x }'), true);
    assert.equal(isMutation('  \n mutation { x }'), true);
    assert.equal(isMutation('{ activeChannel { id } }'), false);
    assert.equal(isMutation('query($id: ID!) { mutationLog }'), false);
});

function client(fetch) {
    const c = new VendureClient({ adminApi: 'http://v/admin-api', username: 'u', password: 'p' }, { fetch, ...FAST });
    c.token = 't';
    return c;
}

test('client queries retry, mutations do not', async () => {
    const q = stubFetch(networkDown, json({ data: { products: { totalItems: 1 } } }));
    assert.deepEqual(await client(q.fetch).gql('{ products { totalItems } }'), { products: { totalItems: 1 } });
    assert.equal(q.calls.length, 2);

    const m = stubFetch(networkDown, json({ data: { createCountry: { id: '1' } } }));
    await assert.rejects(client(m.fetch).gql('mutation { createCountry(input: {}) { id } }'), /fetch failed/);
    assert.equal(m.calls.length, 1, 'a create must not be sent twice');
});

test('client asset uploads are not retried', async () => {
    const { fetch, calls } = stubFetch(text('busy', 503));
    await assert.rejects(client(fetch).uploadAsset('a.png', new Uint8Array([1]), 'image/png'), /HTTP 503/);
    assert.equal(calls.length, 1);
});

test('client rejects a response without data and one with GraphQL errors', async () => {
    await assert.rejects(client(stubFetch(json({ data: null })).fetch).gql('{ x }'), /has no data/);
    const err = await client(stubFetch(json({ errors: [{ message: 'boom' }] })).fetch).gql('{ x }', { a: 1 }).catch(e => e);
    assert.match(err.message, /GraphQL error: boom/);
    assert.deepEqual(err.variables, { a: 1 });
});

test('client keeps GraphQL errors from an HTTP 400 answer', async () => {
    const err = await client(stubFetch(json({ errors: [{ message: 'Cannot query field "y"' }] }, 400)).fetch).gql('{ y }').catch(e => e);
    assert.equal(err.status, 400);
    assert.equal(err.graphqlErrors[0].message, 'Cannot query field "y"');
});

test('client passes the language code as a query parameter', async () => {
    const { fetch, calls } = stubFetch(json({ data: { product: { name: 'Hose' } } }));
    await client(fetch).gql('query($id: ID!) { product(id: $id) { name } }', { id: '1' }, { languageCode: 'de' });
    assert.equal(calls[0].url, 'http://v/admin-api?languageCode=de');
});

test('client login keeps the bearer token', async () => {
    const { fetch } = stubFetch(json({ data: { login: { identifier: 'u' } } }, 200, { 'vendure-auth-token': 'abc' }));
    const c = new VendureClient({ adminApi: 'http://v/admin-api', username: 'u', password: 'p' }, { fetch, ...FAST });
    await c.login();
    assert.equal(c.token, 'abc');
});
