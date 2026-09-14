'use strict';

const escape = require('escape-html');
const he = require('he');
const { getClientIP, getTimezoneFromIP, formatDateWithTimezone } = require('../src/timezoneUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { processUnicodeEmojiInText } = require('./emojiUtils');
const {
    renderTemplate,
    render,
    parseCookies,
    resolveTheme,
    buildSessionParam,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
} = require('./utils');

const auth = require('../src/authentication');
const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

const news_template = loadAndRenderPageTemplate('index', 'news');

const article_template = loadAndRenderPageTemplate('article', 'news');

const AP_BASE = 'https://apnews.com';
const DEFAULT_TOPIC = 'apf-topnews';

// Max article body elements to extract (prevents runaway on malformed HTML)
const MAX_ARTICLE_ELEMENTS = 150;

// Browser-like User-Agent for AP News requests
const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function proxyImageUrl(url) {
    if (!url) return '';
    return `/imageProxy/external/${Buffer.from(url).toString('base64')}`;
}

// Escape text for safe HTML output with the same Unicode processing used for
// Discord messages: normalize weird Unicode → HTML-escape → replace emoji with
// Twemoji img tags (only when images are enabled).
function escapeContent(text, showImages) {
    if (!text) return '';
    const normalized = normalizeWeirdUnicode(text);
    const escaped = escape(normalized);
    if (!showImages) return escaped;
    return processUnicodeEmojiInText(escaped, 18, '1.125em');
}

// Strip all HTML tags from a string, preserving text content only.
// Block-level elements become newlines; all tag markup is removed entirely.
// Output is always passed through he.decode + escape-html before rendering.
function stripHtml(html) {
    if (!html) return '';
    return he
        .decode(
            html
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n')
                .replace(/<\/div>/gi, '\n')
                .replace(/<[^>]*>/g, '') // Remove all HTML tags and their attributes
                .replace(/</g, '') // Remove any stray '<' left by malformed attribute values
        )
        .trim();
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

    const { whiteThemeCookie, images: imagesCookieValue } = parseCookies(req);

    const sessionParam = buildSessionParam(
        urlSessionID,
        urlTheme,
        whiteThemeCookie,
        urlImages,
        imagesCookieValue
    );

    const theme = resolveTheme(req);
    const imagesCookie =
        urlImages !== null
            ? parseInt(urlImages, 10)
            : imagesCookieValue !== undefined
              ? parseInt(imagesCookieValue, 10)
              : 1;

    return { urlSessionID, sessionParam, theme, imagesCookie, parsedUrl };
}

async function fetchHtml(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'text/html,application/xhtml+xml',
        },
    });
    if (!response.ok) {
        const err = new Error(`HTTP ${response.status} fetching ${url}`);
        err.statusCode = response.status;
        throw err;
    }
    return response.text();
}

// AP News mobile GraphQL API - far more reliable for fetching article bodies
// and thumbnails than scraping the rendered HTML, since AP frequently changes
// its page markup but keeps this persisted-query API stable.
const GRAPHQL_BASE = 'https://apnews.com/graphql/delivery/ap/v1';
const STORY_QUERY_HASH = 'd61508dd5f8c1d84fa6d49338e321266f56b4538c07c233564bb11300287d69c';

async function fetchStoryGraphQL(articlePath) {
    const url = new URL(GRAPHQL_BASE);
    url.searchParams.set('operationName', 'StoryQuery');
    url.searchParams.set('variables', JSON.stringify({ path: articlePath }));
    url.searchParams.set(
        'extensions',
        JSON.stringify({ persistedQuery: { version: 1, sha256Hash: STORY_QUERY_HASH } })
    );

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'application/json',
        },
    });
    if (!response.ok) {
        const err = new Error(`HTTP ${response.status} fetching ${url}`);
        err.statusCode = response.status;
        throw err;
    }
    return response.json();
}

// Reconstruct usable HTML from the storyBody parts returned by the GraphQL API.
function reconstructStoryHtml(storyBody) {
    let html = '';
    for (const part of storyBody || []) {
        if (part.__typename === 'HtmlString') {
            html += part.html || '';
        } else if (part.__typename === 'LinkEnhancement') {
            html += (part.body || []).join('');
        }
        // Other parts (video players, ads, etc) are intentionally skipped.
    }
    return html;
}

// __typename discriminators ("Map"/"MapEntry") are only present on some
// persisted queries (e.g. StoryQuery) and absent on others (e.g.
// ContentPageQuery's hub listing), so match on the `key`/`entries` shape
// itself rather than requiring __typename.
function extractURLFromImageMap(imageMap) {
    if (!imageMap) return '';
    for (const entry of imageMap.entries || []) {
        if (entry.key === 'src') return entry.value;
    }
    return '';
}

function extractGalleryImage(gallery) {
    for (const item of gallery || []) {
        if (item.__typename !== 'Carousel') continue;
        for (const slide of item.slides || []) {
            if (slide.__typename !== 'GallerySlide') continue;
            const caption = (slide.caption || []).find((c) => c) || '';
            for (const media of slide.media || []) {
                if (media.__typename !== 'Image') continue;
                const url = extractURLFromImageMap(media.image);
                if (url) return { caption, url };
            }
        }
    }
    return null;
}

function extractLeadImage(storyLead) {
    for (const item of storyLead || []) {
        if (item.__typename !== 'Figure') continue;
        const url = extractURLFromImageMap(item.image);
        if (url) return { caption: item.alt || '', url };
    }
    return null;
}

// Prefer the blended gallery image (as AP does for stories with a lead
// gallery), falling back to the story's lead figure.
function extractStoryThumbnail(storyPage) {
    return extractGalleryImage(storyPage.blendedGallery) || extractLeadImage(storyPage.storyLead);
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

// Fetch the AP News hub listing from the mobile GraphQL API. AP now returns
// 403 for direct HTML fetches of hub pages from server IPs, so this replaces
// the previous HTML scrape entirely.
const CONTENT_PAGE_QUERY_HASH = '3bc305abbf62e9e632403a74cc86dc1cba51156d2313f09b3779efec51fc3acb';

async function fetchHubGraphQL(hubPath) {
    const url = new URL(GRAPHQL_BASE);
    url.searchParams.set('operationName', 'ContentPageQuery');
    url.searchParams.set('variables', JSON.stringify({ path: hubPath }));
    url.searchParams.set(
        'extensions',
        JSON.stringify({ persistedQuery: { version: 1, sha256Hash: CONTENT_PAGE_QUERY_HASH } })
    );

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'application/json',
        },
    });
    if (!response.ok) {
        const err = new Error(`HTTP ${response.status} fetching ${url}`);
        err.statusCode = response.status;
        throw err;
    }
    return response.json();
}

// Parse the ContentPageQuery response into feed items, deduplicated by path.
function parseHubGraphQL(data) {
    const itemsMap = new Map();
    const main = data?.data?.Screen?.main || [];

    for (const block of main) {
        if (block.__typename !== 'ColumnContainer') continue;
        for (const column of block.columns || []) {
            if (column.__typename !== 'PageListModule') continue;
            for (const item of column.items || []) {
                if (item.__typename !== 'PagePromo' || !item.title || !item.graphqlPath) continue;
                if (itemsMap.has(item.graphqlPath)) continue;

                const media = (item.media || [])[0];
                const imageUrl = media ? extractURLFromImageMap(media.image) : '';

                itemsMap.set(item.graphqlPath, {
                    path: item.graphqlPath,
                    title: item.title,
                    publishDateStamp: item.publishDateStamp || 0,
                    imageUrl,
                    imageAlt: (media && media.alt) || item.title,
                    imageCaption: '',
                });
            }
        }
    }

    return Array.from(itemsMap.values());
}

// Extract the article slug from an AP News article path (e.g. "/article/foo-abc123")
function articlePathToSlug(path) {
    if (!path) return null;
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'article' && parts[1]) return parts[1];
    return null;
}

function buildNewsCardHtml(item, timezone, sessionParam, showImages) {
    if (!item) return '';
    const { path, title, publishDateStamp, imageUrl, imageAlt, imageCaption } = item;
    if (!title || !path) return '';

    const slug = articlePathToSlug(path);
    if (!slug) return '';

    const headline = escapeContent(title, showImages);
    const date = publishDateStamp ? new Date(publishDateStamp) : null;
    const dateStr = date ? escape(formatDateWithTimezone(date, timezone)) : '';
    const articleUrl = `/news/${encodeURIComponent(slug)}${sessionParam}`;

    const imageHtml =
        showImages && imageUrl
            ? (() => {
                  const proxied = proxyImageUrl(imageUrl);
                  const alt = escapeContent(imageAlt || title, showImages);
                  const caption = escapeContent(imageCaption || '', showImages);
                  return render('news/news-card-image', {
                      PROXIED_URL: proxied,
                      ALT_TEXT: alt,
                      CAPTION_HTML: caption
                          ? render('news/caption', {
                                CLASS: 'news-card-caption',
                                CAPTION: caption,
                            })
                          : '',
                  });
              })()
            : '';

    return render('news/news-card', {
        IMAGE_HTML: imageHtml,
        TITLE_HTML: render('news/news-card-title', { HEADLINE: headline }),
        DATE_META_HTML: dateStr ? render('news/news-card-meta', { DATE_STR: dateStr }) : '',
        READ_BUTTON_HTML: render('news/news-read-button', {
            ARTICLE_URL: articleUrl,
        }),
    });
}

// Extract the inner content of div.RichTextStoryBody, tightly bounded by div
// depth tracking so we never leak into the related-articles section below.
function extractStoryBody(html) {
    const m = html.match(/<div[^>]+class="[^"]*RichTextStoryBody[^"]*"[^>]*>/i);
    if (!m) return '';
    return extractDivContent(html, m.index + m[0].length);
}

// Parse an AP News article HTML page.
// Extracts headline/author/date from the GraphQL StoryPage when available
// (AP now blocks direct HTML fetches of article pages from server IPs with a
// 403), falling back to JSON-LD/GTM scraping of the rendered page otherwise.
// `bodyHtml`/`thumbnail` similarly come from the GraphQL API when available
// (see fetchStoryGraphQL); when they aren't, body text and inline images
// fall back to scraping div.RichTextStoryBody from the rendered page.
function parseArticlePage(html, showImages, bodyHtml, thumbnail, storyPage) {
    let headline = '',
        bylines = '',
        date = null;

    if (storyPage) {
        headline = storyPage.headline || '';
        bylines = storyPage.authorByline || '';
        if (storyPage.datePublishedISO) date = new Date(storyPage.datePublishedISO);
    }

    // Fallback: JSON-LD structured data from the rendered page
    const ldMatch =
        !headline && html
            ? html.match(/<script[^>]+id="link-ld-json"[^>]*>([\s\S]*?)<\/script>/i)
            : null;
    if (ldMatch) {
        try {
            const raw = JSON.parse(ldMatch[1]);
            const article = Array.isArray(raw)
                ? raw.find((e) => e['@type'] === 'NewsArticle')
                : raw['@type'] === 'NewsArticle'
                  ? raw
                  : null;
            if (article) {
                headline = article.headline || '';
                if (article.author) {
                    const authors = Array.isArray(article.author)
                        ? article.author
                        : [article.author];
                    bylines = authors
                        .map((a) => a.name || (typeof a === 'string' ? a : ''))
                        .filter(Boolean)
                        .join(', ');
                }
                if (article.datePublished) date = new Date(article.datePublished);
            }
        } catch {
            /* ignore */
        }
    }

    // Fallback: GTM dataLayer meta tag
    if (!headline && html) {
        const gtmMatch = html.match(/name="gtm-dataLayer"[^>]+content="([^"]+)"/);
        if (gtmMatch) {
            try {
                const gtm = JSON.parse(gtmMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
                headline = gtm.headline || '';
                bylines = gtm.author || '';
                if (gtm.publication_date) date = new Date(gtm.publication_date);
            } catch {
                /* ignore */
            }
        }
    }

    // Prefer the body reconstructed from the GraphQL API; fall back to
    // scraping div.RichTextStoryBody if that wasn't available.
    const body = bodyHtml || (html ? extractStoryBody(html) : '');

    const leadImageHtml =
        showImages && thumbnail && thumbnail.url
            ? (() => {
                  const proxied = proxyImageUrl(thumbnail.url);
                  const caption = escapeContent(stripHtml(thumbnail.caption || ''), showImages);
                  return (
                      render('news/news-article-image', {
                          PROXIED_URL: proxied,
                          ALT_TEXT: '',
                          CAPTION_HTML: caption
                              ? render('news/caption', {
                                    CLASS: 'news-article-caption',
                                    CAPTION: caption,
                                })
                              : '',
                      }) + '\n'
                  );
              })()
            : body && showImages
              ? (() => {
                    const imgTagRe = /<img(\s[^>]*)>/gi;
                    let imgMatch;
                    while ((imgMatch = imgTagRe.exec(body)) !== null) {
                        const srcMatch = imgMatch[0].match(AP_IMG_SRC_RE);
                        if (!srcMatch) continue;
                        const imgUrl = srcMatch[1];
                        const proxied = proxyImageUrl(imgUrl);
                        const tagEnd = imgMatch.index + imgMatch[0].length;
                        const searchStart = Math.max(0, imgMatch.index - 3000);
                        const nearby = body.slice(searchStart, tagEnd + 5000);
                        const captionMatch = nearby.match(
                            /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i
                        );
                        const caption = captionMatch
                            ? escapeContent(stripHtml(captionMatch[1]), showImages)
                            : '';
                        return (
                            render('news/news-article-image', {
                                PROXIED_URL: proxied,
                                ALT_TEXT: '', // alt is empty here, as in the original
                                CAPTION_HTML: caption
                                    ? render('news/caption', {
                                          CLASS: 'news-article-caption',
                                          CAPTION: caption,
                                      })
                                    : '',
                            }) + '\n'
                        );
                    }
                    return '';
                })()
              : '';

    const contentHtml = (() => {
        if (!body) return getTemplate('news-article-text-error', 'news');
        const pRe = /<p(\s|>)/gi;
        let match;
        let count = 0;
        const paragraphs = [];
        while ((match = pRe.exec(body)) !== null && count < MAX_ARTICLE_ELEMENTS) {
            const end = body.indexOf('</p>', match.index);
            if (end === -1) continue;
            pRe.lastIndex = end + 4;
            const el = body.slice(match.index, end + 4);
            const text = stripHtml(el).trim();
            if (text.length > 10 && !isCTAParagraph(text)) {
                paragraphs.push(
                    render('news/news-article-paragraph', {
                        CONTENT: escapeContent(text, showImages),
                    }) + '\n'
                );
                count++;
            }
        }
        return paragraphs.join('') || getTemplate('news-article-text-error', 'news');
    })();

    return { headline, bylines, date, leadImageHtml, contentHtml };
}

exports.processNews = async function processNews(req, res, args, discordID) {
    const { urlSessionID, sessionParam, theme, parsedUrl, imagesCookie } = resolvePrefs(req);
    const timezone = getTimezoneFromIP(req);
    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;

    // Sanitise tag: allow letters, digits, hyphens (AP News topic format)
    const rawTag = parsedUrl.searchParams.get('tag') || '';
    const tag = rawTag.replace(/[^a-zA-Z0-9-]/g, '') || DEFAULT_TOPIC;
    const displayTag = tag === DEFAULT_TOPIC ? 'Top News' : escape(tag);
    const tagInputValue = escape(tag === DEFAULT_TOPIC ? '' : tag);

    try {
        // AP returns 403 for direct HTML fetches of hub pages from server IPs,
        // so fetch the listing from the mobile GraphQL API instead.
        const hubPath = tag === DEFAULT_TOPIC ? '/' : `/hub/${tag}`;
        const hubData = await fetchHubGraphQL(hubPath);
        const feedItems = parseHubGraphQL(hubData);

        const cards = feedItems
            .map((item) => buildNewsCardHtml(item, timezone, sessionParam, imagesCookie !== 0))
            .filter(Boolean);

        const newsItemsHtml =
            cards.length > 0 ? cards.join('\n') : getTemplate('news-no-articles-error', 'news');
        const sessionHidden = [
            urlSessionID
                ? render('news/hidden-input', {
                      NAME: 'sessionID',
                      VALUE: escape(urlSessionID),
                  })
                : '',
            theme.themeValue !== 0
                ? render('news/hidden-input', {
                      NAME: 'theme',
                      VALUE: theme.themeValue.toString(),
                  })
                : '',
        ].join('');

        const final = renderTemplate(news_template, {
            MENU_OPTIONS: menuOptions,
            WHITE_THEME_ENABLED: theme.themeClass,
            TAG_DISPLAY: displayTag,
            TAG_VALUE: tagInputValue,
            SESSION_PARAM: sessionParam,
            SESSION_HIDDEN: sessionHidden,
            NEWS_ITEMS: newsItemsHtml,
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(final);
    } catch (err) {
        console.warn('AP News feed error:', err.message || err);
        const msg =
            err.statusCode === 404
                ? getTemplate('news-category-not-found-error', 'misc')
                : getTemplate('news-load-feed-error', 'misc');
        res.writeHead(err.statusCode === 404 ? 404 : 502, { 'Content-Type': 'text/html' });
        res.end(msg);
    }
};

exports.processNewsArticle = async function processNewsArticle(req, res, args, discordID) {
    const { sessionParam, theme, imagesCookie } = resolvePrefs(req);
    const timezone = getTimezoneFromIP(req);
    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;

    // args[2] is the article slug (letters, digits, hyphens only)
    const articleSlug = args[2] || '';
    if (!articleSlug || /[^a-zA-Z0-9-]/.test(articleSlug)) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getTemplate('news-invalid-article-id-error', 'misc'));
        return;
    }

    const articleUrl = `${AP_BASE}/article/${articleSlug}`;

    try {
        // The GraphQL API is the primary source: AP now returns 403 for
        // direct HTML fetches of article pages from server IPs, so the
        // rendered-page fetch is best-effort only, used as a fallback for
        // metadata/body if the GraphQL call comes back empty.
        const [storyGraphQL, html] = await Promise.all([
            fetchStoryGraphQL(`/article/${articleSlug}`),
            fetchHtml(articleUrl).catch((err) => {
                console.warn('AP News article HTML fetch error:', err.message || err);
                return null;
            }),
        ]);

        const storyPage = storyGraphQL?.data?.StoryPage;
        const bodyHtml = storyPage ? reconstructStoryHtml(storyPage.storyBody) : '';
        const thumbnail = storyPage ? extractStoryThumbnail(storyPage) : null;

        const { headline, bylines, date, leadImageHtml, contentHtml } = parseArticlePage(
            html,
            imagesCookie !== 0,
            bodyHtml,
            thumbnail,
            storyPage
        );

        const headlineEscaped = escapeContent(headline || 'Untitled', imagesCookie !== 0);
        const bylinesEscaped = bylines ? `${escapeContent(bylines, imagesCookie !== 0)} - ` : '';
        const dateStr = date ? escape(formatDateWithTimezone(date, timezone)) : '';

        const pageTitle = `${headline || 'News'} - AP News - Discross`;
        const seoDescription = `Read this AP News article on Discross, the universal Discord client. ${headline || ''}`;

        const final = renderTemplate(article_template, {
            MENU_OPTIONS: menuOptions,
            WHITE_THEME_ENABLED: theme.themeClass,
            HEADLINE: headlineEscaped,
            BYLINE: bylinesEscaped,
            DATE: dateStr,
            SESSION_PARAM: sessionParam,
            LEAD_IMAGE: leadImageHtml,
            ARTICLE_CONTENT: contentHtml,
            PAGE_TITLE: pageTitle,
            SEO_METADATA: generateSEOMetadata(req, {
                title: pageTitle,
                description: seoDescription,
                noindex: true,
            }),
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(final);
    } catch (err) {
        console.warn('AP News article error:', err.message || err);
        const msg =
            err.statusCode === 404
                ? getTemplate('news-article-not-found-error', 'misc')
                : getTemplate('news-load-article-error', 'misc');
        res.writeHead(err.statusCode === 404 ? 404 : 502, { 'Content-Type': 'text/html' });
        res.end(msg);
    }
};
