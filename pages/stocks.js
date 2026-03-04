'use strict';

const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const escape = require('escape-html');

const auth = require('../authentication.js');

const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;

const YAHOO_FINANCE_USER_AGENT = 'Mozilla/5.0 (compatible; Discross/1.0)';

// Maximum ticker symbol length to prevent abuse
const TICKER_MAX_LENGTH = 10;

// Top market indices to show on the main page
const TOP_SYMBOLS = ['^DJI', '^IXIC', '^GSPC'];

const stocks_template = fs.readFileSync('pages/templates/stocks.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

function fetchJson(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: Object.assign({ 'Accept': 'application/json' }, headers || {}),
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const decompress = encoding === 'gzip' ? zlib.gunzip
          : encoding === 'deflate' ? zlib.inflate
          : null;
        const parse = (raw) => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw.toString('utf8')) });
          } catch (e) {
            const preview = raw.toString('utf8', 0, 200);
            reject(new Error(`Failed to parse response (HTTP ${res.statusCode}): ${e.message} | body preview: ${preview}`));
          }
        };
        if (decompress) {
          decompress(buf, (err, decoded) => {
            if (err) return reject(new Error(`Failed to decompress response: ${err.message}`));
            parse(decoded);
          });
        } else {
          parse(buf);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function formatPrice(price) {
  if (price == null) return '--';
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatChange(change) {
  if (change == null) return '--';
  const sign = change >= 0 ? '+' : '';
  return sign + change.toFixed(2);
}

function formatChangePct(pct) {
  if (pct == null) return '--';
  const sign = pct >= 0 ? '+' : '';
  return sign + pct.toFixed(2) + '%';
}

function changeColor(change) {
  if (change == null) return '#72767d';
  return change >= 0 ? '#57f287' : '#ed4245';
}

function renderQuoteRow(quote) {
  const name = escape(quote.shortName || quote.longName || quote.symbol || '');
  const symbol = escape(quote.symbol || '');
  const price = formatPrice(quote.regularMarketPrice);
  const change = formatChange(quote.regularMarketChange);
  const changePct = formatChangePct(quote.regularMarketChangePercent);
  const color = changeColor(quote.regularMarketChange);
  const prevClose = quote.regularMarketPreviousClose != null ? formatPrice(quote.regularMarketPreviousClose) : '--';
  const dayOpen = quote.regularMarketOpen != null ? formatPrice(quote.regularMarketOpen) : '--';
  const dayHigh = quote.regularMarketDayHigh != null ? formatPrice(quote.regularMarketDayHigh) : '--';
  const dayLow = quote.regularMarketDayLow != null ? formatPrice(quote.regularMarketDayLow) : '--';
  const volume = quote.regularMarketVolume != null
    ? quote.regularMarketVolume.toLocaleString('en-US')
    : '--';
  const marketState = escape(quote.marketState || '');

  return `<table cellpadding="6" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;margin-bottom:20px;">
  <tr>
    <td colspan="2" style="padding-bottom:4px;">
      <font size="5" ${FONT} color="#dddddd"><b>${name}</b></font>
      <font size="3" ${FONT} color="#72767d"> (${symbol})</font>
      ${marketState ? `<font size="2" ${FONT} color="#72767d">&nbsp;&mdash;&nbsp;${marketState}</font>` : ''}
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
      <font size="2" ${FONT} color="#72767d">Previous Close</font><br>
      <font size="3" ${FONT} color="#dddddd">$${prevClose}</font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Open</font><br>
      <font size="3" ${FONT} color="#dddddd">$${dayOpen}</font>
    </td>
  </tr>
  <tr>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Day High</font><br>
      <font size="3" ${FONT} color="#dddddd">$${dayHigh}</font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Day Low</font><br>
      <font size="3" ${FONT} color="#dddddd">$${dayLow}</font>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Volume</font><br>
      <font size="3" ${FONT} color="#dddddd">${volume}</font>
    </td>
  </tr>
</table>`;
}

function renderTopIndices(quotes) {
  const DISPLAY_NAMES = {
    '^DJI':  'Dow Jones Industrial Average',
    '^IXIC': 'NASDAQ Composite',
    '^GSPC': 'S&amp;P 500',
  };

  let html = `<font size="4" ${FONT} color="#dddddd"><b>Major Indices</b></font><br><br>\n`;
  html += `<table cellpadding="4" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">\n`;
  html += `  <tr style="border-bottom:2px solid #40444b;">
    <td><font size="2" ${FONT} color="#72767d"><b>Index</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>Price</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>Change</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>% Change</b></font></td>
  </tr>\n`;

  for (const quote of quotes) {
    if (!quote) continue;
    const name = escape(DISPLAY_NAMES[quote.symbol] || quote.shortName || quote.longName || quote.symbol || '');
    const price = formatPrice(quote.regularMarketPrice);
    const change = formatChange(quote.regularMarketChange);
    const changePct = formatChangePct(quote.regularMarketChangePercent);
    const color = changeColor(quote.regularMarketChange);
    html += `  <tr style="border-bottom:1px solid #40444b;">
    <td><font size="3" ${FONT} color="#dddddd">${name}</font></td>
    <td><font size="3" ${FONT} color="#dddddd">$${price}</font></td>
    <td><font size="3" ${FONT} color="${color}">${change}</font></td>
    <td><font size="3" ${FONT} color="${color}">${changePct}</font></td>
  </tr>\n`;
  }

  html += `</table>\n`;
  return html;
}

async function fetchQuotes(symbols) {
  const symbolsEnc = symbols.map(s => encodeURIComponent(s)).join('%2C');
  const path = `/v8/finance/quote?symbols=${symbolsEnc}&fields=shortName,longName,regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,marketState`;
  const headers = {
    'User-Agent': YAHOO_FINANCE_USER_AGENT,
    'Accept': 'application/json',
  };
  return fetchJson('query1.finance.yahoo.com', path, headers);
}

exports.processStocks = async function processStocks(req, res) {
  const discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  const parsedUrl = new URL(req.url, 'http://localhost');
  const ticker = (parsedUrl.searchParams.get('ticker') || '').trim().toUpperCase();

  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(c => c.startsWith('whiteThemeCookie='))?.split('=')[1];
  const themeValue = whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie, 10) : 0;

  let themeClass = '';
  if (themeValue === 1) {
    themeClass = 'class="light-theme"';
  } else if (themeValue === 2) {
    themeClass = 'class="amoled-theme"';
  }

  let stocksHtml = '';

  try {
    if (ticker) {
      const safeTicker = ticker.slice(0, TICKER_MAX_LENGTH);
      const result = await fetchQuotes([safeTicker]);

      if (!result || result.status !== 200) {
        stocksHtml = `<font color="#ff4444" ${FONT}>Stock data unavailable. Please try again later.</font><br>`;
      } else {
        const quotes = result.data?.quoteResponse?.result;
        if (!Array.isArray(quotes) || quotes.length === 0) {
          stocksHtml = `<font color="#ff4444" ${FONT}>No data found for &ldquo;${escape(safeTicker)}&rdquo;. Please check the ticker symbol and try again.</font><br>`;
        } else {
          stocksHtml = renderQuoteRow(quotes[0]);
        }
      }
    } else {
      // Show top market indices
      const result = await fetchQuotes(TOP_SYMBOLS);

      if (!result || result.status !== 200) {
        stocksHtml = `<font color="#ff4444" ${FONT}>Stock data unavailable. Please try again later.</font><br>`;
      } else {
        const quotes = result.data?.quoteResponse?.result;
        if (!Array.isArray(quotes) || quotes.length === 0) {
          stocksHtml = `<font color="#ff4444" ${FONT}>Unable to load market data. Please try again later.</font><br>`;
        } else {
          stocksHtml = renderTopIndices(quotes);
        }
      }
    }
  } catch (err) {
    console.error('Stocks API error:', err.message);
    stocksHtml = `<font color="#ff4444" ${FONT}>Unable to fetch stock data. Please try again later.</font><br>`;
  }

  let response = strReplace(stocks_template, '{$WHITE_THEME_ENABLED}', themeClass);
  response = strReplace(response, '{$MENU_OPTIONS}',
    strReplace(logged_in_template, '{$USER}', escape(await auth.getUsername(discordID)))
  );
  response = strReplace(response, '{$TICKER_VALUE}', escape(ticker));
  response = strReplace(response, '{$STOCKS_CONTENT}', stocksHtml);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
