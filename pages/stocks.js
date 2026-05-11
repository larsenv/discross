'use strict';

const escape = require('escape-html');

const auth = require('../authentication.js');
const {
    renderTemplate,
    getPageThemeAttr,
    httpsGet,
    formatChangePct,
    changeColor,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');

// Maximum ticker symbol length to prevent abuse
const TICKER_MAX_LENGTH = 10;

// Stooq symbols for major indices (no API key required)
const TOP_SYMBOLS = ['^dji', '^spx', '^ndq'];

const DISPLAY_NAMES = {
    '^dji': 'Dow Jones Industrial Average',
    '^spx': 'S&P 500',
    '^ndq': 'NASDAQ',
};

const stocks_template = loadAndRenderPageTemplate('stocks');

const logged_in_template = getTemplate('logged-in', 'index');

/**
 * Fetch latest quote data from stooq.com for a single symbol.
 * Returns a Promise resolving to a quote object or null.
 *
 * Uses the quote endpoint which does not require an API key for basic data.
 * Format: Symbol,Date,Time,Open,High,Low,Close,Volume,Prev
 */
function fetchStooqQuote(symbol) {
    // Index symbols use ^ prefix; regular stock tickers need .us suffix for US stocks
    const stooqSymbol = !symbol.startsWith('^') && !symbol.includes('.') ? symbol + '.us' : symbol;
    const s = encodeURIComponent(stooqSymbol);
    // f=sd2t2ohlcvp: symbol, date, time, open, high, low, close, volume, previous close
    // h: include header, e: csv format
    const options = {
        hostname: 'stooq.com',
        path: `/q/l/?s=${s}&f=sd2t2ohlcvp&h&e=csv`,
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
        return parseStooqQuote(symbol, body);
    });
}

/**
 * Parse stooq quote CSV.
 * Returns a quote object.
 * Returns null if not enough data.
 */
function parseStooqQuote(symbol, csv) {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return null;

    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const data = lines[1].split(',');
    if (data.length < headers.length) return null;

    const getVal = (name) => {
        const idx = headers.indexOf(name);
        return idx !== -1 ? parseFloat(data[idx]) : NaN;
    };

    const close = getVal('close');
    const prevClose = getVal('prev');
    const open = getVal('open');
    const high = getVal('high');
    const low = getVal('low');
    const volume = getVal('volume');

    if (isNaN(close)) return null;

    // Use previous close (prior trading day) for daily change, fall back to open
    const basePrice = !isNaN(prevClose) ? prevClose : !isNaN(open) ? open : null;
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
    const dayLow =
        quote.regularMarketDayLow !== null ? formatPrice(quote.regularMarketDayLow) : '--';
    const volume =
        quote.regularMarketVolume !== null
            ? quote.regularMarketVolume.toLocaleString('en-US')
            : '--';

    return renderTemplate(getTemplate('summary-card', 'stocks'), {
        NAME: name,
        SYMBOL: symbol,
        PRICE: price,
        COLOR: color,
        CHANGE: change,
        CHANGE_PCT: changePct,
        OPEN: dayOpen,
        HIGH: dayHigh,
        LOW: dayLow,
        VOLUME: volume,
    });
}

function renderTopIndices(quotes) {
    const rows = quotes
        .filter((quote) => !!quote)
        .map((quote) => {
            const name = quote.shortName || quote.symbol;
            const price = formatPrice(quote.regularMarketPrice);
            const change = formatChange(quote.regularMarketChange);
            const changePct = formatChangePct(quote.regularMarketChangePercent);
            const color = changeColor(quote.regularMarketChange);
            return renderTemplate(getTemplate('index-row', 'stocks'), {
                NAME: name,
                PRICE: price,
                COLOR: color,
                CHANGE: change,
                CHANGE_PCT: changePct,
            });
        });
    return renderTemplate(getTemplate('indices-table', 'stocks'), {
        ROWS: rows.join(''),
    });
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
            const quote = await fetchStooqQuote(safeTicker);
            return !quote
                ? renderTemplate(getTemplate('ticker-not-found', 'stocks'), {
                      TICKER: escape(safeTicker),
                  })
                : renderQuoteRow(quote);
        }
        // Fetch all top indices in parallel
        const results = await Promise.allSettled(TOP_SYMBOLS.map((sym) => fetchStooqQuote(sym)));
        const quotes = results
            .filter((r) => r.status === 'fulfilled' && r.value !== null)
            .map((r) => r.value);
        return quotes.length === 0
            ? getTemplate('market-data-error', 'stocks')
            : renderTopIndices(quotes);
    })().catch((err) => {
        console.error('Stocks API error:', err);
        return getTemplate('fetch-error', 'stocks');
    });

    const credit = getTemplate('stooq-credit', 'stocks');
    const menuOptions = renderTemplate(logged_in_template, {
        USER: escape(await auth.getUsername(discordID)),
    });

    const response = renderTemplate(stocks_template, {
        WHITE_THEME_ENABLED: themeClass,
        MENU_OPTIONS: menuOptions,
        TICKER_VALUE: escape(ticker),
        STOCKS_CONTENT: stocksHtml,
        CREDIT: credit,
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
