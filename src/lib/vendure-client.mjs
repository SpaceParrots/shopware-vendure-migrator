// Minimal Vendure Admin API client: bearer login, JSON queries, multipart asset upload.
import fs from 'node:fs/promises';

export class VendureClient {
    constructor({ adminApi, username, password }) {
        this.url = adminApi;
        this.username = username;
        this.password = password;
        this.token = undefined;
    }

    async login() {
        const res = await fetch(this.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                query: `mutation($u: String!, $p: String!) { login(username: $u, password: $p) {
                    ... on CurrentUser { identifier } ... on ErrorResult { errorCode message } } }`,
                variables: { u: this.username, p: this.password },
            }),
        });
        const body = await res.json();
        const result = body.data?.login;
        if (!result?.identifier) throw new Error(`Vendure login failed: ${JSON.stringify(body.errors ?? result)}`);
        this.token = res.headers.get('vendure-auth-token');
        if (!this.token) throw new Error('Vendure login returned no bearer token; is tokenMethod "bearer" enabled?');
    }

    async gql(query, variables = {}) {
        const res = await fetch(this.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
            body: JSON.stringify({ query, variables }),
        });
        const body = await res.json();
        if (body.errors?.length) {
            const err = new Error(`GraphQL error: ${body.errors.map(e => e.message).join('; ')}`);
            err.graphqlErrors = body.errors;
            err.variables = variables;
            throw err;
        }
        return body.data;
    }

    /** Uploads one file and returns the created Asset id. */
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
        const res = await fetch(this.url, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.token}`, 'apollo-require-preflight': 'true' },
            body: form,
        });
        const body = await res.json();
        if (body.errors?.length) throw new Error(`Asset upload failed: ${body.errors.map(e => e.message).join('; ')}`);
        const created = body.data.createAssets[0];
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

export async function readFileBytes(file) {
    return fs.readFile(file);
}
