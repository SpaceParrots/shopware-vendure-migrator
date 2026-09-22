// Minimal Vendure Admin API client: bearer login, JSON queries, multipart asset upload.
// Queries retry on transient failures; mutations never do, because a create that timed out may
// have been applied and a second one would leave an object no binding points to.
import { HttpError, request } from './http.mjs';

/** True for a GraphQL document whose operation is a mutation. */
export function isMutation(query) {
    return /^\s*mutation\b/.test(query);
}

export class VendureClient {
    /**
     * @param {{ adminApi: string, username: string, password: string }} target Admin API URL and
     *   administrator credentials.
     * @param {{ timeoutMs?: number, retries?: number, retryDelayMs?: number, fetch?: typeof fetch }} [http]
     *   Timeout and retry settings passed to request(); `fetch` replaces the global one in tests.
     */
    constructor({ adminApi, username, password }, http = {}) {
        this.url = adminApi;
        this.username = username;
        this.password = password;
        this.http = http;
        this.token = undefined;
    }

    /**
     * Logs in and keeps the bearer token for later calls. Retried like a read: a repeated login
     * only opens a second session.
     * @returns {Promise<void>}
     * @throws {Error} When the credentials are rejected or Vendure sends no bearer token.
     * @throws {HttpError} On timeout, network error or a non-2xx status.
     */
    async login() {
        const { data: body, headers } = await request(this.url, {
            ...this.http,
            method: 'POST',
            retry: true,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                query: `mutation($u: String!, $p: String!) { login(username: $u, password: $p) {
                    ... on CurrentUser { identifier } ... on ErrorResult { errorCode message } } }`,
                variables: { u: this.username, p: this.password },
            }),
        });
        const result = body?.data?.login;
        if (!result?.identifier) throw new Error(`Vendure login at ${this.url} failed: ${JSON.stringify(body?.errors ?? result)}`);
        this.token = headers.get('vendure-auth-token');
        if (!this.token) throw new Error('Vendure login returned no bearer token; is tokenMethod "bearer" enabled?');
    }

    /**
     * Runs one GraphQL operation.
     * @param {string} query GraphQL document.
     * @param {object} [variables]
     * @param {{ languageCode?: string, retry?: boolean }} [options] `languageCode` selects the
     *   language of translated fields; `retry` defaults to true for queries, false for mutations.
     * @returns {Promise<object>} The `data` object of the response.
     * @throws {Error} With `graphqlErrors` and `variables` set when the response carries GraphQL
     *   errors, or when it has no `data`.
     * @throws {HttpError} On timeout, network error or a non-2xx status.
     */
    async gql(query, variables = {}, { languageCode, retry = !isMutation(query) } = {}) {
        const url = languageCode ? `${this.url}?languageCode=${encodeURIComponent(languageCode)}` : this.url;
        let body;
        try {
            ({ data: body } = await request(url, {
                ...this.http,
                method: 'POST',
                retry,
                headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
                body: JSON.stringify({ query, variables }),
            }));
        } catch (e) {
            // Vendure answers invalid documents with HTTP 400 and GraphQL errors in the body.
            if (e instanceof HttpError && e.body) {
                try { e.graphqlErrors = JSON.parse(e.body).errors; } catch { /* not JSON */ }
            }
            throw e;
        }
        if (body?.errors?.length) {
            const err = new Error(`GraphQL error: ${body.errors.map(e => e.message).join('; ')}`);
            err.graphqlErrors = body.errors;
            err.variables = variables;
            throw err;
        }
        if (body?.data == null) throw new Error(`GraphQL response from ${url} has no data`);
        return body.data;
    }

    /**
     * Uploads one file as a Vendure Asset. Never retried: the upload creates the asset.
     * @param {string} fileName
     * @param {Uint8Array} bytes
     * @param {string} mimeType
     * @returns {Promise<string>} The id of the created Asset.
     * @throws {Error} When Vendure rejects the file (MimeTypeError) or answers with errors.
     * @throws {HttpError} On timeout, network error or a non-2xx status.
     */
    async uploadAsset(fileName, bytes, mimeType) {
        const form = new FormData();
        form.append(
            'operations',
            JSON.stringify({
                query: `mutation($input: [CreateAssetInput!]!) { createAssets(input: $input) {
                    ... on Asset { id } ... on MimeTypeError { errorCode message } } }`,
                variables: { input: [{ file: null }] },
            }),
        );
        form.append('map', JSON.stringify({ 0: ['variables.input.0.file'] }));
        form.append('0', new Blob([bytes], { type: mimeType }), fileName);
        const { data: body } = await request(this.url, {
            ...this.http,
            method: 'POST',
            retry: false,
            headers: { authorization: `Bearer ${this.token}`, 'apollo-require-preflight': 'true' },
            body: form,
        });
        if (body?.errors?.length) throw new Error(`Asset upload failed: ${body.errors.map(e => e.message).join('; ')}`);
        const created = body?.data?.createAssets?.[0];
        if (!created) throw new Error(`Asset upload of ${fileName} returned no result`);
        if (!created.id) throw new Error(`Asset upload rejected: ${created.message}`);
        return created.id;
    }
}

/** Throws if a union result came back as an ErrorResult. */
export function unwrap(result, label) {
    if (result && typeof result === 'object' && 'errorCode' in result) {
        throw new Error(`${label}: ${result.errorCode} ${result.message}`);
    }
    return result;
}
