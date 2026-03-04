'use strict';

const fs = require('fs');
const escape = require('escape-html');
const he = require('he');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone } = require('../timezoneUtils');

const head_partial = fs.readFileSync('pages/templates/partials/head.html', 'utf-8');

const news_template = fs.readFileSync('pages/templates/news.html', 'utf-8')
  .split('{$COMMON_HEAD}').join(head_partial);

const article_template = fs.readFileSync('pages/templates/news_article.html', 'utf-8')
  .split('{$COMMON_HEAD}').join(head_partial);

const THEME_CONFIG = {
  0: { themeClass: '' },
  1: { themeClass: 'class="light-theme"' },
  2: { themeClass: 'class="amoled-theme"' },
};

// AP News GraphQL API (mobile client persisted query)
const GRAPHQL_URL = 'https://apnews.com/graphql/delivery/ap/v1';
const GRAPHQL_HASH = '3bc305abbf62e9e632403a74cc86dc1cba51156d2313f09b3779efec51fc3acb';
const AP_BASE = 'https://apnews.com';
const DEFAULT_TOPIC = 'apf-topnews';

// Limits for article body parsing
const MAX_ARTICLE_BODY_BYTES = 200000;
const MAX_ARTICLE_ELEMENTS = 150;

// Browser-like User-Agent for AP News requests
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

function proxyImageUrl(url) {
  return '/imageProxy/external/' + Buffer.from(url).toString('base64');
}

// Extract plain text from HTML for display.
// Replaces angle brackets with spaces (destroying tag structure) so
// no incomplete-sanitization issues arise; output is always passed to escape().
function stripHtml(html) {
  if (!html) return '';
  const withNewlines = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n');
  // Destroy all angle-bracket structures by replacing < and > with spaces
  const noAngles = withNewlines.replace(/</g, ' ').replace(/>/g, ' ');
  return he.decode(noAngles).trim();
}

function resolvePrefs(req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') ?? '';
  const urlTheme = parsedUrl.searchParams.get('theme');
  const urlImages = parsedUrl.searchParams.get('images');

  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(c => c.startsWith('whiteThemeCookie='))?.split('=')[1];
  const imagesCookieValue = req.headers.cookie?.split('; ')?.find(c => c.startsWith('images='))?.split('=')[1];

  const linkParamParts = [];
  if (urlSessionID) linkParamParts.push('sessionID=' + encodeURIComponent(urlSessionID));
  if (urlTheme !== null && whiteThemeCookie === undefined) linkParamParts.push('theme=' + encodeURIComponent(urlTheme));
  if (urlImages !== null && imagesCookieValue === undefined) linkParamParts.push('images=' + encodeURIComponent(urlImages));
  const sessionParam = linkParamParts.length ? '?' + linkParamParts.join('&') : '';

  const themeValue = urlTheme !== null ? parseInt(urlTheme, 10) : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie, 10) : 0);
  const theme = THEME_CONFIG[themeValue] ?? THEME_CONFIG[0];
  const imagesCookie = urlImages !== null ? parseInt(urlImages, 10) : (imagesCookieValue !== undefined ? parseInt(imagesCookieValue, 10) : 1);

  return { urlSessionID, sessionParam, theme, themeValue, imagesCookie, parsedUrl };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json',
    },
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} fetching ${url}`);
    err.statusCode = response.status;
    throw err;
  }
  return response.json();
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} fetching ${url}`);
    err.statusCode = response.status;
    throw err;
  }
  return response.text();
}

// Fetch AP News feed via GraphQL persisted query
async function fetchFeed(topic) {
  const params = new URLSearchParams({
    operationName: 'ContentPageQuery',
    variables: JSON.stringify({ path: `/hub/${topic}` }),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: GRAPHQL_HASH },
    }),
  });
  return fetchJson(`${GRAPHQL_URL}?${params}`);
}

// Walk the GraphQL Screen response and collect all PagePromo/VideoPlaylistItem entries
function parseFeedItems(res) {
  const screen = res?.data?.Screen;
  if (!screen?.main) return [];

  const modules = [];
  for (const item of screen.main) {
    if (item.__typename === 'ColumnContainer') {
      for (const col of item.columns || []) {
        modules.push(col);
      }
    } else {
      modules.push(item);
    }
  }

  const items = [];
  for (const mod of modules) {
    if (mod?.__typename === 'PageListModule') {
      items.push(...(mod.items || []));
    } else if (mod?.__typename === 'VideoPlaylistModule') {
      items.push(...(mod.playlist || []));
    }
  }
  return items.filter(Boolean);
}

// Extract the article slug from an AP News article URL
// e.g. "https://apnews.com/article/some-headline-hash" -> "some-headline-hash"
function articleUrlToSlug(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, AP_BASE);
    if (parsed.hostname !== 'apnews.com' && parsed.hostname !== 'www.apnews.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'article' && parts[1]) {
      return parts[1];
    }
    return null;
  } catch {
    return null;
  }
}

function buildNewsCardHtml(item, timezone, sessionParam, showImages) {
  if (!item) return '';

  const title = item.title || '';
  const url = item.url || '';
  if (!title || !url) return '';

  const slug = articleUrlToSlug(url);
  if (!slug) return ''; // Skip non-article items (live blogs, hub pages, etc.)

  const headline = escape(title);
  const summary = escape(stripHtml(item.description || ''));
  const category = escape(item.category || '');
  const date = item.publishDateStamp ? new Date(item.publishDateStamp) : null;
  const dateStr = date ? escape(formatDateWithTimezone(date, timezone)) : '';
  const articleUrl = `/news/${encodeURIComponent(slug)}${sessionParam}`;

  // AP News GraphQL may include image fields under various names
  let imageHtml = '';
  if (showImages) {
    const imgUrl = item.leadPhoto?.url || item.image?.url ||
                   (typeof item.image === 'string' ? item.image : null) ||
                   item.photo?.url;
    if (imgUrl) {
      const proxied = proxyImageUrl(imgUrl);
      const caption = escape(item.leadPhoto?.caption || item.image?.caption || '');
      imageHtml = `<div class="news-card-image-wrap"><img src="${proxied}" alt="${headline}" class="news-card-image">${caption ? `<br><span class="news-card-caption">${caption}</span>` : ''}</div>`;
    }
  }

  return `<div class="news-card">
  ${imageHtml}
  <div class="news-card-body">
    <b class="news-card-title"><font face="'rodin', Arial, Helvetica, sans-serif" size="4">${headline}</font></b><br>
    <span class="news-card-meta">${category ? category + ' &middot; ' : ''}${dateStr}</span><br>
    ${summary ? `<span class="news-card-summary">${summary}</span><br>` : ''}
    <a href="${articleUrl}" class="discross-button news-read-btn">Read Article</a>
  </div>
</div>`;
}

// Parse an AP News article HTML page:
// - Extracts headline, author, date from JSON-LD (<script id="link-ld-json">)
//   or the GTM dataLayer meta tag (fallback)
// - Extracts paragraphs and images from div.RichTextStoryBody
function parseArticlePage(html, showImages) {
  let headline = '', bylines = '', date = null;

  // Primary: JSON-LD structured data
  const ldMatch = html.match(/<script[^>]+id="link-ld-json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ldMatch) {
    try {
      const raw = JSON.parse(ldMatch[1]);
      const article = Array.isArray(raw)
        ? raw.find(e => e['@type'] === 'NewsArticle')
        : (raw['@type'] === 'NewsArticle' ? raw : null);
      if (article) {
        headline = article.headline || '';
        if (article.author) {
          const authors = Array.isArray(article.author) ? article.author : [article.author];
          bylines = authors
            .map(a => a.name || (typeof a === 'string' ? a : ''))
            .filter(Boolean)
            .join(', ');
        }
        if (article.datePublished) {
          date = new Date(article.datePublished);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Fallback: GTM dataLayer meta tag
  if (!headline) {
    const gtmMatch = html.match(/name="gtm-dataLayer"[^>]+content="([^"]+)"/);
    if (gtmMatch) {
      try {
        const gtm = JSON.parse(gtmMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        headline = gtm.headline || '';
        bylines = gtm.author || '';
        if (gtm.publication_date) {
          date = new Date(gtm.publication_date);
        }
      } catch { /* ignore */ }
    }
  }

  // Extract article body starting from RichTextStoryBody
  let contentHtml = '';
  const bodyIdx = html.indexOf('RichTextStoryBody');
  if (bodyIdx !== -1) {
    // Take up to 200 KB of content after the marker
    const body = html.slice(bodyIdx, bodyIdx + MAX_ARTICLE_BODY_BYTES);

    // Match <p> and <figure> elements in document order
    const elRegex = /(<p[^>]*>[\s\S]*?<\/p>|<figure[^>]*>[\s\S]*?<\/figure>)/gi;
    let match;
    let count = 0;

    while ((match = elRegex.exec(body)) !== null && count < MAX_ARTICLE_ELEMENTS) {
      const el = match[1];
      if (el.startsWith('<p') || el.startsWith('<P')) {
        const text = stripHtml(el).trim();
        if (text.length > 10) {
          contentHtml += `<p class="news-article-paragraph">${escape(text)}</p>\n`;
          count++;
        }
      } else if (showImages && (el.startsWith('<figure') || el.startsWith('<FIGURE'))) {
        const imgMatch = el.match(/<img[^>]+src="([^"]+)"[^>]*/i);
        const captionMatch = el.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
        if (imgMatch) {
          const imgUrl = imgMatch[1];
          if (imgUrl && (imgUrl.startsWith('http://') || imgUrl.startsWith('https://'))) {
            const proxied = proxyImageUrl(imgUrl);
            const caption = captionMatch ? escape(stripHtml(captionMatch[1])) : '';
            contentHtml += `<div class="news-article-image-wrap"><img src="${proxied}" alt="" class="news-article-image">${caption ? `<br><span class="news-article-caption">${caption}</span>` : ''}</div>\n`;
          }
        }
      }
    }
  }

  if (!contentHtml) {
    contentHtml = '<p class="news-article-paragraph news-empty">Article text could not be extracted.</p>';
  }

  return { headline, bylines, date, contentHtml };
}

exports.processNews = async function processNews(req, res, args, discordID) {
  const { urlSessionID, sessionParam, theme, themeValue, parsedUrl, imagesCookie } = resolvePrefs(req);
  const timezone = getTimezoneFromIP(getClientIP(req));

  // Sanitise tag: allow letters, digits, hyphens (AP News topic format)
  const rawTag = parsedUrl.searchParams.get('tag') || '';
  const tag = rawTag.replace(/[^a-zA-Z0-9-]/g, '') || DEFAULT_TOPIC;
  const displayTag = tag === DEFAULT_TOPIC ? 'Top News' : escape(tag);
  const tagInputValue = escape(tag === DEFAULT_TOPIC ? '' : tag);

  try {
    const data = await fetchFeed(tag);
    const rawItems = parseFeedItems(data);

    const cards = rawItems
      .map(item => buildNewsCardHtml(item, timezone, sessionParam, imagesCookie !== 0))
      .filter(Boolean);

    const newsItemsHtml = cards.length > 0
      ? cards.join('\n')
      : '<p class="news-empty">No articles found for this category.</p>';

    // Hidden fields carry session/theme through the search form POST
    let sessionHidden = '';
    if (urlSessionID) sessionHidden += `<input type="hidden" name="sessionID" value="${escape(urlSessionID)}">`;
    if (themeValue !== 0) sessionHidden += `<input type="hidden" name="theme" value="${escape(String(themeValue))}">`;

    let final = strReplace(news_template, '{$WHITE_THEME_ENABLED}', theme.themeClass);
    final = strReplace(final, '{$TAG_DISPLAY}', displayTag);
    final = strReplace(final, '{$TAG_VALUE}', tagInputValue);
    final = strReplace(final, '{$SESSION_PARAM}', sessionParam);
    final = strReplace(final, '{$SESSION_HIDDEN}', sessionHidden);
    final = strReplace(final, '{$NEWS_ITEMS}', newsItemsHtml);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(final);
  } catch (err) {
    console.error('AP News feed error:', err);
    const msg = err.statusCode === 404 ? 'Category not found.' : 'Could not load news feed. Please try again later.';
    res.writeHead(err.statusCode === 404 ? 404 : 502, { 'Content-Type': 'text/html' });
    res.end(msg);
  }
};

exports.processNewsArticle = async function processNewsArticle(req, res, args, discordID) {
  const { sessionParam, theme, imagesCookie } = resolvePrefs(req);
  const timezone = getTimezoneFromIP(getClientIP(req));

  // args[2] is the article slug, e.g. "trump-trade-tariffs-abc123def456"
  // AP News article slugs contain only letters, digits, and hyphens
  const articleSlug = args[2] || '';
  if (!articleSlug || /[^a-zA-Z0-9-]/.test(articleSlug)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid article ID');
    return;
  }

  const articleUrl = `${AP_BASE}/article/${articleSlug}`;

  try {
    const html = await fetchHtml(articleUrl);
    const { headline, bylines, date, contentHtml } = parseArticlePage(html, imagesCookie !== 0);

    const headlineEscaped = escape(headline || 'Untitled');
    const bylinesEscaped = bylines ? `${escape(bylines)} &middot; ` : '';
    const dateStr = date ? escape(formatDateWithTimezone(date, timezone)) : '';

    let final = strReplace(article_template, '{$WHITE_THEME_ENABLED}', theme.themeClass);
    final = strReplace(final, '{$HEADLINE}', headlineEscaped);
    final = strReplace(final, '{$BYLINE}', bylinesEscaped);
    final = strReplace(final, '{$DATE}', dateStr);
    final = strReplace(final, '{$SESSION_PARAM}', sessionParam);
    final = strReplace(final, '{$ARTICLE_CONTENT}', contentHtml);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(final);
  } catch (err) {
    console.error('AP News article error:', err);
    const msg = err.statusCode === 404 ? 'Article not found.' : 'Could not load article. Please try again later.';
    res.writeHead(err.statusCode === 404 ? 404 : 502, { 'Content-Type': 'text/html' });
    res.end(msg);
  }
};

