// Customer and order tables, read in the same consistent snapshot as the catalogue, so an order
// line and the variant it points at describe the same moment.
//
// The customer file holds password hashes. A snapshot is therefore as sensitive as the shop
// database itself: keep out/ off shared drives and out of git (it is in .gitignore).
import { SHOPWARE } from '../config.mjs';

const LIVE = `UNHEX('${SHOPWARE.LIVE_VERSION}')`;
const SYSTEM = `UNHEX('${SHOPWARE.LANGUAGE_SYSTEM}')`;
const hex = col => `LOWER(HEX(${col}))`;
// State names are the technical names; the state machine is implied by the column they come from.
const stateOf = col => `(SELECT technical_name FROM state_machine_state WHERE id = ${col})`;

export const SALES_QUERIES = {
    customer_groups: `SELECT ${hex('g.id')} id, g.display_gross, t.name
        FROM customer_group g LEFT JOIN customer_group_translation t ON t.customer_group_id = g.id AND t.language_id = ${SYSTEM}
        ORDER BY ${hex('g.id')}`,

    salutations: `SELECT ${hex('s.id')} id, s.salutation_key, t.display_name
        FROM salutation s LEFT JOIN salutation_translation t ON t.salutation_id = s.id AND t.language_id = ${SYSTEM}
        ORDER BY ${hex('s.id')}`,

    // legacy_password is only tested for presence: it is a Shopware 5 hash that needs its own
    // authentication strategy, and the migration does not carry it.
    customers: `SELECT ${hex('id')} id, customer_number, ${hex('customer_group_id')} customer_group_id,
            ${hex('sales_channel_id')} sales_channel_id, ${hex('bound_sales_channel_id')} bound_sales_channel_id,
            ${hex('salutation_id')} salutation_id, title, first_name, last_name, company, email, active, guest,
            password, legacy_password IS NOT NULL has_legacy_password, legacy_encoder,
            ${hex('default_billing_address_id')} default_billing_address_id,
            ${hex('default_shipping_address_id')} default_shipping_address_id,
            birthday, account_type, vat_ids, double_opt_in_registration, double_opt_in_confirm_date,
            first_login, last_login, newsletter_sales_channel_ids, created_at
        FROM customer ORDER BY ${hex('id')}`,

    customer_addresses: `SELECT ${hex('a.id')} id, ${hex('a.customer_id')} customer_id, c.iso country_iso,
            st.name state_name, a.company, a.department, a.title, a.first_name, a.last_name, a.street,
            a.zipcode, a.city, a.phone_number, a.additional_address_line1, a.additional_address_line2
        FROM customer_address a JOIN country c ON c.id = a.country_id
        LEFT JOIN country_state_translation st ON st.country_state_id = a.country_state_id AND st.language_id = ${SYSTEM}
        ORDER BY ${hex('a.id')}`,

    payment_methods: `SELECT ${hex('p.id')} id, p.technical_name, p.handler_identifier, t.name
        FROM payment_method p LEFT JOIN payment_method_translation t ON t.payment_method_id = p.id AND t.language_id = ${SYSTEM}
        ORDER BY ${hex('p.id')}`,

    shipping_methods: `SELECT ${hex('s.id')} id, s.technical_name, t.name
        FROM shipping_method s LEFT JOIN shipping_method_translation t ON t.shipping_method_id = s.id AND t.language_id = ${SYSTEM}
        ORDER BY ${hex('s.id')}`,

    orders: `SELECT ${hex('o.id')} id, o.order_number, ${stateOf('o.state_id')} state, cur.iso_code currency,
            o.currency_factor, ${hex('o.sales_channel_id')} sales_channel_id, o.tax_status, o.tax_calculation_type,
            o.amount_total, o.amount_net, o.position_price, o.shipping_total, o.price, o.shipping_costs,
            o.item_rounding, o.total_rounding, o.order_date_time, o.customer_comment,
            ${hex('o.billing_address_id')} billing_address_id, o.created_at
        FROM \`order\` o JOIN currency cur ON cur.id = o.currency_id
        WHERE o.version_id = ${LIVE} ORDER BY ${hex('o.id')}`,

    order_customers: `SELECT ${hex('order_id')} order_id, ${hex('customer_id')} customer_id, email, first_name,
            last_name, title, company, customer_number
        FROM order_customer WHERE version_id = ${LIVE} ORDER BY ${hex('id')}`,

    order_addresses: `SELECT ${hex('a.id')} id, ${hex('a.order_id')} order_id, c.iso country_iso, ct.name country_name,
            st.name state_name, a.company, a.first_name, a.last_name, a.street, a.zipcode, a.city,
            a.phone_number, a.additional_address_line1, a.additional_address_line2
        FROM order_address a JOIN country c ON c.id = a.country_id
        LEFT JOIN country_translation ct ON ct.country_id = a.country_id AND ct.language_id = ${SYSTEM}
        LEFT JOIN country_state_translation st ON st.country_state_id = a.country_state_id AND st.language_id = ${SYSTEM}
        WHERE a.version_id = ${LIVE} ORDER BY ${hex('a.id')}`,

    // product_id is NULL when the product was deleted after the order; the payload keeps the
    // product number the customer saw.
    order_line_items: `SELECT ${hex('id')} id, ${hex('order_id')} order_id, ${hex('parent_id')} parent_id,
            ${hex('product_id')} product_id, referenced_id, type, label, quantity, unit_price, total_price,
            price, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.productNumber')) product_number,
            JSON_UNQUOTE(JSON_EXTRACT(payload, '$.code')) promotion_code, good, position
        FROM order_line_item WHERE version_id = ${LIVE} ORDER BY ${hex('order_id')}, position, ${hex('id')}`,

    order_deliveries: `SELECT ${hex('id')} id, ${hex('order_id')} order_id, ${stateOf('state_id')} state,
            ${hex('shipping_order_address_id')} shipping_address_id, ${hex('shipping_method_id')} shipping_method_id,
            tracking_codes, shipping_costs, shipping_date_earliest, created_at
        FROM order_delivery WHERE version_id = ${LIVE} ORDER BY ${hex('id')}`,

    order_delivery_positions: `SELECT ${hex('order_delivery_id')} delivery_id, ${hex('order_line_item_id')} line_item_id, quantity
        FROM order_delivery_position WHERE version_id = ${LIVE} ORDER BY ${hex('id')}`,

    order_transactions: `SELECT ${hex('id')} id, ${hex('order_id')} order_id, ${stateOf('state_id')} state,
            ${hex('payment_method_id')} payment_method_id, amount, created_at
        FROM order_transaction WHERE version_id = ${LIVE} ORDER BY ${hex('order_id')}, created_at, ${hex('id')}`,

    // Every transition of an order, delivery and transaction: payment and shipping dates, and the
    // order history in Vendure. The username says which admin made a change (NULL: the system).
    order_state_history: `SELECT h.entity_name, ${hex('h.referenced_id')} referenced_id, h.action_name,
            ${stateOf('h.from_state_id')} from_state, ${stateOf('h.to_state_id')} to_state, u.username, h.created_at
        FROM state_machine_history h LEFT JOIN \`user\` u ON u.id = h.user_id
        WHERE h.entity_name IN ('order', 'order_delivery', 'order_transaction') AND h.referenced_version_id = ${LIVE}
        ORDER BY h.created_at, ${hex('h.id')}`,

    // Counted only: the migration does not carry these, and gaps.json says so.
    sales_counts: `SELECT
            (SELECT COUNT(*) FROM document) documents,
            (SELECT COUNT(*) FROM order_transaction_capture) captures,
            (SELECT COUNT(*) FROM order_transaction_capture_refund) capture_refunds,
            (SELECT COUNT(*) FROM customer_wishlist) wishlists,
            (SELECT COUNT(*) FROM newsletter_recipient) newsletter_recipients,
            (SELECT COUNT(*) FROM customer_tag) customer_tags,
            (SELECT COUNT(*) FROM order_tag) order_tags,
            (SELECT COUNT(*) FROM product_review) product_reviews`,
};
