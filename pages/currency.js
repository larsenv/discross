'use strict';

const fs = require('fs');
const escape = require('escape-html');

const { strReplace, getPageThemeAttr, httpsGet } = require('./utils.js');

const auth = require('../authentication.js');

// Frankfurter API — free, no API key required
const FRANKFURTER_HOST = 'api.frankfurter.app';

// Max base currency symbol length
const CURRENCY_MAX_LENGTH = 3;

// Major currencies to display on the default dashboard
const DEFAULT_TARGETS = [
  'EUR',
  'GBP',
  'JPY',
  'CAD',
  'AUD',
  'CHF',
  'CNY',
  'INR',
  'MXN',
  'BRL',
  'KRW',
  'HKD',
];

// Full names for well-known currencies
const CURRENCY_NAMES = {
  AED: 'UAE Dirham',
  AUD: 'Australian Dollar',
  BGN: 'Bulgarian Lev',
  BRL: 'Brazilian Real',
  CAD: 'Canadian Dollar',
  CHF: 'Swiss Franc',
  CNY: 'Chinese Yuan',
  CZK: 'Czech Koruna',
  DKK: 'Danish Krone',
  EUR: 'Euro',
  GBP: 'British Pound',
  HKD: 'Hong Kong Dollar',
  HUF: 'Hungarian Forint',
  IDR: 'Indonesian Rupiah',
  ILS: 'Israeli Shekel',
  INR: 'Indian Rupee',
  ISK: 'Icelandic Krona',
  JPY: 'Japanese Yen',
  KRW: 'South Korean Won',
  MXN: 'Mexican Peso',
  MYR: 'Malaysian Ringgit',
  NOK: 'Norwegian Krone',
  NZD: 'New Zealand Dollar',
  PHP: 'Philippine Peso',
  PLN: 'Polish Zloty',
  RON: 'Romanian Leu',
  SEK: 'Swedish Krona',
  SGD: 'Singapore Dollar',
  THB: 'Thai Baht',
  TRY: 'Turkish Lira',
  USD: 'US Dollar',
  ZAR: 'South African Rand',
};

const currency_template = fs
  .readFileSync('pages/templates/currency.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

/**
 * Return a date string N calendar days before today in YYYY-MM-DD format.
 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch exchange rates for the latest available date and the previous trading day.
 * Returns { latestData, prevData } where both are Frankfurter API response objects (or null).
 *
 * Uses Frankfurter's date-range endpoint /{startDate}.. to retrieve the last several
 * calendar days in one request, then picks the two most recent trading days from the
 * result. This is robust across weekends and public holidays.
 */
async function fetchLatestAndPrevRates(base) {
  const startDate = daysAgo(14); // 14-day window guarantees at least 2 trading days
  const path = `/${encodeURIComponent(startDate)}..?from=${encodeURIComponent(base)}`;
  const options = {
    hostname: FRANKFURTER_HOST,
    path,
    method: 'GET',
    headers: {
      'User-Agent': 'Discross/1.0',
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    },
  };
  const { statusCode, body } = await httpsGet(options, 3);
  if (statusCode !== 200) return { latestData: null, prevData: null };
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return { latestData: null, prevData: null };
  }
  // data.rates is keyed by date string "YYYY-MM-DD"
  const allDates = Object.keys(data.rates || {}).sort();
  if (allDates.length === 0) return { latestData: null, prevData: null };

  const latestDate = allDates[allDates.length - 1];
  const prevDate = allDates.length >= 2 ? allDates[allDates.length - 2] : null;

  const latestData = { date: latestDate, base: data.base, rates: data.rates[latestDate] };
  const prevData = prevDate
    ? { date: prevDate, base: data.base, rates: data.rates[prevDate] }
    : null;

  return { latestData, prevData };
}

function formatRate(rate, decimals) {
  if (rate === null) return '--';
  return rate.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatChange(change, decimals) {
  if (change === null) return '--';
  const sign = change >= 0 ? '+' : '';
  return sign + change.toFixed(decimals);
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

/** Choose decimal precision based on rate magnitude. */
function rateDecimals(rate) {
  if (rate === null) return 4;
  if (rate >= 100) return 2;
  if (rate >= 10) return 3;
  return 4;
}

function renderRatesTable(base, latestData, prevData, targets) {
  const latestRates = latestData ? latestData.rates || {} : {};
  const prevRates = prevData ? prevData.rates || {} : {};

  const dateLabel = latestData?.date
    ? ` <font size="2" ${FONT} color="#72767d">(as of ${escape(latestData.date)})</font>`
    : '';

  const rows = targets.flatMap((code) => {
    if (code === base) return [];
    const rate = latestRates[code] ?? null;
    if (rate === null) return [];
    const prev = prevRates[code] ?? null;
    const change = prev !== null ? rate - prev : null;
    const changePct = prev !== null && prev !== 0 ? ((rate - prev) / prev) * 100 : null;
    const decimals = rateDecimals(rate);
    const color = changeColor(change);
    const name = CURRENCY_NAMES[code] || code;
    return [
      `  <tr style="border-bottom:1px solid #40444b;">
    <td>
      <font size="3" ${FONT} color="#dddddd"><b>${escape(code)}</b></font><br>
      <font size="2" ${FONT} color="#72767d">${escape(name)}</font>
    </td>
    <td><font size="3" ${FONT} color="#dddddd">${formatRate(rate, decimals)}</font></td>
    <td><font size="3" ${FONT} color="${color}">${formatChange(change, decimals)}</font></td>
    <td><font size="3" ${FONT} color="${color}">${formatChangePct(changePct)}</font></td>
  </tr>\n`,
    ];
  });

  const html =
    `<font size="4" ${FONT} color="#dddddd"><b>Exchange Rates &mdash; Base: ${escape(base)}</b></font>` +
    dateLabel +
    '<br><br>\n' +
    `<table cellpadding="4" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">\n` +
    `  <tr style="border-bottom:2px solid #40444b;">
    <td><font size="2" ${FONT} color="#72767d"><b>Currency</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>Rate</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>Change</b></font></td>
    <td><font size="2" ${FONT} color="#72767d"><b>% Change</b></font></td>
  </tr>\n` +
    rows.join('') +
    `</table>\n`;
  return html;
}

exports.processCurrency = async function processCurrency(req, res) {
  const discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  const parsedUrl = new URL(req.url, 'http://localhost');
  const rawBase = (parsedUrl.searchParams.get('base') || 'USD').trim().toUpperCase();
  const base = rawBase.slice(0, CURRENCY_MAX_LENGTH).replace(/[^A-Z]/g, '') || 'USD';
  const inputWasNormalized = rawBase !== '' && base !== rawBase;
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const sessionSuffix = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const themeClass = getPageThemeAttr(req);

  let currencyHtml = '';

  if (inputWasNormalized) {
    currencyHtml += `<font color="#e3a84a" ${FONT}><i>Invalid currency code entered. Showing results for &ldquo;${escape(base)}&rdquo; instead.</i></font><br><br>`;
  }

  try {
    // Fetch latest and previous trading day rates in a single range request.
    // The 14-day window is robust across weekends and public holidays.
    const { latestData, prevData } = await fetchLatestAndPrevRates(base).catch(() => ({
      latestData: null,
      prevData: null,
    }));

    if (!latestData) {
      currencyHtml += `<font color="#ff4444" ${FONT}>No data found for base currency &ldquo;${escape(base)}&rdquo;. Please enter a valid 3-letter currency code (e.g. USD, EUR, GBP).</font><br>`;
    } else {
      // Use all available target currencies or our default list
      const availableCodes = Object.keys(latestData.rates || {}).sort();
      const targets =
        base === 'USD' ? DEFAULT_TARGETS.filter((c) => availableCodes.includes(c)) : availableCodes;
      currencyHtml = renderRatesTable(base, latestData, prevData, targets);
    }
  } catch (err) {
    console.error('Currency API error:', err.message);
    currencyHtml += `<font color="#ff4444" ${FONT}>Unable to fetch currency data. Please try again later.</font><br>`;
  }

  const menuOptions = strReplace(
    logged_in_template,
    '{$USER}',
    escape(await auth.getUsername(discordID))
  );
  const withTheme = strReplace(currency_template, '{$WHITE_THEME_ENABLED}', themeClass);
  const withMenu = strReplace(withTheme, '{$MENU_OPTIONS}', menuOptions);
  const withBase = strReplace(withMenu, '{$BASE_VALUE}', escape(base));
  const withContent = strReplace(withBase, '{$CURRENCY_CONTENT}', currencyHtml);
  const withSession = strReplace(withContent, '{$SESSION_ID}', escape(urlSessionID));
  const response = strReplace(withSession, '{$SESSION_SUFFIX}', escape(sessionSuffix));

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
