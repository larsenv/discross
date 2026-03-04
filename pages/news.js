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

const DEFAULT_TAG = 'apf-topnews';
const AP_FEED_BASE = 'https://afs-prod.appspot.com/api/v2/feed/tag?tags=';
const AP_CONTENT_BASE = 'https://afs-prod.appspot.com/api/v2/content/';

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
      'User-Agent': 'Mozilla/5.0 (compatible; Discross/1.0)',
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

function pickImageUrl(photoLinks) {
  if (!photoLinks || photoLinks.length === 0) return null;
  return (photoLinks.find(p => p.imageType === 'EXTLarge') || photoLinks[0]).url || null;
}

function buildNewsCardHtml(item, timezone, sessionParam, showImages) {
  const headline = escape(item.headline || 'Untitled');
  const summary = escape(stripHtml(item.summary || ''));
  const bylines = escape(item.bylines || '');
  const date = item.firstPublishDate ? new Date(item.firstPublishDate) : null;
  const dateStr = date ? escape(formatDateWithTimezone(date, timezone)) : '';
  const articleId = encodeURIComponent(item.id || '');

  let imageHtml = '';
  if (showImages) {
    const photoLinks = item.mediaSummaryObj?.photoLinks;
    const imgUrl = pickImageUrl(photoLinks);
    if (imgUrl) {
      const proxied = proxyImageUrl(imgUrl);
      const caption = escape(item.mediaSummaryObj?.caption || '');
      imageHtml = `<div class="news-card-image-wrap"><img src="${proxied}" alt="${headline}" class="news-card-image">${caption ? `<br><span class="news-card-caption">${caption}</span>` : ''}</div>`;
    }
  }

  const articleUrl = `/news/${articleId}${sessionParam}`;

  return `<div class="news-card">
  ${imageHtml}
  <div class="news-card-body">
    <b class="news-card-title"><font face="'rodin', Arial, Helvetica, sans-serif" size="4">${headline}</font></b><br>
    <span class="news-card-meta">${bylines}${bylines && dateStr ? ' &middot; ' : ''}${dateStr}</span><br>
    ${summary ? `<span class="news-card-summary">${summary}</span><br>` : ''}
    <a href="${articleUrl}" class="discross-button news-read-btn">Read Article</a>
  </div>
</div>`;
}

exports.processNews = async function processNews(req, res, args, discordID) {
  const { urlSessionID, sessionParam, theme, themeValue, parsedUrl, imagesCookie } = resolvePrefs(req);
  const timezone = getTimezoneFromIP(getClientIP(req));

  // Sanitise tag: allow letters, digits, hyphens (AP News tag format)
  const rawTag = parsedUrl.searchParams.get('tag') || '';
  const tag = rawTag.replace(/[^a-zA-Z0-9-]/g, '') || DEFAULT_TAG;
  const displayTag = tag === DEFAULT_TAG ? 'Top News' : escape(tag);
  const tagInputValue = escape(tag === DEFAULT_TAG ? '' : tag);

  try {
    const data = await fetchJson(`${AP_FEED_BASE}${encodeURIComponent(tag)}`);
    const items = Array.isArray(data.items) ? data.items : [];

    let newsItemsHtml;
    if (items.length === 0) {
      newsItemsHtml = '<p class="news-empty">No articles found for this category.</p>';
    } else {
      newsItemsHtml = items.map(item => buildNewsCardHtml(item, timezone, sessionParam, imagesCookie !== 0)).join('\n');
    }

    // Build hidden fields for the search form so session/theme params carry through
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

  // args[2] contains the URL-decoded article ID from the path
  const articleId = args[2] || '';
  // Restrict to alphanumeric, hyphens, underscores, and dots (covers all AP News ID formats)
  if (!articleId || /[^a-zA-Z0-9_.-]/.test(articleId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid article ID');
    return;
  }

  try {
    const data = await fetchJson(`${AP_CONTENT_BASE}${encodeURIComponent(articleId)}`);

    const headline = escape(data.headline || 'Untitled');
    const bylines = escape(data.bylines || '');
    const date = data.firstPublishDate ? new Date(data.firstPublishDate) : null;
    const dateStr = date ? escape(formatDateWithTimezone(date, timezone)) : '';

    let contentHtml = '';
    const contents = Array.isArray(data.contents) ? data.contents : [];

    for (const item of contents) {
      const type = (item.type || '').toLowerCase();
      if (type === 'text' || type === 'richtext' || type === 'richtextitem') {
        const text = stripHtml(item.content || '');
        if (text) {
          const paragraphs = text.split('\n').map(p => p.trim()).filter(Boolean);
          for (const para of paragraphs) {
            contentHtml += `<p class="news-article-paragraph">${escape(para)}</p>\n`;
          }
        }
      } else if ((type === 'photo' || type === 'image') && imagesCookie !== 0) {
        const imgUrl = pickImageUrl(item.photoLinks);
        if (imgUrl) {
          const proxied = proxyImageUrl(imgUrl);
          const caption = escape(item.captionText || item.caption || '');
          contentHtml += `<div class="news-article-image-wrap"><img src="${proxied}" alt="${caption || headline}" class="news-article-image">${caption ? `<br><span class="news-article-caption">${caption}</span>` : ''}</div>\n`;
        }
      }
    }

    if (!contentHtml) {
      contentHtml = '<p class="news-article-paragraph news-empty">Article text could not be extracted.</p>';
    }

    let final = strReplace(article_template, '{$WHITE_THEME_ENABLED}', theme.themeClass);
    final = strReplace(final, '{$HEADLINE}', headline);
    final = strReplace(final, '{$BYLINE}', bylines ? `${bylines} &middot; ` : '');
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
