'use strict';

const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const escape = require('escape-html');

const auth = require('../authentication.js');

const ACCUWEATHER_API_KEY = process.env.ACCUWEATHER_API_KEY || '6e30dc9ea2aa4d3eb99ad8f6630174cd';
const ACCUWEATHER_HOST = 'api.accuweather.com';

// Max city name length to prevent abuse
const CITY_MAX_LENGTH = 100;

// Map AccuWeather icon codes (1-44) to Twemoji file names (without .gif)
const WEATHER_ICONS = {
  1:  '2600',    // Sunny
  2:  '1f324',   // Mostly Sunny
  3:  '26c5',    // Partly Sunny
  4:  '1f325',   // Intermittent Clouds
  5:  '1f324',   // Hazy Sunshine
  6:  '1f325',   // Mostly Cloudy
  7:  '2601',    // Cloudy
  8:  '2601',    // Dreary (Overcast)
  11: '1f32b',   // Fog
  12: '1f327',   // Showers
  13: '1f327',   // Mostly Cloudy w/ Showers
  14: '1f327',   // Partly Sunny w/ Showers
  15: '1f329',   // T-Storms
  16: '1f329',   // Mostly Cloudy w/ T-Storms
  17: '1f329',   // Partly Sunny w/ T-Storms
  18: '2614',    // Rain
  19: '1f328',   // Flurries
  20: '1f328',   // Mostly Cloudy w/ Flurries
  21: '1f328',   // Partly Sunny w/ Flurries
  22: '2744',    // Snow
  23: '2744',    // Mostly Cloudy w/ Snow
  24: '2744',    // Ice
  25: '1f327',   // Sleet
  26: '1f327',   // Freezing Rain
  29: '1f327',   // Rain and Snow
  30: '1f321',   // Hot
  31: '1f321',   // Cold
  32: '1f32c',   // Windy
  33: '2600',    // Clear (night)
  34: '1f324',   // Mostly Clear (night)
  35: '26c5',    // Partly Cloudy (night)
  36: '1f325',   // Intermittent Clouds (night)
  37: '1f32b',   // Hazy Moonlight
  38: '2601',    // Mostly Cloudy (night)
  39: '1f327',   // Partly Cloudy w/ Showers (night)
  40: '1f327',   // Mostly Cloudy w/ Showers (night)
  41: '1f329',   // Partly Cloudy w/ T-Storms (night)
  42: '1f329',   // Mostly Cloudy w/ T-Storms (night)
  43: '1f328',   // Mostly Cloudy w/ Flurries (night)
  44: '2744',    // Mostly Cloudy w/ Snow (night)
};

const weather_template = fs.readFileSync('pages/templates/weather.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

function fetchJson(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
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

exports.processWeather = async function processWeather(req, res) {
  const discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  const parsedUrl = new URL(req.url, 'http://localhost');
  const city = parsedUrl.searchParams.get('city') || '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(c => c.startsWith('whiteThemeCookie='))?.split('=')[1];
  const themeValue = urlTheme !== null ? parseInt(urlTheme, 10) : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie, 10) : 0);

  let themeClass = '';
  if (themeValue === 1) {
    themeClass = 'class="light-theme"';
  } else if (themeValue === 2) {
    themeClass = 'class="amoled-theme"';
  }

  let weatherHtml = '';

  if (city.trim()) {
    const trimmedCity = city.trim().slice(0, CITY_MAX_LENGTH);
    try {
      // Step 1: Find location key from city name
      const locationPath = `/locations/v1/cities/search?q=${encodeURIComponent(trimmedCity)}&apikey=${ACCUWEATHER_API_KEY}`;
      const locResult = await fetchJson(ACCUWEATHER_HOST, locationPath);

      if (locResult.status === 401) {
        console.error('AccuWeather location API returned 401 (unauthorized). Check API key. Response:', JSON.stringify(locResult.data));
        weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">Weather service unavailable. Please try again later.</font><br>`;
      } else if (locResult.status === 429) {
        console.error('AccuWeather location API returned 429 (rate limited).');
        weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">Too many requests. Please wait a moment and try again.</font><br>`;
      } else if (locResult.status !== 200) {
        console.error(`AccuWeather location API returned HTTP ${locResult.status}. Response:`, JSON.stringify(locResult.data));
        weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">Weather service unavailable. Please try again later.</font><br>`;
      } else if (!locResult.data || !Array.isArray(locResult.data) || locResult.data.length === 0) {
        weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">City not found. Please try a different city name.</font><br>`;
      } else {
        const location = locResult.data[0];
        const locationKey = location.Key;
        const cityName = location.LocalizedName || '';
        const country = location.Country?.LocalizedName || '';
        const adminArea = location.AdministrativeArea?.LocalizedName || '';

        // Step 2: Get current conditions with details
        const condPath = `/currentconditions/v1/${encodeURIComponent(locationKey)}?apikey=${ACCUWEATHER_API_KEY}&details=true`;
        const condResult = await fetchJson(ACCUWEATHER_HOST, condPath);

        if (condResult.status === 429) {
          console.error('AccuWeather conditions API returned 429 (rate limited).');
          weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">Too many requests. Please wait a moment and try again.</font><br>`;
        } else if (condResult.status !== 200) {
          console.error(`AccuWeather conditions API returned HTTP ${condResult.status}. Response:`, JSON.stringify(condResult.data));
          weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">Weather service unavailable. Please try again later.</font><br>`;
        } else if (!condResult.data || !Array.isArray(condResult.data) || condResult.data.length === 0) {
          weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">Weather data unavailable for this location.</font><br>`;
        } else {
          const cond = condResult.data[0];

          const iconCode = cond.WeatherIcon || 1;
          const iconFile = WEATHER_ICONS[iconCode] || '2600';
          const weatherText = escape(cond.WeatherText || '');

          const tempF = cond.Temperature?.Imperial?.Value ?? '--';
          const tempC = cond.Temperature?.Metric?.Value ?? '--';
          const feelsLikeF = cond.RealFeelTemperature?.Imperial?.Value ?? '--';
          const feelsLikeC = cond.RealFeelTemperature?.Metric?.Value ?? '--';
          const humidity = cond.RelativeHumidity ?? '--';
          const windSpeedMph = cond.Wind?.Speed?.Imperial?.Value ?? '--';
          const windSpeedKmh = cond.Wind?.Speed?.Metric?.Value ?? '--';
          const windDir = cond.Wind?.Direction?.Localized || '';
          const visibilityMi = cond.Visibility?.Imperial?.Value ?? '--';
          const visibilityKm = cond.Visibility?.Metric?.Value ?? '--';
          const pressureInHg = cond.Pressure?.Imperial?.Value ?? '--';
          const pressureMb = cond.Pressure?.Metric?.Value ?? '--';
          const uvIndex = cond.UVIndex ?? '--';
          const uvText = cond.UVIndexText ? escape(cond.UVIndexText) : '';
          const cloudCover = cond.CloudCover ?? '--';
          const dewPointF = cond.DewPoint?.Imperial?.Value ?? '--';
          const dewPointC = cond.DewPoint?.Metric?.Value ?? '--';

          const locationParts = [escape(cityName)];
          if (adminArea) locationParts.push(escape(adminArea));
          if (country) locationParts.push(escape(country));
          const locationDisplay = locationParts.join(', ');

          weatherHtml = `<table cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;">
  <tr valign="top">
    <td style="padding-right:16px;width:80px;">
      <img src="/resources/twemoji/${iconFile}.gif" alt="${weatherText}" width="64" height="64" style="width:64px;height:64px;">
    </td>
    <td valign="top">
      <font size="5" face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${locationDisplay}</b></font><br>
      <font size="4" face="'rodin', Arial, Helvetica, sans-serif" color="#b5bac1">${weatherText}</font><br>
      <font size="6" face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${tempF}&deg;F / ${tempC}&deg;C</b></font><br>
      <font size="3" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">Feels like ${feelsLikeF}&deg;F / ${feelsLikeC}&deg;C</font>
    </td>
  </tr>
</table>
<br>
<table cellpadding="8" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">
  <tr>
    <td style="border-bottom:1px solid #40444b;width:50%;vertical-align:top;">
      <font size="2" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">Humidity</font><br>
      <font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${humidity}%</b></font>
    </td>
    <td style="border-bottom:1px solid #40444b;width:50%;vertical-align:top;">
      <font size="2" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">Wind</font><br>
      <font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${windSpeedMph} mph / ${windSpeedKmh} km/h${windDir ? ' ' + escape(windDir) : ''}</b></font>
    </td>
  </tr>
  <tr>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">Visibility</font><br>
      <font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${visibilityMi} mi / ${visibilityKm} km</b></font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">Pressure</font><br>
      <font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${pressureInHg} inHg / ${pressureMb} mb</b></font>
    </td>
  </tr>
  <tr>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">UV Index</font><br>
      <font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${uvIndex}${uvText ? ' (' + uvText + ')' : ''}</b></font>
    </td>
    <td style="border-bottom:1px solid #40444b;vertical-align:top;">
      <font size="2" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">Cloud Cover</font><br>
      <font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${cloudCover}%</b></font>
    </td>
  </tr>
  <tr>
    <td style="vertical-align:top;">
      <font size="2" face="'rodin', Arial, Helvetica, sans-serif" color="#72767d">Dew Point</font><br>
      <font face="'rodin', Arial, Helvetica, sans-serif" color="#dddddd"><b>${dewPointF}&deg;F / ${dewPointC}&deg;C</b></font>
    </td>
    <td style="vertical-align:top;">
    </td>
  </tr>
</table>`;
        }
      }
    } catch (err) {
      console.error('Weather API error:', err.message);
      weatherHtml = `<font color="#ff4444" face="'rodin', Arial, Helvetica, sans-serif">Unable to fetch weather data. Please try again later.</font><br>`;
    }
  }

  let response = strReplace(weather_template, '{$WHITE_THEME_ENABLED}', themeClass);
  response = strReplace(response, '{$MENU_OPTIONS}',
    strReplace(logged_in_template, '{$USER}', escape(await auth.getUsername(discordID)))
  );
  response = strReplace(response, '{$CITY_VALUE}', escape(city));
  response = strReplace(response, '{$WEATHER_CONTENT}', weatherHtml);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
