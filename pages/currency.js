'use strict';

const fs = require('fs');
const escape = require('escape-html');

const {
  renderTemplate,
  getPageThemeAttr,
  httpsGet,
  formatChangePct,
  changeColor,
  loadAndRenderPageTemplate,
  getTemplate,
} = require('./utils.js');

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

const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;

const currency_template = loadAndRenderPageTemplate('currency');

const logged_in_template = getTemplate('logged_in', 'index');

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
  const data = (() => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();
  if (!data) return { latestData: null, prevData: null };
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
    ? renderTemplate(getTemplate('date_label', 'currency'), { DATE: escape(latestData.date) })
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
      renderTemplate(getTemplate('rate_row', 'currency'), {
        CODE: escape(code),
        NAME: escape(name),
        RATE: formatRate(rate, decimals),
        COLOR: color,
        CHANGE: formatChange(change, decimals),
        CHANGE_PCT: formatChangePct(changePct),
      }),
    ];
  });

  return renderTemplate(getTemplate('rates_table', 'currency'), {
    BASE: escape(base),
    DATE_LABEL: dateLabel,
    ROWS: rows.join(''),
  });
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

  const prefix = inputWasNormalized
    ? renderTemplate(getTemplate('invalid_code_prefix', 'currency'), { BASE: escape(base) })
    : '';

  const currencyHtml = await (async () => {
    try {
      // Fetch latest and previous trading day rates in a single range request.
      // The 14-day window is robust across weekends and public holidays.
      const { latestData, prevData } = await fetchLatestAndPrevRates(base).catch(() => ({
        latestData: null,
        prevData: null,
      }));

      if (!latestData) {
        return (
          prefix + renderTemplate(getTemplate('no_data_error', 'currency'), { BASE: escape(base) })
        );
      }
      // Use all available target currencies or our default list
      const availableCodes = Object.keys(latestData.rates || {}).sort();
      const targets =
        base === 'USD' ? DEFAULT_TARGETS.filter((c) => availableCodes.includes(c)) : availableCodes;
      return prefix + renderRatesTable(base, latestData, prevData, targets);
    } catch (err) {
      console.error('Currency API error:', err);
      return prefix + getTemplate('fetch_error', 'currency');
    }
  })();

  const menuOptions = renderTemplate(logged_in_template, {
    USER: escape(await auth.getUsername(discordID)),
  });

  const response = renderTemplate(currency_template, {
    WHITE_THEME_ENABLED: themeClass,
    MENU_OPTIONS: menuOptions,
    BASE_VALUE: escape(base),
    CURRENCY_CONTENT: currencyHtml,
    SESSION_ID: escape(urlSessionID),
    SESSION_SUFFIX: escape(sessionSuffix),
  });

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
