'use strict';

const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { strReplace, getPageThemeAttr } = require('./utils.js');

const ACCUWEATHER_API_KEY = process.env.ACCUWEATHER_API_KEY;
const ACCUWEATHER_HOST = 'api.accuweather.com';

// Max city name length to prevent abuse
const CITY_MAX_LENGTH = 100;

const MPH_TO_KMH = 1.60934;

// Map AccuWeather icon codes (1-44) to Twemoji file names (without .gif)
const WEATHER_ICONS = {
  1: '2600', // Sunny
  2: '1f324', // Mostly Sunny
  3: '26c5', // Partly Sunny
  4: '1f325', // Intermittent Clouds
  5: '1f324', // Hazy Sunshine
  6: '1f325', // Mostly Cloudy
  7: '2601', // Cloudy
  8: '2601', // Dreary (Overcast)
  11: '1f32b', // Fog
  12: '1f327', // Showers
  13: '1f327', // Mostly Cloudy w/ Showers
  14: '1f327', // Partly Sunny w/ Showers
  15: '1f329', // T-Storms
  16: '1f329', // Mostly Cloudy w/ T-Storms
  17: '1f329', // Partly Sunny w/ T-Storms
  18: '2614', // Rain
  19: '1f328', // Flurries
  20: '1f328', // Mostly Cloudy w/ Flurries
  21: '1f328', // Partly Sunny w/ Flurries
  22: '2744', // Snow
  23: '2744', // Mostly Cloudy w/ Snow
  24: '2744', // Ice
  25: '1f327', // Sleet
  26: '1f327', // Freezing Rain
  29: '1f327', // Rain and Snow
  30: '1f321', // Hot
  31: '1f321', // Cold
  32: '1f32c', // Windy
  33: '2600', // Clear (night)
  34: '1f324', // Mostly Clear (night)
  35: '26c5', // Partly Cloudy (night)
  36: '1f325', // Intermittent Clouds (night)
  37: '1f32b', // Hazy Moonlight
  38: '2601', // Mostly Cloudy (night)
  39: '1f327', // Partly Cloudy w/ Showers (night)
  40: '1f327', // Mostly Cloudy w/ Showers (night)
  41: '1f329', // Partly Cloudy w/ T-Storms (night)
  42: '1f329', // Mostly Cloudy w/ T-Storms (night)
  43: '1f328', // Mostly Cloudy w/ Flurries (night)
  44: '2744', // Mostly Cloudy w/ Snow (night)
};

const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;

const VIEWS = [
  { id: 'current', label: 'Current' },
  { id: 'today', label: 'Today' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: '5-Day' },
];

function fToC(f) {
  if (f === null || f === undefined || f === '--') return '--';
  return (((f - 32) * 5) / 9).toFixed(1);
}

function formatDay(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (e) {
    return '';
  }
}

function formatHour(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
  } catch (e) {
    return '';
  }
}

function iconImg(code, size) {
  const file = WEATHER_ICONS[parseInt(code, 10)] || '2600';
  const s = size || 24;
  return `<img src="/resources/twemoji/${file}.gif" alt="" width="${s}" height="${s}" style="width:${s}px;height:${s}px;vertical-align:middle;">`;
}

function buildNavButtons(city, activeView, urlSessionID) {
  const cityEnc = encodeURIComponent(city);
  const sessionSuffix = urlSessionID ? `&sessionID=${encodeURIComponent(urlSessionID)}` : '';
  let html = '<table cellpadding="0" cellspacing="0"><tr>\n';
  for (const v of VIEWS) {
    const cls = v.id === activeView ? 'discross-button' : 'discross-button secondary';
    html += `  <td style="padding:0 6px 10px 0;"><a href="/weather?city=${cityEnc}&view=${v.id}${sessionSuffix}" class="${cls}" style="padding:7px 16px;font-size:14px;margin:0;">${v.label}</a></td>\n`;
  }
  html += '</tr></table>\n';
  return html;
}

const weather_template = fs
  .readFileSync('pages/templates/weather.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function fetchJson(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const decompress =
          encoding === 'gzip' ? zlib.gunzip : encoding === 'deflate' ? zlib.inflate : null;
        const parse = (raw) => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw.toString('utf8')) });
          } catch (e) {
            const preview = raw.toString('utf8', 0, 200);
            reject(
              new Error(
                `Failed to parse response (HTTP ${res.statusCode}): ${e.message} | body preview: ${preview}`
              )
            );
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

// --- View renderers ---

function renderCurrent(cond) {
  if (!cond || cond.status !== 200 || !Array.isArray(cond.data) || !cond.data.length) {
    if (cond && cond.status !== 200)
      console.error(
        `AccuWeather conditions API returned HTTP ${cond.status}. Response:`,
        JSON.stringify(cond.data)
      );
    return `<font color="#ff4444" ${FONT}>Current conditions unavailable for this location.</font><br>`;
  }
  const c = cond.data[0];
  const iconCode = c.WeatherIcon || 1;
  const weatherText = escape(c.WeatherText || '');
  const tempF = c.Temperature?.Imperial?.Value ?? '--';
  const tempC = c.Temperature?.Metric?.Value ?? '--';
  const feelsLikeF = c.RealFeelTemperature?.Imperial?.Value ?? '--';
  const feelsLikeC = c.RealFeelTemperature?.Metric?.Value ?? '--';
  const humidity = c.RelativeHumidity ?? '--';
  const windSpeedMph = c.Wind?.Speed?.Imperial?.Value ?? '--';
  const windSpeedKmh = c.Wind?.Speed?.Metric?.Value ?? '--';
  const windDir = escape(c.Wind?.Direction?.Localized || '');
  const visibilityMi = c.Visibility?.Imperial?.Value ?? '--';
  const visibilityKm = c.Visibility?.Metric?.Value ?? '--';
  const pressureInHg = c.Pressure?.Imperial?.Value ?? '--';
  const pressureMb = c.Pressure?.Metric?.Value ?? '--';
  const uvIndex = c.UVIndex ?? '--';
  const uvText = c.UVIndexText ? escape(c.UVIndexText) : '';
  const cloudCover = c.CloudCover ?? '--';
  const dewPointF = c.DewPoint?.Imperial?.Value ?? '--';
  const dewPointC = c.DewPoint?.Metric?.Value ?? '--';

  return `<table cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;">
  <tr valign="top">
    <td style="padding-right:16px;width:80px;">${iconImg(iconCode, 64)}</td>
    <td valign="top">
      <font size="4" ${FONT} color="#b5bac1">${weatherText}</font><br>
      <font size="6" ${FONT} color="#dddddd"><b>${tempF}&deg;F / ${tempC}&deg;C</b></font><br>
      <font size="3" ${FONT} color="#72767d">Feels like ${feelsLikeF}&deg;F / ${feelsLikeC}&deg;C</font>
    </td>
  </tr>
</table>
<br>
<table cellpadding="6" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">
  <tr>
    <td style="border-bottom:1px solid #40444b;width:50%;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Humidity</font><br>
      <font ${FONT} color="#dddddd"><b>${humidity}%</b></font>
    </td>
    <td style="border-bottom:1px solid #40444b;width:50%;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Wind</font><br>
      <font ${FONT} color="#dddddd"><b>${windSpeedMph} mph / ${windSpeedKmh} km/h${windDir ? ' ' + windDir : ''}</b></font>
    </td>
  </tr>
  <tr>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Visibility</font><br>
      <font ${FONT} color="#dddddd"><b>${visibilityMi} mi / ${visibilityKm} km</b></font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Pressure</font><br>
      <font ${FONT} color="#dddddd"><b>${pressureInHg} inHg / ${pressureMb} mb</b></font>
    </td>
  </tr>
  <tr>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">UV Index</font><br>
      <font ${FONT} color="#dddddd"><b>${uvIndex}${uvText ? ' (' + uvText + ')' : ''}</b></font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Cloud Cover</font><br>
      <font ${FONT} color="#dddddd"><b>${cloudCover}%</b></font>
    </td>
  </tr>
  <tr>
    <td style="vertical-align:top;">
      <font size="2" ${FONT} color="#72767d">Dew Point</font><br>
      <font ${FONT} color="#dddddd"><b>${dewPointF}&deg;F / ${dewPointC}&deg;C</b></font>
    </td>
    <td style="vertical-align:top;"></td>
  </tr>
</table>`;
}

function renderToday(daily) {
  if (!daily || daily.status !== 200 || !daily.data?.DailyForecasts?.length) {
    if (daily && daily.status !== 200)
      console.error(
        `AccuWeather daily forecast API returned HTTP ${daily.status}. Response:`,
        JSON.stringify(daily.data)
      );
    return `<font color="#ff4444" ${FONT}>Today's forecast unavailable for this location.</font><br>`;
  }
  const today = daily.data.DailyForecasts[0];
  const headline = daily.data.Headline?.Text ? escape(daily.data.Headline.Text) : '';
  const highF = today.Temperature?.Maximum?.Value ?? '--';
  const lowF = today.Temperature?.Minimum?.Value ?? '--';
  const highC = fToC(highF);
  const lowC = fToC(lowF);
  const dayIcon = today.Day?.Icon || 1;
  const dayPhrase = escape(today.Day?.IconPhrase || '');
  const nightIcon = today.Night?.Icon || 33;
  const nightPhrase = escape(today.Night?.IconPhrase || '');
  const dayPrecip = today.Day?.PrecipitationProbability ?? '--';
  const nightPrecip = today.Night?.PrecipitationProbability ?? '--';

  const html =
    (headline ? `<font size="3" ${FONT} color="#b5bac1"><i>${headline}</i></font><br><br>\n` : '') +
    `<table cellpadding="6" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">
  <tr style="border-bottom:1px solid #40444b;">
    <td style="padding:8px;width:36px;">${iconImg(dayIcon, 32)}</td>
    <td style="padding:8px;"><font size="3" ${FONT} color="#72767d">Day</font> &mdash; <font ${FONT} color="#dddddd">${dayPhrase}</font><br><font size="2" ${FONT} color="#72767d">Precip: ${dayPrecip}%</font></td>
    <td style="padding:8px;" align="right"><font ${FONT} color="#dddddd"><b>High: ${highF}&deg;F / ${highC}&deg;C</b></font></td>
  </tr>
  <tr>
    <td style="padding:8px;">${iconImg(nightIcon, 32)}</td>
    <td style="padding:8px;"><font size="3" ${FONT} color="#72767d">Night</font> &mdash; <font ${FONT} color="#dddddd">${nightPhrase}</font><br><font size="2" ${FONT} color="#72767d">Precip: ${nightPrecip}%</font></td>
    <td style="padding:8px;" align="right"><font ${FONT} color="#dddddd"><b>Low: ${lowF}&deg;F / ${lowC}&deg;C</b></font></td>
  </tr>
</table>`;
  return html;
}

function renderHourly(hourly) {
  if (!hourly || hourly.status !== 200 || !Array.isArray(hourly.data) || !hourly.data.length) {
    if (hourly && hourly.status !== 200)
      console.error(
        `AccuWeather hourly forecast API returned HTTP ${hourly.status}. Response:`,
        JSON.stringify(hourly.data)
      );
    return `<font color="#ff4444" ${FONT}>Hourly forecast unavailable for this location.</font><br>`;
  }
  const html =
    `<table cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">\n` +
    hourly.data
      .map((hour) => {
        const time = formatHour(hour.DateTime);
        const tempF = hour.Temperature?.Value ?? '--';
        const tempC = fToC(tempF);
        const phrase = escape(hour.IconPhrase || '');
        const iconCode = hour.WeatherIcon || 1;
        const precipProb = hour.PrecipitationProbability ?? '--';
        const windMph = hour.Wind?.Speed?.Value;
        const windKmh =
          windMph !== null && windMph !== undefined ? (windMph * MPH_TO_KMH).toFixed(1) : null;
        const windStr =
          windMph !== null && windMph !== undefined
            ? ` &mdash; Wind: ${windMph} mph / ${windKmh} km/h`
            : '';
        return `  <tr style="border-bottom:1px solid #40444b;">
    <td style="padding:6px 8px;white-space:nowrap;width:70px;"><font size="2" ${FONT} color="#b5bac1">${time}</font></td>
    <td style="padding:6px 4px;width:28px;">${iconImg(iconCode, 24)}</td>
    <td style="padding:6px 8px;"><font ${FONT} color="#dddddd">${tempF}&deg;F / ${tempC}&deg;C</font><br><font size="2" ${FONT} color="#72767d">${phrase}${windStr} &mdash; Precip: ${precipProb}%</font></td>
  </tr>\n`;
      })
      .join('') +
    `</table>\n`;
  return html;
}

function renderDaily(daily) {
  if (!daily || daily.status !== 200 || !daily.data?.DailyForecasts?.length) {
    if (daily && daily.status !== 200)
      console.error(
        `AccuWeather daily forecast API returned HTTP ${daily.status}. Response:`,
        JSON.stringify(daily.data)
      );
    return `<font color="#ff4444" ${FONT}>5-day forecast unavailable for this location.</font><br>`;
  }
  const html =
    `<table cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">\n` +
    daily.data.DailyForecasts.map((day, i) => {
      const isLast = i === daily.data.DailyForecasts.length - 1;
      const dayLabel = i === 0 ? 'Today' : formatDay(day.Date);
      const highF = day.Temperature?.Maximum?.Value ?? '--';
      const lowF = day.Temperature?.Minimum?.Value ?? '--';
      const highC = fToC(highF);
      const lowC = fToC(lowF);
      const dayIcon = day.Day?.Icon || 1;
      const dayPhrase = escape(day.Day?.IconPhrase || '');
      return `  <tr${isLast ? '' : ' style="border-bottom:1px solid #40444b;"'}>
    <td style="padding:8px;white-space:nowrap;width:80px;"><font size="2" ${FONT} color="#b5bac1"><b>${dayLabel}</b></font></td>
    <td style="padding:8px;width:32px;">${iconImg(dayIcon, 24)}</td>
    <td style="padding:8px;"><font ${FONT} color="#dddddd">${dayPhrase}</font></td>
    <td style="padding:8px;" align="right"><font ${FONT} color="#dddddd"><b>${highF}&deg;F / ${highC}&deg;C</b></font><br><font size="2" ${FONT} color="#72767d">${lowF}&deg;F / ${lowC}&deg;C</font></td>
  </tr>\n`;
    }).join('') +
    `</table>\n`;
  return html;
}

exports.processWeather = async function processWeather(req, res) {
  const discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  const parsedUrl = new URL(req.url, 'http://localhost');
  const city = parsedUrl.searchParams.get('city') || '';
  const rawView = parsedUrl.searchParams.get('view') || '';
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  // Resolve view: use rawView if it matches a known view, otherwise default to 'current' when a city is set
  const view = VIEWS.some((v) => v.id === rawView) ? rawView : city.trim() ? 'current' : '';
  const themeClass = getPageThemeAttr(req);
  let weatherHtml = '';
  let navHtml = '';

  if (city.trim()) {
    const trimmedCity = city.trim().slice(0, CITY_MAX_LENGTH);
    try {
      // Step 1: Find location key from city name
      const locationPath = `/locations/v1/cities/search?q=${encodeURIComponent(trimmedCity)}&apikey=${ACCUWEATHER_API_KEY}`;
      const locResult = await fetchJson(ACCUWEATHER_HOST, locationPath);

      if (locResult.status === 401) {
        console.error(
          'AccuWeather location API returned 401 (unauthorized). Check API key. Response:',
          JSON.stringify(locResult.data)
        );
        weatherHtml = `<font color="#ff4444" ${FONT}>Weather service unavailable. Please try again later.</font><br>`;
      } else if (locResult.status === 429) {
        console.error('AccuWeather location API returned 429 (rate limited).');
        weatherHtml = `<font color="#ff4444" ${FONT}>Too many requests. Please wait a moment and try again.</font><br>`;
      } else if (locResult.status !== 200) {
        console.error(
          `AccuWeather location API returned HTTP ${locResult.status}. Response:`,
          JSON.stringify(locResult.data)
        );
        weatherHtml = `<font color="#ff4444" ${FONT}>Weather service unavailable. Please try again later.</font><br>`;
      } else if (!Array.isArray(locResult.data) || locResult.data.length === 0) {
        weatherHtml = `<font color="#ff4444" ${FONT}>City not found. Please try a different city name.</font><br>`;
      } else {
        const location = locResult.data[0];
        const locationKey = location.Key;
        const cityName = location.LocalizedName || '';
        const country = location.Country?.LocalizedName || '';
        const adminArea = location.AdministrativeArea?.LocalizedName || '';
        const locationParts = [escape(cityName)];
        if (adminArea) locationParts.push(escape(adminArea));
        if (country) locationParts.push(escape(country));
        const locationDisplay = locationParts.join(', ');

        // Build navigation buttons (pass trimmedCity so the links preserve the normalised name)
        navHtml = buildNavButtons(trimmedCity, view, urlSessionID);

        // Location header
        weatherHtml = `<font size="5" ${FONT} color="#dddddd"><b>${locationDisplay}</b></font><br><br>\n`;

        // Step 2: Fetch only what this view needs, then render
        const VIEW_CONFIG = {
          current: {
            endpoint: `/currentconditions/v1/${encodeURIComponent(locationKey)}?apikey=${ACCUWEATHER_API_KEY}&details=true`,
            renderer: renderCurrent,
            errLabel: 'current conditions',
          },
          today: {
            endpoint: `/forecasts/v1/daily/5day/${encodeURIComponent(locationKey)}?apikey=${ACCUWEATHER_API_KEY}&details=true`,
            renderer: renderToday,
            errLabel: 'daily forecast',
          },
          hourly: {
            endpoint: `/forecasts/v1/hourly/12hour/${encodeURIComponent(locationKey)}?apikey=${ACCUWEATHER_API_KEY}&details=true`,
            renderer: renderHourly,
            errLabel: 'hourly forecast',
          },
          daily: {
            endpoint: `/forecasts/v1/daily/5day/${encodeURIComponent(locationKey)}?apikey=${ACCUWEATHER_API_KEY}&details=true`,
            renderer: renderDaily,
            errLabel: '5-day forecast',
          },
        };
        const cfg = VIEW_CONFIG[view];
        if (cfg) {
          const result = await fetchJson(ACCUWEATHER_HOST, cfg.endpoint).catch((err) => {
            console.error(`AccuWeather ${cfg.errLabel} error:`, err.message);
            return null;
          });
          weatherHtml += cfg.renderer(result);
        }
      }
    } catch (err) {
      console.error('Weather API error:', err.message);
      weatherHtml = `<font color="#ff4444" ${FONT}>Unable to fetch weather data. Please try again later.</font><br>`;
    }
  }

  const menuOptions = strReplace(
    logged_in_template,
    '{$USER}',
    escape(await auth.getUsername(discordID))
  );
  const withTheme = strReplace(weather_template, '{$WHITE_THEME_ENABLED}', themeClass);
  const withMenu = strReplace(withTheme, '{$MENU_OPTIONS}', menuOptions);
  const withCity = strReplace(withMenu, '{$CITY_VALUE}', escape(city));
  const withNav = strReplace(withCity, '{$NAV_BUTTONS}', navHtml);
  const withContent = strReplace(withNav, '{$WEATHER_CONTENT}', weatherHtml);
  const response = strReplace(withContent, '{$SESSION_ID}', escape(urlSessionID));

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
