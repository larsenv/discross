const fs = require('fs')
const https = require('https')
const escape = require('escape-html')
const querystring = require('querystring')
const crypto = require('crypto')

const auth = require('../authentication.js')
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone } = require('../timezoneUtils')

const API_TIMEOUT_MS = 15000
const VERIFICATION_CODE_MIN = 100000
const VERIFICATION_CODE_MAX = 1000000
const SAUCE_CODES = ['X', 'Xm', 'Cp', 'Bq', 'Rd', 'Hw', 'Mh', 'Du']

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || '')
}

function unixTime() {
  return Math.floor(Date.now() / 1000)
}

// Format a Unix timestamp using the user's detected timezone (IP-based)
function formatTimestamp(ts, req) {
  const timezone = req ? getTimezoneFromIP(getClientIP(req)) : null
  return formatDateWithTimezone(new Date(ts * 1000), timezone)
}

// --- Template loading ---
const commonHead = fs.readFileSync('pages/templates/partials/head.html', 'utf-8')

function loadTemplate(name) {
  return fs.readFileSync(`pages/templates/food/${name}`, 'utf-8')
    .split('{$COMMON_HEAD}').join(commonHead)
}

let _templates = null
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
    }
  }
  return _templates
}

// --- Theme helper ---
function getThemeAttr(req) {
  const parsedurl = new URL(req.url, 'http://localhost')
  const urlTheme = parsedurl.searchParams.get('theme')
  const cookie = req.headers.cookie || ''
  const whiteThemeCookie = cookie.split('; ').find(c => c.startsWith('whiteThemeCookie='))
  const cookieVal = whiteThemeCookie ? whiteThemeCookie.split('=')[1] : undefined
  const theme = urlTheme !== null ? parseInt(urlTheme) : (cookieVal !== undefined ? parseInt(cookieVal) : 0)
  if (theme === 1) return 'class="light-theme"'
  if (theme === 2) return 'class="amoled-theme"'
  return 'bgcolor="303338"'
}

// --- Cart cookie helpers ---
function getCart(req) {
  try {
    const cookie = req.headers.cookie || ''
    const cartCookie = cookie.split('; ').find(c => c.startsWith('pizzaCart='))
    if (!cartCookie) return { storeId: null, items: [] }
    const val = cartCookie.split('=').slice(1).join('=')
    const decoded = Buffer.from(decodeURIComponent(val), 'base64').toString('utf-8')
    const cart = JSON.parse(decoded)
    if (!cart.items) cart.items = []
    return cart
  } catch (e) {
    console.error('getCart: failed to parse cart cookie:', e.message)
    return { storeId: null, items: [] }
  }
}

function encodeCart(cart) {
  return Buffer.from(JSON.stringify(cart)).toString('base64')
}

function cartCookieHeader(cart, useSecure) {
  const encoded = encodeCart(cart)
  return `pizzaCart=${encodeURIComponent(encoded)}; path=/; HttpOnly${useSecure ? '; Secure' : ''}`
}

function clearCartCookieHeader() {
  return 'pizzaCart=; path=/; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

// --- Domino's API helper ---
function dominosRequest(options, body) {
  return new Promise((resolve, reject) => {
    options.headers = options.headers || {}
    options.headers['User-Agent'] = 'Dominos API Wrapper'
    options.headers['Accept'] = 'application/json'
    // Referer required by Dominos API to return results
    if (!options.headers['Referer']) {
      const host = options.hostname || 'order.dominos.com'
      options.headers['Referer'] = `https://${host}/`
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json'
      options.headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) })
        } catch (e) {
          resolve({ status: res.statusCode, data: data })
        }
      })
    })
    req.setTimeout(API_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timed out'))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
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
  )`)
  auth.dbQueryRun(`CREATE TABLE IF NOT EXISTS pizza_verifications (
    discordID TEXT PRIMARY KEY,
    code TEXT,
    cart_json TEXT,
    expires INTEGER
  )`)
}
setup()

// --- Determine if HTTPS is in use (mirrors auth.js logic) ---
function isSecure(req) {
  return req.socket && req.socket.encrypted
}

// --- Parse topping options from a POST request params ---
// Expects params like topping_P=1 (amount: 0=none, 0.5=light, 1=normal, 1.5=extra),
// and sauce_X=1, sauce_Xm=0, etc. (same amount-based format as toppings)
function parseOptions(params) {
  const options = {}
  for (const key of Object.keys(params)) {
    const isTopping = key.startsWith('topping_')
    const isSauce = key.startsWith('sauce_')
    if (isTopping || isSauce) {
      const prefix = isTopping ? 'topping_' : 'sauce_'
      const code = key.slice(prefix.length).replace(/[^a-zA-Z0-9]/g, '')
      const amount = params[key]
      // Accept numeric amounts; skip 0 (none = not included)
      if (code && amount && amount !== '0' && /^[0-9.]+$/.test(amount)) {
        options[code] = { '1/1': amount }
      }
    }
  }
  return options
}

// --- Build a topping code→entry dict from menuData ---
// The Dominos API returns Toppings nested by ProductType: { Pizza: {C: {...}, X: {...}}, Wings: {...} }.
// Per WiiLink/Demae-Dominos: use ONLY the exact productType category.
// Returns empty dict if productType has no matching Toppings category.
function buildToppingDict(menuData, productType) {
  const rawToppings = menuData.Toppings || {}
  if (productType && rawToppings[productType] && typeof rawToppings[productType] === 'object') {
    return rawToppings[productType]
  }
  return {}
}

// --- Parse AvailableToppings string into code set and per-code portion options ---
// AvailableToppings = "X=0:0.5:1:1.5,Xm=0:0.5:1:1.5,C=0:0.5:1:1.5,P=1/1"
// Returns { codeSet: Set<string>, portions: Map<string, string[]> }
function parseAvailableToppings(rawAvailToppings) {
  const codeSet = new Set()
  const portions = new Map()
  const entries = Array.isArray(rawAvailToppings)
    ? rawAvailToppings.map(String)
    : (rawAvailToppings ? String(rawAvailToppings).split(',') : [])
  for (const entry of entries) {
    const eqIdx = entry.indexOf('=')
    const code = (eqIdx === -1 ? entry : entry.slice(0, eqIdx)).trim()
    if (!code) continue
    codeSet.add(code)
    if (eqIdx !== -1) {
      const portionStr = entry.slice(eqIdx + 1)
      // Support "0:0.5:1:1.5" (colon-separated) or "1/1" (legacy fixed)
      const portionList = portionStr.indexOf(':') !== -1
        ? portionStr.split(':').map(p => p.trim()).filter(Boolean)
        : [portionStr.split('/')[0].trim()].filter(Boolean)
      if (portionList.length > 0) {
        portions.set(code, portionList)
      }
    }
  }
  return { codeSet, portions }
}

// --- Classify toppings from a toppingDict, filtered by available code set ---
// Per WiiLink: iterate over toppingDict, skip codes not in availableCodes.
// Sauce = Tags.Sauce only (WiiLink approach, avoids wrong classification for non-pizza items).
// Returns { sauces: [{code, name}], toppings: [{code, name}] }
function classifyToppings(toppingDict, codeSet) {
  const sauces = []
  const toppings = []
  for (const code of Object.keys(toppingDict)) {
    if (!codeSet.has(code)) continue
    const t = toppingDict[code]
    if (!t || typeof t !== 'object') continue
    const name = (t.Name && String(t.Name).trim()) || code
    const tags = t.Tags || {}
    // WiiLink: only classify as sauce if Tags.Sauce is set
    const isSauce = !!(tags.Sauce)
    if (isSauce) {
      sauces.push({ code, name })
    } else {
      toppings.push({ code, name })
    }
  }
  return { sauces, toppings }
}

// =============================================================================
// GET handler
// =============================================================================
exports.handleGet = async function (bot, req, res, discordID) {
  const parsedurl = new URL(req.url, 'http://localhost')
  // Normalize: strip leading /food/ and trailing /
  const subpath = parsedurl.pathname.replace(/^\/food\/?/, '').replace(/\/$/, '')
  const theme = getThemeAttr(req)
  const templates = getTemplates()

  // --- Store finder ---
  if (subpath === '' || subpath === 'index' || subpath === 'index.html') {
    const cart = getCart(req)
    const cartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    let html = strReplace(templates.index, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$CART_COUNT}', String(cartCount))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Store search (server-rendered HTML) ---
  if (subpath === 'store-search') {
    const address = parsedurl.searchParams.get('address') || ''
    const cart = getCart(req)
    const cartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    let html = strReplace(templates.storeSearch, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$SEARCH_ADDRESS}', escape(address))
    html = strReplace(html, '{$CART_COUNT}', String(cartCount))

    if (!address) {
      html = strReplace(html, '{$STORE_RESULTS}', '')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end(html)
    }

    let storesHtml = ''
    try {
      // Try US API first; fall back to Canada API if no results
      let stores = []
      let country = 'us'
      const trySearch = async (hostname) => {
        const r = await dominosRequest({
          hostname,
          path: `/power/store-locator?type=Delivery&c=${encodeURIComponent(address)}&s=&a=`,
          method: 'GET',
        })
        return (r.status >= 200 && r.status < 300 && r.data && r.data.Stores) ? r.data.Stores : []
      }
      stores = await trySearch('order.dominos.com')
      if (stores.length === 0) {
        stores = await trySearch('order.dominos.ca')
        if (stores.length > 0) country = 'ca'
      }
      if (stores.length > 0) {
        storesHtml += `<br><font size="4" face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Nearby Stores</b></font><br><br>`
        for (const s of stores.slice(0, 5)) {
          const city = escape(s.City || '')
          const storeId = escape(String(s.StoreID || ''))
          const wait = (s.ServiceMethodEstimatedWaitMinutes && s.ServiceMethodEstimatedWaitMinutes.Delivery)
            ? escape(s.ServiceMethodEstimatedWaitMinutes.Delivery.Min + '-' + s.ServiceMethodEstimatedWaitMinutes.Delivery.Max + ' min')
            : ''
          const addrLines = (s.AddressDescription || '').split('\n').map(l => escape(l)).join('<br>')
          storesHtml += `<div class="food-store-card">
  <div class="food-store-name">Store #${storeId} ${city}</div>
  <div class="food-store-addr">${addrLines}</div>
  ${wait ? `<div class="food-store-wait">Est. delivery: ${wait}</div>` : ''}
  <a href="/food/menu?store=${encodeURIComponent(s.StoreID || '')}&amp;country=${country}" class="food-btn" style="display:inline-block;margin-top:8px">View Menu</a>
</div>`
        }
      } else {
        storesHtml = '<div class="food-error">No stores found near that address. Try a different zip code or city name.</div>'
      }
    } catch (e) {
      console.error('Dominos store-search error:', e)
      storesHtml = '<div class="food-error">Error searching for stores. Please try again.</div>'
    }

    html = strReplace(html, '{$STORE_RESULTS}', storesHtml)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Menu ---
  if (subpath === 'menu') {
    const storeId = (parsedurl.searchParams.get('store') || '').replace(/[^0-9]/g, '')
    const category = parsedurl.searchParams.get('category') || ''
    const country = parsedurl.searchParams.get('country') === 'ca' ? 'ca' : 'us'
    const dominosHost = country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com'

    if (!storeId) {
      res.writeHead(302, { Location: '/food/' })
      return res.end()
    }

    let menuData = null
    try {
      const result = await dominosRequest({
        hostname: dominosHost,
        path: `/power/store/${encodeURIComponent(storeId)}/menu?lang=en&structured=true`,
        method: 'GET',
      })
      if (result.status >= 200 && result.status < 300) menuData = result.data
    } catch (e) {
      console.error('Dominos menu fetch error:', e)
    }

    const cart = getCart(req)
    let html = strReplace(templates.menu, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$STORE_ID}', escape(storeId))
    html = strReplace(html, '{$SELECTED_CATEGORY}', escape(category))
    const cartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    html = strReplace(html, '{$CART_COUNT}', String(cartCount))

    if (menuData) {
      // Domino's structured menu: Categorization.Food.Categories[] is the array of food categories
      const categorization = menuData.Categorization || {}
      const foodSection = categorization.Food || {}
      const allCategories = foodSection.Categories || []

      // Build a code->category map
      const categoryByCode = {}
      for (const cat of allCategories) {
        if (cat && cat.Code) categoryByCode[cat.Code] = cat
      }

      const selectedCat = category || (allCategories[0] && allCategories[0].Code) || ''

      // Category tabs
      let catTabs = ''
      for (const cat of allCategories) {
        if (!cat || !cat.Code) continue
        const active = (selectedCat === cat.Code) ? ' food-tab-active' : ''
        catTabs += `<a href="/food/menu?store=${encodeURIComponent(storeId)}&amp;category=${encodeURIComponent(cat.Code)}&amp;country=${country}" class="food-tab${active}">${escape(cat.Name || cat.Code)}</a>`
      }
      html = strReplace(html, '{$CATEGORY_TABS}', catTabs)

      // Recursively collect all product codes, handling deeply nested Categories (e.g. Pizza)
      function collectProducts(catNode) {
        let codes = []
        if (catNode.Products && catNode.Products.length) {
          codes = codes.concat(catNode.Products)
        }
        if (catNode.Categories && catNode.Categories.length) {
          for (const sub of catNode.Categories) {
            if (sub) codes = codes.concat(collectProducts(sub))
          }
        }
        return codes
      }

      const catData = categoryByCode[selectedCat]
      const productCodes = catData ? collectProducts(catData) : []

      const products = menuData.Products || {}
      const variants = menuData.Variants || {}
      let itemsHtml = ''

      // Build a map of variant code → qty already in cart
      const cartQtyByVariant = {}
      for (const item of (cart.items || [])) {
        cartQtyByVariant[item.code] = (cartQtyByVariant[item.code] || 0) + (item.qty || 1)
      }
      // Also build a map of product code → total qty in cart (across all variants)
      const cartQtyByProduct = {}
      for (const item of (cart.items || [])) {
        // Try to reverse-map variant to product
        for (const pCode of Object.keys(products)) {
          const p = products[pCode]
          if (p.Variants && p.Variants.includes(item.code)) {
            cartQtyByProduct[pCode] = (cartQtyByProduct[pCode] || 0) + (item.qty || 1)
          }
        }
      }

      for (const code of productCodes) {
        const p = products[code]
        if (!p) continue
        const name = escape(p.Name || code)
        const desc = escape((p.Description || '').slice(0, 120))

        // Pick lowest-price variant
        let price = ''
        const hasMultipleVariants = p.Variants && p.Variants.length > 1
        if (p.Variants && p.Variants.length) {
          const prices = p.Variants
            .map(v => parseFloat((variants[v] || {}).Price || 0))
            .filter(v => v > 0)
          if (prices.length) price = `$${Math.min(...prices).toFixed(2)}`
        }

        const safeCode = escape(code)
        const safeName = escape(p.Name || code)
        const safePrice = escape(price.replace('$', '') || '0')
        const safeStoreId = escape(storeId)
        const safeRedirect = escape(req.url)
        // Total qty in cart for this product (all sizes/variants)
        const inCart = cartQtyByProduct[code] || 0

        // Items with multiple size variants get a "Customize" button linking to the size picker
        let actionHtml
        if (hasMultipleVariants) {
          const customizeUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(code)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(req.url)}`
          const btnLabel = inCart > 0 ? `Customize (${inCart} in cart)` : 'Customize / Add'
          actionHtml = `<a href="${customizeUrl}" class="food-btn food-btn-sm">${escape(btnLabel)}</a>`
        } else {
          const singleVariant = (p.Variants && p.Variants[0]) || code
          const inCartSingle = cartQtyByVariant[singleVariant] || 0
          const btnLabel = inCartSingle > 0 ? `Add to Cart (${inCartSingle} in cart)` : 'Add to Cart'
          actionHtml = `<form method="POST" action="/food/cart/add">
      <input type="hidden" name="storeId" value="${safeStoreId}">
      <input type="hidden" name="country" value="${escape(country)}">
      <input type="hidden" name="code" value="${safeCode}">
      <input type="hidden" name="name" value="${safeName}">
      <input type="hidden" name="price" value="${safePrice}">
      <input type="hidden" name="redirect" value="${safeRedirect}">
      <button type="submit" class="food-btn food-btn-sm">${escape(btnLabel)}</button>
    </form>`
        }

        itemsHtml += `<div class="food-item-card">
  <img src="/foodProxy/${encodeURIComponent((p.ImageCode || code).replace(/[^a-zA-Z0-9_-]/g, ''))}.jpg" alt="${name}" class="food-item-img" onerror="this.style.display='none'">
  <div class="food-item-info">
    <div class="food-item-name">${name}</div>
    <div class="food-item-desc">${desc}</div>
    <div class="food-item-price">${escape(price)}</div>
    ${actionHtml}
  </div>
</div>`
      }
      if (!itemsHtml) itemsHtml = '<font face="\'rodin\', Arial, Helvetica, sans-serif" color="#b5bac1">No items found in this category.</font>'
      html = strReplace(html, '{$MENU_ITEMS}', itemsHtml)
    } else {
      html = strReplace(html, '{$CATEGORY_TABS}', '')
      html = strReplace(html, '{$MENU_ITEMS}', '<div class="food-card"><font face="\'rodin\', Arial, Helvetica, sans-serif" color="#f28b8c">Could not load menu. The store may be temporarily unavailable. Please try again or choose a different store.</font></div>')
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Cart view ---
  if (subpath === 'cart') {
    const cart = getCart(req)
    let html = strReplace(templates.cart, '{$WHITE_THEME_ENABLED}', theme)
    const cartPageCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    html = strReplace(html, '{$CART_COUNT}', String(cartPageCount))

    let itemsHtml = ''
    let total = 0
    const items = cart.items || []
    if (items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const price = parseFloat(item.price || 0)
        const qty = item.qty || 1
        total += price * qty
        itemsHtml += `<tr>
  <td class="food-cart-name">${escape(item.name || item.code)}</td>
  <td class="food-cart-qty">${escape(String(qty))}</td>
  <td class="food-cart-price">$${(price * qty).toFixed(2)}</td>
  <td>
    <form method="POST" action="/food/cart/remove" style="display:inline">
      <input type="hidden" name="index" value="${i}">
      <button type="submit" class="food-btn food-btn-danger">Remove</button>
    </form>
  </td>
</tr>`
      }
    } else {
      itemsHtml = '<tr><td colspan="4" style="font-family:\'rodin\',Arial,Helvetica,sans-serif;color:#b5bac1;padding:16px">Your cart is empty.</td></tr>'
    }

    html = strReplace(html, '{$CART_ITEMS}', itemsHtml)
    html = strReplace(html, '{$CART_TOTAL}', total.toFixed(2))
    html = strReplace(html, '{$STORE_ID}', escape(cart.storeId || ''))
    html = strReplace(html, '{$HAS_ITEMS}', items.length > 0 ? '' : 'display:none;')

    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Checkout form ---
  if (subpath === 'checkout') {
    const cart = getCart(req)
    if (!cart.items || cart.items.length === 0) {
      res.writeHead(302, { Location: '/food/cart' })
      return res.end()
    }

    const dominosHost = cart.country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com'
    let html = strReplace(templates.checkout, '{$WHITE_THEME_ENABLED}', theme)
    const checkoutCartCount = (cart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    html = strReplace(html, '{$CART_COUNT}', String(checkoutCartCount))
    const errorText = parsedurl.searchParams.get('error') || ''
    html = strReplace(html, '{$ERROR}', errorText
      ? `<div class="food-error">${escape(errorText)}</div>`
      : '')

    // Fetch store address to display to user
    let storeAddrHtml = ''
    if (cart.storeId) {
      try {
        const profileResult = await dominosRequest({
          hostname: dominosHost,
          path: `/power/store/${encodeURIComponent(cart.storeId)}/profile`,
          method: 'GET',
        })
        if (profileResult.status >= 200 && profileResult.status < 300 && profileResult.data) {
          const p = profileResult.data
          const addr = [p.StreetName || p.AddressDescription, p.City, p.Region, p.PostalCode]
            .filter(Boolean).join(', ')
          if (addr) {
            storeAddrHtml = `<div style="margin-top:12px;padding:10px;background:#2a2d31;border-radius:6px;">
  <font face="'rodin', Arial, Helvetica, sans-serif" color="#b5bac1" size="3">
    Delivering from: Store #${escape(cart.storeId)} ${escape(addr)}
  </font>
</div>`
          }
        }
      } catch (e) {
        console.error('Dominos store profile fetch error (non-critical):', e.message)
      }
    }
    html = strReplace(html, '{$STORE_ADDRESS}', storeAddrHtml)

    let itemsSummary = ''
    let total = 0
    for (const item of cart.items) {
      const p = parseFloat(item.price || 0)
      const qty = item.qty || 1
      total += p * qty
      itemsSummary += `<div class="food-summary-item">
  <span>${escape(item.name || item.code)} ×${qty}</span>
  <span>$${(p * qty).toFixed(2)}</span>
</div>`
    }
    html = strReplace(html, '{$ORDER_SUMMARY}', itemsSummary)
    html = strReplace(html, '{$ORDER_TOTAL}', total.toFixed(2))

    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Verify code page ---
  if (subpath === 'verify') {
    const verifyCart = getCart(req)
    const verifyCartCount = (verifyCart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    let html = strReplace(templates.verify, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$CART_COUNT}', String(verifyCartCount))
    const errorText = parsedurl.searchParams.get('error') || ''
    html = strReplace(html, '{$ERROR}', errorText
      ? `<div class="food-error">${escape(errorText)}</div>`
      : '')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Tracker page ---
  if (subpath === 'track') {
    const trackCart = getCart(req)
    const trackCartCount = (trackCart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    let html = strReplace(templates.track, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$CART_COUNT}', String(trackCartCount))
    // Show the user's most recent order info
    const lastOrder = auth.dbQuerySingle(
      'SELECT store_name, timestamp FROM pizza_orders WHERE discordID=? ORDER BY timestamp DESC LIMIT 1',
      [discordID]
    )
    let orderInfo = ''
    if (lastOrder && lastOrder.timestamp) {
      orderInfo = `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd">
        <b>Most recent order:</b> ${escape(lastOrder.store_name || 'Unknown store')}<br>
        <b>Placed:</b> ${escape(formatTimestamp(lastOrder.timestamp, req))}
      </font>`
    } else {
      orderInfo = `<font face="'rodin', Arial, Helvetica, sans-serif" color="#b5bac1">No recent orders found.</font>`
    }
    html = strReplace(html, '{$ORDER_INFO}', orderInfo)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Receipts / order history ---
  if (subpath === 'receipts') {
    const receiptCart = getCart(req)
    const receiptCartCount = (receiptCart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    const orders = auth.dbQueryAll(
      'SELECT * FROM pizza_orders WHERE discordID=? ORDER BY timestamp DESC',
      [discordID]
    )
    let html = strReplace(templates.receipts, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$CART_COUNT}', String(receiptCartCount))

    const justPlaced = parsedurl.searchParams.get('placed') === '1'
    const noticeHtml = justPlaced
      ? `<div class="food-success-box"><font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Your order has been placed!</b> Your name, address, phone, and email were used only to send the order and have not been saved to our servers. Only your items, total, and store are stored for your receipt.</font></div>`
      : ''
    html = strReplace(html, '{$NOTICE}', noticeHtml)

    let ordersHtml = ''
    if (orders && orders.length > 0) {
      for (const order of orders) {
        const date = formatTimestamp(order.timestamp, req)
        let items = []
        try { items = JSON.parse(order.items_json) } catch (e) {}
        const itemsList = items.map(i => `${escape(i.name || i.code)} ×${i.qty || 1}`).join(', ')
        ordersHtml += `<div class="food-receipt-card">
  <div class="food-receipt-header">
    <span class="food-receipt-store">${escape(order.store_name || `Store #${order.store_id}`)}</span>
    <span class="food-receipt-date">${escape(date)}</span>
  </div>
  <div class="food-receipt-items">${itemsList || '<em>No item details</em>'}</div>
  <div class="food-receipt-footer">
    <span class="food-receipt-total">Total: $${parseFloat(order.total || 0).toFixed(2)}</span>
    <a href="/food/track" class="food-btn food-btn-sm">Track</a>
  </div>
</div>`
      }
    } else {
      ordersHtml = '<font face="\'rodin\', Arial, Helvetica, sans-serif" color="#b5bac1">No orders yet.</font>'
    }
    html = strReplace(html, '{$ORDERS}', ordersHtml)

    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Cancel order (clears pending verification and checkout cookie) ---
  if (subpath === 'cancel-order') {
    auth.dbQueryRun('DELETE FROM pizza_verifications WHERE discordID=?', [discordID])
    res.writeHead(302, {
      Location: '/food/cart',
      'Set-Cookie': 'pizzaCheckout=; path=/food; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT',
    })
    return res.end()
  }

  // --- Customize item (size/variant picker + toppings) ---
  if (subpath === 'customize') {
    const storeId = (parsedurl.searchParams.get('store') || '').replace(/[^0-9]/g, '')
    const productCode = (parsedurl.searchParams.get('code') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50)
    const variantCode = (parsedurl.searchParams.get('variant') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50)
    const country = parsedurl.searchParams.get('country') === 'ca' ? 'ca' : 'us'
    const backUrl = (() => {
      const raw = parsedurl.searchParams.get('back') || ''
      return /^\/food\//.test(raw) ? raw.slice(0, 300) : `/food/menu?store=${encodeURIComponent(storeId)}&country=${country}`
    })()

    if (!storeId || !productCode) {
      res.writeHead(302, { Location: '/food/' })
      return res.end()
    }

    const dominosHost = country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com'
    let menuData = null
    try {
      const result = await dominosRequest({
        hostname: dominosHost,
        path: `/power/store/${encodeURIComponent(storeId)}/menu?lang=en&structured=true`,
        method: 'GET',
      })
      if (result.status >= 200 && result.status < 300) menuData = result.data
    } catch (e) {
      console.error('Dominos menu fetch error (customize):', e)
    }

    const custCart = getCart(req)
    const custCartCount = (custCart.items || []).reduce((s, i) => s + (i.qty || 1), 0)
    let html = strReplace(templates.customize, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$CART_COUNT}', String(custCartCount))
    html = strReplace(html, '{$STORE_ID}', escape(storeId))
    html = strReplace(html, '{$COUNTRY}', escape(country))
    html = strReplace(html, '{$BACK_URL}', escape(backUrl))

    if (menuData) {
      const products = menuData.Products || {}
      const variants = menuData.Variants || {}
      const product = products[productCode]
      if (!product) {
        res.writeHead(302, { Location: backUrl })
        return res.end()
      }

      const pName = escape(product.Name || productCode)
      const pDesc = escape((product.Description || '').slice(0, 200))

      html = strReplace(html, '{$PRODUCT_NAME}', pName)
      html = strReplace(html, '{$PRODUCT_DESC}', pDesc)

      const productVariants = product.Variants || []

      if (!variantCode) {
        // Step 1: Show size picker
        let sizeOptionsHtml = ''
        if (productVariants.length > 1) {
          sizeOptionsHtml = `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Choose a size:</b></font><br><br>`
          for (const vCode of productVariants) {
            const v = variants[vCode]
            if (!v) continue
            const vPrice = parseFloat(v.Price || 0)
            const vSizeName = escape(v.Name || vCode)
            const customizeUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(productCode)}&variant=${encodeURIComponent(vCode)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(backUrl)}`
            sizeOptionsHtml += `<div class="food-size-option">
  <a href="${customizeUrl}" class="food-size-link">
    ${vSizeName}${vPrice > 0 ? `<span class="food-size-price">$${vPrice.toFixed(2)}</span>` : ''}
  </a>
</div>`
          }
        } else if (productVariants.length === 1) {
          // Single size — redirect directly to toppings step
          const vCode = productVariants[0]
          const redirectUrl = `/food/customize?store=${encodeURIComponent(storeId)}&code=${encodeURIComponent(productCode)}&variant=${encodeURIComponent(vCode)}&country=${encodeURIComponent(country)}&back=${encodeURIComponent(backUrl)}`
          res.writeHead(302, { Location: redirectUrl })
          return res.end()
        } else {
          sizeOptionsHtml = `<form method="POST" action="/food/cart/add">
  <input type="hidden" name="storeId" value="${escape(storeId)}">
  <input type="hidden" name="country" value="${escape(country)}">
  <input type="hidden" name="code" value="${escape(productCode)}">
  <input type="hidden" name="name" value="${pName}">
  <input type="hidden" name="price" value="0">
  <input type="hidden" name="redirect" value="${escape(backUrl)}">
  <button type="submit" class="food-btn food-btn-large">Add to Cart</button>
  &#160;&#160;
  <a href="${escape(backUrl)}" class="food-btn food-btn-secondary">Cancel</a>
</form>`
        }
        html = strReplace(html, '{$SIZE_OPTIONS}', sizeOptionsHtml)
        html = strReplace(html, '{$TOPPINGS_SECTION}', '')
      } else {
        // Step 2: Show toppings/sauce for selected variant
        const v = variants[variantCode]
        if (!v) {
          res.writeHead(302, { Location: backUrl })
          return res.end()
        }
        const vPrice = parseFloat(v.Price || 0)
        const vFullName = escape(`${v.Name || ''} ${product.Name || productCode}`.trim())

        // Show selected size confirmation
        const sizeHtml = `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd">
  <b>Size:</b> ${escape(v.Name || variantCode)}${vPrice > 0 ? ` — $${vPrice.toFixed(2)}` : ''}
  &#160;<a href="/food/customize?store=${encodeURIComponent(storeId)}&amp;code=${encodeURIComponent(productCode)}&amp;country=${encodeURIComponent(country)}&amp;back=${encodeURIComponent(backUrl)}" class="food-back-link" style="font-size:0.85rem">Change size</a>
</font>`
        html = strReplace(html, '{$SIZE_OPTIONS}', sizeHtml)

        // Build toppings/sauce form
        // Get the product type for scoped topping lookup (e.g. "Pizza", "Wings")
        // Per WiiLink/Demae-Dominos: only use the exact Toppings[productType] category
        const productType = product.ProductType || ''
        const toppingDict = buildToppingDict(menuData, productType)

        // Parse AvailableToppings — returns code set and per-code portion options
        // e.g. "X=0:0.5:1:1.5,C=0:0.5:1:1.5,P=1/1" → codeSet=Set{X,C,P}, portions=Map{X:["0","0.5","1","1.5"]}
        const { codeSet, portions } = parseAvailableToppings(product.AvailableToppings)

        // If AvailableToppings is empty, show ALL toppings for this productType (specialty pizzas
        // omit AvailableToppings but still support customization). If the toppingDict is also empty
        // (productType not in Toppings), no customization section is shown.
        const finalCodeSet = codeSet.size > 0 ? codeSet : new Set(Object.keys(toppingDict))

        // Get default options from the variant (e.g. {X: {"1/1": "1"}, C: {"1/1": "1"}})
        const defaultOptions = v.Options || {}

        const PORTION_LABELS = { '0': 'None', '0.5': 'Light', '1': 'Normal', '1.5': 'Extra' }
        // Used when a topping code exists in toppingDict but has no portion info in AvailableToppings
        const DEFAULT_PORTIONS = ['0', '1']

        let toppingsSection = ''
        if (finalCodeSet.size > 0 && Object.keys(toppingDict).length > 0) {
          const { sauces, toppings: toppingList } = classifyToppings(toppingDict, finalCodeSet)

          toppingsSection = `<div class="food-card"><form method="POST" action="/food/cart/add">
  <input type="hidden" name="storeId" value="${escape(storeId)}">
  <input type="hidden" name="country" value="${escape(country)}">
  <input type="hidden" name="code" value="${escape(variantCode)}">
  <input type="hidden" name="name" value="${vFullName}">
  <input type="hidden" name="price" value="${vPrice.toFixed(2)}">
  <input type="hidden" name="redirect" value="${escape(backUrl)}">`

          if (sauces.length > 0) {
            toppingsSection += `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Sauce</b></font><br><br>`
            for (const s of sauces) {
              // Get default sauce amount from variant Options (same logic as toppings)
              const defaultEntry = defaultOptions[s.code]
              const defaultAmt = defaultEntry
                ? (defaultEntry['1/1'] || '1')
                : '0'
              const rawPortions = portions.get(s.code) || DEFAULT_PORTIONS
              const portionSet = new Set(rawPortions)
              if (defaultAmt !== '0') portionSet.add(defaultAmt)
              const portionList = Array.from(portionSet).sort((a, b) => parseFloat(a) - parseFloat(b))
              let optHtml = ''
              for (const p of portionList) {
                const label = PORTION_LABELS[p] || p
                const sel = p === defaultAmt ? ' selected' : ''
                optHtml += `<option value="${escape(p)}"${sel}>${escape(label)}</option>`
              }
              toppingsSection += `<div style="padding:4px 0;font-family:'rodin',Arial,Helvetica,sans-serif;color:#dddddd">
  ${escape(s.name)}: <select name="sauce_${escape(s.code)}" style="background:#222327;color:#dddddd;border:none;border-radius:4px;padding:2px 4px">
${optHtml}
  </select>
</div>`
            }
            toppingsSection += '<br>'
          }

          if (toppingList.length > 0) {
            toppingsSection += `<font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>Toppings</b></font><br><br>`
            for (const t of toppingList) {
              // Get the default amount from Options (e.g. {X: {"1/1": "1"}} → "1")
              const defaultEntry = defaultOptions[t.code]
              const defaultAmt = defaultEntry
                ? (defaultEntry['1/1'] || '1')
                : '0'
              // Get allowed portion values for this topping; DEFAULT_PORTIONS used when no
              // portion info was present in AvailableToppings for this code
              const rawPortions = portions.get(t.code) || DEFAULT_PORTIONS
              // Ensure the default amount is present in the list; insert at correct numeric position
              const portionSet = new Set(rawPortions)
              if (defaultAmt !== '0') portionSet.add(defaultAmt)
              const portionList = Array.from(portionSet).sort((a, b) => parseFloat(a) - parseFloat(b))
              // Build select options with labels
              let optHtml = ''
              for (const p of portionList) {
                const label = PORTION_LABELS[p] || p
                const sel = p === defaultAmt ? ' selected' : ''
                optHtml += `<option value="${escape(p)}"${sel}>${escape(label)}</option>`
              }
              toppingsSection += `<div style="padding:4px 0;font-family:'rodin',Arial,Helvetica,sans-serif;color:#dddddd">
  ${escape(t.name)}: <select name="topping_${escape(t.code)}" style="background:#222327;color:#dddddd;border:none;border-radius:4px;padding:2px 4px">
${optHtml}
  </select>
</div>`
            }
            toppingsSection += '<br>'
          }

          toppingsSection += `  <div style="margin-top:16px">
    <button type="submit" class="food-btn food-btn-large">Add to Cart${vPrice > 0 ? ` — $${vPrice.toFixed(2)}` : ''}</button>
    &#160;&#160;
    <a href="${escape(backUrl)}" class="food-btn food-btn-secondary">Cancel</a>
  </div>
</form></div>`
        } else {
          // No topping info — just a direct add form
          toppingsSection = `<div class="food-card"><form method="POST" action="/food/cart/add">
  <input type="hidden" name="storeId" value="${escape(storeId)}">
  <input type="hidden" name="country" value="${escape(country)}">
  <input type="hidden" name="code" value="${escape(variantCode)}">
  <input type="hidden" name="name" value="${vFullName}">
  <input type="hidden" name="price" value="${vPrice.toFixed(2)}">
  <input type="hidden" name="redirect" value="${escape(backUrl)}">
  <div style="margin-top:8px">
    <button type="submit" class="food-btn food-btn-large">Add to Cart${vPrice > 0 ? ` — $${vPrice.toFixed(2)}` : ''}</button>
    &#160;&#160;
    <a href="${escape(backUrl)}" class="food-btn food-btn-secondary">Cancel</a>
  </div>
</form></div>`
        }
        html = strReplace(html, '{$TOPPINGS_SECTION}', toppingsSection)
      }
    } else {
      html = strReplace(html, '{$PRODUCT_NAME}', escape(productCode))
      html = strReplace(html, '{$PRODUCT_DESC}', '')
      html = strReplace(html, '{$SIZE_OPTIONS}',
        `<div class="food-error">Could not load menu. Please go back and try again.</div>`)
      html = strReplace(html, '{$TOPPINGS_SECTION}', '')
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/html' })
  res.end('<html><body style="background:#1A1A1E;color:#ddd;font-family:\'rodin\',sans-serif;padding:40px"><h1>Not Found</h1><a href="/food/" style="color:#00aff4">Back to Pizza</a></body></html>')
}

// =============================================================================
// POST handler
// =============================================================================
exports.handlePost = async function (bot, req, res, discordID, body) {
  const parsedurl = new URL(req.url, 'http://localhost')
  const subpath = parsedurl.pathname.replace(/^\/food\/?/, '').replace(/\/$/, '')
  const secure = isSecure(req)

  let params = {}
  try {
    params = querystring.parse(body)
  } catch (e) {}

  // --- Add item to cart ---
  if (subpath === 'cart/add') {
    const cart = getCart(req)
    const storeId = (params.storeId || '').replace(/[^0-9]/g, '')
    const country = params.country === 'ca' ? 'ca' : 'us'
    const code = (params.code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50)
    const name = (params.name || '').slice(0, 100)
    const price = parseFloat(params.price) || 0
    // Only allow relative /food/ redirects to prevent open redirect
    const rawRedirect = params.redirect || ''
    const redirect = /^\/food\//.test(rawRedirect) ? rawRedirect.slice(0, 300) : '/food/cart'

    if (!code) {
      res.writeHead(302, { Location: redirect })
      return res.end()
    }

    // Reset cart if store changed
    if (cart.storeId && cart.storeId !== storeId) {
      cart.items = []
    }
    cart.storeId = storeId
    cart.country = country

    // Parse topping/sauce options from form
    const options = parseOptions(params)

    const existing = cart.items.find(i => i.code === code)
    if (existing) {
      existing.qty = (existing.qty || 1) + 1
      // Update options if provided
      if (Object.keys(options).length > 0) {
        existing.options = options
      }
    } else {
      cart.items.push({ code, name, qty: 1, price, options })
    }

    res.writeHead(302, {
      Location: redirect,
      'Set-Cookie': cartCookieHeader(cart, secure),
    })
    return res.end()
  }

  // --- Remove item from cart ---
  if (subpath === 'cart/remove') {
    const cart = getCart(req)
    const idx = parseInt(params.index)
    if (!isNaN(idx) && idx >= 0 && idx < cart.items.length) {
      cart.items.splice(idx, 1)
    }
    res.writeHead(302, {
      Location: '/food/cart',
      'Set-Cookie': cartCookieHeader(cart, secure),
    })
    return res.end()
  }

  // --- Request Discord DM verification ---
  if (subpath === 'request-verify') {
    const cart = getCart(req)
    if (!cart.items || cart.items.length === 0) {
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Your cart is empty.') })
      return res.end()
    }

    // Use crypto.randomInt for cryptographically secure 6-digit code
    const code = String(crypto.randomInt(VERIFICATION_CODE_MIN, VERIFICATION_CODE_MAX))
    const expires = unixTime() + 10 * 60 // 10 minutes

    // Only store the verification code + expiry in DB — no PII
    auth.dbQueryRun(
      'INSERT OR REPLACE INTO pizza_verifications (discordID, code, cart_json, expires) VALUES (?,?,?,?)',
      [discordID, code, '', expires]
    )

    // Validate and sanitize phone: digits only, 10 digits for US/CA
    const rawPhone = (params.phone || '').replace(/\D/g, '').slice(0, 10)
    if (!rawPhone || rawPhone.length < 7) {
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Please enter a valid phone number.') })
      return res.end()
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
      city: (params.city || '').slice(0, 50),
      region: (params.region || '').slice(0, 2).toUpperCase(),
      postalCode: (params.postalCode || '').replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 10),
      tip: Math.min(parseFloat(params.tip_custom) > 0 ? parseFloat(params.tip_custom) : (parseFloat(params.tip) || 0), 100),
    }
    const checkoutCookie = Buffer.from(JSON.stringify(checkoutData)).toString('base64')
    const checkoutCookieHeader = `pizzaCheckout=${encodeURIComponent(checkoutCookie)}; path=/food; HttpOnly${secure ? '; Secure' : ''}; Max-Age=600`

    const sent = await bot.sendPizzaVerification(discordID, code)
    if (!sent) {
      res.writeHead(302, {
        Location: '/food/checkout?error=' + encodeURIComponent('Could not send Discord DM. Please make sure DMs from server members are enabled.'),
      })
      return res.end()
    }

    res.writeHead(302, {
      Location: '/food/verify',
      'Set-Cookie': checkoutCookieHeader,
    })
    return res.end()
  }

  // --- Place order (after code verification) ---
  if (subpath === 'place-order') {
    const code = (params.code || '').replace(/[^0-9]/g, '').slice(0, 6)
    if (!code || !/^\d{6}$/.test(code)) {
      res.writeHead(302, { Location: '/food/verify?error=' + encodeURIComponent('Invalid code format.') })
      return res.end()
    }

    const time = unixTime()
    const verification = auth.dbQuerySingle(
      'SELECT * FROM pizza_verifications WHERE discordID=? AND code=? AND expires > ?',
      [discordID, code, time]
    )
    if (!verification) {
      res.writeHead(302, { Location: '/food/verify?error=' + encodeURIComponent('Invalid or expired verification code.') })
      return res.end()
    }

    // Read checkout data from the client-side cookie (no PII was stored in DB)
    let checkoutData = null
    try {
      const cookie = req.headers.cookie || ''
      const checkoutCookie = cookie.split('; ').find(c => c.startsWith('pizzaCheckout='))
      if (checkoutCookie) {
        const val = checkoutCookie.split('=').slice(1).join('=')
        checkoutData = JSON.parse(Buffer.from(decodeURIComponent(val), 'base64').toString('utf-8'))
        console.log('[place-order] checkout cookie found, items:', checkoutData && checkoutData.cart && checkoutData.cart.items && checkoutData.cart.items.length)
      } else {
        console.error('[place-order] no pizzaCheckout cookie found')
      }
    } catch (e) {
      console.error('[place-order] failed to parse checkout cookie:', e.message)
    }

    if (!checkoutData || !checkoutData.cart || !checkoutData.cart.items || checkoutData.cart.items.length === 0) {
      console.error('[place-order] missing/empty checkout data:', JSON.stringify(checkoutData && { cart: checkoutData.cart ? { items: checkoutData.cart.items } : null }))
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Checkout session expired. Please fill out the form again.') })
      return res.end()
    }

    const { cart, firstName, lastName, email, phone, street, city, region, postalCode, tip } = checkoutData

    if (!firstName || !lastName || !email || !phone || !street || !city || !region || !postalCode) {
      console.error('[place-order] missing fields: firstName=%s lastName=%s email=%s phone=%s street=%s city=%s region=%s postalCode=%s',
        !!firstName, !!lastName, !!email, !!phone, !!street, !!city, !!region, !!postalCode)
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Missing order details. Please fill out the form again.') })
      return res.end()
    }

    const gratuityAmt = parseFloat(tip) || 0

    // Calculate total from cart items (used for receipt)
    const cartTotal = cart.items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0)

    const products = cart.items.map(item => ({
      Code: item.code,
      Qty: item.qty || 1,
      Options: item.options || {},
    }))

    const orderPayload = {
      Order: {
        Address: { Street: street, City: city, Region: region, PostalCode: postalCode, Type: 'House' },
        Coupons: [],
        CustomerID: '',
        Extension: '',
        OrderChannel: 'OLO',
        OrderID: '',
        OrderMethod: 'Web',
        OrderTaker: null,
        Payments: [{
          Type: 'Cash',
        }],
        Products: products,
        ServiceMethod: 'Delivery',
        StoreID: cart.storeId,
        Tags: {},
        Version: '1.0',
        NPC: false,
        metaData: {},
        Amounts: {},
        BusinessDate: '',
        EstimatedWaitMinutes: '',
        FirstName: firstName,
        LastName: lastName,
        Email: email,
        Phone: phone,
        GratuityAmt: gratuityAmt,
      },
    }

    let orderResult = null
    try {
      const dominosHost = cart.country === 'ca' ? 'order.dominos.ca' : 'order.dominos.com'
      const bodyStr = JSON.stringify(orderPayload)
      console.log('[place-order] sending to', dominosHost, '| storeId:', cart.storeId, '| items:', products.length, '| country:', cart.country)
      console.log('[place-order] products:', JSON.stringify(products))
      orderResult = await dominosRequest({
        hostname: dominosHost,
        path: '/power/place-order',
        method: 'POST',
      }, bodyStr)
      console.log('[place-order] HTTP status:', orderResult && orderResult.status)
      console.log('[place-order] response:', JSON.stringify(orderResult && orderResult.data))
    } catch (e) {
      console.error('[place-order] network error:', e)
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Failed to connect to Dominos. Please try again.') })
      return res.end()
    }

    const orderData = orderResult && orderResult.data && orderResult.data.Order
    const badHttpStatus = !orderResult || orderResult.status < 200 || orderResult.status >= 300
    const badApiStatus = !orderData || orderData.Status < 0
    if (badHttpStatus || badApiStatus) {
      const statusItems = orderData && orderData.StatusItems
      const errMsg = (statusItems && statusItems[0] && statusItems[0].Message)
        || 'Order failed. Please check your details and try again.'
      console.error('[place-order] FAILED | HTTP:', orderResult && orderResult.status, '| API Status:', orderData && orderData.Status, '| StatusItems:', JSON.stringify(statusItems))
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent(errMsg) })
      return res.end()
    }

    const storeId = cart.storeId || ''
    const storeAddr = orderData.StoreAddress
    const storeName = storeAddr ? `${storeAddr.City || city} Store #${storeId}` : `Store #${storeId}`

    // Use cart total for receipt (Domino's API Amounts may be 0 on cash orders)
    const total = cartTotal > 0 ? cartTotal : parseFloat((orderData.Amounts && (orderData.Amounts.Payment || orderData.Amounts.Total)) || 0)

    // Save receipt — no PII (no address/name/phone/email)
    auth.dbQueryRun(
      'INSERT INTO pizza_orders (discordID, store_id, store_name, items_json, total, timestamp) VALUES (?,?,?,?,?,?)',
      [
        discordID,
        storeId,
        storeName,
        JSON.stringify(cart.items.map(i => ({ code: i.code, name: i.name, qty: i.qty, price: i.price }))),
        total,
        unixTime(),
      ]
    )

    // Clean up verification record
    auth.dbQueryRun('DELETE FROM pizza_verifications WHERE discordID=?', [discordID])

    // Clear cart and checkout cookies, redirect to receipts with success notice
    res.writeHead(302, {
      Location: '/food/receipts?placed=1',
      'Set-Cookie': [
        clearCartCookieHeader(),
        'pizzaCheckout=; path=/food; HttpOnly; expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ],
    })
    return res.end()
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
}

// =============================================================================
// Food image proxy
// =============================================================================
exports.foodProxy = async function (req, res) {
  const parsedurl = new URL(req.url, 'http://localhost')
  // Allow only safe filename characters
  const imagePath = parsedurl.pathname.replace(/^\/foodProxy\//, '').replace(/[^a-zA-Z0-9_.\-]/g, '')

  if (!imagePath) {
    res.writeHead(404)
    return res.end()
  }

  const imageUrl = `https://cache.dominos.com/olo/6_92_1/assets/build/market/US/_en/images/img/products/larges/${imagePath}`

  try {
    await new Promise((resolve, reject) => {
      https.get(imageUrl, { headers: { 'User-Agent': 'Dominos API Wrapper' } }, (proxyRes) => {
        const chunks = []
        proxyRes.on('data', chunk => chunks.push(chunk))
        proxyRes.on('end', () => {
          const buf = Buffer.concat(chunks)
          const ct = proxyRes.headers['content-type'] || 'image/jpeg'
          res.writeHead(proxyRes.statusCode === 200 ? 200 : 404, {
            'Content-Type': ct,
            'Cache-Control': 'public, max-age=86400',
          })
          res.end(buf)
          resolve()
        })
        proxyRes.on('error', reject)
      }).on('error', reject)
    })
  } catch (e) {
    console.error('foodProxy error:', e)
    if (!res.headersSent) {
      res.writeHead(404)
      res.end()
    }
  }
}
