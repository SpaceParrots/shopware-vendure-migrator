// The storefront decides which visibility, SEO URLs and price display the model uses; countries
// and tax categories decide every tax rate Vendure charges.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pickStorefront } from '../src/transform/tax.mjs';

const STOREFRONT = 'type-storefront';
const channel = (id, active, type_id = STOREFRONT) => ({ id, type_id, active });

describe('pickStorefront', () => {
    test('takes the first active storefront in id order, whatever the row order', () => {
        const channels = [channel('c', 1), channel('a', 0), channel('b', 1), channel('0', 1, 'type-headless')];
        assert.equal(pickStorefront(channels, STOREFRONT).id, 'b');
    });

    test('skips an inactive storefront even when it comes first', () => {
        assert.equal(pickStorefront([channel('a', 0), channel('b', 1)], STOREFRONT).id, 'b');
    });

    test('fails with a clear message when no storefront is active', () => {
        assert.throws(() => pickStorefront([channel('a', 0), channel('h', 1, 'type-headless')], STOREFRONT), /No active storefront sales channel found \(1 storefront channels, all inactive\)/);
        assert.throws(() => pickStorefront([], STOREFRONT), /No active storefront/);
    });
});
