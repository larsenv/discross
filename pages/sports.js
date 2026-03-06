'use strict';

const fs = require('fs');
const https = require('https');
const escape = require('escape-html');

const auth = require('../authentication.js');

const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;

const sports_template = fs
  .readFileSync('pages/templates/sports.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

const SPORTS = [
  { id: 'nfl', label: 'NFL', path: '/apis/site/v2/sports/football/nfl/scoreboard' },
  { id: 'nba', label: 'NBA', path: '/apis/site/v2/sports/basketball/nba/scoreboard' },
  { id: 'mlb', label: 'MLB', path: '/apis/site/v2/sports/baseball/mlb/scoreboard' },
  { id: 'nhl', label: 'NHL', path: '/apis/site/v2/sports/hockey/nhl/scoreboard' },
  { id: 'soccer', label: 'Soccer', path: '/apis/site/v2/sports/soccer/usa.1/scoreboard' },
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

function formatGameTime(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    });
  } catch (_) {
    return '';
  }
}

function statusColor(stateType) {
  if (stateType === 'in') return '#57f287'; // green = live
  if (stateType === 'post') return '#72767d'; // grey = final
  return '#dddddd'; // pre = upcoming
}

function renderScoreboard(data) {
  const events = data && data.events;
  if (!events || events.length === 0) {
    return `<font ${FONT} color="#72767d">No games scheduled recently.</font><br>`;
  }

  let html = `<table cellpadding="0" cellspacing="0" width="100%" style="max-width:580px;border-collapse:collapse;">\n`;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const competition = event.competitions && event.competitions[0];
    if (!competition) continue;

    const competitors = competition.competitors || [];
    const homeTeam = competitors.find((c) => c.homeAway === 'home');
    const awayTeam = competitors.find((c) => c.homeAway === 'away');

    const status = event.status || {};
    const stateType = (status.type && status.type.state) || 'pre';
    const statusDetail = (status.type && status.type.shortDetail) || '';
    const color = statusColor(stateType);
    const isLast = i === events.length - 1;
    const borderStyle = isLast ? '' : ' style="border-bottom:1px solid #40444b;"';

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

    const gameTimeDisplay =
      stateType === 'pre' ? formatGameTime(competition.date || event.date) : escape(statusDetail);

    html += `  <tr${borderStyle}>
    <td style="padding:8px;width:52px;text-align:center;">
      <font size="3" ${FONT} color="${awayColor}">${awayWeight}${awayName}${awayWeightEnd}</font>
    </td>
    <td style="padding:8px;width:36px;text-align:center;">
      <font size="4" ${FONT} color="${awayColor}"><b>${awayScore}</b></font>
    </td>
    <td style="padding:8px;text-align:center;">
      <font size="2" ${FONT} color="${color}">${escape(stateType === 'in' ? statusDetail : (stateType === 'post' ? 'Final' : ''))}</font>
    </td>
    <td style="padding:8px;width:36px;text-align:center;">
      <font size="4" ${FONT} color="${homeColor}"><b>${homeScore}</b></font>
    </td>
    <td style="padding:8px;width:52px;text-align:center;">
      <font size="3" ${FONT} color="${homeColor}">${homeWeight}${homeName}${homeWeightEnd}</font>
    </td>
    <td style="padding:8px;white-space:nowrap;">
      <font size="2" ${FONT} color="#72767d">${gameTimeDisplay}</font>
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
  const sportId = parsedUrl.searchParams.get('sport') || 'nfl';
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';

  const whiteThemeCookie = req.headers.cookie
    ?.split('; ')
    ?.find((c) => c.startsWith('whiteThemeCookie='))
    ?.split('=')[1];
  const themeValue = whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie, 10) : 0;

  let themeClass = '';
  if (themeValue === 1) themeClass = 'class="light-theme"';
  else if (themeValue === 2) themeClass = 'class="amoled-theme"';

  const sport = SPORTS.find((s) => s.id === sportId) || SPORTS[0];
  const navHtml = buildNavButtons(sport.id, urlSessionID);

  let sportsHtml = '';
  try {
    const data = await fetchJson(sport.path);
    sportsHtml = renderScoreboard(data);
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
