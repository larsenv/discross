'use strict';

const fs = require('fs');
const https = require('https');
const escape = require('escape-html');
const he = require('he');

const auth = require('../authentication.js');

const TVPASSPORT_HOST = 'www.tvpassport.com';
const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;
const STATION_MAX_LENGTH = 50;

const tv_template = fs.readFileSync('pages/templates/tv.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

// Make an HTTPS GET request, following up to maxRedirects redirects.
function httpsGet(options, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise(function (resolve, reject) {
    var req = https.request(options, function (res) {
      var status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        var newOptions;
        try {
          var loc = new URL(res.headers.location);
          newOptions = {
            hostname: loc.hostname,
            path: loc.pathname + loc.search,
            method: 'GET',
            headers: options.headers,
          };
        } catch (e) {
          newOptions = Object.assign({}, options, { path: res.headers.location });
        }
        return httpsGet(newOptions, maxRedirects - 1).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ statusCode: status, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function () { req.destroy(new Error('Request timed out')); });
    req.end();
  });
}

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Fetch a TVPassport session cookie by visiting the listings page.
async function fetchCookie() {
  var result = await httpsGet({
    hostname: TVPASSPORT_HOST,
    path: '/tv-listings',
    method: 'GET',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  var setCookie = result.headers['set-cookie'];
  if (!setCookie || setCookie.length === 0) return '';
  var cookies = setCookie.map(function (c) { return c.split(';')[0]; });
  return cookies.join('; ');
}

// Fetch a station schedule HTML page from TVPassport.
function fetchSchedule(station, date, cookie) {
  return httpsGet({
    hostname: TVPASSPORT_HOST,
    path: '/tv-listings/stations/' + encodeURIComponent(station) + '/' + encodeURIComponent(date),
    method: 'GET',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.tvpassport.com/tv-listings',
      'Cookie': cookie,
    },
  });
}

// Extract a single data-* attribute value from an HTML tag string.
function parseDataAttr(tagHtml, name) {
  var pattern = new RegExp('\\bdata-' + name + '="([^"]*)"', 'i');
  var m = tagHtml.match(pattern);
  return m ? he.decode(m[1]) : '';
}

// Parse all list-group-item opening tags from the station-listings section.
function parseListings(html) {
  var items = [];
  // Locate the station-listings container.
  var sectionIdx = html.indexOf('station-listings');
  if (sectionIdx === -1) return items;
  var sectionHtml = html.slice(sectionIdx);

  // Match each list-group-item opening tag (which holds all data attributes).
  var itemTagRegex = /<[a-z]+[^>]+class="list-group-item"[^>]*>/gi;
  var m;
  while ((m = itemTagRegex.exec(sectionHtml)) !== null) {
    var tagHtml = m[0];
    items.push({
      showName: parseDataAttr(tagHtml, 'showName'),
      episodeTitle: parseDataAttr(tagHtml, 'episodeTitle'),
      description: parseDataAttr(tagHtml, 'description'),
      startTime: parseDataAttr(tagHtml, 'st'),
      duration: parseDataAttr(tagHtml, 'duration'),
      rating: parseDataAttr(tagHtml, 'rating'),
      showType: parseDataAttr(tagHtml, 'showType'),
    });
  }
  return items;
}

// Format a TVPassport start time string "YYYY-MM-DD HH:mm:ss" to "H:MM AM/PM".
// All TVPassport times are in Eastern Time.
function formatTime(timeStr) {
  if (!timeStr) return '';
  var timePart = timeStr.split(' ')[1];
  if (!timePart) return '';
  var parts = timePart.split(':');
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return '';
  var period = h >= 12 ? 'PM' : 'AM';
  var hour = h % 12 || 12;
  return hour + ':' + (m < 10 ? '0' : '') + m + ' ' + period;
}

// Get today's date in US Eastern Time as YYYY-MM-DD.
function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Build the HTML table for a list of TV listing items.
function buildListingsHtml(items) {
  var html = '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">\n';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var isLast = i === items.length - 1;
    var timeStr = escape(formatTime(item.startTime));
    var durationStr = item.duration ? escape(item.duration) + ' min' : '';
    var showName = escape(item.showName || '(Unknown)');
    var episodeTitle = item.episodeTitle ? ' &ndash; ' + escape(item.episodeTitle) : '';
    var rating = item.rating ? ' <font size="1" color="#72767d">[' + escape(item.rating) + ']</font>' : '';
    var showType = item.showType ? '<font size="2" color="#72767d">' + escape(item.showType) + '</font><br>' : '';
    var description = item.description ? '<font size="2" color="#aaaaaa">' + escape(item.description) + '</font>' : '';
    var rowStyle = isLast ? '' : ' style="border-bottom:1px solid #40444b;"';

    html += '  <tr' + rowStyle + '>\n';
    html += '    <td style="padding:8px;white-space:nowrap;width:70px;" valign="top">';
    html += '<font ' + FONT + ' color="#b5bac1" size="2"><b>' + timeStr + '</b>';
    if (durationStr) {
      html += '<br><font size="1" color="#72767d">' + durationStr + '</font>';
    }
    html += '</font></td>\n';
    html += '    <td style="padding:8px;" valign="top">';
    html += '<font ' + FONT + ' color="#dddddd"><b>' + showName + episodeTitle + '</b>' + rating + '</font><br>';
    html += showType + description;
    html += '</td>\n';
    html += '  </tr>\n';
  }
  html += '</table>\n';
  return html;
}

exports.processTV = async function processTV(req, res) {
  var discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  var parsedUrl = new URL(req.url, 'http://localhost');
  var station = (parsedUrl.searchParams.get('station') || '').trim().slice(0, STATION_MAX_LENGTH);
  var date = (parsedUrl.searchParams.get('date') || '').trim();
  var urlSessionID = parsedUrl.searchParams.get('sessionID') || '';

  // Validate date format; fall back to today in US Eastern Time.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = getTodayET();
  }

  // Theme handling (matches weather.js pattern).
  var urlTheme = parsedUrl.searchParams.get('theme');
  var whiteThemeCookie = (req.headers.cookie || '').split('; ')
    .filter(function (c) { return c.startsWith('whiteThemeCookie='); })[0];
  whiteThemeCookie = whiteThemeCookie ? whiteThemeCookie.split('=')[1] : undefined;
  var themeValue = urlTheme !== null
    ? parseInt(urlTheme, 10)
    : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie, 10) : 0);
  var themeClass = '';
  if (themeValue === 1) themeClass = 'class="light-theme"';
  else if (themeValue === 2) themeClass = 'class="amoled-theme"';

  var listingsHtml = '';

  if (station) {
    // Restrict station to alphanumeric, hyphens, and underscores (call sign characters).
    var cleanStation = station.replace(/[^a-zA-Z0-9\-_]/g, '');
    if (!cleanStation) {
      listingsHtml = '<font color="#ff4444" ' + FONT + '>Invalid station identifier. Use the station call sign (e.g. WNBC, WABC).</font><br>';
    } else {
      try {
        var cookie = await fetchCookie();
        var result = await fetchSchedule(cleanStation, date, cookie);
        if (result.statusCode === 404) {
          listingsHtml = '<font color="#ff4444" ' + FONT + '>Station not found. Check the call sign and try again.</font><br>';
        } else if (result.statusCode !== 200) {
          listingsHtml = '<font color="#ff4444" ' + FONT + '>Unable to load TV guide. Please try again later.</font><br>';
        } else {
          var items = parseListings(result.body);
          if (items.length === 0) {
            listingsHtml = '<font color="#aaaaaa" ' + FONT + '>No listings found for this station and date.</font><br>';
          } else {
            listingsHtml = buildListingsHtml(items);
          }
        }
      } catch (err) {
        console.error('TV guide fetch error:', err.message);
        listingsHtml = '<font color="#ff4444" ' + FONT + '>Unable to load TV guide. Please try again later.</font><br>';
      }
    }
  }

  var username = await auth.getUsername(discordID);
  var response = strReplace(tv_template, '{$WHITE_THEME_ENABLED}', themeClass);
  response = strReplace(response, '{$MENU_OPTIONS}',
    strReplace(logged_in_template, '{$USER}', escape(username))
  );
  response = strReplace(response, '{$STATION_VALUE}', escape(station));
  response = strReplace(response, '{$DATE_VALUE}', escape(date));
  response = strReplace(response, '{$TV_CONTENT}', listingsHtml);
  response = strReplace(response, '{$SESSION_ID}', escape(urlSessionID));

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
