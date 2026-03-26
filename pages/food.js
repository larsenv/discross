'use strict';
const fs = require('fs');
const https = require('https');
const escape = require('escape-html');
const crypto = require('crypto');

const auth = require('../authentication.js');
const notFound = require('./notFound.js');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone } = require('../timezoneUtils');
const { getPageThemeAttr } = require('./utils.js');

const API_TIMEOUT_MS = 15000;
const VERIFICATION_CODE_MIN = 100000;
const VERIFICATION_CODE_MAX = 1000000;

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}

// Format a Unix timestamp using the user's detected timezone (IP-based)
function formatTimestamp(ts, req) {
  const timezone = req ? getTimezoneFromIP(getClientIP(req)) : null;
  return formatDateWithTimezone(new Date(ts * 1000), timezone);
}

// --- Template loading ---
const commonHead = fs.readFileSync('pages/templates/partials/head.html', 'utf-8');

function loadTemplate(name) {
  return fs
    .readFileSync(`pages/templates/food/${name}`, 'utf-8')
    .split('{$COMMON_HEAD}')
    .join(commonHead);
}

let _templates = null;
function getTemplates() {
  if (!_templates) {
    _templates = {
      index: loadTemplate('index.html'),
      storeSearch: loadTemplate('store-search.html'),
      menu: loadTemplate('menu.html'),
      cart: loadTemplate('cart.html'),
      checkout: loadTemplate('checkout.html'),
      verify: loadTemplate('verify.html'),
      track: loadTemplate('track.html'),
      receipts: loadTemplate('receipts.html'),
      customize: loadTemplate('customize.html'),
    };
  }
  return _templates;
}

// --- Theme helper ---
// --- Cart cookie helpers ---
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
    // Fallback: URL param for browsers that don't save cookies (e.g. Wii U)
    const urlCart = new URL(req.url, 'http://localhost').searchParams.get('pizzaCart');
    if (urlCart) {
      const decoded = Buffer.from(decodeURIComponent(urlCart), 'base64').toString('utf-8');
      const cart = JSON.parse(decoded);
      if (!cart.items) cart.items = [];
      return cart;
    }
  } catch (e) {
    console.error('getCart: failed to parse cart cookie:', e);
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
    options.headers = options.headers || {};
    const host = options.hostname || 'order.dominos.com';
    const market = host.endsWith('.ca') ? 'CANADA' : 'UNITED_STATES';
    // Match WiiLink headers for proper Dominos API authentication
    if (body) {
      options.headers['User-Agent'] =
        'DominosAndroid/11.5.0 (Android 11; OnePlus/ONEPLUS A3003; en)';
      options.headers['Accept'] = 'text/plain, application/json, application/json, text/plain, */*';
      options.headers['Accept-Language'] = 'en-US,en;q=0.5';
      options.headers['Content-Type'] = 'application/json; charset=utf-8';
      options.headers['Content-Length'] = Buffer.byteLength(body);
      options.headers['Origin'] = `https://${host}`;
      options.headers['Referer'] = `https://${host}/assets/build/xdomain/proxy.html`;
      options.headers['Connection'] = 'close';
    } else {
      options.headers['User-Agent'] =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';
      options.headers['Accept'] = 'application/json, text/javascript, */*; q=0.01';
      if (!options.headers['Referer']) {
        options.headers['Referer'] = `https://${host}/`;
      }
    }
    options.headers['Market'] = market;
    options.headers['DPZ-Language'] = 'en';
    options.headers['DPZ-Market'] = market;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.setTimeout(API_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- DB setup ---
function setup() {
  auth.dbQueryRun(`CREATE TABLE IF NOT EXISTS pizza_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discordID TEXT,
    store_id TEXT,
    store_name TEXT,
    items_json TEXT,
    total REAL,
    timestamp INTEGER
  )`);
  auth.dbQueryRun(`CREATE TABLE IF NOT EXISTS pizza_verifications (
    discordID TEXT PRIMARY KEY,
    code TEXT,
    cart_json TEXT,
    expires INTEGER
  )`);
}
setup();

// --- Determine if HTTPS is in use (mirrors auth.js logic) ---
function isSecure(req) {
  return req.socket && req.socket.encrypted;
}

// --- Parse topping options from a POST request params ---
// Expects params like topping_P=1 (amount: 0=none, 0.5=light, 1=normal, 1.5=extra),
// and sauce_X=1, sauce_Xm=0, etc. (same amount-based format as toppings).
// If a default_options JSON param is present, codes in the defaults that the user
// sets to "0" are included as {"1/1":"0"} (explicit removal) so Dominos knows to
// remove that topping rather than re-adding the product default.
function parseOptions(params) {
  const defaultsMap = (() => {
    try {
      return params.default_options ? JSON.parse(params.default_options) : {};
    } catch (e) {
      console.warn('[parseOptions] Failed to parse default_options:', e.message);
      return {};
    }
  })();

  const options = {};
  const hasFormFields = Object.keys(params).some(
    (key) => key.startsWith('topping_') || key.startsWith('sauce_')
  );
  for (const key of Object.keys(params)) {
    const isTopping = key.startsWith('topping_');
    const isSauce = key.startsWith('sauce_');
    if (isTopping || isSauce) {
      const prefix = isTopping ? 'topping_' : 'sauce_';
      const code = key.slice(prefix.length).replace(/[^a-zA-Z0-9]/g, '');
      const amount = params[key];
      if (code && amount && /^[0-9.]+$/.test(amount)) {
        if (amount !== '0') {
          options[code] = { '1/1': amount };
        } else if (code in defaultsMap) {
          // User explicitly removed a default topping — include as "0" so Dominos removes it
          options[code] = { '1/1': '0' };
        }
        // amount='0' and not in defaults: skip (topping was never on this pizza)
      }
    }
  }

  // No interactive topping/sauce fields — specialty pizza added directly from customize page.
  // Per WiiLink: use Tags.DefaultToppings (passed via default_options) so the full recipe
  // (sauce + cheese + toppings) is sent to Dominos, preventing OptionExclusivityViolated.
  if (!hasFormFields && Object.keys(defaultsMap).length > 0) {
    for (const [code, amount] of Object.entries(defaultsMap)) {
      const amtNum = parseFloat(String(amount));
      if (!isNaN(amtNum) && isFinite(amtNum) && amtNum > 0) {
        options[code] = { '1/1': String(amount) };
      }
    }
  }

  return options;
}

// --- Build a topping code→entry dict from menuData ---
// The Dominos API returns Toppings nested by ProductType: { Pizza: {C: {...}, X: {...}}, Wings: {...} }.
// Per WiiLink/Demae-Dominos: use ONLY the exact productType category.
// Returns empty dict if productType has no matching Toppings category.
function buildToppingDict(menuData, productType) {
  const rawToppings = menuData.Toppings || {};
  if (productType && rawToppings[productType] && typeof rawToppings[productType] === 'object') {
    return rawToppings[productType];
  }
  return {};
}

// --- Parse AvailableToppings string into code set and per-code portion options ---
// AvailableToppings = "X=0:0.5:1:1.5,Xm=0:0.5:1:1.5,C=0:0.5:1:1.5,P=1/1"
// Returns { codeSet: Set<string>, portions: Map<string, string[]> }
function parseAvailableToppings(rawAvailToppings) {
  const codeSet = new Set();
  const portions = new Map();
  const entries = Array.isArray(rawAvailToppings)
    ? rawAvailToppings.map(String)
    : rawAvailToppings
      ? String(rawAvailToppings).split(',')
      : [];
  for (const entry of entries) {
    const eqIdx = entry.indexOf('=');
    const code = (eqIdx === -1 ? entry : entry.slice(0, eqIdx)).trim();
    if (!code) continue;
    codeSet.add(code);
    if (eqIdx !== -1) {
      const portionStr = entry.slice(eqIdx + 1);
      // Support "0:0.5:1:1.5" (colon-separated) or "1/1" (legacy fixed)
      const portionList =
        portionStr.indexOf(':') !== -1
          ? portionStr
              .split(':')
              .map((p) => p.trim())
              .filter(Boolean)
          : [portionStr.split('/')[0].trim()].filter(Boolean);
      if (portionList.length > 0) {
        portions.set(code, portionList);
      }
    }
  }
  return { codeSet, portions };
}

// --- Classify toppings from a toppingDict, filtered by available code set ---
// Per WiiLink: iterate over toppingDict, skip codes not in availableCodes.
// Sauce = Tags.Sauce only (WiiLink approach, avoids wrong classification for non-pizza items).
// Returns { sauces: [{code, name}], toppings: [{code, name}] }
function classifyToppings(toppingDict, codeSet) {
  return Object.keys(toppingDict).reduce(
    (acc, code) => {
      if (!codeSet.has(code)) return acc;
      const t = toppingDict[code];
      if (!t || typeof t !== 'object') return acc;
      const name = (t.Name && String(t.Name).trim()) || code;
      // WiiLink: only classify as sauce if Tags.Sauce is set
      if (!!(t.Tags || {}).Sauce) {
        acc.sauces.push({ code, name });
      } else {
        acc.toppings.push({ code, name });
      }
      return acc;
    },
    { sauces: [], toppings: [] }
  );
}

// =============================================================================
// GET handler
// =============================================================================
exports.handleGet = async function (bot, req, res, discordID) {
  const parsedurl = new URL(req.url, 'http://localhost');
  // Normalize: strip leading /food/ and trailing /
  const subpath = parsedurl.pathname.replace(/^\/food\/?/, '').replace(/\/$/, '');
  const theme = getPageThemeAttr(req);
  const templates = getTemplates();

  // Session + cart/checkout state: Wii U and other browsers without cookie support
  // pass state as URL params. Forward in all links and form hidden fields.
  const urlSessionID = parsedurl.searchParams.get('sessionID') || '';
  const urlCartEncoded = parsedurl.searchParams.get('pizzaCart') || '';
  const urlCheckoutEncoded = parsedurl.searchParams.get('pizzaCheckout') || '';
  // Combined persistent params (session + cart + checkout) for Wii U URL-based state
  const _pParts = [];
  if (urlSessionID) _pParts.push('sessionID=' + encodeURIComponent(urlSessionID));
  if (urlCartEncoded) _pParts.push('pizzaCart=' + encodeURIComponent(urlCartEncoded));
  if (urlCheckoutEncoded) _pParts.push('pizzaCheckout=' + encodeURIComponent(urlCheckoutEncoded));
  const persistentParam = _pParts.length ? '?' + _pParts.join('&') : '';
  const persistentSuffix = _pParts.length ? '&' + _pParts.join('&') : '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';
  const sessionIdSuffix = urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '';

  function applySessionToTemplate(html) {
    html = strReplace(html, '{$SESSION_PARAM}', persistentParam);
    html = strReplace(html, '{$SESSION_ID}', escape(urlSessionID));
    html = strReplace(html, '{$SESSION_ID_SUFFIX}', persistentSuffix);
    return html;
  }

  // --- Store finder ---
  if (subpath === '' || subpath === 'index' || subpath === 'index.html') {
    const cart = getCart(req);
    const cartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const html = applySessionToTemplate(
      strReplace(
        strReplace(templates.index, '{$WHITE_THEME_ENABLED}', theme),
        '{$CART_COUNT}',
        String(cartCount)
      )
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // --- Store search (server-rendered HTML) ---
  if (subpath === 'store-search') {
    const address = parsedurl.searchParams.get('address') || '';
    const cart = getCart(req);
    const cartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const withTheme = strReplace(templates.storeSearch, '{$WHITE_THEME_ENABLED}', theme);
    const withAddress = strReplace(withTheme, '{$SEARCH_ADDRESS}', escape(address));
    const baseHtml = strReplace(withAddress, '{$CART_COUNT}', String(cartCount));

    if (!address) {
      const html = applySessionToTemplate(strReplace(baseHtml, '{$STORE_RESULTS}', ''));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    const storesHtml = await (async () => {
      try {
        // Try US API first; fall back to Canada API if no results
        let stores = [];
        let country = 'us';
        const trySearch = async (hostname) => {
          const r = await dominosRequest({
            hostname,
            path: `/power/store-locator?type=Delivery&c=${encodeURIComponent(address)}&s=&a=`,
            method: 'GET',
          });
          return r.status >= 200 && r.status < 300 && r.data && r.data.Stores ? r.data.Stores : [];
        };
        stores = await trySearch('order.dominos.com');
        if (stores.length === 0) {
          stores = await trySearch('order.dominos.ca');
          if (stores.length > 0) country = 'ca';
        }
        if (stores.length > 0) {
          const header = `<br><font size="4" face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Nearby Stores</b></font><br><br>`;
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
                .join('<br>');
              return `<div class="food-store-card">
  <div class="food-store-name">Store #${storeId} ${city}</div>
  <div class="food-store-addr">${addrLines}</div>
  ${wait ? `<div class="food-store-wait">Est. delivery: ${wait}</div>` : ''}
  <a href="/food/menu?store=${encodeURIComponent(s.StoreID || '')}&amp;country=${country}${persistentSuffix}" class="food-btn" style="display:inline-block;margin-top:8px">View Menu</a>
</div>`;
            })
            .join('');
          return header + cards;
        } else {
          return '<div class="food-error">No stores found near that address. Try a different zip code or city name.</div>';
        }
      } catch (e) {
        console.error('Dominos store-search error:', e);
        return '<div class="food-error">Error searching for stores. Please try again.</div>';
      }
    })();

    const html = applySessionToTemplate(strReplace(baseHtml, '{$STORE_RESULTS}', storesHtml));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // --- Menu ---
  if (subpath === 'menu') {
    const storeId = (parsedurl.searchParams.get('store') || '').replace(/[^0-9]/g, '');
    const category = parsedurl.searchParams.get('category') || '';
    const country = parsedurl.searchParams.get('country') === 'ca' ? 'ca' : 'us';
    const dominosHost = country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com';

    if (!storeId) {
      res.writeHead(302, { Location: '/food/' + persistentParam });
      return res.end();
    }

    const menuData = await dominosRequest({
      hostname: dominosHost,
      path: `/power/store/${encodeURIComponent(storeId)}/menu?lang=en&structured=true`,
      method: 'GET',
    })
      .then((result) => (result.status >= 200 && result.status < 300 ? result.data : null))
      .catch((e) => {
        console.error('Dominos menu fetch error:', e);
        return null;
      });

    const cart = getCart(req);
    const cartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const withThemeMenu = strReplace(templates.menu, '{$WHITE_THEME_ENABLED}', theme);
    const withStoreIdMenu = strReplace(withThemeMenu, '{$STORE_ID}', escape(storeId));
    const withSelCatMenu = strReplace(withStoreIdMenu, '{$SELECTED_CATEGORY}', escape(category));
    let html = strReplace(withSelCatMenu, '{$CART_COUNT}', String(cartCount));

    if (menuData) {
      // Domino's structured menu: Categorization.Food.Categories[] is the array of food categories
      const categorization = menuData.Categorization || {};
      const foodSection = categorization.Food || {};
      const allCategories = foodSection.Categories || [];

      // Build a code->category map
      const categoryByCode = Object.fromEntries(
        allCategories.filter((cat) => cat?.Code).map((cat) => [cat.Code, cat])
      );

      const selectedCat = category || (allCategories[0] && allCategories[0].Code) || '';

      // Category tabs
      const catTabs = allCategories
        .filter((cat) => cat && cat.Code)
        .map((cat) => {
          const active = selectedCat === cat.Code ? ' food-tab-active' : '';
          return `<a href="/food/menu?store=${encodeURIComponent(storeId)}&amp;category=${encodeURIComponent(cat.Code)}&amp;country=${country}${persistentSuffix}" class="food-tab${active}">${escape(cat.Name || cat.Code)}</a>`;
        })
        .join('');
      html = strReplace(html, '{$CATEGORY_TABS}', catTabs);

      // Recursively collect all product codes, handling deeply nested Categories (e.g. Pizza)
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

      // Build a map of variant code → qty already in cart
      const cartQtyByVariant = (cart.items || []).reduce((acc, item) => {
        acc[item.code] = (acc[item.code] || 0) + (item.qty || 1);
        return acc;
      }, {});
      // Also build a map of product code → total qty in cart (across all variants)
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

          // Pick lowest-price variant
          const variantPrices = p.Variants?.length
            ? p.Variants.map((v) => parseFloat((variants[v] || {}).Price || 0)).filter((v) => v > 0)
            : [];
          const price = variantPrices.length ? `$${Math.min(...variantPrices).toFixed(2)}` : '';
          const hasMultipleVariants = p.Variants && p.Variants.length > 1;

          const safeCode = escape(code);
          const safeName = escape(p.Name || code);
          const safePrice = escape(price.replace('$', '') || '0');
          const safeStoreId = escape(storeId);
          const safeRedirect = escape(req.url);
          // Total qty in cart for this product (all sizes/variants)
          const inCart = cartQtyByProduct[code] || 0;

          // Items with multiple size variants get a "Customize" button linking to the size picker
          const actionHtml = (() => {
            if (hasMultipleVariants) {
              const customizeUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(code)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(req.url)}${persistentSuffix}`;
              const btnLabel = inCart > 0 ? `Customize (${inCart} in cart)` : 'Customize / Add';
              return `<a href="${customizeUrl}" class="food-btn food-btn-sm">${escape(btnLabel)}</a>`;
            }
            const singleVariant = p.Variants?.[0] || code;
            const inCartSingle = cartQtyByVariant[singleVariant] || 0;
            const btnLabel =
              inCartSingle > 0 ? `Add to Cart (${inCartSingle} in cart)` : 'Add to Cart';
            return `<form method="POST" action="/food/cart/add${persistentParam}">
      <input type="hidden" name="storeId" value="${safeStoreId}">
      <input type="hidden" name="country" value="${escape(country)}">
      <input type="hidden" name="code" value="${safeCode}">
      <input type="hidden" name="name" value="${safeName}">
      <input type="hidden" name="price" value="${safePrice}">
      <input type="hidden" name="redirect" value="${safeRedirect}">
      <button type="submit" class="food-btn food-btn-sm">${escape(btnLabel)}</button>
    </form>`;
          })();

          return [
            `<div class="food-item-card">
  <img src="/foodProxy/${encodeURIComponent((p.ImageCode || code).replace(/[^a-zA-Z0-9_-]/g, ''))}.jpg" alt="${name}" class="food-item-img" onerror="this.style.display='none'">
  <div class="food-item-info">
    <div class="food-item-name">${name}</div>
    <div class="food-item-desc">${desc}</div>
    <div class="food-item-price">${escape(price)}</div>
    ${actionHtml}
  </div>
</div>`,
          ];
        })
        .join('');
      const itemsHtml =
        rawItemsHtml ||
        '<font face="\'rodin\', Arial, Helvetica, sans-serif" color="#b5bac1">No items found in this category.</font>';
      html = strReplace(html, '{$MENU_ITEMS}', itemsHtml);
    } else {
      html = strReplace(html, '{$CATEGORY_TABS}', '');
      html = strReplace(
        html,
        '{$MENU_ITEMS}',
        '<div class="food-card"><font face="\'rodin\', Arial, Helvetica, sans-serif" color="#f28b8c">Could not load menu. The store may be temporarily unavailable. Please try again or choose a different store.</font></div>'
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    html = applySessionToTemplate(html);
    return res.end(html);
  }

  // --- Cart view ---
  if (subpath === 'cart') {
    const cart = getCart(req);
    const cartPageCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const items = cart.items || [];
    const total = items.reduce(
      (sum, item) => sum + parseFloat(item.price || 0) * (item.qty || 1),
      0
    );
    const itemsHtml =
      items.length > 0
        ? items
            .map((item, i) => {
              const price = parseFloat(item.price || 0);
              const qty = item.qty || 1;
              return `<tr>
  <td class="food-cart-name">${escape(item.name || item.code)}</td>
  <td class="food-cart-qty">${escape(String(qty))}</td>
  <td class="food-cart-price">$${(price * qty).toFixed(2)}</td>
  <td>
    <form method="POST" action="/food/cart/remove${persistentParam}" style="display:inline">
      <input type="hidden" name="index" value="${i}">
      <button type="submit" class="food-btn food-btn-danger">Remove</button>
    </form>
  </td>
</tr>`;
            })
            .join('')
        : '<tr><td colspan="4" style="font-family:\'rodin\',Arial,Helvetica,sans-serif;color:#b5bac1;padding:16px">Your cart is empty.</td></tr>';

    const withThemeCart = strReplace(templates.cart, '{$WHITE_THEME_ENABLED}', theme);
    const withCartCount = strReplace(withThemeCart, '{$CART_COUNT}', String(cartPageCount));
    const withItems = strReplace(withCartCount, '{$CART_ITEMS}', itemsHtml);
    const withTotal = strReplace(withItems, '{$CART_TOTAL}', total.toFixed(2));
    const withStoreId = strReplace(withTotal, '{$STORE_ID}', escape(cart.storeId || ''));
    const withHasItems = strReplace(
      withStoreId,
      '{$HAS_ITEMS}',
      items.length > 0 ? '' : 'display:none;'
    );
    const html = applySessionToTemplate(withHasItems);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // --- Checkout form ---
  if (subpath === 'checkout') {
    const cart = getCart(req);
    if (!cart.items || cart.items.length === 0) {
      res.writeHead(302, { Location: '/food/cart' + persistentParam });
      return res.end();
    }

    const dominosHost = cart.country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com';
    const checkoutCartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const errorText = parsedurl.searchParams.get('error') || '';

    // Fetch store address to display to user
    const storeAddrHtml = cart.storeId
      ? await dominosRequest({
          hostname: dominosHost,
          path: `/power/store/${encodeURIComponent(cart.storeId)}/profile`,
          method: 'GET',
        })
          .then((profileResult) => {
            if (profileResult.status >= 200 && profileResult.status < 300 && profileResult.data) {
              const p = profileResult.data;
              const addr = [p.StreetName || p.AddressDescription, p.City, p.Region, p.PostalCode]
                .filter(Boolean)
                .join(', ');
              if (addr) {
                return `<div style="margin-top:12px;padding:10px;background:#2a2d31;border-radius:6px;">
  <font face="'rodin', Arial, Helvetica, sans-serif" color="#b5bac1" size="3">
    Delivering from: Store #${escape(cart.storeId)} ${escape(addr)}
  </font>
</div>`;
              }
            }
            return '';
          })
          .catch((e) => {
            console.error('Dominos store profile fetch error (non-critical):', e);
            return '';
          })
      : '';

    const total = cart.items.reduce(
      (sum, item) => sum + parseFloat(item.price || 0) * (item.qty || 1),
      0
    );
    const itemsSummary = cart.items
      .map((item) => {
        const p = parseFloat(item.price || 0);
        const qty = item.qty || 1;
        return `<div class="food-summary-item">
  <span>${escape(item.name || item.code)} ×${qty}</span>
  <span>$${(p * qty).toFixed(2)}</span>
</div>`;
      })
      .join('');

    const withThemeCheckout = strReplace(templates.checkout, '{$WHITE_THEME_ENABLED}', theme);
    const withCheckoutCount = strReplace(
      withThemeCheckout,
      '{$CART_COUNT}',
      String(checkoutCartCount)
    );
    const withError = strReplace(
      withCheckoutCount,
      '{$ERROR}',
      errorText ? `<div class="food-error">${escape(errorText)}</div>` : ''
    );
    const withStoreAddress = strReplace(withError, '{$STORE_ADDRESS}', storeAddrHtml);
    const withSummary = strReplace(withStoreAddress, '{$ORDER_SUMMARY}', itemsSummary);
    const withOrderTotal = strReplace(withSummary, '{$ORDER_TOTAL}', total.toFixed(2));
    const html = applySessionToTemplate(withOrderTotal);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // --- Verify code page ---
  if (subpath === 'verify') {
    const verifyCart = getCart(req);
    const verifyCartCount = (verifyCart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const errorText = parsedurl.searchParams.get('error') || '';
    const html = applySessionToTemplate(
      strReplace(
        strReplace(
          strReplace(templates.verify, '{$WHITE_THEME_ENABLED}', theme),
          '{$CART_COUNT}',
          String(verifyCartCount)
        ),
        '{$ERROR}',
        errorText ? `<div class="food-error">${escape(errorText)}</div>` : ''
      )
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // --- Tracker page ---
  if (subpath === 'track') {
    const trackCart = getCart(req);
    const trackCartCount = (trackCart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const withTheme = strReplace(templates.track, '{$WHITE_THEME_ENABLED}', theme);
    const withCartCount = strReplace(withTheme, '{$CART_COUNT}', String(trackCartCount));
    // Show the user's most recent order info
    const lastOrder = auth.dbQuerySingle(
      'SELECT store_name, timestamp FROM pizza_orders WHERE discordID=? ORDER BY timestamp DESC LIMIT 1',
      [discordID]
    );
    const orderInfo = lastOrder?.timestamp
      ? `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd">
        <b>Most recent order:</b> ${escape(lastOrder.store_name || 'Unknown store')}<br>
        <b>Placed:</b> ${escape(formatTimestamp(lastOrder.timestamp, req))}
      </font>`
      : `<font face="'rodin', Arial, Helvetica, sans-serif" color="#b5bac1">No recent orders found.</font>`;
    const html = applySessionToTemplate(strReplace(withCartCount, '{$ORDER_INFO}', orderInfo));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // --- Receipts / order history ---
  if (subpath === 'receipts') {
    const receiptCart = getCart(req);
    const receiptCartCount = (receiptCart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const orders = auth.dbQueryAll(
      'SELECT * FROM pizza_orders WHERE discordID=? ORDER BY timestamp DESC',
      [discordID]
    );
    const withTheme = strReplace(templates.receipts, '{$WHITE_THEME_ENABLED}', theme);
    const withCartCount = strReplace(withTheme, '{$CART_COUNT}', String(receiptCartCount));

    const justPlaced = parsedurl.searchParams.get('placed') === '1';
    const noticeHtml = justPlaced
      ? `<div class="food-success-box"><font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Your order has been placed!</b> Your name, address, phone, and email were used only to send the order and have not been saved to our servers. Only your items, total, and store are stored for your receipt.</font></div>`
      : '';
    const withNotice = strReplace(withCartCount, '{$NOTICE}', noticeHtml);

    const ordersHtml =
      orders && orders.length > 0
        ? orders
            .map((order) => {
              const date = formatTimestamp(order.timestamp, req);
              const items = (() => {
                try {
                  return JSON.parse(order.items_json);
                } catch (e) {
                  console.warn(
                    '[orders] Failed to parse items_json for order:',
                    order.id,
                    e.message
                  );
                  return [];
                }
              })();
              const itemsList = items
                .map((i) => `${escape(i.name || i.code)} ×${i.qty || 1}`)
                .join(', ');
              return `<div class="food-receipt-card">
  <div class="food-receipt-header">
    <span class="food-receipt-store">${escape(order.store_name || `Store #${order.store_id}`)}</span>
    <span class="food-receipt-date">${escape(date)}</span>
  </div>
  <div class="food-receipt-items">${itemsList || '<em>No item details</em>'}</div>
  <div class="food-receipt-footer">
    <span class="food-receipt-total">Total: $${parseFloat(order.total || 0).toFixed(2)}</span>
    <a href="/food/track${persistentParam}" class="food-btn food-btn-sm">Track</a>
  </div>
</div>`;
            })
            .join('')
        : '<font face="\'rodin\', Arial, Helvetica, sans-serif" color="#b5bac1">No orders yet.</font>';
    const html = applySessionToTemplate(strReplace(withNotice, '{$ORDERS}', ordersHtml));

    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // --- Cancel order (clears pending verification and checkout cookie) ---
  if (subpath === 'cancel-order') {
    auth.dbQueryRun('DELETE FROM pizza_verifications WHERE discordID=?', [discordID]);
    res.writeHead(302, {
      Location: '/food/cart' + persistentParam,
      'Set-Cookie': 'pizzaCheckout=; path=/food; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT',
    });
    return res.end();
  }

  // --- Customize item (size/variant picker + toppings) ---
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
      res.writeHead(302, { Location: '/food/' + persistentParam });
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
        console.error('Dominos menu fetch error (customize):', e);
        return null;
      });

    const custCart = getCart(req);
    const custCartCount = (custCart.items || []).reduce((s, i) => s + (i.qty || 1), 0);
    const custTheme = strReplace(templates.customize, '{$WHITE_THEME_ENABLED}', theme);
    const custWithCount = strReplace(custTheme, '{$CART_COUNT}', String(custCartCount));
    const custWithStore = strReplace(custWithCount, '{$STORE_ID}', escape(storeId));
    const custWithCountry = strReplace(custWithStore, '{$COUNTRY}', escape(country));
    let html = strReplace(custWithCountry, '{$BACK_URL}', escape(backUrl));

    if (menuData) {
      const products = menuData.Products || {};
      const variants = menuData.Variants || {};
      const product = products[productCode];
      if (!product) {
        res.writeHead(302, { Location: backUrl });
        return res.end();
      }

      const pName = escape(product.Name || productCode);
      const pDesc = escape((product.Description || '').slice(0, 200));

      html = strReplace(html, '{$PRODUCT_NAME}', pName);
      html = strReplace(html, '{$PRODUCT_DESC}', pDesc);

      const productVariants = product.Variants || [];

      if (!variantCode) {
        // Single size — redirect directly to toppings step (no size picker needed)
        if (productVariants.length === 1) {
          const vCode = productVariants[0];
          const redirectUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(productCode)}&variant=${encodeURIComponent(vCode)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(backUrl)}${persistentSuffix}`;
          res.writeHead(302, { Location: redirectUrl });
          return res.end();
        }

        // Step 1: Show size picker
        const sizeOptionsHtml =
          productVariants.length > 1
            ? `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Choose a size:</b></font><br><br>` +
              productVariants
                .filter((vCode) => variants[vCode])
                .map((vCode) => {
                  const v = variants[vCode];
                  const vPrice = parseFloat(v.Price || 0);
                  const vSizeName = escape(v.Name || vCode);
                  const customizeUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(productCode)}&variant=${encodeURIComponent(vCode)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(backUrl)}${persistentSuffix}`;
                  return `<div class="food-size-option">
  <a href="${customizeUrl}" class="food-size-link">
    ${vSizeName}${vPrice > 0 ? `<span class="food-size-price">$${vPrice.toFixed(2)}</span>` : ''}
  </a>
</div>`;
                })
                .join('')
            : `<form method="POST" action="/food/cart/add${persistentParam}">
  <input type="hidden" name="storeId" value="${escape(storeId)}">
  <input type="hidden" name="country" value="${escape(country)}">
  <input type="hidden" name="code" value="${escape(productCode)}">
  <input type="hidden" name="name" value="${pName}">
  <input type="hidden" name="price" value="0">
  <input type="hidden" name="redirect" value="${escape(backUrl)}">
  <button type="submit" class="food-btn food-btn-large">Add to Cart</button>
  &#160;&#160;
  <a href="${escape(backUrl)}" class="food-btn food-btn-secondary">Cancel</a>
</form>`;
        html = strReplace(html, '{$SIZE_OPTIONS}', sizeOptionsHtml);
        html = strReplace(html, '{$TOPPINGS_SECTION}', '');
      } else {
        // Step 2: Show toppings/sauce for selected variant
        const v = variants[variantCode];
        if (!v) {
          res.writeHead(302, { Location: backUrl });
          return res.end();
        }
        const vPrice = parseFloat(v.Price || 0);
        const vFullName = escape(v.Name || product.Name || productCode);

        // Show selected size confirmation
        const sizeHtml = `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd">
  <b>Size:</b> ${escape(v.Name || variantCode)}${vPrice > 0 ? ` - $${vPrice.toFixed(2)}` : ''}
  &#160;<a href="/food/customize?store=${encodeURIComponent(storeId)}&amp;code=${encodeURIComponent(productCode)}&amp;country=${encodeURIComponent(country)}&amp;back=${encodeURIComponent(backUrl)}${persistentSuffix.replace(/&/g, '&amp;')}" class="food-back-link" style="font-size:0.85rem">Change size</a>
</font>`;
        html = strReplace(html, '{$SIZE_OPTIONS}', sizeHtml);

        // Build toppings/sauce form
        // Get the product type for scoped topping lookup (e.g. "Pizza", "Wings")
        // Per WiiLink/Demae-Dominos: only use the exact Toppings[productType] category
        const productType = product.ProductType || '';
        const toppingDict = buildToppingDict(menuData, productType);

        // Parse AvailableToppings — returns code set and per-code portion options
        // e.g. "X=0:0.5:1:1.5,C=0:0.5:1:1.5,P=1/1" → codeSet=Set{X,C,P}, portions=Map{X:["0","0.5","1","1.5"]}
        const { codeSet, portions } = parseAvailableToppings(product.AvailableToppings);

        // Get default options from the variant (e.g. {X: {"1/1": "1"}, C: {"1/1": "1"}})
        const defaultOptions = v.Options || {};

        // If AvailableToppings is explicitly set, use those codes (BYO pizzas list exactly which
        // toppings can be added/changed). For specialty pizzas (empty AvailableToppings), skip the
        // interactive toppings form entirely — per WiiLink, GetToppings returns nil for these.
        // We pass Tags.DefaultToppings as hidden default_options so the full recipe is sent.
        const finalCodeSet = codeSet;

        // Build a normalized defaults map (code → amount string) for the hidden field.
        // Normalises portion keys (1/1, 1/2, 2/4, etc.) to a plain amount string for the form.
        const normalizedDefaults = Object.fromEntries(
          Object.entries(defaultOptions).map(([code, portionObj]) => {
            // Prefer '1/1' (full pizza), then any other portion key; fall back to '1'
            const vals = portionObj && Object.values(portionObj);
            const amt =
              (portionObj && (portionObj['1/1'] || portionObj['1/2'] || portionObj['2/4'])) ||
              (vals && vals[0]) ||
              '1';
            return [code, String(amt)];
          })
        );

        // For specialty pizzas (empty AvailableToppings): build full recipe from Tags.DefaultToppings
        // and Tags.DefaultSides per WiiLink's AddItem. v.Options only has the sauce code; the full
        // default recipe (sauce + cheese + toppings) lives in Tags.DefaultToppings.
        const defaultToppingsStr = v.Tags?.DefaultToppings || '';
        const defaultSidesStr = v.Tags?.DefaultSides || '';
        // Parse "CODE=value,CODE=value" strings into {code: value} objects
        const parseKvStr = (str) =>
          Object.fromEntries(
            str
              .split(',')
              .map((part) => {
                const eqIdx = part.indexOf('=');
                return eqIdx > 0 ? [part.slice(0, eqIdx), part.slice(eqIdx + 1)] : null;
              })
              .filter(Boolean)
          );
        const tagDefaults = { ...parseKvStr(defaultToppingsStr), ...parseKvStr(defaultSidesStr) };

        const PORTION_LABELS = { 0: 'None', 0.5: 'Light', 1: 'Normal', 1.5: 'Extra' };
        // Used when a topping code exists in toppingDict but has no portion info in AvailableToppings
        const DEFAULT_PORTIONS = ['0', '1'];

        const toppingsSection = (() => {
          if (finalCodeSet.size > 0 && Object.keys(toppingDict).length > 0) {
            const { sauces, toppings: toppingList } = classifyToppings(toppingDict, finalCodeSet);

            // Helper: build one sauce/topping row (select element) given a topping entry
            const buildToppingRow = (item, inputName) => {
              // Use normalizedDefaults so portion key variants (1/2, 2/4, etc.) are handled
              const defaultAmt = normalizedDefaults[item.code] || '0';
              const rawPortions = portions.get(item.code) || DEFAULT_PORTIONS;
              const portionSet = new Set(rawPortions);
              if (defaultAmt !== '0') portionSet.add(defaultAmt);
              const portionList = Array.from(portionSet).sort(
                (a, b) => parseFloat(a) - parseFloat(b)
              );
              const optHtml = portionList
                .map((p) => {
                  const label = PORTION_LABELS[p] || p;
                  const sel = p === defaultAmt ? ' selected' : '';
                  return `<option value="${escape(p)}"${sel}>${escape(label)}</option>`;
                })
                .join('');
              return `<div style="padding:4px 0;font-family:'rodin',Arial,Helvetica,sans-serif;color:#dddddd">
  ${escape(item.name)}: <select name="${inputName}_${escape(item.code)}" style="background:#222327;color:#dddddd;border:none;border-radius:4px;padding:2px 4px">
${optHtml}
  </select>
</div>`;
            };

            const sauceSection =
              sauces.length > 0
                ? `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Sauce</b></font><br><br>` +
                  sauces.map((s) => buildToppingRow(s, 'sauce')).join('') +
                  '<br>'
                : '';
            const toppingSection =
              toppingList.length > 0
                ? `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Toppings</b></font><br><br>` +
                  // Get allowed portion values for each topping; DEFAULT_PORTIONS used when no
                  // portion info was present in AvailableToppings for this code
                  toppingList.map((t) => buildToppingRow(t, 'topping')).join('') +
                  '<br>'
                : '';

            return `<div class="food-card"><form method="POST" action="/food/cart/add${persistentParam}">
  <input type="hidden" name="storeId" value="${escape(storeId)}">
  <input type="hidden" name="country" value="${escape(country)}">
  <input type="hidden" name="code" value="${escape(variantCode)}">
  <input type="hidden" name="name" value="${vFullName}">
  <input type="hidden" name="price" value="${vPrice.toFixed(2)}">
  <input type="hidden" name="redirect" value="${escape(backUrl)}">
  <input type="hidden" name="default_options" value="${escape(JSON.stringify(normalizedDefaults))}">
<font face="'rodin', Arial, Helvetica, sans-serif" color="#aaaaaa"><i>Default toppings, sauce, and cheese are pre-selected below. Adjust as needed.</i></font><br><br>${sauceSection}${toppingSection}  <div style="margin-top:16px">
    <button type="submit" class="food-btn food-btn-large">Add to Cart${vPrice > 0 ? ` - $${vPrice.toFixed(2)}` : ''}</button>
    &#160;&#160;
    <a href="${escape(backUrl)}" class="food-btn food-btn-secondary">Cancel</a>
  </div>
</form></div>`;
          }
          // No AvailableToppings (specialty pizza) — direct add form.
          // Per WiiLink's AddItem: send Options built from Tags.DefaultToppings/DefaultSides
          // so the full recipe (sauce + cheese + toppings) is included. Sending {} (no options)
          // or partial options (e.g. just the sauce) can cause OptionExclusivityViolated or
          // an incomplete order that the store may not process correctly.
          return `<div class="food-card"><form method="POST" action="/food/cart/add${persistentParam}">
  <input type="hidden" name="storeId" value="${escape(storeId)}">
  <input type="hidden" name="country" value="${escape(country)}">
  <input type="hidden" name="code" value="${escape(variantCode)}">
  <input type="hidden" name="name" value="${vFullName}">
  <input type="hidden" name="price" value="${vPrice.toFixed(2)}">
  <input type="hidden" name="redirect" value="${escape(backUrl)}">
  <input type="hidden" name="default_options" value="${escape(JSON.stringify(tagDefaults))}">
  <div style="margin-top:8px">
    <button type="submit" class="food-btn food-btn-large">Add to Cart${vPrice > 0 ? ` - $${vPrice.toFixed(2)}` : ''}</button>
    &#160;&#160;
    <a href="${escape(backUrl)}" class="food-btn food-btn-secondary">Cancel</a>
  </div>
</form></div>`;
        })();
        html = strReplace(html, '{$TOPPINGS_SECTION}', toppingsSection);
      }
    } else {
      html = strReplace(html, '{$PRODUCT_NAME}', escape(productCode));
      html = strReplace(html, '{$PRODUCT_DESC}', '');
      html = strReplace(
        html,
        '{$SIZE_OPTIONS}',
        `<div class="food-error">Could not load menu. Please go back and try again.</div>`
      );
      html = strReplace(html, '{$TOPPINGS_SECTION}', '');
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    html = applySessionToTemplate(html);
    return res.end(html);
  }

  // 404
  return notFound.serve404(
    req,
    res,
    'Page not found.',
    '/food/' + persistentParam,
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
      console.warn('[food] Failed to parse request body:', e.message);
      return {};
    }
  })();

  // Session + cart/checkout state for Wii U URL-based fallback
  const urlSessionID = params.sessionID || parsedurl.searchParams.get('sessionID') || '';
  const urlCartEncoded = parsedurl.searchParams.get('pizzaCart') || '';
  const urlCheckoutEncoded = parsedurl.searchParams.get('pizzaCheckout') || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';
  const sessionIdSuffix = urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '';

  // Build redirect URL with session + cart + optional extra params
  function persistRedirect(path, extras) {
    const parts = [];
    if (urlSessionID) parts.push('sessionID=' + encodeURIComponent(urlSessionID));
    if (urlCartEncoded) parts.push('pizzaCart=' + encodeURIComponent(urlCartEncoded));
    if (urlCheckoutEncoded) parts.push('pizzaCheckout=' + encodeURIComponent(urlCheckoutEncoded));
    if (extras) parts.push(...extras);
    return parts.length ? path + '?' + parts.join('&') : path;
  }

  // --- Add item to cart ---
  if (subpath === 'cart/add') {
    const cart = getCart(req);
    const storeId = (params.storeId || '').replace(/[^0-9]/g, '');
    const country = params.country === 'ca' ? 'ca' : 'us';
    const code = (params.code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
    const name = (params.name || '').slice(0, 100);
    const price = parseFloat(params.price) || 0;
    // Only allow relative /food/ redirects to prevent open redirect
    const rawRedirect = params.redirect || '';
    // HTML-unescape &amp; → & only: old browsers (e.g. Wii U WebKit) may submit form
    // values with literal &amp; instead of decoding HTML entities first. In a URL context
    // only &amp; appears (as the query-param separator), so we decode only that to avoid
    // the double-unescape risk from chaining multiple entity replacements.
    const rawRedirectDecoded = rawRedirect.replace(/&amp;/g, '&');
    const redirect = /^\/food\//.test(rawRedirectDecoded)
      ? rawRedirectDecoded.slice(0, 300)
      : '/food/cart';

    if (!code) {
      // Preserve session ID even on early exit
      const noCodeRedirect =
        urlSessionID && !redirect.includes('sessionID=')
          ? redirect + (redirect.includes('?') ? sessionIdSuffix : sessionParam)
          : redirect;
      res.writeHead(302, { Location: noCodeRedirect });
      return res.end();
    }

    // Reset cart if store changed
    if (cart.storeId && cart.storeId !== storeId) {
      cart.items = [];
    }
    cart.storeId = storeId;
    cart.country = country;

    // Parse topping/sauce options from form
    const options = parseOptions(params);

    const existing = cart.items.find((i) => i.code === code);
    if (existing) {
      existing.qty = (existing.qty || 1) + 1;
      // Always update options (including clearing stale partial options when re-adding specialty pizza)
      existing.options = options;
      existing._nf = 1; // new-format flag: options include full recipe; skip stale detection
    } else {
      cart.items.push({ code, name, qty: 1, price, options, _nf: 1 }); // _nf: new-format, skip stale detection
    }

    // Build redirect URL with fresh cart data (always include pizzaCart for Wii U cookie fallback)
    const newCartEncoded = encodeCart(cart);
    // Strip any stale pizzaCart already in the redirect, then append fresh values
    const redirectWithSession = (() => {
      try {
        const rUrl = new URL(redirect, 'http://localhost');
        rUrl.searchParams.set('pizzaCart', newCartEncoded);
        if (urlSessionID && !rUrl.searchParams.has('sessionID'))
          rUrl.searchParams.set('sessionID', urlSessionID);
        return rUrl.pathname + rUrl.search;
      } catch (e) {
        // Fallback: plain string append
        const base =
          urlSessionID && !redirect.includes('sessionID=')
            ? redirect + (redirect.includes('?') ? sessionIdSuffix : sessionParam)
            : redirect;
        return (
          base +
          (base.includes('?') ? '&' : '?') +
          'pizzaCart=' +
          encodeURIComponent(newCartEncoded)
        );
      }
    })();
    res.writeHead(302, {
      Location: redirectWithSession,
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
      Location: persistRedirect('/food/cart', [
        'pizzaCart=' + encodeURIComponent(encodeCart(cart)),
      ]),
      'Set-Cookie': cartCookieHeader(cart, secure),
    });
    return res.end();
  }

  // --- Request Discord DM verification ---
  if (subpath === 'request-verify') {
    const cart = getCart(req);
    if (!cart.items || cart.items.length === 0) {
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' + encodeURIComponent('Your cart is empty.'),
        ]),
      });
      return res.end();
    }

    // Use crypto.randomInt for cryptographically secure 6-digit code
    const code = String(crypto.randomInt(VERIFICATION_CODE_MIN, VERIFICATION_CODE_MAX));
    const expires = unixTime() + 10 * 60; // 10 minutes

    // Only store the verification code + expiry in DB — no PII
    auth.dbQueryRun(
      'INSERT OR REPLACE INTO pizza_verifications (discordID, code, cart_json, expires) VALUES (?,?,?,?)',
      [discordID, code, '', expires]
    );

    // Validate and sanitize phone: digits only, 10 digits for US/CA
    const rawPhone = (params.phone || '').replace(/\D/g, '').slice(0, 10);
    if (!rawPhone || rawPhone.length < 7) {
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' + encodeURIComponent('Please enter a valid phone number.'),
        ]),
      });
      return res.end();
    }

    // Store checkout form data in a short-lived HttpOnly cookie.
    // This keeps all PII client-side; the server never persists it.
    // Payment is cash on delivery — no card data collected.
    const checkoutData = {
      cart,
      firstName: (params.firstName || '').slice(0, 50),
      lastName: (params.lastName || '').slice(0, 50),
      email: (params.email || '').slice(0, 100),
      phone: rawPhone,
      street: (params.street || '').slice(0, 100),
      apt: (params.apt || '').replace(/[^a-zA-Z0-9 #-]/g, '').slice(0, 20),
      addressType: ['House', 'Apartment', 'Business', 'Hotel', 'Other'].includes(params.addressType)
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
    const checkoutCookieHeader = `pizzaCheckout=${encodeURIComponent(checkoutCookie)}; path=/food; HttpOnly${secure ? '; Secure' : ''}; Max-Age=600`;

    const sent = await bot.sendPizzaVerification(discordID, code);
    if (!sent) {
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' +
            encodeURIComponent(
              'Could not send Discord DM. Please make sure DMs from server members are enabled.'
            ),
        ]),
      });
      return res.end();
    }

    res.writeHead(302, {
      Location: persistRedirect('/food/verify', [
        'pizzaCheckout=' + encodeURIComponent(checkoutCookie),
      ]),
      'Set-Cookie': checkoutCookieHeader,
    });
    return res.end();
  }

  // --- Place order (after code verification) ---
  if (subpath === 'place-order') {
    const code = (params.code || '').replace(/[^0-9]/g, '').slice(0, 6);
    if (!code || !/^\d{6}$/.test(code)) {
      res.writeHead(302, {
        Location: persistRedirect('/food/verify', [
          'error=' + encodeURIComponent('Invalid code format.'),
        ]),
      });
      return res.end();
    }

    const time = unixTime();
    const verification = auth.dbQuerySingle(
      'SELECT * FROM pizza_verifications WHERE discordID=? AND code=? AND expires > ?',
      [discordID, code, time]
    );
    if (!verification) {
      res.writeHead(302, {
        Location: persistRedirect('/food/verify', [
          'error=' + encodeURIComponent('Invalid or expired verification code.'),
        ]),
      });
      return res.end();
    }

    // Read checkout data from the client-side cookie (no PII was stored in DB)
    const checkoutData = (() => {
      try {
        const cookie = req.headers.cookie || '';
        const checkoutCookieVal = cookie.split('; ').find((c) => c.startsWith('pizzaCheckout='));
        // Also fall back to URL param for browsers that don't save cookies (e.g. Wii U)
        const rawVal = checkoutCookieVal
          ? checkoutCookieVal.split('=').slice(1).join('=')
          : urlCheckoutEncoded || '';
        if (rawVal) {
          const parsed = JSON.parse(
            Buffer.from(decodeURIComponent(rawVal), 'base64').toString('utf-8')
          );
          console.info('[place-order] checkout data found, items:', parsed?.cart?.items?.length);
          return parsed;
        } else {
          console.error('[place-order] no pizzaCheckout cookie or URL param found');
          return null;
        }
      } catch (e) {
        console.error('[place-order] failed to parse checkout data:', e);
        return null;
      }
    })();

    if (
      !checkoutData ||
      !checkoutData.cart ||
      !checkoutData.cart.items ||
      checkoutData.cart.items.length === 0
    ) {
      console.error(
        '[place-order] missing/empty checkout data:',
        JSON.stringify(
          checkoutData && { cart: checkoutData.cart ? { items: checkoutData.cart.items } : null }
        )
      );
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' +
            encodeURIComponent('Checkout session expired. Please fill out the form again.'),
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

    if (!firstName || !lastName || !email || !phone || !street || !city || !region || !postalCode) {
      console.error(
        '[place-order] missing fields: firstName=%s lastName=%s email=%s phone=%s street=%s city=%s region=%s postalCode=%s',
        !!firstName,
        !!lastName,
        !!email,
        !!phone,
        !!street,
        !!city,
        !!region,
        !!postalCode
      );
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' + encodeURIComponent('Missing order details. Please fill out the form again.'),
        ]),
      });
      return res.end();
    }

    // Calculate total from cart items (used for receipt)
    const cartTotal = cart.items.reduce((s, i) => s + parseFloat(i.price || 0) * (i.qty || 1), 0);

    // Dominos pizza sauce codes. Used to detect stale partial-options from old cart data.
    // Old code stored only the sauce (e.g. {"Xw":{"1/1":"1"}}) for specialty pizzas.
    // This is incomplete — WiiLink sends the full recipe (sauce + cheese + toppings).
    // Items added by current code have _nf:1 — skip stale check for those (preserves user customization).
    // Only apply stale detection to old cart data (no _nf flag) with sauce-only options.
    const PIZZA_SAUCE_CODES = new Set(['X', 'Xw', 'Xf', 'Xo', 'Xb', 'Xm', 'Cp', 'Rd']);
    const products = cart.items.map((item) => {
      const opts = item.options || {};
      const keys = Object.keys(opts);
      const isStale =
        !item._nf &&
        keys.length > 0 &&
        keys.length <= 2 &&
        keys.every((k) => PIZZA_SAUCE_CODES.has(k));
      if (isStale) {
        console.info(
          '[place-order] stale sauce-only options detected for',
          item.code,
          '— resetting to {} so Dominos applies full recipe'
        );
      }
      return {
        Code: item.code,
        Qty: item.qty || 1,
        Options: isStale ? {} : opts,
      };
    });

    const dominosHost = cart.country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com';
    console.info(
      '[place-order] sending to',
      dominosHost,
      '| storeId:',
      cart.storeId,
      '| items:',
      products.length,
      '| country:',
      cart.country
    );
    console.info('[place-order] products:', JSON.stringify(products));

    // Normalize address via store-locator to get Street, StreetName, StreetNumber, City, PostalCode.
    // WiiLink uses the normalized Street/City/PostalCode from the API response in the payload.
    let normalizedStreet = street;
    let normalizedCity = city;
    let normalizedPostalCode = postalCode;
    let streetName = '';
    let streetNumber = '';
    // Helper: parse StreetNumber and StreetName from raw street string (e.g. "123 Main St" → "123" / "Main St")
    const parseStreetParts = (s) => {
      const m = s.trim().match(/^(\d+)\s+(.+)$/);
      return m ? { number: m[1], name: m[2] } : null;
    };
    try {
      const fullAddress = `${street}, ${city}, ${region} ${postalCode}`;
      const addrResult = await dominosRequest({
        hostname: dominosHost,
        path: `/power/store-locator?type=Delivery&c=${encodeURIComponent(fullAddress)}&s=&a=`,
        method: 'GET',
      });
      const addrObj = addrResult?.data?.Address;
      const locatorStores = addrResult?.data?.Stores ?? [];
      console.info(
        '[place-order] store-locator HTTP=%s | Address=%s',
        addrResult?.status,
        JSON.stringify(addrObj)
      );
      // Use the nearest store for this delivery address from the locator results.
      // This ensures the order goes to the store that actually serves the address,
      // preventing ServiceMethodNotAllowed when the user's selected store is outside
      // the delivery zone.
      if (locatorStores.length > 0) {
        const nearestStoreId = String(locatorStores[0].StoreID);
        console.info(
          '[place-order] using nearest store for delivery address: %s (was: %s)',
          nearestStoreId,
          cart.storeId
        );
        cart.storeId = nearestStoreId;
      }
      if (addrObj && (addrObj.StreetName || addrObj.StreetNumber)) {
        // Use the API-normalized values (WiiLink uses addrObj.Street for the Street field too)
        if (addrObj.Street) normalizedStreet = addrObj.Street;
        streetName = addrObj.StreetName || '';
        streetNumber = addrObj.StreetNumber || '';
        if (addrObj.City) normalizedCity = addrObj.City;
        if (addrObj.PostalCode) normalizedPostalCode = addrObj.PostalCode;
        console.info(
          '[place-order] address normalized via API: Street=%s StreetName=%s StreetNumber=%s City=%s PostalCode=%s',
          normalizedStreet,
          streetName,
          streetNumber,
          normalizedCity,
          normalizedPostalCode
        );
      } else {
        // Fallback: parse StreetNumber and StreetName from the raw street string.
        const parsed = parseStreetParts(street);
        if (parsed) {
          streetNumber = parsed.number;
          streetName = parsed.name;
          console.info(
            '[place-order] address parsed from street string: StreetName=%s StreetNumber=%s',
            streetName,
            streetNumber
          );
        } else {
          console.info(
            '[place-order] address normalization: could not extract StreetName/StreetNumber from street=%s',
            street
          );
        }
      }
    } catch (e) {
      console.info('[place-order] address normalization failed:', e?.message);
      // Fallback: parse from raw street string
      const parsed = parseStreetParts(street);
      if (parsed) {
        streetNumber = parsed.number;
        streetName = parsed.name;
        console.info(
          '[place-order] address parsed (fallback): StreetName=%s StreetNumber=%s',
          streetName,
          streetNumber
        );
      }
    }

    // Validate payload (used for validate-order and price-order steps)
    // Uses empty Payments/PII fields per WiiLink's GetPrice flow
    // Includes normalized StreetName and StreetNumber per WiiLink's AddressLookup
    const validatePayload = {
      Order: {
        Address: {
          Street: normalizedStreet,
          City: normalizedCity,
          Region: region,
          PostalCode: normalizedPostalCode,
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

    // Step 1: First validate-order call (empty OrderID) — Dominos returns an OrderID.
    // Per WiiLink's GetPrice: call validate-order twice then price-order before place-order.
    // WiiLink does NOT check Status on validate-order steps — AutoAddedOrderId /
    // ServiceMethodNotAllowed are informational codes Dominos always returns. Just extract the
    // OrderID and proceed regardless of API Status.
    let orderId = '';
    for (let vStep = 0; vStep < 2; vStep++) {
      const vResult = await dominosRequest(
        {
          hostname: dominosHost,
          path: '/power/validate-order',
          method: 'POST',
        },
        JSON.stringify(validatePayload)
      ).catch((e) => {
        console.error(`[place-order] validate-order step ${vStep + 1} network error:`, e);
        res.writeHead(302, {
          Location: persistRedirect('/food/checkout', [
            'error=' + encodeURIComponent('Failed to connect to Dominos. Please try again.'),
          ]),
        });
        res.end();
        return null;
      });
      if (vResult === null) return; // response already sent in .catch()
      console.info(`[place-order] validate-order step ${vStep + 1} HTTP status:`, vResult?.status);
      const vOrder = vResult?.data?.Order;
      const vOuterStatus = vResult?.data?.Status;
      if (vResult.status < 200 || vResult.status >= 300) {
        console.error(
          `[place-order] validate-order step ${vStep + 1} HTTP error:`,
          vResult?.status
        );
        res.writeHead(302, {
          Location: persistRedirect('/food/checkout', [
            'error=' + encodeURIComponent('Failed to connect to Dominos. Please try again.'),
          ]),
        });
        return res.end();
      }
      // Log outer + Order status. Per WiiLink: AutoAddedOrderId/ServiceMethodNotAllowed at Order
      // level are informational. WiiLink does NOT check Status on validate steps; only on price-order.
      const vStatusItems = vOrder?.StatusItems;
      console.info(
        `[place-order] validate-order step ${vStep + 1} outer Status:`,
        vOuterStatus,
        '| Order Status:',
        vOrder?.Status,
        '| StatusItems:',
        JSON.stringify(vStatusItems),
        '(continuing per WiiLink flow)'
      );
      // Save/update the OrderID for subsequent calls
      orderId = vOrder?.OrderID || orderId;
      validatePayload.Order.OrderID = orderId;
    }

    // Step 2: price-order — retrieves final price with Amounts populated.
    // Per WiiLink's GetPrice: checks outer Status (0 or 1 = success, else fail).
    validatePayload.Order.metaData = { orderFunnel: 'payments' };
    const priceResult = await dominosRequest(
      {
        hostname: dominosHost,
        path: '/power/price-order',
        method: 'POST',
      },
      JSON.stringify(validatePayload)
    ).catch((e) => {
      console.error('[place-order] price-order network error:', e);
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' + encodeURIComponent('Failed to connect to Dominos. Please try again.'),
        ]),
      });
      res.end();
      return null;
    });
    if (priceResult === null) return; // response already sent in .catch()
    console.info('[place-order] price-order HTTP status:', priceResult?.status);
    const priceOrderData = priceResult?.data?.Order;
    const priceOuterStatus = priceResult?.data?.Status;
    if (priceResult.status < 200 || priceResult.status >= 300) {
      console.error('[place-order] price-order HTTP error:', priceResult?.status);
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' + encodeURIComponent('Failed to price order. Please try again.'),
        ]),
      });
      return res.end();
    }
    console.info(
      '[place-order] price-order outer Status:',
      priceOuterStatus,
      '| Order Status:',
      priceOrderData?.Status,
      '| StatusItems:',
      JSON.stringify(priceOrderData?.StatusItems)
    );
    // Per WiiLink: Status 0 or 1 = success; anything else (e.g. -1) means the store cannot
    // process this order (e.g. ServiceMethodNotAllowed = store doesn't deliver to this address).
    if (priceOuterStatus !== 0 && priceOuterStatus !== 1) {
      const priceTopItems = priceResult?.data?.StatusItems ?? [];
      const priceErrMsg =
        priceTopItems
          .map((s) => s.Message)
          .filter(Boolean)
          .join(' ') ||
        "This isn't the closest location - the selected store may not deliver to your address. Please go back to store search and choose the nearest store.";
      console.error(
        '[place-order] price-order failed: outer Status:',
        priceOuterStatus,
        '| top-level StatusItems:',
        JSON.stringify(priceTopItems)
      );
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', ['error=' + encodeURIComponent(priceErrMsg)]),
      });
      return res.end();
    }
    // Update orderId from price-order response (WiiLink uses price-order OrderID for place-order)
    if (priceOrderData?.OrderID) {
      orderId = priceOrderData.OrderID;
      console.info('[place-order] using price-order OrderID:', orderId);
    }
    // Use the priced total (Amounts.Customer) as the payment amount — this includes tax +
    // delivery surcharge and is the amount Domino's POS expects. Without this the order fails
    // with "Amount paid is insufficient" (PosOrderIncomplete). Fall back to cartTotal if the
    // Amounts field is absent (e.g. on an error response that still returned Status 0/1).
    const pricedTotal =
      priceOrderData?.Amounts && typeof priceOrderData.Amounts.Customer === 'number'
        ? priceOrderData.Amounts.Customer
        : null;
    if (pricedTotal !== null) {
      console.info(
        '[place-order] using priced total from price-order Amounts.Customer:',
        pricedTotal,
        '(cart subtotal was:',
        cartTotal,
        ')'
      );
    }

    // Step 3: Build the place-order payload from scratch per WiiLink's PlaceOrder function.
    // WiiLink never merges pricedOrderBase — it builds the full payload from user info.
    // Using pricedOrderBase risked carrying stale/bad fields (empty Address, wrong ServiceMethod, etc.)
    const placePayload = {
      Status: 0,
      Order: {
        Address: {
          Street: normalizedStreet,
          City: normalizedCity,
          Region: region,
          PostalCode: normalizedPostalCode,
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
        Payments: [{ Type: 'Cash', Amount: pricedTotal !== null ? pricedTotal : cartTotal }],
        PendingOrder: false,
        Phone: phone,
        PhonePrefix: '',
        Platform: 'androidNativeApp',
        PlaceOrderMs: 0,
        PriceOrderMs: 0,
        Products: products,
        ServiceMethod: 'Delivery',
        SourceOrganizationURI: cart.country === 'ca' ? 'order.dominos.com' : 'android.dominos.com',
        Status: 0,
        StoreID: cart.storeId,
        Tags: {},
        TestOrderFlagCCProcess: false,
        Version: '1.0',
        metaData: { PiePassPickup: false, calculateNutrition: true, contactless: false },
      },
    };

    // Step 4: Place the priced order.
    console.info(
      '[place-order] placing order: storeId=%s orderId=%s street=%s city=%s postalCode=%s streetName=%s streetNumber=%s',
      cart.storeId,
      orderId,
      normalizedStreet,
      normalizedCity,
      normalizedPostalCode,
      streetName,
      streetNumber
    );
    console.info('[place-order] place payload:', JSON.stringify(placePayload));
    const orderResult = await dominosRequest(
      {
        hostname: dominosHost,
        path: '/power/place-order',
        method: 'POST',
        headers: { 'DPZ-Source': 'DSSPlaceOrder' },
      },
      JSON.stringify(placePayload)
    ).catch((e) => {
      console.error('[place-order] network error:', e);
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', [
          'error=' + encodeURIComponent('Failed to connect to Dominos. Please try again.'),
        ]),
      });
      res.end();
      return null;
    });
    if (orderResult === null) return; // response already sent in .catch()
    console.info('[place-order] HTTP status:', orderResult?.status);
    console.info('[place-order] response:', JSON.stringify(orderResult?.data));

    const orderData = orderResult?.data?.Order;
    const topLevelStatus = orderResult?.data?.Status;
    const topLevelStatusItems = orderResult?.data?.StatusItems ?? [];
    const badHttpStatus = orderResult.status < 200 || orderResult.status >= 300;
    const products_response = orderData?.Products ?? [];
    const orderStatusItems = orderData?.StatusItems ?? [];
    const hasProductErrors = products_response.some((p) => (p.Status || 0) < 0);
    // Per WiiLink's PlaceOrder: Status 0 or 1 = success. Also check for "Failure" code in
    // top-level StatusItems as a secondary indicator. ServiceMethodNotAllowed/AutoAddedOrderId
    // in Order.StatusItems are purely informational and always present — never failure indicators.
    const hasTopLevelFailure =
      topLevelStatusItems.some((s) => s.Code === 'Failure') ||
      (topLevelStatus !== 0 && topLevelStatus !== 1);
    if (badHttpStatus || hasProductErrors || hasTopLevelFailure) {
      const productErrors = products_response.flatMap((p) =>
        (p.StatusItems || [])
          .map((s) => ({ code: s.Code, message: s.Message }))
          .filter((e) => e.code || e.message)
      );
      const statusItemWithMsg = orderStatusItems.find((s) => s.Message);
      const errMsg =
        (statusItemWithMsg && statusItemWithMsg.Message) ||
        'Order failed. Please check your details and try again.';
      console.error(
        '[place-order] FAILED | HTTP:',
        orderResult?.status,
        '| top-level Status:',
        topLevelStatus,
        '| Order Status:',
        orderData?.Status,
        '| OrderStatusItems:',
        JSON.stringify(orderStatusItems),
        '| top-level StatusItems:',
        JSON.stringify(topLevelStatusItems),
        '| Product errors:',
        JSON.stringify(productErrors)
      );
      res.writeHead(302, {
        Location: persistRedirect('/food/checkout', ['error=' + encodeURIComponent(errMsg)]),
      });
      return res.end();
    }
    console.info(
      '[place-order] SUCCESS | products:',
      JSON.stringify(products_response.map((p) => ({ code: p.Code, status: p.Status }))),
      '| orderId:',
      orderData?.OrderID
    );

    const storeId = cart.storeId || '';
    const storeAddr = orderData.StoreAddress;
    const storeName = storeAddr
      ? `${storeAddr.City || normalizedCity} Store #${storeId}`
      : `Store #${storeId}`;

    // Use the priced total (from price-order Amounts.Customer, includes tax + delivery) for receipt.
    // Fall back to cart total if priced total unavailable, then to the place-order response amounts.
    const total =
      pricedTotal !== null
        ? pricedTotal
        : cartTotal > 0
          ? cartTotal
          : parseFloat(orderData.Amounts?.Payment || orderData.Amounts?.Total || 0);

    // Save receipt — no PII (no address/name/phone/email)
    auth.dbQueryRun(
      'INSERT INTO pizza_orders (discordID, store_id, store_name, items_json, total, timestamp) VALUES (?,?,?,?,?,?)',
      [
        discordID,
        storeId,
        storeName,
        JSON.stringify(
          cart.items.map((i) => ({ code: i.code, name: i.name, qty: i.qty, price: i.price }))
        ),
        total,
        unixTime(),
      ]
    );

    // Clean up verification record
    auth.dbQueryRun('DELETE FROM pizza_verifications WHERE discordID=?', [discordID]);

    // Clear cart and checkout cookies, redirect to receipts with success notice
    res.writeHead(302, {
      Location: persistRedirect('/food/receipts', ['placed=1']),
      'Set-Cookie': [
        clearCartCookieHeader(),
        'pizzaCheckout=; path=/food; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ],
    });
    return res.end();
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
};

// =============================================================================
// Food image proxy
// =============================================================================
exports.foodProxy = async function (req, res) {
  const parsedurl = new URL(req.url, 'http://localhost');
  // Allow only safe filename characters
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
            const buf = Buffer.concat(chunks);
            const ct = proxyRes.headers['content-type'] || 'image/jpeg';
            res.writeHead(proxyRes.statusCode === 200 ? 200 : 404, {
              'Content-Type': ct,
              'Cache-Control': 'public, max-age=86400',
            });
            res.end(buf);
            resolve();
          });
          proxyRes.on('error', reject);
        })
        .on('error', reject);
    });
  } catch (e) {
    console.error('foodProxy error:', e);
    if (!res.headersSent) {
      res.writeHead(404);
      res.end();
    }
  }
};
