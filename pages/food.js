const fs = require('fs')
const https = require('https')
const escape = require('escape-html')
const querystring = require('querystring')
const crypto = require('crypto')

const auth = require('../authentication.js')

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || '')
}

function unixTime() {
  return Math.floor(Date.now() / 1000)
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
      menu: loadTemplate('menu.html'),
      cart: loadTemplate('cart.html'),
      checkout: loadTemplate('checkout.html'),
      verify: loadTemplate('verify.html'),
      track: loadTemplate('track.html'),
      receipts: loadTemplate('receipts.html'),
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
    order_key TEXT,
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
    let html = strReplace(templates.index, '{$WHITE_THEME_ENABLED}', theme)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Store search API (JSON) ---
  if (subpath === 'store-search') {
    const address = parsedurl.searchParams.get('address') || ''
    if (!address) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Address required' }))
    }
    try {
      const result = await dominosRequest({
        hostname: 'order.dominos.com',
        path: `/power/store-locator?type=Delivery&c=${encodeURIComponent(address)}&s=&a=`,
        method: 'GET',
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(result.data))
    } catch (e) {
      console.error('Dominos store-search error:', e)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Failed to find stores' }))
    }
  }

  // --- Menu ---
  if (subpath === 'menu') {
    const storeId = (parsedurl.searchParams.get('store') || '').replace(/[^0-9]/g, '')
    const category = parsedurl.searchParams.get('category') || ''

    if (!storeId) {
      res.writeHead(302, { Location: '/food/' })
      return res.end()
    }

    let menuData = null
    try {
      const result = await dominosRequest({
        hostname: 'order.dominos.com',
        path: `/power/store/${encodeURIComponent(storeId)}/menu?lang=en&structured=true`,
        method: 'GET',
      })
      if (result.status === 200) menuData = result.data
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
      const categories = menuData.Categorization || {}
      const topLevel = Object.keys(categories)
      const selectedCat = category || topLevel[0] || ''

      // Category tabs
      let catTabs = ''
      for (const cat of topLevel) {
        const active = (selectedCat === cat) ? ' food-tab-active' : ''
        catTabs += `<a href="/food/menu?store=${encodeURIComponent(storeId)}&amp;category=${encodeURIComponent(cat)}" class="food-tab${active}">${escape(categories[cat].Name || cat)}</a>`
      }
      html = strReplace(html, '{$CATEGORY_TABS}', catTabs)

      // Collect product codes for selected category
      const catData = categories[selectedCat]
      let productCodes = []
      if (catData) {
        if (catData.Products && catData.Products.length) {
          productCodes = catData.Products
        } else if (catData.Subcategories) {
          for (const sub of Object.values(catData.Subcategories)) {
            if (sub.Products) productCodes = productCodes.concat(sub.Products)
          }
        }
      }

      const products = menuData.Products || {}
      const variants = menuData.Variants || {}
      let itemsHtml = ''

      for (const code of productCodes.slice(0, 50)) {
        const p = products[code]
        if (!p) continue
        const name = escape(p.Name || code)
        const desc = escape((p.Description || '').slice(0, 120))

        // Pick lowest-price variant
        let price = ''
        if (p.Variants && p.Variants.length) {
          const prices = p.Variants
            .map(v => parseFloat((variants[v] || {}).Price || 0))
            .filter(v => v > 0)
          if (prices.length) price = `$${Math.min(...prices).toFixed(2)}`
        }

        const imgCode = (p.ImageCode || code).replace(/[^a-zA-Z0-9_-]/g, '')
        const imgUrl = `/foodProxy/${encodeURIComponent(imgCode)}.jpg`
        const safeCode = escape(code)
        const safeName = escape(p.Name || code)
        const safePrice = escape(price.replace('$', '') || '0')
        const safeStoreId = escape(storeId)
        const safeRedirect = escape(req.url)

        itemsHtml += `<div class="food-item-card">
  <img src="${imgUrl}" alt="${name}" class="food-item-img" onerror="this.style.display='none'">
  <div class="food-item-info">
    <div class="food-item-name">${name}</div>
    <div class="food-item-desc">${desc}</div>
    <div class="food-item-price">${escape(price)}</div>
    <form method="POST" action="/food/cart/add">
      <input type="hidden" name="storeId" value="${safeStoreId}">
      <input type="hidden" name="code" value="${safeCode}">
      <input type="hidden" name="name" value="${safeName}">
      <input type="hidden" name="price" value="${safePrice}">
      <input type="hidden" name="redirect" value="${safeRedirect}">
      <button type="submit" class="food-btn">Add to Cart</button>
    </form>
  </div>
</div>`
      }
      if (!itemsHtml) itemsHtml = '<p style="color:#b5bac1">No items found in this category.</p>'
      html = strReplace(html, '{$MENU_ITEMS}', itemsHtml)
    } else {
      html = strReplace(html, '{$CATEGORY_TABS}', '')
      html = strReplace(html, '{$MENU_ITEMS}', '<p style="color:#b5bac1">Could not load menu. Please try again.</p>')
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Cart view ---
  if (subpath === 'cart') {
    const cart = getCart(req)
    let html = strReplace(templates.cart, '{$WHITE_THEME_ENABLED}', theme)

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
      itemsHtml = '<tr><td colspan="4" style="color:#b5bac1;padding:16px">Your cart is empty.</td></tr>'
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

    let html = strReplace(templates.checkout, '{$WHITE_THEME_ENABLED}', theme)
    const errorText = parsedurl.searchParams.get('error') || ''
    html = strReplace(html, '{$ERROR}', errorText
      ? `<div class="food-error">${escape(errorText)}</div>`
      : '')

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
    let html = strReplace(templates.verify, '{$WHITE_THEME_ENABLED}', theme)
    const errorText = parsedurl.searchParams.get('error') || ''
    html = strReplace(html, '{$ERROR}', errorText
      ? `<div class="food-error">${escape(errorText)}</div>`
      : '')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Tracker page ---
  if (subpath === 'track') {
    const phone = (parsedurl.searchParams.get('phone') || '').replace(/[^0-9]/g, '').slice(0, 10)
    let html = strReplace(templates.track, '{$WHITE_THEME_ENABLED}', theme)
    html = strReplace(html, '{$PHONE}', escape(phone))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // --- Tracker status API (JSON, polled by client JS) ---
  if (subpath === 'track-status') {
    const phone = (parsedurl.searchParams.get('phone') || '').replace(/[^0-9]/g, '')
    if (!phone || phone.length !== 10) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Invalid phone number' }))
    }
    try {
      const result = await dominosRequest({
        hostname: 'tracker.dominos.com',
        path: `/tracker/user/pizza?phonenumber=${encodeURIComponent(phone)}`,
        method: 'GET',
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(result.data))
    } catch (e) {
      console.error('Dominos tracker error:', e)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Failed to fetch tracking data' }))
    }
  }

  // --- Receipts / order history ---
  if (subpath === 'receipts') {
    const orders = auth.dbQueryAll(
      'SELECT * FROM pizza_orders WHERE discordID=? ORDER BY timestamp DESC',
      [discordID]
    )
    let html = strReplace(templates.receipts, '{$WHITE_THEME_ENABLED}', theme)

    let ordersHtml = ''
    if (orders && orders.length > 0) {
      for (const order of orders) {
        const date = new Date(order.timestamp * 1000).toLocaleString()
        let items = []
        try { items = JSON.parse(order.items_json) } catch (e) {}
        const itemsList = items.map(i => `${escape(i.name || i.code)} ×${i.qty || 1}`).join(', ')
        const trackKey = escape(order.order_key || '')
        ordersHtml += `<div class="food-receipt-card">
  <div class="food-receipt-header">
    <span class="food-receipt-store">${escape(order.store_name || `Store #${order.store_id}`)}</span>
    <span class="food-receipt-date">${escape(date)}</span>
  </div>
  <div class="food-receipt-items">${itemsList || '<em>No item details</em>'}</div>
  <div class="food-receipt-footer">
    <span class="food-receipt-total">Total: $${parseFloat(order.total || 0).toFixed(2)}</span>
    <a href="/food/track" class="food-btn food-btn-sm" title="Track order ${trackKey}">Track</a>
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

    const existing = cart.items.find(i => i.code === code)
    if (existing) {
      existing.qty = (existing.qty || 1) + 1
    } else {
      cart.items.push({ code, name, qty: 1, price, options: {} })
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
    const code = String(crypto.randomInt(100000, 1000000))
    const expires = unixTime() + 10 * 60 // 10 minutes

    // Only store the verification code + expiry in DB — no PII
    auth.dbQueryRun(
      'INSERT OR REPLACE INTO pizza_verifications (discordID, code, cart_json, expires) VALUES (?,?,?,?)',
      [discordID, code, '', expires]
    )

    // Store checkout form data in a short-lived HttpOnly cookie.
    // This keeps all PII client-side; the server never persists it.
    // Payment is cash on delivery — no card data collected.
    const checkoutData = {
      cart,
      firstName: (params.firstName || '').slice(0, 50),
      lastName: (params.lastName || '').slice(0, 50),
      email: (params.email || '').slice(0, 100),
      phone: (params.phone || '').replace(/[^0-9]/g, '').slice(0, 10),
      street: (params.street || '').slice(0, 100),
      city: (params.city || '').slice(0, 50),
      region: (params.region || '').slice(0, 2).toUpperCase(),
      postalCode: (params.postalCode || '').replace(/[^a-zA-Z0-9 -]/g, '').slice(0, 10),
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
      }
    } catch (e) {
      console.error('place-order: failed to parse checkout cookie:', e.message)
    }

    if (!checkoutData || !checkoutData.cart || !checkoutData.cart.items || checkoutData.cart.items.length === 0) {
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Checkout session expired. Please fill out the form again.') })
      return res.end()
    }

    const { cart, firstName, lastName, email, phone, street, city, region, postalCode } = checkoutData

    if (!firstName || !lastName || !email || !phone || !street || !city || !region || !postalCode) {
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Missing order details. Please fill out the form again.') })
      return res.end()
    }

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
        Phone: phone,
        FirstName: firstName,
        LastName: lastName,
        Email: email,
      },
    }

    let orderResult = null
    try {
      const bodyStr = JSON.stringify(orderPayload)
      orderResult = await dominosRequest({
        hostname: 'order.dominos.com',
        path: '/power/place-order',
        method: 'POST',
      }, bodyStr)
    } catch (e) {
      console.error('Dominos place-order error:', e)
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent('Failed to connect to Dominos. Please try again.') })
      return res.end()
    }

    const orderData = orderResult && orderResult.data && orderResult.data.Order
    if (!orderResult || orderResult.status !== 200 || !orderData || !orderData.OrderID) {
      const errMsg = (orderData && orderData.StatusItems && orderData.StatusItems[0] && orderData.StatusItems[0].Message)
        || 'Order failed. Please check your details and try again.'
      res.writeHead(302, { Location: '/food/checkout?error=' + encodeURIComponent(errMsg) })
      return res.end()
    }

    const orderKey = orderData.OrderID || ''
    const storeId = cart.storeId || ''
    const storeAddr = orderData.StoreAddress
    const storeName = storeAddr ? `${storeAddr.City || city} Store #${storeId}` : `Store #${storeId}`
    const total = parseFloat((orderData.Amounts && orderData.Amounts.Payment) || 0)

    // Save receipt — no PII (no address/name/phone/email/card)
    auth.dbQueryRun(
      'INSERT INTO pizza_orders (discordID, order_key, store_id, store_name, items_json, total, timestamp) VALUES (?,?,?,?,?,?,?)',
      [
        discordID,
        orderKey,
        storeId,
        storeName,
        JSON.stringify(cart.items.map(i => ({ code: i.code, name: i.name, qty: i.qty, price: i.price }))),
        total,
        unixTime(),
      ]
    )

    // Clean up verification record
    auth.dbQueryRun('DELETE FROM pizza_verifications WHERE discordID=?', [discordID])

    // Clear cart and checkout cookies, redirect to receipts
    res.writeHead(302, {
      Location: '/food/receipts',
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

  const imageUrl = `https://cache.dominos.com/nolo/en/market/NOLO/ng/images/products/en/${imagePath}`

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
