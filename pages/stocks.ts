'use strict';

const escape = require('escape-html');

const auth = require('../src/authentication');
const {
    renderTemplate,
    render,
    getPageThemeAttr,
    httpsGet,
    formatChangePct,
    changeColor,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
} = require('./utils');

// Maximum ticker symbol length to prevent abuse
const TICKER_MAX_LENGTH = 10;

// Symbols for major indices
const TOP_SYMBOLS = ['^DJI', '^GSPC', '^IXIC'];

const DISPLAY_NAMES = {
    '^dji': 'Dow Jones Industrial Average',
    '^gspc': 'S&P 500',
    '^spx': 'S&P 500',
    '^ixic': 'NASDAQ',
    '^ndq': 'NASDAQ',
    '^ndx': 'NASDAQ-100',
};

const stocks_template = loadAndRenderPageTemplate('stocks');

const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

function normalizeSymbol(symbol) {
    let sym = symbol.trim();
    if (sym.toLowerCase().endsWith('.us')) {
        sym = sym.slice(0, -3);
    }
    const lower = sym.toLowerCase();
    if (lower === '^ndq') return '^IXIC';
    if (lower === '^spx') return '^GSPC';
    return sym;
}

/**
 * Fetch latest quote data from Yahoo Finance for a single symbol.
 * Returns a Promise resolving to a quote object or null.
 *
 * Uses the v8 chart endpoint which does not require an API key for basic data.
 */
function fetchQuote(symbol) {
    const yahooSymbol = normalizeSymbol(symbol);
    const s = encodeURIComponent(yahooSymbol);
    const options = {
        hostname: 'query1.finance.yahoo.com',
        path: `/v8/finance/chart/${s}?interval=1d&range=1d`,
        method: 'GET',
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json,*/*',
            'Accept-Encoding': 'identity',
            Referer: 'https://finance.yahoo.com/',
        },
    };
    return httpsGet(options, 3).then(({ statusCode, body }) => {
        if (statusCode === 404) {
            return null;
        }
        if (statusCode !== 200) {
            throw new Error(`Yahoo Finance returned HTTP ${statusCode} for ${symbol}`);
        }
        return parseQuote(symbol, body);
    });
}

/**
 * Parse Yahoo Finance chart JSON.
 * Returns a quote object.
 * Returns null if not enough data.
 */
function parseQuote(symbol, jsonStr) {
    try {
        const data = JSON.parse(jsonStr);
        const result = data?.chart?.result?.[0];
        if (!result || !result.meta) return null;

        const meta = result.meta;
        const ind = result.indicators?.quote?.[0] || {};

        const close = meta.regularMarketPrice;
        if (close === undefined || close === null || isNaN(close)) return null;

        const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
        const openVal = meta.regularMarketOpen ?? (ind.open && ind.open[0]) ?? null;
        const highVal = meta.regularMarketDayHigh ?? (ind.high && ind.high[0]) ?? null;
        const lowVal = meta.regularMarketDayLow ?? (ind.low && ind.low[0]) ?? null;
        const volVal = meta.regularMarketVolume ?? (ind.volume && ind.volume[0]) ?? null;

        const open = openVal !== null && !isNaN(openVal) ? openVal : null;
        const high = highVal !== null && !isNaN(highVal) ? highVal : null;
        const low = lowVal !== null && !isNaN(lowVal) ? lowVal : null;
        const volume = volVal !== null && !isNaN(volVal) ? Math.round(volVal) : null;

        const basePrice = prevClose !== null && !isNaN(prevClose) ? prevClose : open;
        const change = basePrice !== null ? close - basePrice : null;
        const changePct =
            basePrice !== null && basePrice !== 0 ? ((close - basePrice) / basePrice) * 100 : null;

        const normalized = normalizeSymbol(symbol);

        return {
            symbol: normalized.toUpperCase(),
            shortName: meta.shortName || meta.longName || null,
            regularMarketPrice: close,
            regularMarketOpen: open,
            regularMarketDayHigh: high,
            regularMarketDayLow: low,
            regularMarketVolume: volume,
            regularMarketChange: change,
            regularMarketChangePercent: changePct,
        };
    } catch (e) {
        return null;
    }
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
    const name = escape(
        DISPLAY_NAMES[quote.symbol.toLowerCase()] || quote.shortName || quote.symbol || ''
    );
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

    return render('stocks/summary-card', {
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
            const name =
                DISPLAY_NAMES[quote.symbol.toLowerCase()] || quote.shortName || quote.symbol;
            const price = formatPrice(quote.regularMarketPrice);
            const change = formatChange(quote.regularMarketChange);
            const changePct = formatChangePct(quote.regularMarketChangePercent);
            const color = changeColor(quote.regularMarketChange);
            return render('stocks/index-row', {
                NAME: name,
                PRICE: price,
                COLOR: color,
                CHANGE: change,
                CHANGE_PCT: changePct,
            });
        });
    return render('stocks/indices-table', {
        ROWS: rows.join(''),
    });
}

exports.processStocks = async function processStocks(req, res) {
    // These pages are public — read the session if there is one (so the header
    // can greet the user) but never send a logged-out visitor to the login page.
    const discordID = await auth.checkAuth(req, res, true);

    const parsedUrl = new URL(req.url, 'http://localhost');
    const ticker = (parsedUrl.searchParams.get('ticker') || '').trim().toUpperCase();

    const themeClass = getPageThemeAttr(req);

    const stocksHtml = await (async () => {
        if (ticker) {
            const safeTicker = ticker.slice(0, TICKER_MAX_LENGTH);
            const quote = await fetchQuote(safeTicker);
            return !quote
                ? render('stocks/ticker-not-found', {
                      TICKER: escape(safeTicker),
                  })
                : renderQuoteRow(quote);
        }
        // Fetch all top indices in parallel
        const results = await Promise.allSettled(TOP_SYMBOLS.map((sym) => fetchQuote(sym)));
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

    const credit = getTemplate('yahoo-credit', 'stocks');
    const menuOptions = discordID
        ? render('index/logged-in', { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;

    const pageTitle = ticker
        ? `Stock Quote (${ticker}) - Discross`
        : 'Stock Market Indices - Discross';
    const seoDescription = ticker
        ? `View live stock market quotes and data for ${ticker} on Discross, the universal Discord client.`
        : 'View live stock market index data and major indices on Discross, the universal Discord client.';

    const response = renderTemplate(stocks_template, {
        WHITE_THEME_ENABLED: themeClass,
        MENU_OPTIONS: menuOptions,
        TICKER_VALUE: escape(ticker),
        STOCKS_CONTENT: stocksHtml,
        CREDIT: credit,
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: seoDescription,
        }),
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
