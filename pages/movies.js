"use strict";

const fs = require("fs");
const escape = require("escape-html");
const he = require("he");

const head_partial = fs.readFileSync(
  "pages/templates/partials/head.html",
  "utf-8",
);

const movies_template = fs
  .readFileSync("pages/templates/movies.html", "utf-8")
  .split("{$COMMON_HEAD}")
  .join(head_partial);

const THEME_CONFIG = {
  0: { themeClass: "" },
  1: { themeClass: 'class="light-theme"' },
  2: { themeClass: 'class="amoled-theme"' },
};

const FONT = `face="'rodin', Arial, Helvetica, sans-serif"`;

const RT_BASE = "https://www.rottentomatoes.com";

// Browser-like User-Agent for Rotten Tomatoes requests
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Tab definitions: id, label, RT browse URL suffix
const TABS = [
  {
    id: "movies_in_theaters",
    label: "In Theaters",
    url: "/browse/movies_in_theaters/",
  },
  { id: "movies_at_home", label: "At Home", url: "/browse/movies_at_home/" },
  { id: "tv", label: "TV Shows", url: "/browse/tv_series_browsing/" },
];

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? "");
}

function proxyImageUrl(url) {
  return "/imageProxy/external/" + Buffer.from(url).toString("base64");
}

function resolvePrefs(req) {
  const parsedUrl = new URL(req.url, "http://localhost");
  const urlSessionID = parsedUrl.searchParams.get("sessionID") ?? "";
  const urlTheme = parsedUrl.searchParams.get("theme");
  const urlImages = parsedUrl.searchParams.get("images");

  const whiteThemeCookie = req.headers.cookie
    ?.split("; ")
    ?.find((c) => c.startsWith("whiteThemeCookie="))
    ?.split("=")[1];
  const imagesCookieValue = req.headers.cookie
    ?.split("; ")
    ?.find((c) => c.startsWith("images="))
    ?.split("=")[1];

  const linkParamParts = [];
  if (urlSessionID)
    linkParamParts.push("sessionID=" + encodeURIComponent(urlSessionID));
  if (urlTheme !== null && whiteThemeCookie === undefined)
    linkParamParts.push("theme=" + encodeURIComponent(urlTheme));
  if (urlImages !== null && imagesCookieValue === undefined)
    linkParamParts.push("images=" + encodeURIComponent(urlImages));
  const sessionParam = linkParamParts.length
    ? "?" + linkParamParts.join("&")
    : "";

  const themeValue =
    urlTheme !== null
      ? parseInt(urlTheme, 10)
      : whiteThemeCookie !== undefined
        ? parseInt(whiteThemeCookie, 10)
        : 0;
  const theme = THEME_CONFIG[themeValue] ?? THEME_CONFIG[0];
  const imagesCookie =
    urlImages !== null
      ? parseInt(urlImages, 10)
      : imagesCookieValue !== undefined
        ? parseInt(imagesCookieValue, 10)
        : 1;

  const tabId = parsedUrl.searchParams.get("tab") || TABS[0].id;

  return {
    urlSessionID,
    sessionParam,
    theme,
    themeValue,
    imagesCookie,
    parsedUrl,
    tabId,
  };
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} fetching ${url}`);
    err.statusCode = response.status;
    throw err;
  }
  return response.text();
}

// Strip HTML tags, collapse whitespace, and HTML-decode the result
function stripHtml(html) {
  if (!html) return "";
  const noTags = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return he.decode(noTags);
}

// Try to extract a poster image URL from an RT-CDN img tag
const RT_IMG_SRC_RE =
  /\bsrc(?!set)="(https?:\/\/[^"]*(?:resizing\.flixster\.com|cloudfront\.net|rottentomatoes\.com)[^"]*)"/i;

/**
 * Parse Rotten Tomatoes browse page HTML.
 * Extracts movie/TV items using multiple strategies:
 *   1. Embedded JSON via <script type="application/json">
 *   2. HTML tiles using data-qa attributes
 *   3. Fallback: <a href="/m/..."> or <a href="/tv/..."> links
 */
function parseRTPage(html, isTv) {
  // Strategy 1: try to extract from embedded JSON script tags
  const items = tryParseEmbeddedJson(html, isTv);
  if (items && items.length > 0) return items;

  // Strategy 2: data-qa HTML tiles
  const htmlItems = parseHtmlTiles(html, isTv);
  if (htmlItems && htmlItems.length > 0) return htmlItems;

  // Strategy 3: bare <a href="/m/..."> links fallback
  return parseFallbackLinks(html, isTv);
}

// Strategy 1: extract from embedded JSON
function tryParseEmbeddedJson(html, isTv) {
  const items = [];

  // Look for <script type="application/json"> tags
  const scriptRe =
    /<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    // Look for arrays that might be movie/TV lists
    const found = extractItemsFromJson(data, isTv);
    if (found.length > 0) return found;
  }

  // Also look for window.__data or window.rt_init_data in regular scripts
  // Extract a bounded substring around the known key to avoid catastrophic backtracking
  const winKeys = [
    "window.__data",
    "window.rt_init_data",
    "window.__RT_INITIAL_STATE__",
  ];
  for (const key of winKeys) {
    const keyIdx = html.indexOf(key);
    if (keyIdx === -1) continue;
    // Only consider the next 50,000 chars after the key
    const slice = html.slice(keyIdx, keyIdx + 50000);
    const assignIdx = slice.indexOf("=");
    if (assignIdx === -1) continue;
    const jsonStart = slice.indexOf("{", assignIdx);
    if (jsonStart === -1) continue;
    // Find the matching closing brace
    let depth = 0;
    let end = -1;
    for (let i = jsonStart; i < slice.length; i++) {
      if (slice[i] === "{") depth++;
      else if (slice[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    try {
      const data = JSON.parse(slice.slice(jsonStart, end));
      const found = extractItemsFromJson(data, isTv);
      if (found.length > 0) return found;
    } catch {
      /* ignore */
    }
  }

  return items;
}

// Recursively search JSON for movie/TV item arrays
function extractItemsFromJson(data, isTv, depth) {
  if (!data || typeof data !== "object" || (depth || 0) > 6) return [];

  // Check if data itself is an array of items
  if (Array.isArray(data)) {
    const scored = data.filter(
      (x) =>
        x &&
        typeof x === "object" &&
        (x.title || x.name) &&
        (x.url || x.vanity || x.mediaUrl || x.slug),
    );
    if (scored.length >= 2) {
      return scored
        .map((x) => normalizeJsonItem(x, isTv))
        .filter((x) => x.title && x.url)
        .slice(0, 30);
    }
  }

  // Recurse into object keys
  for (const key of Object.keys(data)) {
    const result = extractItemsFromJson(data[key], isTv, (depth || 0) + 1);
    if (result.length >= 2) return result;
  }
  return [];
}

function normalizeJsonItem(x, isTv) {
  const title = x.title || x.name || "";
  let url = x.url || x.mediaUrl || "";
  if (!url && x.vanity) {
    url = `${RT_BASE}/${isTv ? "tv" : "m"}/${x.vanity}`;
  }
  if (!url && x.slug) {
    url = `${RT_BASE}/${isTv ? "tv" : "m"}/${x.slug}`;
  }
  if (url && !url.startsWith("http")) url = RT_BASE + url;
  const year = x.year || x.releaseYear || "";
  const criticsScore =
    x.tomatometer != null
      ? x.tomatometer
      : x.criticsScore != null
        ? x.criticsScore
        : (x.rottenTomatoes?.tomatometer ?? null);
  const audienceScore =
    x.audienceScore != null
      ? x.audienceScore
      : x.popcornmeter != null
        ? x.popcornmeter
        : null;
  const poster =
    x.posterUri ||
    x.image ||
    x.posterUrl ||
    x.thumbnail ||
    x.posterImage ||
    x.poster ||
    "";
  return { title, url, year, criticsScore, audienceScore, poster };
}

// Strategy 2: parse data-qa HTML tiles using linear index-based extraction
function parseHtmlTiles(html, isTv) {
  const items = [];
  const seen = new Set();

  // Common RT data-qa values for tile containers
  const tileQaValues = [
    "discovery-media-list-item",
    "media-tile",
    "tile",
    "movie-tile",
    "search-result-item",
  ];

  for (const qa of tileQaValues) {
    const marker = `data-qa="${qa}"`;
    let pos = 0;
    while (pos < html.length) {
      const tileStart = html.indexOf(marker, pos);
      if (tileStart === -1) break;

      // Find the opening tag's end
      const tagEnd = html.indexOf(">", tileStart);
      if (tagEnd === -1) break;

      // Extract a bounded block (3000 chars) from this tile's opening tag onward
      const block = html.slice(tileStart, Math.min(html.length, tagEnd + 3000));
      const item = extractTileItem(block, isTv);
      if (item && item.title && item.url && !seen.has(item.url)) {
        seen.add(item.url);
        items.push(item);
        if (items.length >= 30) break;
      }
      pos = tagEnd + 1;
    }
    if (items.length > 0) break;
  }

  // If above didn't work, try anchor-based tile parsing (bounded per anchor)
  if (items.length === 0) {
    const linkPrefix = isTv ? "/tv/" : "/m/";
    let pos = 0;
    while (pos < html.length) {
      const anchorStart = html.indexOf("<a ", pos);
      if (anchorStart === -1) break;
      const tagEnd = html.indexOf(">", anchorStart);
      if (tagEnd === -1) break;
      const tag = html.slice(anchorStart, tagEnd + 1);
      const hrefMatch = tag.match(/href="(\/(?:tv|m)\/[^"#?]+)"/);
      if (!hrefMatch || !hrefMatch[1].startsWith(linkPrefix)) {
        pos = tagEnd + 1;
        continue;
      }
      const href = hrefMatch[1];
      const url = RT_BASE + href;
      if (seen.has(url)) {
        pos = tagEnd + 1;
        continue;
      }
      // Collect anchor block up to 800 chars
      const block = html.slice(tagEnd + 1, Math.min(html.length, tagEnd + 800));
      const titleMatch = block.match(
        /data-qa="(?:discovery-media-list-item-title|media-tile-title|tile-title)"[^>]*>([\s\S]{0,200}?)<\/[a-z]+>/i,
      );
      if (!titleMatch) {
        pos = tagEnd + 1;
        continue;
      }
      const title = stripHtml(titleMatch[1]).trim();
      if (!title) {
        pos = tagEnd + 1;
        continue;
      }
      seen.add(url);
      const poster = extractPosterFromBlock(block);
      const scoreMatch = block.match(/criticsScore[=:]["']?(\d+)/i);
      const criticsScore = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
      items.push({
        title,
        url,
        year: "",
        criticsScore,
        audienceScore: null,
        poster,
      });
      if (items.length >= 30) break;
      pos = tagEnd + 1;
    }
  }

  return items;
}

function extractTileItem(block, isTv) {
  // Title
  let titleMatch = block.match(
    /data-qa="(?:discovery-media-list-item-title|media-tile-title|tile-title)"[^>]*>([\s\S]*?)<\/[a-z]+>/i,
  );
  if (!titleMatch) {
    // Fallback: look for any <p> or <span> with a title-like class
    titleMatch = block.match(
      /<(?:p|span|h\d)[^>]+class="[^"]*(?:title|name|heading)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|span|h\d)>/i,
    );
  }
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : "";
  if (!title) return null;

  // URL
  const urlMatch = block.match(
    isTv ? /href="(\/tv\/[^"#?]+)"/ : /href="(\/m\/[^"#?]+)"/,
  );
  if (!urlMatch) return null;
  const url = RT_BASE + urlMatch[1];

  // Year
  const yearMatch = block.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : "";

  // Critics score
  const scoreMatch = block.match(/criticsScore[=:]["']?\s*(\d+)/i);
  const criticsScore = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

  // Audience score
  const audMatch = block.match(/audienceScore[=:]["']?\s*(\d+)/i);
  const audienceScore = audMatch ? parseInt(audMatch[1], 10) : null;

  // Poster
  const poster = extractPosterFromBlock(block);

  return { title, url, year, criticsScore, audienceScore, poster };
}

function extractPosterFromBlock(block) {
  const imgMatch = block.match(RT_IMG_SRC_RE);
  if (imgMatch) return imgMatch[1];
  // Fallback: any img with a CDN URL
  const anyImg = block.match(
    /\bsrc(?!set)="(https?:\/\/[^"]{10,}(?:\.jpg|\.jpeg|\.png|\.webp)[^"]*)"/i,
  );
  return anyImg ? anyImg[1] : null;
}

// Strategy 3: simple link-based fallback (minimal info)
function parseFallbackLinks(html, isTv) {
  const items = [];
  const seen = new Set();
  const pattern = isTv
    ? /href="(\/tv\/[a-z0-9_-]+)"/gi
    : /href="(\/m\/[a-z0-9_-]+)"/gi;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    const url = RT_BASE + m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    // Try to find the title near this link
    const start = Math.max(0, m.index - 500);
    const end = Math.min(html.length, m.index + 500);
    const nearby = html.slice(start, end);
    const slug = m[1].replace(isTv ? "/tv/" : "/m/", "").replace(/-/g, " ");
    const title = slug
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ");
    // Check for a short title in nearby HTML
    const titleMatch = nearby.match(
      /<(?:p|span|h\d|div)[^>]*>\s*([^<]{5,80})\s*<\/(?:p|span|h\d|div)>/,
    );
    const resolvedTitle = titleMatch
      ? stripHtml(titleMatch[1]).trim() || title
      : title;
    if (!resolvedTitle) continue;
    items.push({
      title: resolvedTitle,
      url,
      year: "",
      criticsScore: null,
      audienceScore: null,
      poster: null,
    });
    if (items.length >= 20) break;
  }
  return items;
}

// Build the score badge HTML
function buildScoreBadge(score, label) {
  if (score == null) return "";
  const color = score >= 60 ? "#006f2e" : "#fa320a";
  return `<span class="movie-score-badge" style="background:${color};">${score}%</span> <span class="movie-score-label">${label}</span>`;
}

// Build a single movie card
function buildMovieCardHtml(item, showImages) {
  if (!item || !item.title) return "";
  const title = escape(item.title);
  const year = item.year ? ` (${escape(String(item.year))})` : "";
  const rtUrl = item.url || "";

  let posterHtml = "";
  if (showImages && item.poster) {
    const proxied = proxyImageUrl(item.poster);
    posterHtml = `<div class="movie-card-poster"><img src="${proxied}" alt="" class="movie-card-img" width="100" height="148"></div>`;
  }

  const tomatometer = buildScoreBadge(item.criticsScore, "Tomatometer");
  const audience = buildScoreBadge(item.audienceScore, "Audience");
  const scores =
    tomatometer || audience
      ? `<div class="movie-card-scores">${tomatometer}${tomatometer && audience ? "&nbsp;&nbsp;" : ""}${audience}</div>`
      : "";

  const rtLink = rtUrl
    ? `<a href="${escape(rtUrl)}" class="discross-button movie-rt-btn" target="_blank" rel="noopener noreferrer">View on RT</a>`
    : "";

  return `<div class="movie-card">
  ${posterHtml}<div class="movie-card-body">
    <div class="movie-card-title"><font ${FONT}>${title}${year}</font></div>
    ${scores}
    ${rtLink}
  </div>
</div>`;
}

exports.processMovies = async function processMovies(req, res) {
  const { urlSessionID, sessionParam, theme, themeValue, imagesCookie, tabId } =
    resolvePrefs(req);

  const tab = TABS.find((t) => t.id === tabId) || TABS[0];
  const isTv = tab.id === "tv";

  // Build tab bar HTML
  const tabsHtml = TABS.map((t) => {
    const active = t.id === tab.id ? " movie-tab-active" : "";
    const sep = sessionParam
      ? sessionParam + "&tab=" + encodeURIComponent(t.id)
      : "?tab=" + encodeURIComponent(t.id);
    return `<a href="/movies${sep}" class="movie-tab${active}"><font ${FONT}>${escape(t.label)}</font></a>`;
  }).join("\n");

  let sessionHidden = "";
  if (urlSessionID)
    sessionHidden += `<input type="hidden" name="sessionID" value="${escape(urlSessionID)}">`;
  if (themeValue !== 0)
    sessionHidden += `<input type="hidden" name="theme" value="${escape(String(themeValue))}">`;

  let moviesHtml;
  try {
    const html = await fetchHtml(RT_BASE + tab.url);
    const items = parseRTPage(html, isTv);

    if (items.length === 0) {
      moviesHtml =
        '<p class="movie-empty">No results found. Rotten Tomatoes may have updated their page layout.</p>';
    } else {
      moviesHtml = items
        .map((item) => buildMovieCardHtml(item, imagesCookie !== 0))
        .filter(Boolean)
        .join("\n");
    }
  } catch (err) {
    console.error("Rotten Tomatoes fetch error:", err);
    moviesHtml =
      '<p class="movie-empty">Could not load Rotten Tomatoes data. Please try again later.</p>';
  }

  let final = strReplace(
    movies_template,
    "{$WHITE_THEME_ENABLED}",
    theme.themeClass,
  );
  final = strReplace(final, "{$SESSION_PARAM}", sessionParam);
  final = strReplace(final, "{$SESSION_HIDDEN}", sessionHidden);
  final = strReplace(final, "{$TABS}", tabsHtml);
  final = strReplace(final, "{$TAB_LABEL}", escape(tab.label));
  final = strReplace(final, "{$MOVIES_ITEMS}", moviesHtml);

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(final);
};
