// Shopware customers -> Vendure customers, users and addresses.
//
// Three Shopware facts drive the shape of this builder:
// - A guest checkout creates a new customer row per order, so one email can own several rows.
//   Vendure keeps one customer per email and channel, and a guest is a customer without a user.
// - Shopware hashes passwords with PHP's password_hash (bcrypt, prefix $2y$). Node's bcrypt only
//   accepts $2a$/$2b$, and compare() answers false for $2y$ instead of throwing.
// - Shopware 5 imports keep the old hash in legacy_password with a legacy_encoder; Vendure has no
//   upgrade-on-login for those without a custom authentication strategy.
import { groupBy } from '../lib/util.mjs';
import { buildCustomerHistory } from './order-history.mjs';

/**
 * Normalises an email the way Vendure's normalizeEmailAddress does for lookups: trimmed and
 * lower-cased. Shopware stores what the customer typed.
 * @param {unknown} email
 * @returns {string}
 */
export function normalizeEmail(email) {
    return String(email ?? '').trim().toLowerCase();
}

/**
 * Turns a Shopware password hash into one Vendure's BcryptPasswordHashingStrategy verifies.
 * PHP's $2y$ is the same algorithm as $2b$; only the prefix differs.
 * @param {string|null} hash
 * @returns {{ ok: true, hash: string, rewritten: boolean } | { ok: false, reason: string }}
 */
export function vendurePasswordHash(hash) {
    if (!hash) return { ok: false, reason: 'no password' };
    if (hash.startsWith('$2y$')) return { ok: true, hash: `$2b$${hash.slice(4)}`, rewritten: true };
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) return { ok: true, hash, rewritten: false };
    return { ok: false, reason: `hash scheme ${hash.split('$')[1] ?? 'unknown'} is not bcrypt` };
}

const address = (a, defaults) => ({
    sourceId: a.id,
    fullName: [a.first_name, a.last_name].filter(Boolean).join(' '),
    company: [a.company, a.department].filter(Boolean).join(', ') || undefined,
    streetLine1: a.street,
    streetLine2: [a.additional_address_line1, a.additional_address_line2].filter(Boolean).join(', ') || undefined,
    city: a.city,
    province: a.state_name ?? undefined,
    postalCode: a.zipcode ?? undefined,
    countryCode: a.country_iso,
    phoneNumber: a.phone_number || undefined,
    defaultShippingAddress: a.id === defaults.shipping,
    defaultBillingAddress: a.id === defaults.billing,
});

/**
 * Builds the customers of the model. Pure.
 * @param {object} raw Snapshot tables (customers, customer_addresses, customer_groups, salutations).
 * @returns {{ customerGroups: object[], customers: object[], mergedInto: Record<string, string>,
 *   decisions: object[], gaps: object }}
 *   `customers` holds one entry per Vendure customer. `mergedInto` maps every Shopware customer id
 *   to the source id of the Vendure customer it becomes, so orders can find their customer.
 */
export function buildCustomers(raw) {
    const addressesByCustomer = groupBy(raw.customer_addresses, 'customer_id');
    const salutations = new Map(raw.salutations.map(s => [s.id, s]));
    const customerGroups = raw.customer_groups.map(g => ({ sourceId: g.id, name: g.name ?? g.id }));

    // Registered accounts first, then guests, each oldest first: the primary row of an email is
    // the registered account if there is one, else the oldest guest.
    const ordered = [...raw.customers].sort((a, b) =>
        Number(a.guest) - Number(b.guest) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
    const primaryByEmail = new Map();
    const mergedInto = {};
    const customers = [];
    const gaps = {
        registeredEmailConflicts: [],
        guestsMergedIntoRegistered: 0,
        guestsMergedIntoGuest: 0,
        passwordsRewritten2yTo2b: 0,
        passwordsNotMigrated: [],
        legacyPasswords: 0,
        inactive: 0,
        salutationsDropped: 0,
        companies: 0,
        vatIds: 0,
        birthdays: 0,
        businessAccounts: 0,
        boundToSalesChannel: 0,
        bySalesChannel: {},
        newsletterSubscriptions: 0,
    };

    for (const c of ordered) {
        const email = normalizeEmail(c.email);
        const guest = Boolean(Number(c.guest));
        gaps.bySalesChannel[c.sales_channel_id] = (gaps.bySalesChannel[c.sales_channel_id] ?? 0) + 1;
        const primary = primaryByEmail.get(email);
        if (primary) {
            if (!guest) {
                // Two registered accounts on one email exist in Shopware only when they are bound
                // to different sales channels. One Vendure channel cannot hold both.
                gaps.registeredEmailConflicts.push({ sourceId: c.id, email, keptSourceId: primary.sourceId });
                continue;
            }
            mergedInto[c.id] = primary.sourceId;
            if (primary.guest) gaps.guestsMergedIntoGuest++;
            else gaps.guestsMergedIntoRegistered++;
            continue;
        }

        let password;
        if (!guest) {
            const converted = vendurePasswordHash(c.password);
            if (converted.ok) {
                password = converted.hash;
                if (converted.rewritten) gaps.passwordsRewritten2yTo2b++;
            } else {
                gaps.passwordsNotMigrated.push({ sourceId: c.id, reason: converted.reason });
            }
            if (Number(c.has_legacy_password)) gaps.legacyPasswords++;
        }
        if (!Number(c.active)) gaps.inactive++;
        if (c.salutation_id && salutations.get(c.salutation_id)?.salutation_key !== 'not_specified') gaps.salutationsDropped++;
        if (c.company) gaps.companies++;
        if (c.vat_ids && c.vat_ids !== '[]') gaps.vatIds++;
        if (c.birthday) gaps.birthdays++;
        if (c.account_type === 'business') gaps.businessAccounts++;
        if (c.bound_sales_channel_id) gaps.boundToSalesChannel++;
        if (c.newsletter_sales_channel_ids && c.newsletter_sales_channel_ids !== '[]') gaps.newsletterSubscriptions++;

        const defaults = { billing: c.default_billing_address_id, shipping: c.default_shipping_address_id };
        // A guest keeps no address book in Vendure either; its addresses live on its orders.
        const addresses = guest ? [] : (addressesByCustomer.get(c.id) ?? []).map(a => address(a, defaults));
        const billing = addresses.find(a => a.defaultBillingAddress);
        // Shopware sets active = 0 while a double opt-in registration is unconfirmed.
        const verified = Boolean(Number(c.active));
        const customer = {
            sourceId: c.id,
            email,
            guest,
            title: c.title || undefined,
            firstName: c.first_name,
            lastName: c.last_name,
            phoneNumber: billing?.phoneNumber,
            customerNumber: c.customer_number,
            groupSourceIds: guest ? [] : [c.customer_group_id],
            verified,
            passwordHash: password,
            createdAt: c.created_at,
            lastLogin: c.last_login ?? undefined,
            addresses,
            history: buildCustomerHistory({ guest, verified, createdAt: c.created_at, verifiedAt: c.double_opt_in_confirm_date ?? undefined }),
        };
        customers.push(customer);
        primaryByEmail.set(email, customer);
        mergedInto[c.id] = c.id;
    }

    const decisions = [
        {
            topic: 'customers.identity',
            decision: 'One Vendure customer per email. A registered account is the primary row of its email; guest rows with the same email become that customer, the oldest guest row otherwise. Guests get no Vendure user.',
            why: 'Shopware creates a customer row per guest checkout; Vendure identifies a customer by email within a channel, and a guest is a customer without a user.',
        },
        {
            topic: 'customers.passwords',
            decision: 'Shopware bcrypt hashes are written to the native authentication method with the prefix $2y$ rewritten to $2b$. Other hash schemes and Shopware 5 legacy hashes are not carried; those customers need a password reset.',
            why: "PHP's $2y$ and $2b$ are the same algorithm. Node's bcrypt 6 answers false for $2y$ without an error, so an unconverted hash fails every login silently.",
        },
        {
            topic: 'customers.channel',
            decision: 'Every customer is assigned to the default channel, whatever Shopware sales channel it registered in.',
            why: 'The catalogue slice migrates one storefront into one Vendure channel.',
        },
        {
            topic: 'customers.groups',
            decision: 'Shopware customer groups become Vendure customer groups with the same name; each registered customer joins its group.',
            why: "Vendure groups carry no gross/net display flag; the group's display_gross decides nothing in Vendure.",
        },
        {
            topic: 'customers.writePath',
            decision: 'Customers are written in-process through the ORM, not through the Admin API.',
            why: 'createCustomer always creates a user and publishes AccountRegistrationEvent (a verification mail with the EmailPlugin), cannot take an existing password hash, and cannot create a guest without a user.',
        },
    ];
    return { customerGroups, customers, mergedInto, decisions, gaps };
}
