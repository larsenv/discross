'use strict';

const fs = require('fs');
const https = require('https');
const escape = require('escape-html');

const auth = require('../authentication.js');

const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;

// Fallback timezone when user cookie is absent or invalid
const DEFAULT_TZ = 'America/New_York';

// Game state colors (text + row background)
const COLOR_LIVE = '#57f287'; // green text — in-progress game
const COLOR_FINAL = '#72767d'; // grey text — finished game
const COLOR_UPCOMING = '#dddddd'; // white text — scheduled game
const BG_LIVE = '#1a2f22'; // dark green tint — in-progress row
const BG_FINAL = '#25262b'; // slightly dimmer — finished row
const BG_UPCOMING = '#2f3136'; // default dark — upcoming row

const sports_template = fs
  .readFileSync('pages/templates/sports.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

// NBA first — in full regular season; NFL last since it's off-season in early spring
const SPORTS = [
  { id: 'nba', label: 'NBA', path: '/apis/site/v2/sports/basketball/nba/scoreboard' },
  { id: 'nhl', label: 'NHL', path: '/apis/site/v2/sports/hockey/nhl/scoreboard' },
  { id: 'mlb', label: 'MLB', path: '/apis/site/v2/sports/baseball/mlb/scoreboard' },
  { id: 'soccer', label: 'Soccer', path: '/apis/site/v2/sports/soccer/usa.1/scoreboard' },
  { id: 'nfl', label: 'NFL', path: '/apis/site/v2/sports/football/nfl/scoreboard' },
];

const ESPN_HOST = 'site.api.espn.com';

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ESPN_HOST,
        path,
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`ESPN API returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Failed to parse ESPN API response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('ESPN API request timed out'));
    });
    req.end();
  });
}

// Returns a YYYYMMDD string for today + daysOffset in UTC
function getDateString(daysOffset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Read and validate a timezone string from cookies; fall back to DEFAULT_TZ
function getUserTZ(cookieHeader) {
  if (!cookieHeader) return DEFAULT_TZ;
  const match = cookieHeader.split('; ').find((c) => c.startsWith('userTZ='));
  if (!match) return DEFAULT_TZ;
  const raw = decodeURIComponent(match.split('=').slice(1).join('='));
  // Validate: attempt to use it; Intl throws for unknown zones
  try {
    Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch (_) {
    return DEFAULT_TZ;
  }
}

function formatGameTime(dateStr, userTZ) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: userTZ,
      timeZoneName: 'short',
    });
  } catch (_) {
    return '';
  }
}

// Text color for the status label and time column
function statusColor(stateType) {
  if (stateType === 'in') return COLOR_LIVE;
  if (stateType === 'post') return COLOR_FINAL;
  return COLOR_UPCOMING;
}

// Row background color to visually distinguish game states
function rowBgColor(stateType) {
  if (stateType === 'in') return BG_LIVE;
  if (stateType === 'post') return BG_FINAL;
  return BG_UPCOMING;
}

// Expand common ESPN shortDetail abbreviations that may be confusing
function expandStatusDetail(text) {
  if (!text) return text;
  return text
    .replace(/^Bot\b/, 'Bottom') // baseball: "Bot 7th" → "Bottom 7th"
    .replace(/^End\b/, 'End of') // baseball: "End 5th" → "End of 5th"
    .replace(/^Mid\b/, 'Mid-') // baseball: "Mid 3rd" → "Mid-3rd"
    .replace(/^P(\d)\b/, 'Period $1') // hockey: "P2 14:22" → "Period 2 14:22"
    .replace(/^OT\b/, 'Overtime') // all sports: "OT" → "Overtime"
    .replace(/^HT\b/, 'Halftime') // soccer: "HT" → "Halftime"
    .replace(/^FT\b/, 'Full Time'); // soccer: "FT" → "Full Time"
}

// Sort events: live (in) first, then upcoming (pre) by start time asc, then finished (post) by time desc
function sortEvents(events) {
  const stateOrder = { in: 0, pre: 1, post: 2 };
  return [...events].sort((a, b) => {
    const aState = (a.status && a.status.type && a.status.type.state) || 'pre';
    const bState = (b.status && b.status.type && b.status.type.state) || 'pre';
    const aOrder = stateOrder[aState] != null ? stateOrder[aState] : 1;
    const bOrder = stateOrder[bState] != null ? stateOrder[bState] : 1;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aTime = new Date(a.date || 0).getTime();
    const bTime = new Date(b.date || 0).getTime();
    // Upcoming: earlier games first; live/finished: most recent first
    return aState === 'pre' ? aTime - bTime : bTime - aTime;
  });
}

function renderScoreboard(events, userTZ) {
  if (!events || events.length === 0) {
    return `<font ${FONT} color="#72767d">No games scheduled recently.</font><br>`;
  }

  // 640px to accommodate full date/timezone strings (wider than stock/weather 580px)
  let html = `<table cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;border-collapse:collapse;">\n`;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const competition = event.competitions && event.competitions[0];
    if (!competition) continue;

    const competitors = competition.competitors || [];
    const homeTeam = competitors.find((c) => c.homeAway === 'home');
    const awayTeam = competitors.find((c) => c.homeAway === 'away');

    const status = event.status || {};
    const stateType = (status.type && status.type.state) || 'pre';
    const statusDetail = expandStatusDetail((status.type && status.type.shortDetail) || '');
    const color = statusColor(stateType);
    const bgColor = rowBgColor(stateType);
    const isLast = i === events.length - 1;
    const borderBottom = isLast ? '' : 'border-bottom:1px solid #40444b;';
    const rowStyle = ` style="background-color:${bgColor};${borderBottom}"`;

    const homeName = escape((homeTeam && homeTeam.team && homeTeam.team.abbreviation) || '???');
    const awayName = escape((awayTeam && awayTeam.team && awayTeam.team.abbreviation) || '???');
    const homeScore = homeTeam && homeTeam.score != null ? escape(String(homeTeam.score)) : '-';
    const awayScore = awayTeam && awayTeam.score != null ? escape(String(awayTeam.score)) : '-';

    const homeWinner = homeTeam && homeTeam.winner === true;
    const awayWinner = awayTeam && awayTeam.winner === true;

    const homeColor = homeWinner ? '#dddddd' : '#b5bac1';
    const awayColor = awayWinner ? '#dddddd' : '#b5bac1';
    const homeWeight = homeWinner ? '<b>' : '';
    const homeWeightEnd = homeWinner ? '</b>' : '';
    const awayWeight = awayWinner ? '<b>' : '';
    const awayWeightEnd = awayWinner ? '</b>' : '';

    let gameTimeDisplay;
    if (stateType === 'in') {
      // Status is already shown in the center column; show start time dimmed for context
      gameTimeDisplay = escape(formatGameTime(competition.date || event.date, userTZ));
    } else if (stateType === 'post') {
      gameTimeDisplay = `Final &mdash; ${escape(formatGameTime(competition.date || event.date, userTZ))}`;
    } else {
      gameTimeDisplay = escape(formatGameTime(competition.date || event.date, userTZ));
    }

    const statusLabel = stateType === 'in' ? escape(statusDetail) : stateType === 'post' ? 'Final' : '';

    html += `  <tr${rowStyle}>
    <td style="padding:8px;width:52px;text-align:center;">
      <font size="3" ${FONT} color="${awayColor}">${awayWeight}${awayName}${awayWeightEnd}</font>
    </td>
    <td style="padding:8px;width:36px;text-align:center;">
      <font size="4" ${FONT} color="${awayColor}"><b>${awayScore}</b></font>
    </td>
    <td style="padding:8px;text-align:center;">
      <font size="2" ${FONT} color="${color}">${statusLabel}</font>
    </td>
    <td style="padding:8px;width:36px;text-align:center;">
      <font size="4" ${FONT} color="${homeColor}"><b>${homeScore}</b></font>
    </td>
    <td style="padding:8px;width:52px;text-align:center;">
      <font size="3" ${FONT} color="${homeColor}">${homeWeight}${homeName}${homeWeightEnd}</font>
    </td>
    <td style="padding:8px;white-space:nowrap;">
      <font size="2" ${FONT} color="${stateType === 'in' ? COLOR_FINAL : color}">${gameTimeDisplay}</font>
    </td>
  </tr>\n`;
  }

  html += `</table>\n`;
  return html;
}

function buildNavButtons(activeSport, urlSessionID) {
  const sessionParam = urlSessionID ? `?sessionID=${encodeURIComponent(urlSessionID)}&sport=` : '?sport=';
  let html = '';
  for (const s of SPORTS) {
    const isActive = s.id === activeSport;
    const bg = isActive ? '#5865f2' : '#2f3136';
    const borderR = s === SPORTS[SPORTS.length - 1] ? 'border-radius:0 4px 4px 0;' : '';
    const borderL = s === SPORTS[0] ? 'border-radius:4px 0 0 4px;' : '';
    html += `<a href="/sports${sessionParam}${encodeURIComponent(s.id)}" style="display:inline-block;padding:6px 12px;background:${bg};color:#dddddd;text-decoration:none;font-family:'rodin',Arial,Helvetica,sans-serif;font-size:14px;${borderL}${borderR}"><font ${FONT} color="#dddddd">${s.label}</font></a>`;
  }
  return html + '<br><br>';
}

exports.processSports = async function processSports(req, res) {
  const discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  const parsedUrl = new URL(req.url, 'http://localhost');
  const sportId = parsedUrl.searchParams.get('sport') || 'nba';
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';

  const cookieHeader = req.headers.cookie || '';
  const userTZ = getUserTZ(cookieHeader);

  const whiteThemeCookie = cookieHeader
    .split('; ')
    .find((c) => c.startsWith('whiteThemeCookie='))
    ?.split('=')[1];
  const themeValue = whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie, 10) : 0;

  let themeClass = '';
  if (themeValue === 1) themeClass = 'class="light-theme"';
  else if (themeValue === 2) themeClass = 'class="amoled-theme"';

  const sport = SPORTS.find((s) => s.id === sportId) || SPORTS[0];
  const navHtml = buildNavButtons(sport.id, urlSessionID);

  let sportsHtml = '';
  try {
    const todayStr = getDateString(0);
    const yestStr = getDateString(-1);

    const [todayResult, yestResult] = await Promise.allSettled([
      fetchJson(`${sport.path}?dates=${todayStr}`),
      fetchJson(`${sport.path}?dates=${yestStr}`),
    ]);

    const todayEvents = todayResult.status === 'fulfilled' ? (todayResult.value?.events || []) : [];

    // Include recently finished games from yesterday (cap at 8 to avoid a wall of scores)
    const yestEvents =
      yestResult.status === 'fulfilled'
        ? (yestResult.value?.events || [])
            .filter((e) => e?.status?.type?.state === 'post')
            .slice(0, 8)
        : [];

    const allEvents = sortEvents([...todayEvents, ...yestEvents]);
    sportsHtml = renderScoreboard(allEvents, userTZ);
  } catch (err) {
    console.error('Sports API error:', err.message);
    sportsHtml = `<font color="#ff4444" ${FONT}>Unable to load scores. Please try again later.</font><br>`;
  }

  let response = strReplace(sports_template, '{$WHITE_THEME_ENABLED}', themeClass);
  response = strReplace(
    response,
    '{$MENU_OPTIONS}',
    strReplace(logged_in_template, '{$USER}', escape(await auth.getUsername(discordID)))
  );
  response = strReplace(response, '{$NAV_BUTTONS}', navHtml);
  response = strReplace(response, '{$SPORTS_CONTENT}', sportsHtml);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
