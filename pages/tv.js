'use strict';

const fs = require('fs');
const https = require('https');
const escape = require('escape-html');
const he = require('he');

const auth = require('../authentication.js');

const TVPASSPORT_HOST = 'www.tvpassport.com';
const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;
const ZIP_MAX_LENGTH = 10;
const LINEUP_MAX_LENGTH = 120;
const STATION_ID_MAX_LENGTH = 120;

const head_partial = fs.readFileSync('pages/templates/partials/head.html', 'utf-8');

const tv_template = fs.readFileSync('pages/templates/tv.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(head_partial);

const tv_station_template = fs.readFileSync('pages/templates/tv_station.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(head_partial);

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

// Make an HTTPS request (GET or POST), following up to maxRedirects redirects.
// After a POST redirect, follow the redirect with a GET (standard browser POST-back behaviour).
function httpsRequest(options, postBody, maxRedirects) {
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
            headers: Object.assign({}, options.headers),
          };
          delete newOptions.headers['Content-Length'];
          delete newOptions.headers['Content-Type'];
        } catch (e) {
          newOptions = Object.assign({}, options, { path: res.headers.location, method: 'GET' });
          delete newOptions.headers['Content-Length'];
          delete newOptions.headers['Content-Type'];
        }
        // After a redirect always use GET (no body)
        return httpsRequest(newOptions, null, maxRedirects - 1).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ statusCode: status, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, function () { req.destroy(new Error('Request timed out')); });
    if (postBody) {
      req.write(postBody);
    }
    req.end();
  });
}

// Convenience wrappers
function httpsGet(options, maxRedirects) {
  return httpsRequest(options, null, maxRedirects);
}

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// POST to a TVPassport form endpoint (application/x-www-form-urlencoded), following any redirect as a GET.
function fetchPost(path, formData, cookie) {
  var body = formData;
  return httpsRequest({
    hostname: TVPASSPORT_HOST,
    path: path,
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Referer': 'https://www.tvpassport.com/lineups',
      'Cookie': cookie,
    },
  }, body);
}

// Fetch a TVPassport session cookie.
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

// Fetch any TVPassport page.
function fetchPage(path, cookie) {
  return httpsGet({
    hostname: TVPASSPORT_HOST,
    path: path,
    method: 'GET',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.tvpassport.com/lineups',
      'Cookie': cookie,
    },
  });
}

// Build a proxied image URL using the imageProxy.
function proxyImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) url = 'https:' + url;
  return '/imageProxy/external/' + Buffer.from(url).toString('base64');
}

// Build a URL with query parameters from a base path and a params object.
// Omits keys with falsy values. sessionSuffix (e.g. '&sessionID=abc') is appended last if provided.
function buildUrl(base, params, sessionSuffix) {
  var parts = [];
  for (var key in params) {
    if (params[key]) parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
  }
  var url = base + (parts.length ? '?' + parts.join('&') : '');
  if (sessionSuffix) url += sessionSuffix;
  return url;
}

// Extract a single data-* attribute value from an HTML tag string.
function parseDataAttr(tagHtml, name) {
  var pattern = new RegExp('\\bdata-' + name + '="([^"]*)"', 'i');
  var m = tagHtml.match(pattern);
  return m ? he.decode(m[1]) : '';
}

// Get today's date in US Eastern Time as YYYY-MM-DD.
function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Format a TVPassport start time "YYYY-MM-DD HH:mm:ss" to "H:MM AM/PM".
function formatTime(timeStr) {
  if (!timeStr) return '';
  var timePart = timeStr.split(' ')[1];
  if (!timePart) return '';
  var parts = timePart.split(':');
  if (parts.length < 2) return '';
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return '';
  var period = h >= 12 ? 'PM' : 'AM';
  var hour = h % 12 || 12;
  return hour + ':' + (m < 10 ? '0' : '') + m + ' ' + period;
}

// Strip HTML tags and return plain text.
function stripTags(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Parse providers/lineups from TVPassport /index.php/lineups POST response HTML.
// Provider links use the format /lineups/set/{lineupId} (optionally followed by ?lineupname=...).
// Returns array of {name, lineupId} objects.
function parseLineups(html) {
  var lineups = [];
  var seen = new Set();

  // Match hrefs pointing to /lineups/set/{lineupId} (capturing the bare lineupId before any ? or &).
  // Handles both double-quoted and single-quoted href attributes.
  var linkRegex = /href=["']?(?:https?:\/\/(?:www\.)?tvpassport\.com)?\/lineups\/set\/([^"'?&\s]+)/gi;
  var m;
  while ((m = linkRegex.exec(html)) !== null) {
    var lineupId = m[1];
    if (!lineupId || seen.has(lineupId)) continue;

    // Find the link's visible text — look in the 400 chars after the href
    var before = m.index;
    var after = before + m[0].length;
    var context = html.substring(Math.max(0, before - 10), after + 400);
    var textMatch = context.match(/>[^<\n]{2,80}</);
    var name = textMatch ? he.decode(stripTags(textMatch[0])).trim() : lineupId;
    if (!name || name.length < 2) name = lineupId;

    seen.add(lineupId);
    lineups.push({ name: name, lineupId: lineupId });
  }

  return lineups;
}

// Parse channels from a TVPassport lineup page.
// Returns array of {name, callsign, stationId, logoUrl} objects.
function parseLineupChannels(html, date) {
  var channels = [];
  var seen = new Set();

  // Find all station page links in the format /tv-listings/stations/{slug}/{id} or /{slug}/{id}/{date}.
  // Capture group 1: full station site_id (e.g. "nbc-wnbc-new-york-ny/1767")
  // Capture group 2: station slug (e.g. "nbc-wnbc-new-york-ny")
  // Capture group 3: numeric station id (e.g. "1767")
  var stationLinkRegex = /href="(?:https?:\/\/(?:www\.)?tvpassport\.com)?\/tv-listings\/stations\/(([a-z0-9\-]+)\/(\d+))(?:\/\d{4}-\d{2}-\d{2})?"/gi;
  var m;

  while ((m = stationLinkRegex.exec(html)) !== null) {
    var stationId = m[1]; // e.g. "nbc-wnbc-new-york-ny/1767"
    var stationSlug = m[2];
    if (seen.has(stationId)) continue;

    // Search context around the link for logo and channel name
    var contextStart = Math.max(0, m.index - 600);
    var contextEnd = Math.min(html.length, m.index + 600);
    var context = html.substring(contextStart, contextEnd);

    // Find channel logo (cdn.tvpassport.com image)
    var logoMatch = context.match(/src="(?:https?:)?\/\/cdn\.tvpassport\.com\/image\/station\/[0-9x]+\/([a-z0-9\-]+)\.png"/i);
    var callsign = logoMatch ? logoMatch[1] : '';
    var logoUrl = callsign ? '//cdn.tvpassport.com/image/station/240x135/' + callsign + '.png' : '';

    // Try to find data-callsign if logo not found
    if (!callsign) {
      var csMatch = context.match(/data-callsign="([^"]+)"/i);
      if (csMatch) {
        callsign = csMatch[1].toLowerCase();
        logoUrl = '//cdn.tvpassport.com/image/station/240x135/' + callsign + '.png';
      }
    }

    // Extract channel name from nearby text — look for anchor text or heading
    var nameMatch = context.match(/<a[^>]+>([^<]{3,60})<\/a>/i);
    var name = '';
    if (nameMatch) {
      name = he.decode(stripTags(nameMatch[1])).trim();
    }
    if (!name || name.length < 2) {
      // Fall back to title-casing the slug: "nbc-wnbc-new-york-ny" -> "Nbc Wnbc New York Ny"
      name = stationSlug.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    seen.add(stationId);
    channels.push({ stationId: stationId, name: name, callsign: callsign, logoUrl: logoUrl });
  }

  return channels;
}

// Parse schedule listings from a station page.
function parseListings(html) {
  var items = [];
  var sectionIdx = html.indexOf('station-listings');
  if (sectionIdx === -1) return items;
  var sectionHtml = html.slice(sectionIdx);

  var itemTagRegex = /<[a-z]+(?:\s+[^>]*?)?\bclass="[^"]*\blist-group-item\b[^"]*"[^>]*>/gi;
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

// Get the station name from the page HTML og:title meta tag.
function parseStationName(html) {
  var m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  if (m) return he.decode(m[1]).replace(/^TV (?:Schedule|Listings?) for /i, '').trim();
  return '';
}

// Get the station logo from the page HTML og:image meta tag.
function parseStationLogo(html) {
  var m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  if (m) return m[1];
  return '';
}

// Build the HTML channel grid (table-based, 3 columns, backwards compatible).
// zip and lineup are passed so station links can include them for a working back button.
function buildChannelGrid(channels, date, zip, lineup, sessionSuffix) {
  if (channels.length === 0) {
    return '<font color="#aaaaaa" ' + FONT + '>No channels found for this provider.</font><br>';
  }

  var cols = 3;
  var html = '<table cellpadding="4" cellspacing="4" width="100%">\n';

  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    if (i % cols === 0) html += '  <tr valign="top">\n';

    var logoHtml = '';
    if (ch.logoUrl) {
      var proxied = proxyImageUrl(ch.logoUrl);
      logoHtml = '<img src="' + proxied + '" alt="" width="120" height="68" style="width:120px;height:68px;display:block;background:#1a1b1e;">';
    } else {
      logoHtml = '<div style="width:120px;height:68px;background:#1a1b1e;"></div>';
    }

    var stationUrl = buildUrl('/tv/station/' + ch.stationId, { date: date, zip: zip, lineup: lineup }, sessionSuffix);
    var nameHtml = escape(ch.name);

    html += '    <td width="33%" style="padding:4px;">';
    html += '<a href="' + stationUrl + '" style="text-decoration:none;display:block;background:#2e3035;padding:6px;border:1px solid #3a3d42;">';
    html += logoHtml;
    html += '<font ' + FONT + ' color="#dddddd" size="2"><b>' + nameHtml + '</b></font>';
    html += '</a>';
    html += '</td>\n';

    if ((i + 1) % cols === 0 || i === channels.length - 1) html += '  </tr>\n';
  }

  html += '</table>\n';
  return html;
}

// Build the HTML schedule table for a station page.
function buildScheduleHtml(items) {
  if (items.length === 0) {
    return '<font color="#aaaaaa" ' + FONT + '>No listings found for this station and date.</font><br>';
  }

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

// Helper: get theme class from request.
function getThemeClass(req, parsedUrl) {
  var urlTheme = parsedUrl.searchParams.get('theme');
  var whiteThemeCookie = (req.headers.cookie || '').split('; ')
    .filter(function (c) { return c.startsWith('whiteThemeCookie='); })[0];
  whiteThemeCookie = whiteThemeCookie ? whiteThemeCookie.split('=')[1] : undefined;
  var themeValue = urlTheme !== null
    ? parseInt(urlTheme, 10)
    : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie, 10) : 0);
  if (themeValue === 1) return 'class="light-theme"';
  if (themeValue === 2) return 'class="amoled-theme"';
  return '';
}

exports.processTV = async function processTV(req, res) {
  var discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

  var parsedUrl = new URL(req.url, 'http://localhost');
  var subpath = parsedUrl.pathname.replace(/^\/tv\/?/, '').replace(/\/$/, '');
  var urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  var sessionSuffix = urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '';
  var sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';
  var themeClass = getThemeClass(req, parsedUrl);
  var username = await auth.getUsername(discordID);
  var menuHtml = strReplace(logged_in_template, '{$USER}', escape(username));

  // Station schedule sub-page: /tv/station/{slug}/{id}
  if (subpath.startsWith('station/')) {
    return serveStationPage(req, res, parsedUrl, subpath, themeClass, menuHtml, urlSessionID, sessionParam, sessionSuffix);
  }

  // Main page: ZIP/provider search + channel grid
  return serveMainPage(req, res, parsedUrl, themeClass, menuHtml, urlSessionID, sessionParam, sessionSuffix);
};

// -------
// Main page: ZIP search → provider list → channel grid
// -------
async function serveMainPage(req, res, parsedUrl, themeClass, menuHtml, urlSessionID, sessionParam, sessionSuffix) {
  var zip = (parsedUrl.searchParams.get('zip') || '').trim().slice(0, ZIP_MAX_LENGTH);
  var lineup = (parsedUrl.searchParams.get('lineup') || '').trim().slice(0, LINEUP_MAX_LENGTH);
  var date = (parsedUrl.searchParams.get('date') || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = getTodayET();
  }

  var contentHtml = '';

  // Sanitize ZIP: keep alphanumeric and space/hyphen only
  var cleanZip = zip.replace(/[^a-zA-Z0-9 \-]/g, '').trim();
  if (cleanZip) {
    if (lineup) {
      // Step 2: fetch channel grid for selected lineup.
      // TVPassport lineup pages live at /lineups/set/{lineupId}?tz=America/New_York
      var cleanLineup = lineup.replace(/[^a-zA-Z0-9_\-]/g, '');
      if (cleanLineup) {
        try {
          var cookie = await fetchCookie();
          var lineupResult = await fetchPage(
            '/lineups/set/' + cleanLineup + '?tz=America%2FNew_York',
            cookie
          );
          if (lineupResult.statusCode === 200) {
            var channels = parseLineupChannels(lineupResult.body, date);
            if (channels.length > 0) {
              contentHtml = buildChannelGrid(channels, date, cleanZip, cleanLineup, sessionSuffix);
            } else {
              contentHtml = '<font color="#aaaaaa" ' + FONT + '>No channels found for this provider. Try selecting a different provider or date.</font><br>';
            }
          } else if (lineupResult.statusCode === 404) {
            contentHtml = '<font color="#ff4444" ' + FONT + '>Provider not found. Please go back and try again.</font><br>';
          } else {
            contentHtml = '<font color="#ff4444" ' + FONT + '>Unable to load channel list. Please try again later.</font><br>';
          }
        } catch (err) {
          console.error('TV lineup channels fetch error:', err.message);
          contentHtml = '<font color="#ff4444" ' + FONT + '>Unable to load channel list. Please try again later.</font><br>';
        }
      }
    } else {
      // Step 1: POST the ZIP to TVPassport's lineup search endpoint to get the provider list.
      // TVPassport uses a form POST to /index.php/lineups with postalCode=ZIP.
      try {
        var cookie = await fetchCookie();
        var lineupsResult = await fetchPost(
          '/index.php/lineups',
          'postalCode=' + encodeURIComponent(cleanZip),
          cookie
        );
        if (lineupsResult.statusCode === 200) {
          var lineupList = parseLineups(lineupsResult.body);
          if (lineupList.length === 0) {
            contentHtml = '<font color="#aaaaaa" ' + FONT + '>No TV providers found for ZIP code &ldquo;' + escape(cleanZip) + '&rdquo;. Please check the ZIP code and try again.</font><br>';
          } else {
            contentHtml = '<font ' + FONT + ' color="#dddddd"><b>Select your TV provider:</b></font><br><br>\n';
            for (var i = 0; i < lineupList.length; i++) {
              var li = lineupList[i];
              var lineupUrl = buildUrl('/tv', { zip: cleanZip, lineup: li.lineupId, date: date }, sessionSuffix);
              contentHtml += '<a href="' + lineupUrl + '" class="discross-button" style="padding:6px 14px;font-size:14px;margin:0 0 6px 0;display:inline-block;">' + escape(li.name) + '</a><br>\n';
            }
          }
        } else {
          contentHtml = '<font color="#ff4444" ' + FONT + '>Unable to load provider list. Please try again later.</font><br>';
        }
      } catch (err) {
        console.error('TV lineups fetch error:', err.message);
        contentHtml = '<font color="#ff4444" ' + FONT + '>Unable to load provider list. Please try again later.</font><br>';
      }
    }
  }

  var response = strReplace(tv_template, '{$WHITE_THEME_ENABLED}', themeClass);
  response = strReplace(response, '{$MENU_OPTIONS}', menuHtml);
  response = strReplace(response, '{$ZIP_VALUE}', escape(zip));
  response = strReplace(response, '{$DATE_VALUE}', escape(date));
  response = strReplace(response, '{$TV_CONTENT}', contentHtml);
  response = strReplace(response, '{$SESSION_ID}', escape(urlSessionID));

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
}

// -------
// Station schedule sub-page: /tv/station/{slug}/{id}
// -------
async function serveStationPage(req, res, parsedUrl, subpath, themeClass, menuHtml, urlSessionID, sessionParam, sessionSuffix) {
  // subpath = "station/{slug}/{id}", e.g. "station/nbc-wnbc-new-york-ny/1767"
  var stationId = subpath.replace(/^station\//, '').slice(0, STATION_ID_MAX_LENGTH);
  var date = (parsedUrl.searchParams.get('date') || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = getTodayET();
  }

  // Sanitize station ID: allow slug chars, digits, and single forward slashes
  var cleanId = stationId.replace(/[^a-zA-Z0-9\-_\/]/g, '');

  var contentHtml = '';
  var stationName = '';
  var stationLogoHtml = '';

  if (cleanId) {
    try {
      var cookie = await fetchCookie();
      var result = await fetchPage('/tv-listings/stations/' + cleanId + '/' + date, cookie);

      if (result.statusCode === 404) {
        contentHtml = '<font color="#ff4444" ' + FONT + '>Station not found.</font><br>';
      } else if (result.statusCode !== 200) {
        contentHtml = '<font color="#ff4444" ' + FONT + '>Unable to load TV guide. Please try again later.</font><br>';
      } else {
        stationName = parseStationName(result.body);
        var logoUrl = parseStationLogo(result.body);
        if (logoUrl) {
          var proxied = proxyImageUrl(logoUrl);
          stationLogoHtml = '<img src="' + proxied + '" alt="" width="160" height="90" style="width:160px;height:90px;display:block;background:#1a1b1e;margin-bottom:8px;"><br>';
        }
        var items = parseListings(result.body);
        contentHtml = stationLogoHtml + buildScheduleHtml(items);
      }
    } catch (err) {
      console.error('TV station fetch error:', err.message);
      contentHtml = '<font color="#ff4444" ' + FONT + '>Unable to load TV guide. Please try again later.</font><br>';
    }
  } else {
    contentHtml = '<font color="#ff4444" ' + FONT + '>Invalid station ID.</font><br>';
  }

  // Build back URL preserving zip/lineup/date parameters
  var backZip = (parsedUrl.searchParams.get('zip') || '').replace(/[^a-zA-Z0-9 \-]/g, '').trim();
  var backLineup = (parsedUrl.searchParams.get('lineup') || '').replace(/[^a-zA-Z0-9_\-\/]/g, '');
  var backSessionSuffix = urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '';
  var backUrl = buildUrl('/tv', { date: date, zip: backZip, lineup: backLineup }, backSessionSuffix);

  var response = strReplace(tv_station_template, '{$WHITE_THEME_ENABLED}', themeClass);
  response = strReplace(response, '{$MENU_OPTIONS}', menuHtml);
  response = strReplace(response, '{$STATION_NAME}', escape(stationName || 'TV Schedule'));
  response = strReplace(response, '{$DATE_VALUE}', escape(date));
  response = strReplace(response, '{$STATION_ID}', escape(cleanId));
  response = strReplace(response, '{$TV_CONTENT}', contentHtml);
  response = strReplace(response, '{$SESSION_ID}', escape(urlSessionID));
  response = strReplace(response, '{$BACK_URL}', escape(backUrl));

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
}
