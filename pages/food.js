'use strict';
const https = require('https');
const escape = require('escape-html');
const crypto = require('crypto');

const auth = require('../src/authentication.js');
const notFound = require('./notFound.js');
const { getTimezoneFromIP, formatDateWithTimezone } = require('../src/timezoneUtils');
const {
    renderTemplate,
    getPageThemeAttr,
    parseCookies,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');
const AsyncLock = require('async-lock');

const API_TIMEOUT_MS = 15000;
const VERIFICATION_CODE_MIN = 100000;
const VERIFICATION_CODE_MAX = 999999;

// =============================================================================
// Helper functions
// =============================================================================

function strReplace(string, needle, replacement) {
    return string.split(needle).join(replacement ?? '');
}

/**
 * Apply common template fields like session ID, cart count, and theme.
 */
function applyCommonFields(html, req, templates, theme, sessionData) {
    const { persistentParam, persistentSuffix, urlSessionID } = sessionData;

    html = strReplace(html, '{$SESSION_PARAM}', persistentParam);
    html = strReplace(html, '{$SESSION_ID}', escape(urlSessionID));
    html = strReplace(html, '{$SESSION_ID_SUFFIX}', persistentSuffix);
    html = strReplace(html, '{$WHITE_THEME_ENABLED}', theme);

    const cart = getCart(req);
    const cartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    html = strReplace(html, '{$CART_COUNT}', String(cartCount));

    return html;
}

function unixTime() {
    return Math.floor(Date.now() / 1000);
}

// Format a Unix timestamp using the user's detected timezone (IP-based)
function formatTimestamp(ts, req) {
    const timezone = req ? getTimezoneFromIP(req) : null;
    return formatDateWithTimezone(new Date(ts * 1000), timezone);
}

// --- Determine if HTTPS is in use (mirrors auth.js logic) ---
function isSecure(req) {
    return req.socket && req.socket.encrypted;
}

let _templates = null;
function getTemplates() {
    if (!_templates) {
        _templates = {
            index: loadAndRenderPageTemplate('index', 'food'),
            storeSearch: loadAndRenderPageTemplate('store-search', 'food'),
            menu: loadAndRenderPageTemplate('menu', 'food'),
            cart: loadAndRenderPageTemplate('cart', 'food'),
            checkout: loadAndRenderPageTemplate('checkout', 'food'),
            verify: loadAndRenderPageTemplate('verify', 'food'),
            track: loadAndRenderPageTemplate('track', 'food'),
            receipts: loadAndRenderPageTemplate('receipts', 'food'),
            customize: loadAndRenderPageTemplate('customize', 'food'),
            // Partials
            storeCard: getTemplate('store-card', 'food/partials'),
            categoryTab: getTemplate('category-tab', 'food/partials'),
            menuItem: getTemplate('menu-item', 'food/partials'),
            cartItem: getTemplate('cart-item', 'food/partials'),
            checkoutAddress: getTemplate('checkout-address', 'food/partials'),
            checkoutSummaryItem: getTemplate('checkout-summary-item', 'food/partials'),
            receiptCard: getTemplate('receipt-card', 'food/partials'),
            customizeSizeOption: getTemplate('customize-size-option', 'food/partials'),
            customizeSizeHeader: getTemplate('customize-size-header', 'food/partials'),
            customizeToppingRow: getTemplate('customize-topping-row', 'food/partials'),
            customizeToppingsInfo: getTemplate('customize-toppings-info', 'food/partials'),
            customizeActionForm: getTemplate('customize-action-form', 'food/partials'),
            menuItemActionForm: getTemplate('menu-item-action-form', 'food/partials'),
            trackOrderInfo: getTemplate('track-order-info', 'food/partials'),
            receiptSuccessNotice: getTemplate('receipt-success-notice', 'food/partials'),
            errorBox: getTemplate('error-box', 'food/partials'),
            infoText: getTemplate('info-text', 'food/partials'),
            sectionHeader: getTemplate('section-header', 'food/partials'),
            lineBreak: getTemplate('line-break', 'food/partials'),
            selectOption: getTemplate('select-option', 'food/partials'),
            foodSizePrice: getTemplate('food-size-price', 'food/partials'),
            storeWait: getTemplate('store-wait', 'food/partials'),
            buttonLink: getTemplate('button-link', 'food/partials'),
            cartEmptyRow: getTemplate('cart-empty-row', 'food/partials'),
            loggedIn: getTemplate('logged-in', 'index'),
        };
    }
    return _templates;
}

// --- Cart cookie helpers ---// --- Cart cookie helpers ---
function getCart(req) {
    try {
        const cookie = req.headers.cookie || '';
        const cartCookie = cookie.split('; ').find((c) => c.startsWith('pizzaCart='));
        if (cartCookie) {
            const val = cartCookie.split('=').slice(1).join('=');
            const decoded = Buffer.from(decodeURIComponent(val), 'base64').toString('utf-8');
            const cart = JSON.parse(decoded);
            if (!cart.items) cart.items = [];
            return cart;
        }
        const urlCart = new URL(req.url, 'http://localhost').searchParams.get('pizzaCart');
        if (urlCart) {
            const decoded = Buffer.from(decodeURIComponent(urlCart), 'base64').toString('utf-8');
            const cart = JSON.parse(decoded);
            if (!cart.items) cart.items = [];
            return cart;
        }
    } catch (e) {
        console.error('getCart: failed to parse cart cookie:', e.message);
    }
    return { storeId: null, items: [] };
}

function encodeCart(cart) {
    return Buffer.from(JSON.stringify(cart)).toString('base64');
}

function cartCookieHeader(cart, useSecure) {
    const encoded = encodeCart(cart);
    return `pizzaCart=${encodeURIComponent(encoded)}; path=/; HttpOnly${useSecure ? '; Secure' : ''}`;
}

function clearCartCookieHeader() {
    return 'pizzaCart=; path=/; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

// --- Domino's API helper ---
function dominosRequest(options, body) {
    return new Promise((resolve, reject) => {
        const host = options.hostname || 'order.dominos.com';
        const market = host.endsWith('.ca') ? 'CANADA' : 'UNITED_STATES';

        options.headers = {
            Market: market,
            'DPZ-Language': 'en',
            'DPZ-Market': market,
            ...options.headers,
        };

        if (body) {
            Object.assign(options.headers, {
                'User-Agent': 'DominosAndroid/11.5.0 (Android 11; OnePlus/ONEPLUS A3003; en)',
                Accept: 'text/plain, application/json, application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.5',
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                Origin: `https://${host}`,
                Referer: `https://${host}/assets/build/xdomain/proxy.html`,
                Connection: 'close',
            });
        } else {
            Object.assign(options.headers, {
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
                Accept: 'application/json, text/javascript, */*; q=0.01',
                Referer: options.headers.Referer || `https://${host}/`,
            });
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data });
                }
            });
        });

        req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Helper: build dictionary of topping code -> {name, code} for a specific product type
function buildToppingDict(menuData, productType) {
    const toppingDict = {};
    const toppingsSection = menuData.Toppings?.[productType] || {};
    for (const group of Object.values(toppingsSection)) {
        for (const item of Object.values(group || {})) {
            if (item.Code)
                toppingDict[item.Code] = { name: item.Name, code: item.Code, Tags: item.Tags };
        }
    }
    return toppingDict;
}

// Helper: parse Domino's AvailableToppings string into Set and Map
function parseAvailableToppings(str) {
    const codeSet = new Set();
    const portions = new Map();
    if (!str) return { codeSet, portions };

    const parts = Array.isArray(str) ? str.map(String) : String(str).split(',');
    parts.forEach((part) => {
        const eqIdx = part.indexOf('=');
        const code = (eqIdx === -1 ? part : part.slice(0, eqIdx)).trim();
        if (!code) return;
        codeSet.add(code);
        if (eqIdx !== -1) {
            const pStr = part.slice(eqIdx + 1);
            const pList = pStr.includes(':')
                ? pStr.split(':').map((p) => p.trim())
                : [pStr.split('/')[0].trim()];
            portions.set(code, pList.filter(Boolean));
        }
    });
    return { codeSet, portions };
}

// Helper: classify toppings into sauces and non-sauce toppings
function classifyToppings(toppingDict, codeSet) {
    const sauces = [];
    const toppings = [];
    const sauceCodes = new Set(['X', 'Xw', 'Xf', 'Xo', 'Xb', 'Xm', 'Cp', 'Rd']);

    for (const code of codeSet) {
        const item = toppingDict[code];
        if (!item) continue;
        const isSauce = sauceCodes.has(code) || (item.Tags || {}).Sauce;
        if (isSauce) sauces.push({ code, name: item.Name || code });
        else toppings.push({ code, name: item.Name || code });
    }
    return { sauces, toppings };
}

// Helper: parse cart options into {code: amount} map
function parseOptions(params) {
    const defaultsMap = (() => {
        try {
            return params.default_options
                ? JSON.parse(decodeURIComponent(params.default_options))
                : {};
        } catch (e) {
            return {};
        }
    })();

    const options = {};
    const hasFormFields = Object.keys(params).some(
        (k) => k.startsWith('topping_') || k.startsWith('sauce_')
    );

    for (const [key, amount] of Object.entries(params)) {
        if (key.startsWith('topping_') || key.startsWith('sauce_')) {
            const code = key.split('_').slice(1).join('_');
            if (amount !== '0') options[code] = { '1/1': amount };
            else if (code in defaultsMap) options[code] = { '1/1': '0' };
        }
    }

    if (!hasFormFields) {
        for (const [code, amount] of Object.entries(defaultsMap)) {
            if (parseFloat(amount) > 0) options[code] = { '1/1': String(amount) };
        }
    }
    return options;
}

// --- Helper: build one sauce/topping row (select element) given a topping entry ---
function buildToppingRow(item, inputName, normalizedDefaults, portions, templates) {
    const PORTION_LABELS = { 0: 'None', 0.5: 'Light', 1: 'Normal', 1.5: 'Extra' };
    const DEFAULT_PORTIONS = ['0', '1'];

    const defaultAmt = normalizedDefaults[item.code] || '0';
    const rawPortions = portions.get(item.code) || DEFAULT_PORTIONS;
    const portionSet = new Set(rawPortions);
    if (defaultAmt !== '0') portionSet.add(defaultAmt);

    const optHtml = Array.from(portionSet)
        .sort((a, b) => parseFloat(a) - parseFloat(b))
        .map((p) => {
            let opt = templates.selectOption;
            opt = strReplace(opt, '{$VALUE}', escape(p));
            opt = strReplace(opt, '{$SELECTED}', p === defaultAmt ? ' selected' : '');
            opt = strReplace(opt, '{$LABEL}', escape(PORTION_LABELS[p] || p));
            return opt;
        })
        .join('');

    let row = templates.customizeToppingRow;
    row = strReplace(row, '{$NAME}', escape(item.name));
    row = strReplace(row, '{$INPUT_NAME}', inputName);
    row = strReplace(row, '{$CODE}', escape(item.code));
    row = strReplace(row, '{$OPTIONS_HTML}', optHtml);
    return row;
}

// =============================================================================
// GET handler
// =============================================================================
exports.handleGet = async function (bot, req, res, discordID) {
    const parsedurl = new URL(req.url, 'http://localhost');
    const subpath = parsedurl.pathname.replace(/^\/food\/?/, '').replace(/\/$/, '');
    const theme = getPageThemeAttr(req);
    const templates = getTemplates();

    const sessionData = {
        urlSessionID: parsedurl.searchParams.get('sessionID') || '',
        urlCartEncoded: parsedurl.searchParams.get('pizzaCart') || '',
        urlCheckoutEncoded: parsedurl.searchParams.get('pizzaCheckout') || '',
    };
    const _pParts = [];
    if (sessionData.urlSessionID)
        _pParts.push('sessionID=' + encodeURIComponent(sessionData.urlSessionID));
    if (sessionData.urlCartEncoded)
        _pParts.push('pizzaCart=' + encodeURIComponent(sessionData.urlCartEncoded));
    if (sessionData.urlCheckoutEncoded)
        _pParts.push('pizzaCheckout=' + encodeURIComponent(sessionData.urlCheckoutEncoded));
    sessionData.persistentParam = _pParts.length ? '?' + _pParts.join('&') : '';
    sessionData.persistentSuffix = _pParts.length ? '&' + _pParts.join('&') : '';

    const common = (html) => applyCommonFields(html, req, templates, theme, sessionData);

    // --- Store finder ---
    if (subpath === '' || subpath === 'index' || subpath === 'index.html') {
        return res.end(common(templates.index));
    }

    // --- Store search ---
    if (subpath === 'store-search') {
        const address = parsedurl.searchParams.get('address') || '';
        let html = common(templates.storeSearch);
        html = strReplace(html, '{$SEARCH_ADDRESS}', escape(address));

        if (!address) {
            html = strReplace(html, '{$STORE_RESULTS}', '');
            return res.end(html);
        }

        const storesHtml = await (async () => {
            try {
                const trySearch = async (hostname) => {
                    const r = await dominosRequest({
                        hostname,
                        // Use type=Carryout for initial search as it's less "specific" than Delivery
                        // and works better for zip codes or city names.
                        path: `/power/store-locator?type=Carryout&c=${encodeURIComponent(address)}&s=&a=`,
                        method: 'GET',
                    });
                    return r.status >= 200 && r.status < 300 && r.data?.Stores ? r.data.Stores : [];
                };
                let stores = await trySearch('order.dominos.com');
                if (stores.length === 0) {
                    stores = await trySearch('order.dominos.ca');
                }
                if (stores.length > 0) {
                    const header = strReplace(templates.sectionHeader, '{$TITLE}', 'Nearby Stores');
                    const cards = stores
                        .slice(0, 5)
                        .map((s) => {
                            const city = escape(s.City || '');
                            const storeId = escape(String(s.StoreID || ''));
                            const wait = s.ServiceMethodEstimatedWaitMinutes?.Delivery
                                ? escape(
                                      s.ServiceMethodEstimatedWaitMinutes.Delivery.Min +
                                          '-' +
                                          s.ServiceMethodEstimatedWaitMinutes.Delivery.Max +
                                          ' min'
                                  )
                                : '';
                            const addrLines = (s.AddressDescription || '')
                                .split('\n')
                                .map((l) => escape(l))
                                .join(templates.lineBreak);

                            let card = templates.storeCard;
                            card = strReplace(card, '{$STORE_ID}', storeId);
                            card = strReplace(card, '{$CITY}', city);
                            card = strReplace(card, '{$ADDR_LINES}', addrLines);
                            card = strReplace(
                                card,
                                '{$WAIT_HTML}',
                                wait ? strReplace(templates.storeWait, '{$WAIT}', wait) : ''
                            );
                            card = strReplace(
                                card,
                                '{$COUNTRY}',
                                s.Market === 'CANADA' ? 'ca' : 'us'
                            );
                            card = strReplace(
                                card,
                                '{$SESSION_ID_SUFFIX}',
                                sessionData.persistentSuffix
                            );
                            return card;
                        })
                        .join('');
                    return header + cards;
                } else {
                    return strReplace(
                        templates.errorBox,
                        '{$MESSAGE}',
                        'No stores found near that address. Try a different zip code or city name.'
                    );
                }
            } catch (e) {
                console.error('Dominos store-search error:', e.message);
                return strReplace(
                    templates.errorBox,
                    '{$MESSAGE}',
                    'Error searching for stores. Please try again.'
                );
            }
        })();

        return res.end(strReplace(html, '{$STORE_RESULTS}', storesHtml));
    }

    // --- Menu ---
    if (subpath === 'menu') {
        const storeId = (parsedurl.searchParams.get('store') || '').replace(/[^0-9]/g, '');
        const category = parsedurl.searchParams.get('category') || '';
        const country = parsedurl.searchParams.get('country') === 'ca' ? 'ca' : 'us';
        const dominosHost = country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com';

        if (!storeId) {
            res.writeHead(302, { Location: '/food/' + sessionData.persistentParam });
            return res.end();
        }

        const menuData = await dominosRequest({
            hostname: dominosHost,
            path: `/power/store/${encodeURIComponent(storeId)}/menu?lang=en&structured=true`,
            method: 'GET',
        })
            .then((result) => (result.status >= 200 && result.status < 300 ? result.data : null))
            .catch((e) => {
                console.error('Dominos menu fetch error:', e.message);
                return null;
            });

        let html = common(templates.menu);
        html = strReplace(html, '{$STORE_ID}', escape(storeId));
        html = strReplace(html, '{$SELECTED_CATEGORY}', escape(category));

        if (menuData) {
            const allCategories = menuData.Categorization?.Food?.Categories || [];
            const categoryByCode = Object.fromEntries(
                allCategories.filter((cat) => cat?.Code).map((cat) => [cat.Code, cat])
            );

            const selectedCat = category || allCategories[0]?.Code || '';

            const catTabs = allCategories
                .filter((cat) => cat?.Code)
                .map((cat) => {
                    const active = selectedCat === cat.Code ? ' food-tab-active' : '';
                    let tab = templates.categoryTab;
                    tab = strReplace(tab, '{$STORE_ID}', encodeURIComponent(storeId));
                    tab = strReplace(tab, '{$CATEGORY_CODE}', encodeURIComponent(cat.Code));
                    tab = strReplace(tab, '{$COUNTRY}', country);
                    tab = strReplace(tab, '{$SESSION_ID_SUFFIX}', sessionData.persistentSuffix);
                    tab = strReplace(tab, '{$ACTIVE_CLASS}', active);
                    tab = strReplace(tab, '{$CATEGORY_NAME}', escape(cat.Name || cat.Code));
                    return tab;
                })
                .join('');
            html = strReplace(html, '{$CATEGORY_TABS}', catTabs);

            function collectProducts(catNode) {
                const products = catNode.Products?.length ? [...catNode.Products] : [];
                const subProducts = catNode.Categories?.length
                    ? catNode.Categories.filter(Boolean).flatMap((sub) => collectProducts(sub))
                    : [];
                return products.concat(subProducts);
            }

            const catData = categoryByCode[selectedCat];
            const productCodes = catData ? collectProducts(catData) : [];
            const products = menuData.Products || {};
            const variants = menuData.Variants || {};
            const cart = getCart(req);

            const cartQtyByVariant = (cart.items || []).reduce((acc, item) => {
                acc[item.code] = (acc[item.code] || 0) + (item.qty || 1);
                return acc;
            }, {});
            const cartQtyByProduct = (cart.items || []).reduce((acc, item) => {
                for (const pCode of Object.keys(products)) {
                    if (products[pCode].Variants?.includes(item.code)) {
                        acc[pCode] = (acc[pCode] || 0) + (item.qty || 1);
                    }
                }
                return acc;
            }, {});

            const rawItemsHtml = productCodes
                .flatMap((code) => {
                    const p = products[code];
                    if (!p) return [];
                    const name = escape(p.Name || code);
                    const desc = escape((p.Description || '').slice(0, 120));

                    const variantPrices = (p.Variants || [])
                        .map((v) => parseFloat(variants[v]?.Price || 0))
                        .filter((v) => v > 0);
                    const price = variantPrices.length
                        ? `$${Math.min(...variantPrices).toFixed(2)}`
                        : '';
                    const hasMultipleVariants = (p.Variants?.length || 0) > 1;

                    const safeCode = escape(code);
                    const safeName = escape(p.Name || code);
                    const safePrice = escape(price.replace('$', '') || '0');
                    const safeStoreId = escape(storeId);
                    const safeRedirect = escape(req.url);
                    const inCart = cartQtyByProduct[code] || 0;

                    const actionHtml = (() => {
                        if (hasMultipleVariants) {
                            const customizeUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(code)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(req.url)}${sessionData.persistentSuffix}`;
                            const btnLabel =
                                inCart > 0 ? `Customize (${inCart} in cart)` : 'Customize / Add';

                            let link = templates.buttonLink;
                            link = strReplace(link, '{$URL}', customizeUrl);
                            link = strReplace(link, '{$LABEL}', escape(btnLabel));
                            return link;
                        }
                        const singleVariant = p.Variants?.[0] || code;
                        const inCartSingle = cartQtyByVariant[singleVariant] || 0;
                        const btnLabel =
                            inCartSingle > 0
                                ? `Add to Cart (${inCartSingle} in cart)`
                                : 'Add to Cart';

                        let form = templates.menuItemActionForm;
                        form = strReplace(form, '{$SESSION_PARAM}', sessionData.persistentParam);
                        form = strReplace(form, '{$STORE_ID}', safeStoreId);
                        form = strReplace(form, '{$COUNTRY}', escape(country));
                        form = strReplace(form, '{$CODE}', safeCode);
                        form = strReplace(form, '{$NAME}', safeName);
                        form = strReplace(form, '{$PRICE}', safePrice);
                        form = strReplace(form, '{$REDIRECT}', safeRedirect);
                        form = strReplace(form, '{$BTN_LABEL}', escape(btnLabel));
                        return form;
                    })();

                    let item = templates.menuItem;
                    item = strReplace(
                        item,
                        '{$IMAGE_CODE}',
                        encodeURIComponent((p.ImageCode || code).replace(/[^a-zA-Z0-9_-]/g, ''))
                    );
                    item = strReplace(item, '{$NAME}', name);
                    item = strReplace(item, '{$DESC}', desc);
                    item = strReplace(item, '{$PRICE}', escape(price));
                    item = strReplace(item, '{$ACTION_HTML}', actionHtml);
                    return [item];
                })
                .join('');

            html = strReplace(
                html,
                '{$MENU_ITEMS}',
                rawItemsHtml ||
                    strReplace(templates.infoText, '{$MESSAGE}', 'No items found in this category.')
            );
        } else {
            html = strReplace(html, '{$CATEGORY_TABS}', '');
            html = strReplace(
                html,
                '{$MENU_ITEMS}',
                strReplace(
                    templates.errorBox,
                    '{$MESSAGE}',
                    'Could not load menu. The store may be temporarily unavailable. Please try again or choose a different store.'
                )
            );
        }

        return res.end(html);
    }

    // --- Cart view ---
    if (subpath === 'cart') {
        const cart = getCart(req);
        const items = cart.items || [];
        const total = items.reduce(
            (sum, item) => sum + parseFloat(item.price || 0) * (item.qty || 1),
            0
        );

        const itemsHtml =
            items.length > 0
                ? items
                      .map((item, i) => {
                          let row = templates.cartItem;
                          row = strReplace(row, '{$NAME}', escape(item.name || item.code));
                          row = strReplace(row, '{$QTY}', escape(String(item.qty || 1)));
                          row = strReplace(
                              row,
                              '{$PRICE_TOTAL}',
                              (parseFloat(item.price || 0) * (item.qty || 1)).toFixed(2)
                          );
                          row = strReplace(row, '{$SESSION_PARAM}', sessionData.persistentParam);
                          row = strReplace(row, '{$INDEX}', String(i));
                          return row;
                      })
                      .join('')
                : strReplace(
                      templates.cartEmptyRow,
                      '{$MESSAGE}',
                      strReplace(templates.infoText, '{$MESSAGE}', 'Your cart is empty.')
                  );

        let html = common(templates.cart);
        html = strReplace(html, '{$CART_ITEMS}', itemsHtml);
        html = strReplace(html, '{$CART_TOTAL}', total.toFixed(2));
        html = strReplace(html, '{$STORE_ID}', escape(cart.storeId || ''));
        html = strReplace(html, '{$HAS_ITEMS}', items.length > 0 ? '' : 'display:none;');

        return res.end(html);
    }

    // --- Checkout form ---
    if (subpath === 'checkout') {
        const cart = getCart(req);
        if (!cart.items?.length) {
            res.writeHead(302, { Location: '/food/cart' + sessionData.persistentParam });
            return res.end();
        }

        const dominosHost = cart.country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com';
        const errorText = parsedurl.searchParams.get('error') || '';

        const storeAddrHtml = cart.storeId
            ? await dominosRequest({
                  hostname: dominosHost,
                  path: `/power/store/${encodeURIComponent(cart.storeId)}/profile`,
                  method: 'GET',
              })
                  .then((profileResult) => {
                      const p = profileResult.data;
                      if (profileResult.status >= 200 && profileResult.status < 300 && p) {
                          const addr = [
                              p.StreetName || p.AddressDescription,
                              p.City,
                              p.Region,
                              p.PostalCode,
                          ]
                              .filter(Boolean)
                              .join(', ');
                          if (addr) {
                              let addrHtml = templates.checkoutAddress;
                              addrHtml = strReplace(addrHtml, '{$STORE_ID}', escape(cart.storeId));
                              addrHtml = strReplace(addrHtml, '{$ADDRESS}', escape(addr));
                              return addrHtml;
                          }
                      }
                      return '';
                  })
                  .catch((e) => {
                      console.error('Dominos store profile fetch error (non-critical):', e.message);
                      return '';
                  })
            : '';

        const total = cart.items.reduce(
            (sum, item) => sum + parseFloat(item.price || 0) * (item.qty || 1),
            0
        );
        const itemsSummary = cart.items
            .map((item) => {
                let summary = templates.checkoutSummaryItem;
                summary = strReplace(summary, '{$NAME}', escape(item.name || item.code));
                summary = strReplace(summary, '{$QTY}', String(item.qty || 1));
                summary = strReplace(
                    summary,
                    '{$PRICE_TOTAL}',
                    (parseFloat(item.price || 0) * (item.qty || 1)).toFixed(2)
                );
                return summary;
            })
            .join('');

        let html = common(templates.checkout);
        html = strReplace(
            html,
            '{$ERROR}',
            errorText ? strReplace(templates.errorBox, '{$MESSAGE}', escape(errorText)) : ''
        );
        html = strReplace(html, '{$STORE_ADDRESS}', storeAddrHtml);
        html = strReplace(html, '{$ORDER_SUMMARY}', itemsSummary);
        html = strReplace(html, '{$ORDER_TOTAL}', total.toFixed(2));

        return res.end(html);
    }

    // --- Verify code page ---
    if (subpath === 'verify') {
        const errorText = parsedurl.searchParams.get('error') || '';
        let html = common(templates.verify);
        html = strReplace(
            html,
            '{$ERROR}',
            errorText ? strReplace(templates.errorBox, '{$MESSAGE}', escape(errorText)) : ''
        );
        return res.end(html);
    }

    // --- Tracker page ---
    if (subpath === 'track') {
        let html = common(templates.track);
        const lastOrder = auth.dbQuerySingle(
            'SELECT store_name, timestamp FROM pizza_orders WHERE discordID=? ORDER BY timestamp DESC LIMIT 1',
            [discordID]
        );
        let orderInfo = '';
        if (lastOrder?.timestamp) {
            orderInfo = templates.trackOrderInfo;
            orderInfo = strReplace(
                orderInfo,
                '{$STORE_NAME}',
                escape(lastOrder.store_name || 'Unknown store')
            );
            orderInfo = strReplace(
                orderInfo,
                '{$DATE}',
                escape(formatTimestamp(lastOrder.timestamp, req))
            );
        } else {
            orderInfo = strReplace(templates.infoText, '{$MESSAGE}', 'No recent orders found.');
        }
        return res.end(strReplace(html, '{$ORDER_INFO}', orderInfo));
    }

    // --- Receipts / order history ---
    if (subpath === 'receipts') {
        const orders = auth.dbQueryAll(
            'SELECT * FROM pizza_orders WHERE discordID=? ORDER BY timestamp DESC',
            [discordID]
        );
        const justPlaced = parsedurl.searchParams.get('placed') === '1';
        let html = common(templates.receipts);
        html = strReplace(html, '{$NOTICE}', justPlaced ? templates.receiptSuccessNotice : '');

        const ordersHtml =
            orders?.length > 0
                ? orders
                      .map((order) => {
                          const date = formatTimestamp(order.timestamp, req);
                          let items = [];
                          try {
                              items = JSON.parse(order.items_json);
                          } catch (e) {}
                          const itemsList = items
                              .map((i) => `${escape(i.name || i.code)} ×${i.qty || 1}`)
                              .join(', ');

                          let card = templates.receiptCard;
                          card = strReplace(
                              card,
                              '{$STORE_NAME}',
                              escape(order.store_name || `Store #${order.store_id}`)
                          );
                          card = strReplace(card, '{$DATE}', escape(date));
                          card = strReplace(
                              card,
                              '{$ITEMS_LIST}',
                              itemsList ||
                                  strReplace(templates.infoText, '{$MESSAGE}', 'No item details')
                          );
                          card = strReplace(
                              card,
                              '{$TOTAL}',
                              parseFloat(order.total || 0).toFixed(2)
                          );
                          card = strReplace(card, '{$SESSION_PARAM}', sessionData.persistentParam);
                          return card;
                      })
                      .join('')
                : strReplace(templates.infoText, '{$MESSAGE}', 'No orders yet.');

        return res.end(strReplace(html, '{$ORDERS}', ordersHtml));
    }

    // --- Cancel order ---
    if (subpath === 'cancel-order') {
        auth.dbQueryRun('DELETE FROM pizza_verifications WHERE discordID=?', [discordID]);
        res.writeHead(302, {
            Location: '/food/cart' + sessionData.persistentParam,
            'Set-Cookie':
                'pizzaCheckout=; path=/food; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT',
        });
        return res.end();
    }

    // --- Customize item ---
    if (subpath === 'customize') {
        const storeId = (parsedurl.searchParams.get('store') || '').replace(/[^0-9]/g, '');
        const productCode = (parsedurl.searchParams.get('code') || '')
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 50);
        const variantCode = (parsedurl.searchParams.get('variant') || '')
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 50);
        const country = parsedurl.searchParams.get('country') === 'ca' ? 'ca' : 'us';
        const backUrl = (() => {
            const raw = parsedurl.searchParams.get('back') || '';
            return /^\/food\//.test(raw)
                ? raw.slice(0, 300)
                : `/food/menu?store=${encodeURIComponent(storeId)}&country=${country}`;
        })();

        if (!storeId || !productCode) {
            res.writeHead(302, { Location: '/food/' + sessionData.persistentParam });
            return res.end();
        }

        const dominosHost = country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com';
        const menuData = await dominosRequest({
            hostname: dominosHost,
            path: `/power/store/${encodeURIComponent(storeId)}/menu?lang=en&structured=true`,
            method: 'GET',
        })
            .then((result) => (result.status >= 200 && result.status < 300 ? result.data : null))
            .catch((e) => {
                console.error('Dominos menu fetch error (customize):', e.message);
                return null;
            });

        let html = common(templates.customize);
        html = strReplace(html, '{$STORE_ID}', escape(storeId));
        html = strReplace(html, '{$COUNTRY}', escape(country));
        html = strReplace(html, '{$BACK_URL}', escape(backUrl));

        if (menuData) {
            const products = menuData.Products || {};
            const variants = menuData.Variants || {};
            const product = products[productCode];
            if (!product) {
                res.writeHead(302, { Location: backUrl });
                return res.end();
            }

            html = strReplace(html, '{$PRODUCT_NAME}', escape(product.Name || productCode));
            html = strReplace(
                html,
                '{$PRODUCT_DESC}',
                escape((product.Description || '').slice(0, 200))
            );

            const productVariants = product.Variants || [];

            if (!variantCode) {
                if (productVariants.length === 1) {
                    const redirectUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(productCode)}&variant=${encodeURIComponent(productVariants[0])}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(backUrl)}${sessionData.persistentSuffix}`;
                    res.writeHead(302, { Location: redirectUrl });
                    return res.end();
                }

                let sizeOptionsHtml = '';
                if (productVariants.length > 1) {
                    sizeOptionsHtml =
                        strReplace(templates.sectionHeader, '{$TITLE}', 'Choose a size:') +
                        productVariants
                            .filter((vCode) => variants[vCode])
                            .map((vCode) => {
                                const v = variants[vCode];
                                const vPrice = parseFloat(v.Price || 0);
                                const customizeUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(productCode)}&variant=${encodeURIComponent(vCode)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(backUrl)}${sessionData.persistentSuffix}`;

                                let opt = templates.customizeSizeOption;
                                opt = strReplace(opt, '{$CUSTOMIZE_URL}', customizeUrl);
                                opt = strReplace(opt, '{$SIZE_NAME}', escape(v.Name || vCode));
                                opt = strReplace(
                                    opt,
                                    '{$PRICE_HTML}',
                                    vPrice > 0
                                        ? strReplace(
                                              templates.foodSizePrice,
                                              '{$PRICE}',
                                              vPrice.toFixed(2)
                                          )
                                        : ''
                                );
                                return opt;
                            })
                            .join('');
                } else {
                    let form = templates.customizeActionForm;
                    form = strReplace(form, '{$SESSION_PARAM}', sessionData.persistentParam);
                    form = strReplace(form, '{$STORE_ID}', escape(storeId));
                    form = strReplace(form, '{$COUNTRY}', escape(country));
                    form = strReplace(form, '{$CODE}', escape(productCode));
                    form = strReplace(form, '{$NAME}', escape(product.Name || productCode));
                    form = strReplace(form, '{$PRICE}', '0');
                    form = strReplace(form, '{$REDIRECT}', escape(backUrl));
                    form = strReplace(form, '{$DEFAULT_OPTIONS}', '');
                    form = strReplace(form, '{$TOPPINGS_INFO_HTML}', '');
                    form = strReplace(form, '{$MARGIN_STYLE}', 'margin-top:8px');
                    form = strReplace(form, '{$PRICE_DISPLAY}', '');
                    form = strReplace(form, '{$BACK_URL}', escape(backUrl));
                    sizeOptionsHtml = form;
                }
                html = strReplace(html, '{$SIZE_OPTIONS}', sizeOptionsHtml);
                html = strReplace(html, '{$TOPPINGS_SECTION}', '');
            } else {
                const v = variants[variantCode];
                if (!v) {
                    res.writeHead(302, { Location: backUrl });
                    return res.end();
                }
                const vPrice = parseFloat(v.Price || 0);
                const vFullName = escape(v.Name || product.Name || productCode);

                let sizeHtml = templates.customizeSizeHeader;
                sizeHtml = strReplace(sizeHtml, '{$SIZE_NAME}', escape(v.Name || variantCode));
                sizeHtml = strReplace(
                    sizeHtml,
                    '{$PRICE_DISPLAY}',
                    vPrice > 0 ? ` - $${vPrice.toFixed(2)}` : ''
                );
                sizeHtml = strReplace(sizeHtml, '{$STORE_ID}', encodeURIComponent(storeId));
                sizeHtml = strReplace(sizeHtml, '{$PRODUCT_CODE}', encodeURIComponent(productCode));
                sizeHtml = strReplace(sizeHtml, '{$COUNTRY}', encodeURIComponent(country));
                sizeHtml = strReplace(sizeHtml, '{$BACK_URL}', encodeURIComponent(backUrl));
                sizeHtml = strReplace(
                    sizeHtml,
                    '{$SESSION_ID_SUFFIX_ESCAPED}',
                    sessionData.persistentSuffix.replace(/&/g, '&amp;')
                );
                sizeHtml = strReplace(sizeHtml, '{$LINK_TEXT}', 'Change size');
                html = strReplace(html, '{$SIZE_OPTIONS}', sizeHtml);

                const toppingDict = buildToppingDict(menuData, product.ProductType || '');
                const { codeSet, portions } = parseAvailableToppings(product.AvailableToppings);
                const normalizedDefaults = Object.fromEntries(
                    Object.entries(v.Options || {}).map(([code, pObj]) => [
                        code,
                        String(
                            pObj?.['1/1'] ||
                                pObj?.['1/2'] ||
                                pObj?.['2/4'] ||
                                Object.values(pObj || {})[0] ||
                                '1'
                        ),
                    ])
                );

                const parseKvStr = (str) =>
                    Object.fromEntries(
                        String(str || '')
                            .split(',')
                            .map((part) => {
                                const eqIdx = part.indexOf('=');
                                return eqIdx > 0
                                    ? [part.slice(0, eqIdx), part.slice(eqIdx + 1)]
                                    : null;
                            })
                            .filter(Boolean)
                    );
                const tagDefaults = {
                    ...parseKvStr(v.Tags?.DefaultToppings),
                    ...parseKvStr(v.Tags?.DefaultSides),
                };

                const toppingsSection = (() => {
                    const hasInteractive = codeSet.size > 0 && Object.keys(toppingDict).length > 0;
                    let form = templates.customizeActionForm;
                    form = strReplace(form, '{$SESSION_PARAM}', sessionData.persistentParam);
                    form = strReplace(form, '{$STORE_ID}', escape(storeId));
                    form = strReplace(form, '{$COUNTRY}', escape(country));
                    form = strReplace(form, '{$CODE}', escape(variantCode));
                    form = strReplace(form, '{$NAME}', vFullName);
                    form = strReplace(form, '{$PRICE}', vPrice.toFixed(2));
                    form = strReplace(form, '{$REDIRECT}', escape(backUrl));
                    form = strReplace(form, '{$BACK_URL}', escape(backUrl));
                    form = strReplace(
                        form,
                        '{$PRICE_DISPLAY}',
                        vPrice > 0 ? ` - $${vPrice.toFixed(2)}` : ''
                    );

                    if (hasInteractive) {
                        const { sauces, toppings: toppingList } = classifyToppings(
                            toppingDict,
                            codeSet
                        );
                        const sSection = sauces.length
                            ? strReplace(templates.sectionHeader, '{$TITLE}', 'Sauce') +
                              sauces
                                  .map((s) =>
                                      buildToppingRow(
                                          s,
                                          'sauce',
                                          normalizedDefaults,
                                          portions,
                                          templates
                                      )
                                  )
                                  .join('') +
                              templates.lineBreak
                            : '';
                        const tSection = toppingList.length
                            ? strReplace(templates.sectionHeader, '{$TITLE}', 'Toppings') +
                              toppingList
                                  .map((t) =>
                                      buildToppingRow(
                                          t,
                                          'topping',
                                          normalizedDefaults,
                                          portions,
                                          templates
                                      )
                                  )
                                  .join('') +
                              templates.lineBreak
                            : '';

                        form = strReplace(
                            form,
                            '{$DEFAULT_OPTIONS}',
                            escape(JSON.stringify(normalizedDefaults))
                        );
                        form = strReplace(
                            form,
                            '{$TOPPINGS_INFO_HTML}',
                            templates.customizeToppingsInfo + sSection + tSection
                        );
                        form = strReplace(form, '{$MARGIN_STYLE}', 'margin-top:16px');
                    } else {
                        form = strReplace(
                            form,
                            '{$DEFAULT_OPTIONS}',
                            escape(JSON.stringify(tagDefaults))
                        );
                        form = strReplace(form, '{$TOPPINGS_INFO_HTML}', '');
                        form = strReplace(form, '{$MARGIN_STYLE}', 'margin-top:8px');
                    }
                    return form;
                })();
                html = strReplace(html, '{$TOPPINGS_SECTION}', toppingsSection);
            }
        } else {
            html = strReplace(html, '{$PRODUCT_NAME}', escape(productCode));
            html = strReplace(html, '{$PRODUCT_DESC}', '');
            html = strReplace(
                html,
                '{$SIZE_OPTIONS}',
                strReplace(
                    templates.errorBox,
                    '{$MESSAGE}',
                    'Could not load menu. Please go back and try again.'
                )
            );
            html = strReplace(html, '{$TOPPINGS_SECTION}', '');
        }

        return res.end(html);
    }

    return notFound.serve404(
        req,
        res,
        'Page not found.',
        '/food/' + sessionData.persistentParam,
        'Back to Pizza'
    );
};

// =============================================================================
// POST handler
// =============================================================================
exports.handlePost = async function (bot, req, res, discordID, body) {
    const parsedurl = new URL(req.url, 'http://localhost');
    const subpath = parsedurl.pathname.replace(/^\/food\/?/, '').replace(/\/$/, '');
    const secure = isSecure(req);

    const params = (() => {
        try {
            return Object.fromEntries(new URLSearchParams(body));
        } catch (e) {
            return {};
        }
    })();

    const urlSessionID = params.sessionID || parsedurl.searchParams.get('sessionID') || '';
    const urlCheckoutEncoded =
        params.pizzaCheckout || parsedurl.searchParams.get('pizzaCheckout') || '';

    function buildRedirect(path, extras = []) {
        const parts = [];
        if (urlSessionID) parts.push('sessionID=' + encodeURIComponent(urlSessionID));

        const cart = getCart(req);
        if (cart.items?.length || cart.storeId) {
            parts.push('pizzaCart=' + encodeURIComponent(encodeCart(cart)));
        }
        if (urlCheckoutEncoded)
            parts.push('pizzaCheckout=' + encodeURIComponent(urlCheckoutEncoded));
        if (extras.length) parts.push(...extras);

        return parts.length ? path + (path.includes('?') ? '&' : '?') + parts.join('&') : path;
    }

    // --- Add item to cart ---
    if (subpath === 'cart/add') {
        const cart = getCart(req);
        const storeId = (params.storeId || '').replace(/[^0-9]/g, '');
        const code = (params.code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);

        let redirectPath = '/food/cart';
        const rawRedirect = params.redirect || '';
        const rawRedirectDecoded = rawRedirect.replace(/&amp;/g, '&');
        if (/^\/food\//.test(rawRedirectDecoded)) {
            redirectPath = rawRedirectDecoded.split('?')[0].slice(0, 300);
        }

        if (!code) {
            res.writeHead(302, { Location: buildRedirect(redirectPath) });
            return res.end();
        }

        if (cart.storeId && cart.storeId !== storeId) cart.items = [];
        cart.storeId = storeId;
        cart.country = params.country === 'ca' ? 'ca' : 'us';

        const options = parseOptions(params);
        const existing = cart.items.find((i) => i.code === code);
        if (existing) {
            existing.qty = (existing.qty || 1) + 1;
            existing.options = options;
            existing._nf = 1;
        } else {
            cart.items.push({
                code,
                name: (params.name || '').slice(0, 100),
                qty: 1,
                price: parseFloat(params.price) || 0,
                options,
                _nf: 1,
            });
        }

        res.writeHead(302, {
            Location: buildRedirect(redirectPath),
            'Set-Cookie': cartCookieHeader(cart, secure),
        });
        return res.end();
    }

    // --- Remove item from cart ---
    if (subpath === 'cart/remove') {
        const cart = getCart(req);
        const idx = parseInt(params.index, 10);
        if (!isNaN(idx) && idx >= 0 && idx < cart.items.length) {
            cart.items.splice(idx, 1);
        }
        res.writeHead(302, {
            Location: buildRedirect('/food/cart'),
            'Set-Cookie': cartCookieHeader(cart, secure),
        });
        return res.end();
    }

    // --- Request Discord DM verification ---
    if (subpath === 'request-verify') {
        const cart = getCart(req);
        if (!cart.items?.length) {
            res.writeHead(302, {
                Location: buildRedirect('/food/checkout', [
                    'error=' + encodeURIComponent('Your cart is empty.'),
                ]),
            });
            return res.end();
        }

        const rawPhone = (params.phone || '').replace(/\D/g, '').slice(0, 10);
        if (!rawPhone || rawPhone.length < 7) {
            res.writeHead(302, {
                Location: buildRedirect('/food/checkout', [
                    'error=' + encodeURIComponent('Please enter a valid phone number.'),
                ]),
            });
            return res.end();
        }

        const code = String(crypto.randomInt(VERIFICATION_CODE_MIN, VERIFICATION_CODE_MAX));
        const expires = unixTime() + 600;
        auth.dbQueryRun(
            'INSERT OR REPLACE INTO pizza_verifications (discordID, code, cart_json, expires) VALUES (?,?,?,?)',
            [discordID, code, '', expires]
        );

        const checkoutData = {
            cart,
            firstName: (params.firstName || '').slice(0, 50),
            lastName: (params.lastName || '').slice(0, 50),
            email: (params.email || '').slice(0, 100),
            phone: rawPhone,
            street: (params.street || '').slice(0, 100),
            apt: (params.apt || '').replace(/[^a-zA-Z0-9 #-]/g, '').slice(0, 20),
            addressType: ['House', 'Apartment', 'Business', 'Hotel', 'Other'].includes(
                params.addressType
            )
                ? params.addressType
                : 'House',
            city: (params.city || '').slice(0, 50),
            region: (params.region || '').slice(0, 2).toUpperCase(),
            postalCode: (params.postalCode || '').replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 10),
            tip: Math.min(
                parseFloat(params.tip_custom) > 0
                    ? parseFloat(params.tip_custom)
                    : parseFloat(params.tip) || 0,
                100
            ),
        };
        const checkoutCookie = Buffer.from(JSON.stringify(checkoutData)).toString('base64');

        if (await bot.sendPizzaVerification(discordID, code)) {
            res.writeHead(302, {
                Location: buildRedirect('/food/verify', [
                    'pizzaCheckout=' + encodeURIComponent(checkoutCookie),
                ]),
                'Set-Cookie': `pizzaCheckout=${encodeURIComponent(checkoutCookie)}; path=/food; HttpOnly${secure ? '; Secure' : ''}; Max-Age=600`,
            });
        } else {
            res.writeHead(302, {
                Location: buildRedirect('/food/checkout', [
                    'error=' +
                        encodeURIComponent(
                            'Could not send Discord DM. Please check your privacy settings.'
                        ),
                ]),
            });
        }
        return res.end();
    }

    // --- Place order ---
    if (subpath === 'place-order') {
        const code = (params.code || '').replace(/[^0-9]/g, '').slice(0, 6);
        const verification = auth.dbQuerySingle(
            'SELECT * FROM pizza_verifications WHERE discordID=? AND code=? AND expires > ?',
            [discordID, code, unixTime()]
        );

        if (!verification) {
            res.writeHead(302, {
                Location: buildRedirect('/food/verify', [
                    'error=' + encodeURIComponent('Invalid or expired verification code.'),
                ]),
            });
            return res.end();
        }

        const checkoutData = (() => {
            try {
                const cookie = req.headers.cookie || '';
                const rawVal =
                    cookie
                        .split('; ')
                        .find((c) => c.startsWith('pizzaCheckout='))
                        ?.split('=')[1] || urlCheckoutEncoded;
                return rawVal
                    ? JSON.parse(
                          Buffer.from(decodeURIComponent(rawVal), 'base64').toString('utf-8')
                      )
                    : null;
            } catch (e) {
                return null;
            }
        })();

        if (!checkoutData?.cart?.items?.length) {
            res.writeHead(302, {
                Location: buildRedirect('/food/checkout', [
                    'error=' + encodeURIComponent('Checkout session expired.'),
                ]),
            });
            return res.end();
        }

        const {
            cart,
            firstName,
            lastName,
            email,
            phone,
            street,
            apt,
            city,
            region,
            postalCode,
            addressType,
        } = checkoutData;
        if (
            !firstName ||
            !lastName ||
            !email ||
            !phone ||
            !street ||
            !city ||
            !region ||
            !postalCode
        ) {
            res.writeHead(302, {
                Location: buildRedirect('/food/checkout', [
                    'error=' + encodeURIComponent('Missing order details.'),
                ]),
            });
            return res.end();
        }

        const cartTotal = cart.items.reduce(
            (s, i) => s + parseFloat(i.price || 0) * (i.qty || 1),
            0
        );
        const PIZZA_SAUCE_CODES = new Set(['X', 'Xw', 'Xf', 'Xo', 'Xb', 'Xm', 'Cp', 'Rd']);
        const products = cart.items.map((item) => {
            const opts = item.options || {};
            const keys = Object.keys(opts);
            const isStale =
                !item._nf &&
                keys.length > 0 &&
                keys.length <= 2 &&
                keys.every((k) => PIZZA_SAUCE_CODES.has(k));
            return { Code: item.code, Qty: item.qty || 1, Options: isStale ? {} : opts };
        });

        const dominosHost = cart.country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com';
        let nStreet = street,
            nCity = city,
            nPostalCode = postalCode,
            streetName = '',
            streetNumber = '';

        try {
            const addrResult = await dominosRequest({
                hostname: dominosHost,
                path: `/power/store-locator?type=Delivery&c=${encodeURIComponent(`${street}, ${city}, ${region} ${postalCode}`)}&s=&a=`,
                method: 'GET',
            });
            const addrObj = addrResult?.data?.Address;
            if (addrResult?.data?.Stores?.length)
                cart.storeId = String(addrResult.data.Stores[0].StoreID);
            if (addrObj) {
                nStreet = addrObj.Street || nStreet;
                streetName = addrObj.StreetName || '';
                streetNumber = addrObj.StreetNumber || '';
                nCity = addrObj.City || nCity;
                nPostalCode = addrObj.PostalCode || nPostalCode;
            } else {
                const m = street.trim().match(/^(\d+)\s+(.+)$/);
                if (m) {
                    streetNumber = m[1];
                    streetName = m[2];
                }
            }
        } catch (e) {
            const m = street.trim().match(/^(\d+)\s+(.+)$/);
            if (m) {
                streetNumber = m[1];
                streetName = m[2];
            }
        }

        const validatePayload = {
            Order: {
                Address: {
                    Street: nStreet,
                    City: nCity,
                    Region: region,
                    PostalCode: nPostalCode,
                    Type: addressType || 'House',
                    StreetName: streetName,
                    StreetNumber: streetNumber,
                    UnitNumber: apt || '',
                },
                Coupons: [],
                CustomerID: '',
                Email: '',
                Extension: '',
                FirstName: '',
                LastName: '',
                LanguageCode: 'en',
                OrderChannel: 'OLO',
                OrderID: '',
                OrderMethod: 'Web',
                OrderTaker: null,
                Payments: [],
                Phone: '',
                PhonePrefix: '',
                Products: products,
                ServiceMethod: 'Delivery',
                SourceOrganizationURI: 'order.dominos.com',
                StoreID: cart.storeId,
                Tags: {},
                Version: '1.0',
                NoCombine: true,
                Partners: {},
                HotspotsLite: false,
                OrderInfoCollection: [],
                metaData: null,
            },
        };

        let orderId = '';
        for (let vStep = 0; vStep < 2; vStep++) {
            const vResult = await dominosRequest(
                { hostname: dominosHost, path: '/power/validate-order', method: 'POST' },
                JSON.stringify(validatePayload)
            ).catch(() => null);
            if (!vResult || vResult.status < 200 || vResult.status >= 300) {
                res.writeHead(302, {
                    Location: buildRedirect('/food/checkout', [
                        'error=' + encodeURIComponent('Failed to connect to Dominos.'),
                    ]),
                });
                return res.end();
            }
            orderId = vResult.data?.Order?.OrderID || orderId;
            validatePayload.Order.OrderID = orderId;
        }

        validatePayload.Order.metaData = { orderFunnel: 'payments' };
        const priceResult = await dominosRequest(
            { hostname: dominosHost, path: '/power/price-order', method: 'POST' },
            JSON.stringify(validatePayload)
        ).catch(() => null);
        if (
            !priceResult ||
            priceResult.status < 200 ||
            priceResult.status >= 300 ||
            (priceResult.data?.Status !== 0 && priceResult.data?.Status !== 1)
        ) {
            const msg =
                priceResult?.data?.StatusItems?.[0]?.Message ||
                'Failed to price order. Check your address and store.';
            res.writeHead(302, {
                Location: buildRedirect('/food/checkout', ['error=' + encodeURIComponent(msg)]),
            });
            return res.end();
        }

        orderId = priceResult.data.Order?.OrderID || orderId;
        const pricedTotal = priceResult.data.Order?.Amounts?.Customer ?? null;

        const placePayload = {
            Status: 0,
            Order: {
                Address: {
                    Street: nStreet,
                    City: nCity,
                    Region: region,
                    PostalCode: nPostalCode,
                    Type: addressType || 'House',
                    StreetName: streetName,
                    StreetNumber: streetNumber,
                    UnitNumber: apt || '',
                    DeliveryInstructions: '',
                },
                Channel: 'Mobile',
                Coupons: [],
                CustomerID: '',
                DataWarehouseUpdate: false,
                Email: email,
                EstimatedWaitMinutes: '21-31',
                Extension: '',
                FirstName: firstName,
                HotspotsLite: true,
                LanguageCode: 'en',
                LastName: lastName,
                NoCombine: true,
                OrderChannel: 'OLO',
                OrderID: orderId,
                OrderInfoCollection: [],
                OrderMethod: 'Web',
                OrderTaker: 'power',
                OrderTakeSeconds: 0,
                Partners: {},
                Payments: [
                    { Type: 'Cash', Amount: pricedTotal !== null ? pricedTotal : cartTotal },
                ],
                PendingOrder: false,
                Phone: phone,
                PhonePrefix: '',
                Platform: 'androidNativeApp',
                PlaceOrderMs: 0,
                PriceOrderMs: 0,
                Products: products,
                ServiceMethod: 'Delivery',
                SourceOrganizationURI:
                    cart.country === 'ca' ? 'order.dominos.com' : 'android.dominos.com',
                Status: 0,
                StoreID: cart.storeId,
                Tags: {},
                TestOrderFlagCCProcess: false,
                Version: '1.0',
                metaData: { PiePassPickup: false, calculateNutrition: true, contactless: false },
            },
        };

        const orderResult = await dominosRequest(
            {
                hostname: dominosHost,
                path: '/power/place-order',
                method: 'POST',
                headers: { 'DPZ-Source': 'DSSPlaceOrder' },
            },
            JSON.stringify(placePayload)
        ).catch(() => null);
        if (
            !orderResult ||
            orderResult.status < 200 ||
            orderResult.status >= 300 ||
            (orderResult.data?.Status !== 0 &&
                orderResult.data?.Status !== 1 &&
                !orderResult.data?.StatusItems?.some((s) => s.Code === 'Failure'))
        ) {
            const msg =
                orderResult?.data?.Order?.StatusItems?.find((s) => s.Message)?.Message ||
                'Order failed. Please try again.';
            res.writeHead(302, {
                Location: buildRedirect('/food/checkout', ['error=' + encodeURIComponent(msg)]),
            });
            return res.end();
        }

        const storeName = orderResult.data.Order?.StoreAddress
            ? `${orderResult.data.Order.StoreAddress.City || nCity} Store #${cart.storeId}`
            : `Store #${cart.storeId}`;
        const finalTotal =
            pricedTotal !== null
                ? pricedTotal
                : cartTotal > 0
                  ? cartTotal
                  : parseFloat(orderResult.data.Order?.Amounts?.Payment || 0);

        auth.dbQueryRun(
            'INSERT INTO pizza_orders (discordID, store_id, store_name, items_json, total, timestamp) VALUES (?,?,?,?,?,?)',
            [
                discordID,
                cart.storeId,
                storeName,
                JSON.stringify(
                    cart.items.map((i) => ({
                        code: i.code,
                        name: i.name,
                        qty: i.qty,
                        price: i.price,
                    }))
                ),
                finalTotal,
                unixTime(),
            ]
        );
        auth.dbQueryRun('DELETE FROM pizza_verifications WHERE discordID=?', [discordID]);

        res.writeHead(302, {
            Location: buildRedirect('/food/receipts', ['placed=1']),
            'Set-Cookie': [
                clearCartCookieHeader(),
                'pizzaCheckout=; path=/food; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT',
            ],
        });
        return res.end();
    }

    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(getTemplate('not-found', 'misc'));
};

// =============================================================================
// Food image proxy
// =============================================================================
exports.foodProxy = async function (req, res) {
    const parsedurl = new URL(req.url, 'http://localhost');
    const imagePath = parsedurl.pathname
        .replace(/^\/foodProxy\//, '')
        .replace(/[^a-zA-Z0-9_.\-]/g, '');

    if (!imagePath) {
        res.writeHead(404);
        return res.end();
    }

    const imageUrl = `https://cache.dominos.com/olo/6_92_1/assets/build/market/US/_en/images/img/products/larges/${imagePath}`;

    try {
        await new Promise((resolve, reject) => {
            https
                .get(imageUrl, { headers: { 'User-Agent': 'Dominos API Wrapper' } }, (proxyRes) => {
                    const chunks = [];
                    proxyRes.on('data', (chunk) => chunks.push(chunk));
                    proxyRes.on('end', () => {
                        const ct = proxyRes.headers['content-type'] || 'image/jpeg';
                        res.writeHead(proxyRes.statusCode === 200 ? 200 : 404, {
                            'Content-Type': ct,
                            'Cache-Control': 'public, max-age=86400',
                        });
                        res.end(Buffer.concat(chunks));
                        resolve();
                    });
                    proxyRes.on('error', reject);
                })
                .on('error', reject);
        });
    } catch (e) {
        console.error('foodProxy error:', e.message);
        if (!res.headersSent) {
            res.writeHead(404);
            res.end();
        }
    }
};
