'use strict';

const https = require('https');
const escape = require('escape-html');
const { renderTemplate, loadAndRenderPageTemplate, getTemplate } = require('./utils.js');
const he = require('he');

const auth = require('../authentication.js');

const TVPASSPORT_HOST = 'www.tvpassport.com';
const ZIP_MAX_LENGTH = 10;
const LINEUP_MAX_LENGTH = 120;
const STATION_ID_MAX_LENGTH = 120;

const tv_template = loadAndRenderPageTemplate('index', 'tv');
const tv_station_template = loadAndRenderPageTemplate('station', 'tv');

const logged_in_template = getTemplate('logged_in', 'index');

// Make an HTTPS request (GET or POST), following up to maxRedirects redirects.
// After a POST redirect, follow the redirect with a GET (standard browser POST-back behaviour).
function httpsRequest(options, postBody, maxRedirects) {
    if (maxRedirects === undefined) maxRedirects = 5;
    return new Promise(function (resolve, reject) {
        const req = https.request(options, function (res) {
            const status = res.statusCode;
            if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
                res.resume();
                let newOptions;
                try {
                    const loc = new URL(res.headers.location);
                    newOptions = {
                        hostname: loc.hostname,
                        path: loc.pathname + loc.search,
                        method: 'GET',
                        headers: Object.assign({}, options.headers),
                    };
                    delete newOptions.headers['Content-Length'];
                    delete newOptions.headers['Content-Type'];
                } catch (e) {
                    newOptions = Object.assign({}, options, {
                        path: res.headers.location,
                        method: 'GET',
                    });
                    delete newOptions.headers['Content-Length'];
                    delete newOptions.headers['Content-Type'];
                }
                // After a redirect always use GET (no body)
                return httpsRequest(newOptions, null, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
            }
            const chunks = [];
            res.on('data', function (chunk) {
                chunks.push(chunk);
            });
            res.on('end', function () {
                resolve({
                    statusCode: status,
                    body: Buffer.concat(chunks).toString('utf8'),
                    headers: res.headers,
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(25000, function () {
            req.destroy(new Error('Request timed out'));
        });
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

var BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// POST to a TVPassport form endpoint (application/x-www-form-urlencoded), following any redirect as a GET.
function fetchPost(path, formData, cookie) {
    var body = formData;
    return httpsRequest(
        {
            hostname: TVPASSPORT_HOST,
            path: path,
            method: 'POST',
            headers: {
                'User-Agent': BROWSER_UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                Referer: 'https://www.tvpassport.com/lineups',
                Cookie: cookie,
            },
        },
        body
    );
}

// Fetch a TVPassport session cookie.
async function fetchCookie() {
    var result = await httpsGet({
        hostname: TVPASSPORT_HOST,
        path: '/tv-listings',
        method: 'GET',
        headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });
    var setCookie = result.headers['set-cookie'];
    if (!setCookie || setCookie.length === 0) return '';
    var cookies = setCookie.map(function (c) {
        return c.split(';')[0];
    });
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
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.tvpassport.com/lineups',
            Cookie: cookie,
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
        if (params[key])
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
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
    return str
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Strip angle brackets (< and >) from text.
function stripAngleBrackets(str) {
    if (!str) return '';
    return str.replace(/[<>]/g, '');
}

// Parse providers/lineups from TVPassport /index.php/lineups POST response HTML.
// Provider links use the format /lineups/set/{lineupId} (optionally followed by ?lineupname=...).
// Returns array of {name, lineupId} objects.
function parseLineups(html) {
    var lineups = [];
    var seen = new Set();

    // Match hrefs pointing to /lineups/set/{lineupId} (capturing the bare lineupId before any ? or &).
    // Handles both double-quoted and single-quoted href attributes.
    var linkRegex =
        /href=["']?(?:https?:\/\/(?:www\.)?tvpassport\.com)?\/lineups\/set\/([^"'?&\s]+)/gi;
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
        lineups.push({ name: stripAngleBrackets(name), lineupId: lineupId });
    }

    return lineups;
}

// Smart title case for station names
function smartTitleCase(str) {
    if (!str) return '';

    // Common TV network acronyms
    var acronyms = [
        'tv', 'hd', 'dt', 'fm', 'am', 'hbo', 'cnn', 'mtv', 'vh1', 'amc', 'tbs', 'tnt', 'espn',
        'hgtv', 'fox', 'nbc', 'abc', 'cbs', 'pbs', 'cw', 'tbn', 'ion', 'up', 'bet', 'ctv',
        'msnbc', 'cnbc', 'syfy', 'fxx', 'fx', 'usa', 'ifc', 'hsn', 'qvc', 'tcm', 'e!', 
        'disney', 'nick', 'bravo', 'tlc', 'own', 'oxgn', 'ngc', 'disc', 'apl', 'id', 'ads', 
        'uni', 'tele'
    ];
    
    // US States and Canadian Provinces
    var states = [
        'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'dc', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
        'ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'on', 'pe', 'qc', 'sk', 'nt', 'nu', 'yt'
    ];

    var smallWords = ['of', 'the', 'and', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'a', 'an'];

    // 1. Process chunks separated by spaces, commas, or parentheses
    var result = str.replace(/([a-z0-9\-]+)|([^a-z0-9\-]+)/gi, function(match, word, sep, index) {
        if (sep) return sep;
        
        // If the "word" contains hyphens, split and process each part
        if (word.indexOf('-') !== -1) {
            return word.split('-').map(function(part, i) {
                var lowerPart = part.toLowerCase();
                if (acronyms.indexOf(lowerPart) !== -1) return lowerPart.toUpperCase();
                if (lowerPart.length === 2 && states.indexOf(lowerPart) !== -1) return lowerPart.toUpperCase();
                if (/^[kwcx][a-z0-9]{2,3}$/i.test(part)) return part.toUpperCase();
                return lowerPart.charAt(0).toUpperCase() + lowerPart.slice(1);
            }).join('-');
        }

        var lower = word.toLowerCase();
        if (word !== word.toUpperCase() && word !== word.toLowerCase()) return word;
        if (acronyms.indexOf(lower) !== -1) return lower.toUpperCase();
        if (lower.length === 2 && states.indexOf(lower) !== -1) return lower.toUpperCase();
        if (/^[kwcx][a-z0-9]{2,3}$/i.test(word)) return word.toUpperCase();
        if (index > 0 && smallWords.indexOf(lower) !== -1) return lower;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    });

    // 2. Deduplicate similar words (e.g. "WNBC WNBC-DT" -> "WNBC-DT")
    // Also remove network names in parentheses if they are part of the callsign (e.g. "WNBC (NBC)" -> "WNBC")
    var parts = result.split(/\s+/);
    var finalParts = [];
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i].replace(/[()]/g, '');
        if (!p) continue;
        var isRedundant = false;
        for (var j = 0; j < parts.length; j++) {
            if (i === j) continue;
            var other = parts[j].replace(/[()]/g, '');
            // If p is a substring of other and they are both likely IDs (acronyms or callsigns)
            if (other.indexOf(p) !== -1 && other.length > p.length && (acronyms.indexOf(p.toLowerCase()) !== -1 || /^[kwcx][a-z0-9\-]+$/i.test(p))) {
                isRedundant = true;
                break;
            }
        }
        if (!isRedundant) finalParts.push(parts[i]);
    }
    
    return finalParts.join(' ').replace(/\s+/g, ' ').trim();
}

// Parse channels from a TVPassport lineup page.
// Returns array of {name, callsign, stationId, logoUrl} objects.
function parseLineupChannels(html, date) {
    var channels = [];
    var seen = new Set();

    // 1. Find all station link matches first to determine boundaries
    var stationLinkRegex =
        /href="(?:https?:\/\/(?:www\.)?tvpassport\.com)?\/tv-listings\/stations\/(([a-z0-9\-]+)\/(\d+))(?:\/\d{4}-\d{2}-\d{2})?"/gi;
    
    var matches = [];
    var m;
    while ((m = stationLinkRegex.exec(html)) !== null) {
        matches.push({
            index: m.index,
            fullMatch: m[0],
            stationId: m[1],
            stationSlug: m[2]
        });
    }

    // 2. Process each match using boundaries to avoid picking up data from other rows
    for (var i = 0; i < matches.length; i++) {
        var match = matches[i];
        if (seen.has(match.stationId)) continue;

        // Isolate the row: from start of previous match to end of next match (roughly)
        var start = i === 0 ? 0 : matches[i-1].index + matches[i-1].fullMatch.length;
        var end = i === matches.length - 1 ? html.length : matches[i+1].index;
        
        // Refine context: look primarily BEFORE the link, as logos usually precede text
        // But also look slightly after just in case.
        var context = html.substring(start, end);

        // Logo detection within isolated row
        var logoUrl = '';
        var callsign = '';
        
        // a. Try to find the callsign from a CDN image URL
        var logoMatch = context.match(
            /(?:src|data-src|data-original)="(?:https?:)?\/\/cdn\.tvpassport\.com\/image\/station\/[^"\/]+\/([a-z0-9\-]+)\.(?:png|jpg|gif|svg)/i
        );
        if (logoMatch) {
            callsign = logoMatch[1];
        } else {
            // b. Try data-callsign attribute
            var csMatch = context.match(/data-(?:stn-)?callsign="([^"]+)"/i);
            if (csMatch) callsign = csMatch[1].toLowerCase();
        }

        if (callsign) {
            logoUrl = '//cdn.tvpassport.com/image/station/240x135/' + callsign + '.png';
        } else {
            // c. Last resort: any station image in this row
            var genericMatch = context.match(/(?:src|data-src|data-original)="((?:https?:)?\/\/cdn\.tvpassport\.com\/image\/station\/[^"]+)"/i);
            if (genericMatch) logoUrl = genericMatch[1];
        }

        // Name detection within isolated row
        var name = '';
        
        // Find the text of the link itself (the anchor text)
        var anchorMatch = context.match(new RegExp('>([\\s\\S]*?)</a>', 'i'));
        if (anchorMatch) {
            name = he.decode(stripTags(anchorMatch[1])).trim();
        }

        // Fallbacks for name
        if (!name || name.length < 2 || /^\d{4}-\d{2}-\d{2}$/.test(name)) {
            var altMatch = context.match(/alt="([^"]{3,60})"/i) || context.match(/title="([^"]{3,60})"/i);
            if (altMatch) name = he.decode(altMatch[1]);
            else name = match.stationSlug.replace(/-/g, ' ');
        }

        name = smartTitleCase(name);

        seen.add(match.stationId);
        channels.push({ stationId: match.stationId, name: name, callsign: callsign, logoUrl: logoUrl });
    }

    // Sort by name for a better list experience
    channels.sort(function(a, b) {
        return a.name.localeCompare(b.name);
    });

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
        
        // Try 'duration' first, then 'dr' as a common shorthand
        var duration = parseDataAttr(tagHtml, 'duration');
        if (!duration) duration = parseDataAttr(tagHtml, 'dr');

        items.push({
            showName: stripAngleBrackets(parseDataAttr(tagHtml, 'showName')),
            episodeTitle: stripAngleBrackets(parseDataAttr(tagHtml, 'episodeTitle')),
            description: stripAngleBrackets(parseDataAttr(tagHtml, 'description')),
            startTime: parseDataAttr(tagHtml, 'st'),
            duration: stripAngleBrackets(duration),
            rating: stripAngleBrackets(parseDataAttr(tagHtml, 'rating')),
            showType: stripAngleBrackets(parseDataAttr(tagHtml, 'showType')),
        });
    }
    return items;
}

// Get the station name from the page HTML og:title meta tag.
function parseStationName(html) {
    var m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (m) {
        var name = he
            .decode(m[1])
            .replace(/^TV (?:Schedule|Listings?) for /i, '')
            .trim();
        return smartTitleCase(stripAngleBrackets(name));
    }
    return '';
}

// Get the station logo from the page HTML og:image meta tag.
function parseStationLogo(html) {
    var m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (m) return m[1];
    return '';
}

// Build the HTML channel grid (single column list).
// zip and lineup are passed so station links can include them for a working back button.
function buildChannelGrid(channels, date, zip, lineup, sessionSuffix) {
    if (channels.length === 0) {
        return getTemplate('tv_no_channels_provider_error', 'tv');
    }

    var rowsHtml = '';

    for (var i = 0; i < channels.length; i++) {
        var ch = channels[i];
        var logoHtml = '';
        if (ch.logoUrl) {
            var proxied = proxyImageUrl(ch.logoUrl);
            logoHtml = renderTemplate(getTemplate('channel_logo_with_image', 'tv'), {
                PROXIED_URL: proxied,
            });
        } else {
            logoHtml = getTemplate('channel_logo_placeholder', 'tv');
        }

        var stationUrl = buildUrl(
            '/tv/station/' + ch.stationId,
            { date: date, zip: zip, lineup: lineup },
            sessionSuffix
        );
        var nameHtml = escape(ch.name);

        rowsHtml += renderTemplate(getTemplate('channel_grid_item', 'tv'), {
            STATION_URL: stationUrl,
            LOGO_HTML: logoHtml,
            NAME_HTML: nameHtml,
        });
    }

    return renderTemplate(getTemplate('channel_grid', 'tv'), { ROWS: rowsHtml });
}


// Build the HTML schedule table for a station page.
function buildScheduleHtml(items) {
    if (items.length === 0) {
        return getTemplate('no_listings_found', 'tv');
    }

    var rowsHtml = '';
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var isLast = i === items.length - 1;
        var timeStr = escape(formatTime(item.startTime));
        var durationStr = item.duration
            ? renderTemplate(getTemplate('duration_html', 'tv'), {
                  DURATION_STR: escape(item.duration),
              })
            : '';
        var showName = escape(item.showName || '(Unknown)');
        var episodeTitle = item.episodeTitle ? ' &ndash; ' + escape(item.episodeTitle) : '';
        var rating = item.rating
            ? renderTemplate(getTemplate('rating_html', 'tv'), { RATING: escape(item.rating) })
            : '';
        var showType = item.showType
            ? renderTemplate(getTemplate('show_type_html', 'tv'), {
                  SHOW_TYPE: escape(item.showType),
              })
            : '';
        var description = item.description
            ? renderTemplate(getTemplate('description_html', 'tv'), {
                  DESCRIPTION: escape(item.description),
              })
            : '';
        var rowStyle = isLast ? '' : ' style="border-bottom:1px solid #40444b;"';

        rowsHtml += renderTemplate(getTemplate('schedule_row', 'tv'), {
            ROW_STYLE: rowStyle,
            TIME_STR: timeStr,
            DURATION_HTML: durationStr,
            SHOW_NAME: showName,
            EPISODE_TITLE: episodeTitle,
            RATING: rating,
            SHOW_TYPE: showType,
            DESCRIPTION: description,
        });
    }
    return renderTemplate(getTemplate('schedule_table', 'tv'), { ROWS: rowsHtml });
}

// Helper: get theme class from request.
function getThemeClass(req, parsedUrl) {
    var urlTheme = parsedUrl.searchParams.get('theme');
    var whiteThemeCookie = (req.headers.cookie || '').split('; ').filter(function (c) {
        return c.startsWith('whiteThemeCookie=');
    })[0];
    whiteThemeCookie = whiteThemeCookie ? whiteThemeCookie.split('=')[1] : undefined;
    var themeValue =
        urlTheme !== null
            ? parseInt(urlTheme, 10)
            : whiteThemeCookie !== undefined
              ? parseInt(whiteThemeCookie, 10)
              : 0;
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
    var menuHtml = renderTemplate(logged_in_template, { USER: escape(username) });

    // Station schedule sub-page: /tv/station/{slug}/{id}
    if (subpath.startsWith('station/')) {
        return serveStationPage(
            req,
            res,
            parsedUrl,
            subpath,
            themeClass,
            menuHtml,
            urlSessionID,
            sessionParam,
            sessionSuffix
        );
    }

    // Main page: ZIP/provider search + channel grid
    return serveMainPage(
        req,
        res,
        parsedUrl,
        themeClass,
        menuHtml,
        urlSessionID,
        sessionParam,
        sessionSuffix
    );
};

// -------
// Main page: ZIP search → provider list → channel grid
// -------
async function serveMainPage(
    req,
    res,
    parsedUrl,
    themeClass,
    menuHtml,
    urlSessionID,
    sessionParam,
    sessionSuffix
) {
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
                            contentHtml = buildChannelGrid(
                                channels,
                                date,
                                cleanZip,
                                cleanLineup,
                                sessionSuffix
                            );
                        } else {
                            contentHtml = getTemplate('tv_no_channels_provider_error', 'tv');
                        }
                    } else if (lineupResult.statusCode === 404) {
                        contentHtml = getTemplate('tv_provider_not_found_error', 'tv');
                    } else {
                        contentHtml = getTemplate('tv_load_channel_list_error', 'tv');
                    }
                } catch (err) {
                    console.error('TV lineup channels fetch error:', err);
                    contentHtml = getTemplate('tv_load_channel_list_error', 'tv');
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
                        contentHtml = renderTemplate(
                            getTemplate('tv_no_providers_zip_error', 'tv'),
                            {
                                ZIP_CODE: escape(cleanZip),
                            }
                        );
                    } else {
                        contentHtml = getTemplate('tv_select_provider_header', 'tv');
                        for (var i = 0; i < lineupList.length; i++) {
                            var li = lineupList[i];
                            var lineupUrl = buildUrl(
                                '/tv',
                                { zip: cleanZip, lineup: li.lineupId, date: date },
                                sessionSuffix
                            );
                            contentHtml +=
                                renderTemplate(getTemplate('provider_button', 'tv'), {
                                    LINEUP_URL: lineupUrl,
                                    LINEUP_NAME: escape(li.name),
                                }) + '\n';
                        }
                    }
                } else {
                    contentHtml = getTemplate('tv_load_provider_list_error', 'tv');
                }
            } catch (err) {
                console.error('TV lineups fetch error:', err);
                contentHtml = getTemplate('tv_load_provider_list_error', 'tv');
            }
        }
    }

    const response = renderTemplate(tv_template, {
        WHITE_THEME_ENABLED: themeClass,
        MENU_OPTIONS: menuHtml,
        ZIP_VALUE: escape(zip),
        DATE_VALUE: escape(date),
        TV_CONTENT: contentHtml,
        SESSION_ID: escape(urlSessionID),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
}

// -------
// Station schedule sub-page: /tv/station/{slug}/{id}
// -------
async function serveStationPage(
    req,
    res,
    parsedUrl,
    subpath,
    themeClass,
    menuHtml,
    urlSessionID,
    sessionParam,
    sessionSuffix
) {
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
                contentHtml = getTemplate('tv_station_not_found_error', 'tv');
            } else if (result.statusCode !== 200) {
                contentHtml = getTemplate('tv_load_tv_guide_error', 'tv');
            } else {
                stationName = parseStationName(result.body);
                var logoUrl = parseStationLogo(result.body);
                if (logoUrl) {
                    var proxied = proxyImageUrl(logoUrl);
                    stationLogoHtml = renderTemplate(getTemplate('station_logo', 'tv'), {
                        PROXIED_URL: proxied,
                    });
                }
                var items = parseListings(result.body);
                contentHtml = stationLogoHtml + buildScheduleHtml(items);
            }
        } catch (err) {
            console.error('TV station fetch error:', err);
            contentHtml = getTemplate('tv_load_tv_guide_error', 'tv');
        }
    } else {
        contentHtml = getTemplate('tv_invalid_station_id_error', 'tv');
    }

    // Build back URL preserving zip/lineup/date parameters
    var backZip = (parsedUrl.searchParams.get('zip') || '').replace(/[^a-zA-Z0-9 \-]/g, '').trim();
    var backLineup = (parsedUrl.searchParams.get('lineup') || '').replace(/[^a-zA-Z0-9_\-\/]/g, '');
    var backSessionSuffix = urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '';
    var backUrl = buildUrl(
        '/tv',
        { date: date, zip: backZip, lineup: backLineup },
        backSessionSuffix
    );

    const response = renderTemplate(tv_station_template, {
        WHITE_THEME_ENABLED: themeClass,
        MENU_OPTIONS: menuHtml,
        STATION_NAME: escape(stationName || 'TV Schedule'),
        DATE_VALUE: escape(date),
        STATION_ID: escape(cleanId),
        TV_CONTENT: contentHtml,
        SESSION_ID: escape(urlSessionID),
        BACK_URL: escape(backUrl),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
}
