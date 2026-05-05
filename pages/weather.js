'use strict';

const https = require('https');
const zlib = require('zlib');
const escape = require('escape-html');

const auth = require('../authentication.js');
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');

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
    return renderTemplate(getTemplate('icon', 'weather'), {
        FILE: file,
        SIZE: s.toString(),
    });
}

function buildNavButtons(city, activeView, urlSessionID) {
    const cityEnc = encodeURIComponent(city);
    const sessionSuffix = urlSessionID ? `&sessionID=${encodeURIComponent(urlSessionID)}` : '';
    const rows = VIEWS.map((v) => {
        const cls = v.id === activeView ? 'discross-button' : 'discross-button secondary';
        return renderTemplate(getTemplate('nav_button', 'weather'), {
            CITY_ENC: cityEnc,
            VIEW_ID: v.id,
            SESSION_SUFFIX: sessionSuffix,
            CLASS: cls,
            LABEL: v.label,
        });
    });
    return renderTemplate(getTemplate('nav_table', 'weather'), { ROWS: rows.join('') });
}

const weather_template = loadAndRenderPageTemplate('weather');

const logged_in_template = getTemplate('logged_in', 'index');

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
                    encoding === 'gzip'
                        ? zlib.gunzip
                        : encoding === 'deflate'
                          ? zlib.inflate
                          : null;
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
                        if (err)
                            return reject(
                                new Error(`Failed to decompress response: ${err.message}`)
                            );
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
        return getTemplate('current_conditions_error', 'weather');
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

    return renderTemplate(getTemplate('current_view', 'weather'), {
        ICON_HTML: iconImg(iconCode, 64),
        WEATHER_TEXT: weatherText,
        TEMP_F: tempF.toString(),
        TEMP_C: tempC.toString(),
        FEELS_LIKE_F: feelsLikeF.toString(),
        FEELS_LIKE_C: feelsLikeC.toString(),
        HUMIDITY: humidity.toString(),
        WIND_SPEED_MPH: windSpeedMph.toString(),
        WIND_SPEED_KMH: windSpeedKmh.toString(),
        WIND_DIR: windDir ? ' ' + windDir : '',
        VISIBILITY_MI: visibilityMi.toString(),
        VISIBILITY_KM: visibilityKm.toString(),
        PRESSURE_INHG: pressureInHg.toString(),
        PRESSURE_MB: pressureMb.toString(),
        UV_INDEX: uvIndex.toString(),
        UV_TEXT: uvText ? ' (' + uvText + ')' : '',
        CLOUD_COVER: cloudCover.toString(),
        DEW_POINT_F: dewPointF.toString(),
        DEW_POINT_C: dewPointC.toString(),
    });
}

function renderToday(daily) {
    if (!daily || daily.status !== 200 || !daily.data?.DailyForecasts?.length) {
        if (daily && daily.status !== 200)
            console.error(
                `AccuWeather daily forecast API returned HTTP ${daily.status}. Response:`,
                JSON.stringify(daily.data)
            );
        return renderTemplate(getTemplate('forecast_error', 'weather'), { VIEW_NAME: "Today's" });
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

    const headlineHtml = headline
        ? renderTemplate(getTemplate('headline', 'weather'), { TEXT: headline })
        : '';

    return renderTemplate(getTemplate('today_view', 'weather'), {
        HEADLINE_HTML: headlineHtml,
        DAY_ICON_HTML: iconImg(dayIcon, 32),
        DAY_PHRASE: dayPhrase,
        DAY_PRECIP: dayPrecip.toString(),
        HIGH_F: highF.toString(),
        HIGH_C: highC.toString(),
        NIGHT_ICON_HTML: iconImg(nightIcon, 32),
        NIGHT_PHRASE: nightPhrase,
        NIGHT_PRECIP: nightPrecip.toString(),
        LOW_F: lowF.toString(),
        LOW_C: lowC.toString(),
    });
}

function renderHourly(hourly) {
    if (!hourly || hourly.status !== 200 || !Array.isArray(hourly.data) || !hourly.data.length) {
        if (hourly && hourly.status !== 200)
            console.error(
                `AccuWeather hourly forecast API returned HTTP ${hourly.status}. Response:`,
                JSON.stringify(hourly.data)
            );
        return renderTemplate(getTemplate('forecast_error', 'weather'), { VIEW_NAME: 'Hourly' });
    }
    const rows = hourly.data.map((hour) => {
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
        return renderTemplate(getTemplate('hourly_row', 'weather'), {
            TIME: time,
            ICON_HTML: iconImg(iconCode, 24),
            TEMP_F: tempF.toString(),
            TEMP_C: tempC.toString(),
            PHRASE: phrase,
            WIND_STR: windStr,
            PRECIP_PROB: precipProb.toString(),
        });
    });
    return renderTemplate(getTemplate('table', 'weather'), { ROWS: rows.join('') });
}

function renderDaily(daily) {
    if (!daily || daily.status !== 200 || !daily.data?.DailyForecasts?.length) {
        if (daily && daily.status !== 200)
            console.error(
                `AccuWeather daily forecast API returned HTTP ${daily.status}. Response:`,
                JSON.stringify(daily.data)
            );
        return renderTemplate(getTemplate('forecast_error', 'weather'), { VIEW_NAME: '5-day' });
    }
    const rows = daily.data.DailyForecasts.map((day, i) => {
        const isLast = i === daily.data.DailyForecasts.length - 1;
        const dayLabel = i === 0 ? 'Today' : formatDay(day.Date);
        const highF = day.Temperature?.Maximum?.Value ?? '--';
        const lowF = day.Temperature?.Minimum?.Value ?? '--';
        const highC = fToC(highF);
        const lowC = fToC(lowF);
        const dayIcon = day.Day?.Icon || 1;
        const dayPhrase = escape(day.Day?.IconPhrase || '');
        return renderTemplate(getTemplate('daily_row', 'weather'), {
            ROW_STYLE: isLast ? '' : ' style="border-bottom:1px solid #40444b;"',
            DAY_LABEL: dayLabel,
            ICON_HTML: iconImg(dayIcon, 24),
            PHRASE: dayPhrase,
            HIGH_F: highF.toString(),
            HIGH_C: highC.toString(),
            LOW_F: lowF.toString(),
            LOW_C: lowC.toString(),
        });
    });
    return renderTemplate(getTemplate('table', 'weather'), { ROWS: rows.join('') });
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
                weatherHtml = renderTemplate(getTemplate('error-message', 'weather/partials'), {
                    MESSAGE: 'Weather service unavailable. Please try again later.',
                });
            } else if (locResult.status === 429) {
                console.error('AccuWeather location API returned 429 (rate limited).');
                weatherHtml = renderTemplate(getTemplate('error-message', 'weather/partials'), {
                    MESSAGE: 'Too many requests. Please wait a moment and try again.',
                });
            } else if (locResult.status !== 200) {
                console.error(
                    `AccuWeather location API returned HTTP ${locResult.status}. Response:`,
                    JSON.stringify(locResult.data)
                );
                weatherHtml = renderTemplate(getTemplate('error-message', 'weather/partials'), {
                    MESSAGE: 'Weather service unavailable. Please try again later.',
                });
            } else if (!Array.isArray(locResult.data) || locResult.data.length === 0) {
                weatherHtml = renderTemplate(getTemplate('error-message', 'weather/partials'), {
                    MESSAGE: 'City not found. Please try a different city name.',
                });
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
                weatherHtml = renderTemplate(getTemplate('location_header', 'weather'), {
                    LOCATION: locationDisplay,
                });

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
                        console.error(`AccuWeather ${cfg.errLabel} error:`, err);
                        return null;
                    });
                    weatherHtml += cfg.renderer(result);
                }
            }
        } catch (err) {
            console.error('Weather API error:', err);
            weatherHtml = renderTemplate(getTemplate('error-message', 'weather/partials'), {
                MESSAGE: 'Unable to fetch weather data. Please try again later.',
            });
        }
    }

    const menuOptions = renderTemplate(logged_in_template, {
        USER: escape(await auth.getUsername(discordID)),
    });

    const response = renderTemplate(weather_template, {
        WHITE_THEME_ENABLED: themeClass,
        MENU_OPTIONS: menuOptions,
        CITY_VALUE: escape(city),
        NAV_BUTTONS: navHtml,
        WEATHER_CONTENT: weatherHtml,
        SESSION_ID: escape(urlSessionID),
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
