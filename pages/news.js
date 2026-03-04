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

const AP_BASE = 'https://apnews.com';
const DEFAULT_TOPIC = 'apf-topnews';

// Max article body elements to extract (prevents runaway on malformed HTML)
const MAX_ARTICLE_ELEMENTS = 150;

// Browser-like User-Agent for AP News requests
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement ?? '');
}

function proxyImageUrl(url) {
  return '/imageProxy/external/' + Buffer.from(url).toString('base64');
}

// Strip all HTML tags from a string, preserving text content only.
// Block-level elements become newlines; all tag markup is removed entirely.
// Output is always passed through he.decode + escape-html before rendering.
function stripHtml(html) {
  if (!html) return '';
  return he.decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]*>/g, '')  // Remove all HTML tags and their attributes
      .replace(/</g, '')        // Remove any stray '<' left by malformed attribute values
  ).trim();
}

// Returns true if the paragraph text is a CTA / live-update callout that
// should not appear in the article body (e.g. "▶ Follow live updates…").
function isCTAParagraph(text) {
  // AP News prepends ▶ (U+25B6) to live-blog follow links
  return text.startsWith('\u25B6') || text.startsWith('▶');
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

// AP News image src regex: matches src="https://dims.apnews.com/..." or assets.apnews.com
// Uses negative lookahead (?!set) to avoid matching srcset attributes.
const AP_IMG_SRC_RE = /\bsrc(?!set)="(https?:\/\/(?:dims|assets)\.apnews\.com\/[^"]+)"/i;

// Extract the inner content of a <div> block starting at contentStart
// (i.e., just after the opening tag), bounded by tracking div nesting depth.
function extractDivContent(html, contentStart) {
  let depth = 1;
  let i = contentStart;

  while (i < html.length && depth > 0) {
    // Use indexOf('<div', i) then verify the next char is whitespace or '>'
    // so we don't count <divider> or other elements starting with 'div'.
    let nextOpen = -1;
    let pos = i;
    while (pos < html.length) {
      const candidate = html.indexOf('<div', pos);
      if (candidate === -1) break;
      const c = html[candidate + 4];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '>') {
        nextOpen = candidate;
        break;
      }
      pos = candidate + 1;
    }

    const nextClose = html.indexOf('</div>', i);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return html.slice(contentStart, nextClose);
      i = nextClose + 6;
    }
  }

  return html.slice(contentStart, i);
}

// Scrape the AP News hub HTML page for feed items.
// Mirrors the approach used by RSSHub topics.ts but also extracts images.
function parseHubHtml(html) {
  const items = [];
  const seen = new Set();

  // Each article on the hub page is a div.PagePromo
  const PROMO_OPEN_RE = /<div[^>]+class="[^"]*\bPagePromo\b[^"]*"[^>]*>/gi;
  let m;

  while ((m = PROMO_OPEN_RE.exec(html)) !== null) {
    const contentStart = m.index + m[0].length;

    // Timestamp lives as a data attribute on the PagePromo div itself
    const tsMatch = m[0].match(/data-posted-date-timestamp="(\d+)"/);
    const timestamp = tsMatch ? parseInt(tsMatch[1], 10) : 0;

    const block = extractDivContent(html, contentStart);

    // Skip nested PagePromos by jumping past this block
    PROMO_OPEN_RE.lastIndex = contentStart + block.length;

    // Article URL — prefer /article/ links to skip live-blog/hub links
    const urlMatch = block.match(/href="((?:https:\/\/apnews\.com)?\/article\/[^"#]+)"/i);
    if (!urlMatch) continue;

    // Headline text from the PagePromoContentIcons-text span
    const titleMatch = block.match(/<span[^>]+class="[^"]*PagePromoContentIcons-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!titleMatch) continue;

    const url = urlMatch[1].startsWith('http') ? urlMatch[1] : `${AP_BASE}${urlMatch[1]}`;
    const title = stripHtml(titleMatch[1]).trim();
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);

    // Lead image: src from an img tag at dims/assets.apnews.com (not srcset)
    const imgMatch = block.match(AP_IMG_SRC_RE);
    const altMatch = block.match(/<img[^>]+alt="([^"]*)"[^>]*>/i);
    const captionMatch = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);

    items.push({
      url,
      title,
      publishDateStamp: timestamp,
      imageUrl: imgMatch ? imgMatch[1] : null,
      imageAlt: altMatch ? altMatch[1] : title,
      imageCaption: captionMatch ? stripHtml(captionMatch[1]) : '',
    });
  }

  return items;
}

// Extract the article slug from an AP News article URL
function articleUrlToSlug(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, AP_BASE);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'article' && parts[1]) return parts[1];
    return null;
  } catch {
    return null;
  }
}

function buildNewsCardHtml(item, timezone, sessionParam, showImages) {
  if (!item) return '';
  const { url, title, publishDateStamp, imageUrl, imageAlt, imageCaption } = item;
  if (!title || !url) return '';

  const slug = articleUrlToSlug(url);
  if (!slug) return '';

  const headline = escape(title);
  const date = publishDateStamp ? new Date(publishDateStamp) : null;
  const dateStr = date ? escape(formatDateWithTimezone(date, timezone)) : '';
  const articleUrl = `/news/${encodeURIComponent(slug)}${sessionParam}`;

  let imageHtml = '';
  if (showImages && imageUrl) {
    const proxied = proxyImageUrl(imageUrl);
    const alt = escape(imageAlt || title);
    const caption = escape(imageCaption || '');
    imageHtml = `<div class="news-card-image-wrap"><img src="${proxied}" alt="${alt}" class="news-card-image">${caption ? `<br><span class="news-card-caption">${caption}</span>` : ''}</div>`;
  }

  return `<div class="news-card">
  ${imageHtml}
  <div class="news-card-body">
    <div class="news-card-title"><font face="'rodin', Arial, Helvetica, sans-serif">${headline}</font></div>
    ${dateStr ? `<div class="news-card-meta">${dateStr}</div>` : ''}
    <a href="${articleUrl}" class="discross-button news-read-btn">Read Article</a>
  </div>
</div>`;
}

// Extract the inner content of div.RichTextStoryBody, tightly bounded by div
// depth tracking so we never leak into the related-articles section below.
function extractStoryBody(html) {
  const m = html.match(/<div[^>]+class="[^"]*RichTextStoryBody[^"]*"[^>]*>/i);
  if (!m) return '';
  return extractDivContent(html, m.index + m[0].length);
}

// Parse an AP News article HTML page.
// Extracts headline/author/date from JSON-LD, with a GTM dataLayer fallback.
// Body text and inline images come from div.RichTextStoryBody only.
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
          bylines = authors.map(a => a.name || (typeof a === 'string' ? a : '')).filter(Boolean).join(', ');
        }
        if (article.datePublished) date = new Date(article.datePublished);
      }
    } catch { /* ignore */ }
  }

  // Fallback: GTM dataLayer meta tag
  if (!headline) {
    const gtmMatch = html.match(/name="gtm-dataLayer"[^>]+content="([^"]+)"/);
    if (gtmMatch) {
      try {
        const gtm = JSON.parse(gtmMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        headline = gtm.headline || '';
        bylines = gtm.author || '';
        if (gtm.publication_date) date = new Date(gtm.publication_date);
      } catch { /* ignore */ }
    }
  }

  // Extract article body — ONLY what's inside div.RichTextStoryBody
  const body = extractStoryBody(html);
  let contentHtml = '';

  if (body) {
    // Walk <p> and <img> tags in document order.
    // Looking for <img> directly (rather than <figure> or <div>) handles any
    // wrapping structure AP News uses (figure, div.Figure, bare img, etc.).
    const tagRe = /<(p|img)(\s|>)/gi;
    let match;
    let count = 0;
    const seenImages = new Set();

    while ((match = tagRe.exec(body)) !== null && count < MAX_ARTICLE_ELEMENTS) {
      const tagName = match[1].toLowerCase();

      if (tagName === 'p') {
        const end = body.indexOf('</p>', match.index);
        if (end === -1) continue;
        tagRe.lastIndex = end + 4;
        const el = body.slice(match.index, end + 4);
        const text = stripHtml(el).trim();
        if (text.length > 10 && !isCTAParagraph(text)) {
          contentHtml += `<p class="news-article-paragraph">${escape(text)}</p>\n`;
          count++;
        }
      } else if (tagName === 'img' && showImages) {
        const tagEnd = body.indexOf('>', match.index);
        if (tagEnd === -1) continue;
        tagRe.lastIndex = tagEnd + 1;
        const el = body.slice(match.index, tagEnd + 1);
        // Only proxy AP News CDN images (dims/assets.apnews.com)
        const srcMatch = el.match(AP_IMG_SRC_RE);
        if (!srcMatch || seenImages.has(srcMatch[1])) continue;
        seenImages.add(srcMatch[1]);
        const imgUrl = srcMatch[1];
        const proxied = proxyImageUrl(imgUrl);
        // Look for figcaption in the next ~1500 chars after this img tag
        const nearby = body.slice(tagEnd + 1, tagEnd + 1500);
        const captionMatch = nearby.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
        const caption = captionMatch ? escape(stripHtml(captionMatch[1])) : '';
        contentHtml += `<div class="news-article-image-wrap"><img src="${proxied}" alt="" class="news-article-image">${caption ? `<br><span class="news-article-caption">${caption}</span>` : ''}</div>\n`;
        count++;
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
    // Scrape the hub HTML page — gives us titles, dates, URLs, and lead images
    const html = await fetchHtml(`${AP_BASE}/hub/${tag}`);
    const feedItems = parseHubHtml(html);

    const cards = feedItems
      .map(item => buildNewsCardHtml(item, timezone, sessionParam, imagesCookie !== 0))
      .filter(Boolean);

    const newsItemsHtml = cards.length > 0
      ? cards.join('\n')
      : '<p class="news-empty">No articles found for this category.</p>';

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

  // args[2] is the article slug (letters, digits, hyphens only)
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
    const bylinesEscaped = bylines ? `${escape(bylines)} - ` : '';
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


