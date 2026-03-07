'use strict';

const fs = require('fs');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { strReplace, getPageThemeAttr, httpsGet } = require('./utils.js');

const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;

// Maximum ticker symbol length to prevent abuse
const TICKER_MAX_LENGTH = 10;

// Stooq symbols for major indices (no API key required)
const TOP_SYMBOLS = ['^dji', '^spx', '^ndq'];

const DISPLAY_NAMES = {
  '^dji': 'Dow Jones Industrial Average',
  '^spx': 'S&P 500',
  '^ndq': 'NASDAQ',
};

const stocks_template = fs
  .readFileSync('pages/templates/stocks.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

/**
 * Fetch a real-time quote from Yahoo Finance v8 chart API for a single symbol.
 * No API key or authentication required.
 * Returns a Promise resolving to a quote object or null.
 */
function fetchYahooQuote(symbol) {
  const s = encodeURIComponent(symbol.toUpperCase());
  const options = {
    hostname: 'query1.finance.yahoo.com',
    path: `/v8/finance/chart/${s}?range=5d&interval=1d&includePrePost=false`,
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'identity',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://finance.yahoo.com/',
      Origin: 'https://finance.yahoo.com',
    },
  };
  return httpsGet(options, 5).then(({ statusCode, body }) => {
    if (statusCode !== 200) return null;
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return null;
    }
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const close = meta.regularMarketPrice;
    if (!close) return null;
    const prevClose = meta.chartPreviousClose || meta.previousClose || null;
    const change = prevClose !== null ? close - prevClose : null;
    const changePct =
      prevClose !== null && prevClose !== 0 ? ((close - prevClose) / prevClose) * 100 : null;
    return {
      symbol: meta.symbol || symbol.toUpperCase(),
      regularMarketPrice: close,
      regularMarketOpen: meta.regularMarketOpen || null,
      regularMarketDayHigh: meta.regularMarketDayHigh || null,
      regularMarketDayLow: meta.regularMarketDayLow || null,
      regularMarketVolume: meta.regularMarketVolume || null,
      regularMarketChange: change,
      regularMarketChangePercent: changePct,
    };
  });
}

/**
 * Fetch daily historical data from stooq.com for a single symbol.
 * Returns a Promise resolving to a quote object (latest completed day) or null.
 *
 * Uses the daily history endpoint which always has data regardless of market hours.
 * Format: Date,Open,High,Low,Close,Volume (ascending date order)
 */
function fetchStooqHistory(symbol) {
  // Index symbols use ^ prefix; regular stock tickers need .us suffix for US stocks
  const stooqSymbol = !symbol.startsWith('^') && !symbol.includes('.') ? symbol + '.us' : symbol;
  const s = encodeURIComponent(stooqSymbol);
  // i=d: daily bars; returns last ~5 years ascending by date
  const options = {
    hostname: 'stooq.com',
    path: `/q/d/l/?s=${s}&i=d`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/csv,text/plain,*/*',
      'Accept-Encoding': 'identity',
      Referer: 'https://stooq.com/',
    },
  };
  return httpsGet(options, 3).then(({ statusCode, body }) => {
    if (statusCode !== 200) {
      throw new Error(`Stooq returned HTTP ${statusCode} for ${symbol}`);
    }
    // If stooq returned an HTML error page instead of CSV, treat as no data
    if (body.trimStart().startsWith('<')) {
      return null;
    }
    // Pass original display symbol (without .us suffix) to the parser
    return parseStooqHistory(symbol, body);
  });
}

/**
 * Parse stooq daily history CSV.
 * Returns a quote object built from the most recent two rows (for change calculation).
 * Returns null if not enough data rows.
 */
function parseStooqHistory(symbol, csv) {
  const lines = csv.trim().split('\n');
  // Need at least header + 2 data rows for change calculation
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const closeIdx = headers.indexOf('close');
  const openIdx = headers.indexOf('open');
  const highIdx = headers.indexOf('high');
  const lowIdx = headers.indexOf('low');
  const volumeIdx = headers.indexOf('volume');

  if (closeIdx === -1) return null;

  // Rows are ascending by date — last row is most recent
  const rows = [];
  for (let i = lines.length - 1; i >= 1; i--) {
    const values = lines[i].split(',');
    if (values.length < headers.length) continue;
    const close = parseFloat(values[closeIdx]);
    if (isNaN(close)) continue;
    rows.push(values);
    if (rows.length === 2) break;
  }

  if (rows.length === 0) return null;

  const latest = rows[0];
  const previous = rows[1] || null;

  const close = parseFloat(latest[closeIdx]);
  const open = openIdx !== -1 ? parseFloat(latest[openIdx]) : NaN;
  const high = highIdx !== -1 ? parseFloat(latest[highIdx]) : NaN;
  const low = lowIdx !== -1 ? parseFloat(latest[lowIdx]) : NaN;
  const volume = volumeIdx !== -1 ? parseInt(latest[volumeIdx], 10) : NaN;

  // Use previous close (prior trading day) for daily change, fall back to open
  const pc = previous ? parseFloat(previous[closeIdx]) : NaN;
  const prevClose = !isNaN(pc) ? pc : null;
  const basePrice = prevClose !== null ? prevClose : !isNaN(open) ? open : null;

  const change = basePrice !== null ? close - basePrice : null;
  const changePct =
    basePrice !== null && basePrice !== 0 ? ((close - basePrice) / basePrice) * 100 : null;

  return {
    symbol: symbol.toUpperCase(),
    regularMarketPrice: close,
    regularMarketOpen: isNaN(open) ? null : open,
    regularMarketDayHigh: isNaN(high) ? null : high,
    regularMarketDayLow: isNaN(low) ? null : low,
    regularMarketVolume: isNaN(volume) ? null : volume,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
  };
}

function formatPrice(price) {
  if (price === null) return '--';
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatChange(change) {
  if (change === null) return '--';
  const sign = change >= 0 ? '+' : '';
  return sign + change.toFixed(2);
}

function formatChangePct(pct) {
  if (pct === null) return '--';
  const sign = pct >= 0 ? '+' : '';
  return sign + pct.toFixed(2) + '%';
}

function changeColor(change) {
  if (change === null) return '#72767d';
  return change >= 0 ? '#57f287' : '#ed4245';
}

function renderQuoteRow(quote) {
  const name = escape(DISPLAY_NAMES[quote.symbol.toLowerCase()] || quote.symbol || '');
  const symbol = escape(quote.symbol || '');
  const price = formatPrice(quote.regularMarketPrice);
  const change = formatChange(quote.regularMarketChange);
  const changePct = formatChangePct(quote.regularMarketChangePercent);
  const color = changeColor(quote.regularMarketChange);
  const dayOpen = quote.regularMarketOpen !== null ? formatPrice(quote.regularMarketOpen) : '--';
  const dayHigh =
    quote.regularMarketDayHigh !== null ? formatPrice(quote.regularMarketDayHigh) : '--';
  const dayLow = quote.regularMarketDayLow !== null ? formatPrice(quote.regularMarketDayLow) : '--';
  const volume =
    quote.regularMarketVolume !== null ? quote.regularMarketVolume.toLocaleString('en-US') : '--';

  return `<table cellpadding="6" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;margin-bottom:20px;">
  <tr>
    <td colspan="2" style="padding-bottom:4px;">
      <font size="5" ${FONT} color="#dddddd"><b>${name}</b></font>
      <font size="3" ${FONT} color="#72767d"> (${symbol})</font>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding-top:0;padding-bottom:8px;">
      <font size="6" ${FONT} color="#dddddd"><b>$${price}</b></font>
      <font size="4" ${FONT} color="${color}"> ${change} (${changePct})</font>
    </td>
  </tr>
  <tr style="border-top:1px solid #40444b;">
    <td style="border-bottom:1px solid #40444b;width:50%;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Open</font><br>
      <font size="3" ${FONT} color="#dddddd">$${dayOpen}</font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Day High</font><br>
      <font size="3" ${FONT} color="#dddddd">$${dayHigh}</font>
    </td>
  </tr>
  <tr>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Day Low</font><br>
      <font size="3" ${FONT} color="#dddddd">$${dayLow}</font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Volume</font><br>
      <font size="3" ${FONT} color="#dddddd">${volume}</font>
    </td>
  </tr>
</table>`;
}

function renderTopIndices(quotes) {
  const rows = quotes
    .filter((quote) => !!quote)
    .map((quote) => {
      const sym = quote.symbol.toLowerCase();
      const name = escape(DISPLAY_NAMES[sym] || quote.symbol || '');
      const price = formatPrice(quote.regularMarketPrice);
      const change = formatChange(quote.regularMarketChange);
      const changePct = formatChangePct(quote.regularMarketChangePercent);
      const color = changeColor(quote.regularMarketChange);
      return `  <tr style="border-bottom:1px solid #40444b;">
    <td><font size="3" ${FONT} color="#dddddd">${name}</font></td>
    <td><font size="3" ${FONT} color="#dddddd">$${price}</font></td>
    <td><font size="3" ${FONT} color="${color}">${change}</font></td>
    <td><font size="3" ${FONT} color="${color}">${changePct}</font></td>
  </tr>\n`;
    });
  const html =
    `<font size="4" ${FONT} color="#dddddd"><b>Major Indices</b></font><br><br>\n` +
    `<table cellpadding="4" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">\n` +
    `  <tr style="border-bottom:2px solid #40444b;">
    <td><font size="2" ${FONT} color="#72767d"><b>Index</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>Price</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>Change</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>% Change</b></font></td>
  </tr>\n` +
    rows.join('') +
    `</table>\n`;
  return html;
}

exports.processStocks = async function processStocks(req, res) {
  const discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  const parsedUrl = new URL(req.url, 'http://localhost');
  const ticker = (parsedUrl.searchParams.get('ticker') || '').trim().toUpperCase();

  const themeClass = getPageThemeAttr(req);

  const stocksHtml = await (async () => {
    if (ticker) {
      const safeTicker = ticker.slice(0, TICKER_MAX_LENGTH);
      const quote = await fetchYahooQuote(safeTicker);
      return !quote
        ? `<font color="#ff4444" ${FONT}>No data found for &ldquo;${escape(safeTicker)}&rdquo;. Please check the ticker symbol and try again.</font><br>`
        : renderQuoteRow(quote);
    }
    // Fetch all top indices in parallel
    const results = await Promise.allSettled(TOP_SYMBOLS.map((sym) => fetchStooqHistory(sym)));
    const quotes = results
      .filter((r) => r.status === 'fulfilled' && r.value !== null)
      .map((r) => r.value);
    return quotes.length === 0
      ? `<font color="#ff4444" ${FONT}>Unable to load market data. Please try again later.</font><br>`
      : renderTopIndices(quotes);
  })().catch((err) => {
    console.error('Stocks API error:', err.message);
    return `<font color="#ff4444" ${FONT}>Unable to fetch stock data. Please try again later.</font><br>`;
  });

  const credit = ticker
    ? 'Stock data courtesy of <a href="https://finance.yahoo.com/" style="color: #5865f2;">Yahoo Finance</a>'
    : 'Stock data courtesy of <a href="https://stooq.com/" style="color: #5865f2;">Stooq</a>';

  const menuOptions = strReplace(
    logged_in_template,
    '{$USER}',
    escape(await auth.getUsername(discordID))
  );
  const withTheme = strReplace(stocks_template, '{$WHITE_THEME_ENABLED}', themeClass);
  const withMenu = strReplace(withTheme, '{$MENU_OPTIONS}', menuOptions);
  const withTicker = strReplace(withMenu, '{$TICKER_VALUE}', escape(ticker));
  const withContent = strReplace(withTicker, '{$STOCKS_CONTENT}', stocksHtml);
  const response = strReplace(withContent, '{$CREDIT}', credit);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
