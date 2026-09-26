'use strict';

const escape = require('escape-html');

const auth = require('../src/authentication');
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
    isBotReady,
    isValidSnowflake,
    canViewChannel,
    mentionsToReadableText,
    buildSessionParam,
    parseCookies,
    render,
} = require('./utils');
const { processEmbeds } = require('./embedUtils');
const { normalizeWeirdUnicode } = require('./unicodeUtils');
const { getTimezoneFromIP, formatDateWithTimezone } = require('../src/timezoneUtils');

const search_template = loadAndRenderPageTemplate('search');

const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

const no_results_template = getTemplate('no-results', 'search');
const no_results_banana_template = getTemplate('no-results-banana', 'search');

// DuckDuckGo's HTML-only results page (built for Tor/lite clients, no JS,
// minimal CSS) works well for old browsers with real live results.
// FrogFind used to be listed as an alternative for the same purpose, but it's
// a single-maintainer hobby project that stopped responding entirely, so it's
// been dropped.
const SEARCH_ENGINES = {
    duckduckgo: 'https://html.duckduckgo.com/html/?q=',
    wiby: 'http://wiby.me/?q=',
    google: 'http://www.google.com/search?q=',
};

const VALID_ENGINES = Object.keys(SEARCH_ENGINES);
const DEFAULT_ENGINE = 'duckduckgo';

const MESSAGE_SEARCH_RESULT_LIMIT = 25;
const CONTENT_SNIPPET_LENGTH = 160;

/**
 * Renders the <option> list for the server dropdown.
 *
 * @param {Array<{serverID: string}>} rows - Rows from the servers table for this user.
 * @param {object} bot - The bot instance.
 * @param {string} selectedGuildId - Currently-selected guild ID, if any.
 * @returns {string} HTML <option> tags.
 */
function buildServerOptions(rows, bot, selectedGuildId) {
    return rows
        .map((row) => bot.client.guilds.cache.get(row.serverID))
        .filter(Boolean)
        .map(
            (guild) =>
                `<option value="${escape(guild.id)}"${guild.id === selectedGuildId ? ' selected' : ''}>${escape(normalizeWeirdUnicode(guild.name))}</option>`
        )
        .join('');
}

/**
 * Runs a Discord message search against one guild and renders the results.
 *
 * The search API itself is bot-wide (it returns anything the bot can read in
 * the guild), so results are filtered afterward down to channels the
 * requesting member themself can view — otherwise a user could search their
 * way into reading channels they don't have access to.
 *
 * @param {object} bot - The bot instance.
 * @param {string} guildId - The guild to search.
 * @param {string} query - The message content to search for.
 * @param {string} channelNameFilter - Optional channel name to narrow the search to.
 * @param {string} discordID - The requesting user's Discord ID.
 * @param {string} clientTimezone - The requesting user's timezone.
 * @param {string} sessionParam - Combined session/theme/etc query string to carry through result links.
 * @param {object} req - The incoming request, needed to render embeds (theme cookie).
 * @param {number} imagesCookie - Cookie value indicating if images should be displayed.
 * @returns {Promise<string>} Rendered HTML for the results (or an error/empty state).
 */
async function renderMessageSearchResults(
    bot,
    guildId,
    query,
    channelNameFilter,
    discordID,
    clientTimezone,
    sessionParam,
    req,
    imagesCookie
) {
    const guild = bot.client.guilds.cache.get(guildId);
    if (!guild) return `<p>That server isn't available.</p>`;

    const member = await guild.members.fetch(discordID).catch(() => null);
    if (!member) return `<p>You're not a member of that server.</p>`;

    const botMember =
        guild.members.cache.get(bot.client.user.id) ||
        (await guild.members.fetch(bot.client.user.id).catch(() => null));
    if (!botMember) return `<p>Discross isn't in that server anymore.</p>`;

    let channelIds;
    if (channelNameFilter.trim()) {
        const rawFilter = channelNameFilter.trim();
        const needle = rawFilter.toLowerCase().replace(/^#/, '');
        const matches = guild.channels.cache.filter(
            (c) =>
                c.isTextBased?.() &&
                !c.isThread() &&
                (c.id === rawFilter || c.name?.toLowerCase() === needle)
        );
        if (matches.size === 0) {
            return `<p>No channel named "${escape(channelNameFilter.trim())}" in this server.</p>`;
        }
        const viewable = [];
        for (const c of matches.values()) {
            if (await canViewChannel(member, botMember, c, discordID)) viewable.push(c.id);
        }
        if (viewable.length === 0) {
            return `<p>You don't have access to #${escape(needle)}.</p>`;
        }
        channelIds = viewable;
    }

    let data;
    try {
        data = await bot.searchGuildMessages(guildId, {
            content: query,
            channelIds,
            limit: MESSAGE_SEARCH_RESULT_LIMIT,
        });
    } catch (err) {
        console.error('Discord message search failed:', err);
        return `<p>Search failed — Discord's search API may not be available for this server yet.</p>`;
    }

    if (!data || !Array.isArray(data.messages)) {
        return `<p>This server's messages are still being indexed by Discord — try again in a moment.</p>`;
    }

    // The response is a nested array (historically for surrounding context,
    // no longer populated) — each result's own message is the first entry.
    const rawResults = data.messages.map((group) => group?.[0]).filter(Boolean);

    const channelCache = new Map();
    const visibleResults = [];
    for (const msg of rawResults) {
        let channel = channelCache.get(msg.channel_id);
        if (channel === undefined) {
            channel =
                guild.channels.cache.get(msg.channel_id) ||
                (await bot.client.channels.fetch(msg.channel_id).catch(() => null));
            channelCache.set(msg.channel_id, channel);
        }
        if (channel && (await canViewChannel(member, botMember, channel, discordID))) {
            visibleResults.push({ msg, channel });
        }
    }

    if (visibleResults.length === 0) {
        return Math.random() < 0.1 ? no_results_banana_template : no_results_template;
    }

    const rows = visibleResults
        .map(({ msg, channel }) => {
            const authorName = msg.author
                ? normalizeWeirdUnicode(msg.author.global_name || msg.author.username || 'Unknown')
                : 'Unknown';

            let content = mentionsToReadableText(msg.content || '', guild);
            content = normalizeWeirdUnicode(content);
            if (content.length > CONTENT_SNIPPET_LENGTH) {
                content = content.slice(0, CONTENT_SNIPPET_LENGTH).trimEnd() + '...';
            }
            if (!content && msg.attachments?.length) content = '[attachment]';

            const embedsHtml = msg.embeds?.length
                ? processEmbeds(req, msg.embeds, imagesCookie, 1, clientTimezone)
                : '';

            const timestamp = msg.timestamp
                ? formatDateWithTimezone(new Date(msg.timestamp), clientTimezone)
                : '';

            const jumpUrl = `/channels/${channel.id}?around=${msg.id}${
                sessionParam ? '&' + sessionParam.replace(/^\?/, '') : ''
            }#msg-${msg.id}`;

            return render('search/message-result', {
                JUMP_URL: jumpUrl,
                AUTHOR: escape(authorName),
                CHANNEL_NAME: escape(normalizeWeirdUnicode(channel.name || 'channel')),
                TIMESTAMP: escape(timestamp),
                CONTENT: escape(content),
                EMBEDS: embedsHtml,
            });
        })
        .join('');

    const totalNote =
        typeof data.total_results === 'number' && data.total_results > visibleResults.length
            ? `<p style="font-size: 13px; color: #72767d;">Showing ${visibleResults.length} of ${data.total_results} matches.</p>`
            : '';

    return rows + totalNote;
}

exports.processSearch = async function processSearch(bot, req, res) {
    // These pages are public — read the session if there is one (so the header
    // can greet the user) but never send a logged-out visitor to the login page.
    const discordID = await auth.checkAuth(req, res, true);

    const parsedUrl = new URL(req.url, 'http://localhost');
    const query = parsedUrl.searchParams.get('q') || '';
    const engine = parsedUrl.searchParams.get('engine') || DEFAULT_ENGINE;
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const safeEngine = VALID_ENGINES.includes(engine) ? engine : DEFAULT_ENGINE;

    // If a web search query is provided, redirect to the chosen search engine
    if (query.trim()) {
        const searchUrl = SEARCH_ENGINES[safeEngine] + encodeURIComponent(query.trim());
        res.writeHead(302, { Location: searchUrl });
        res.end();
        return;
    }

    const dq = parsedUrl.searchParams.get('dq') || '';
    const dguild = parsedUrl.searchParams.get('dguild') || '';
    const dchannel = parsedUrl.searchParams.get('dchannel') || '';

    const themeClass = getPageThemeAttr(req);

    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;

    let serverOptions = '';
    let discordSearchDisabled = false;
    let discordResultsHtml = '';

    if (!discordID) {
        discordSearchDisabled = true;
        discordResultsHtml = `<p>Log in to search your Discord messages.</p>`;
    } else if (!isBotReady(bot)) {
        discordSearchDisabled = true;
        discordResultsHtml = `<p>Discross isn't connected to Discord right now.</p>`;
    } else {
        const serverRows = auth.queryAll('SELECT * FROM servers WHERE discordID=?', [discordID]);
        serverOptions = buildServerOptions(serverRows, bot, dguild);

        if (serverRows.length === 0) {
            discordSearchDisabled = true;
            discordResultsHtml = `<p>You don't have any servers set up yet.</p>`;
        } else if (dq.trim()) {
            const belongsToServer = serverRows.some((r) => r.serverID === dguild);
            if (!isValidSnowflake(dguild) || !belongsToServer) {
                discordResultsHtml = `<p>Pick one of your servers to search.</p>`;
            } else {
                const clientTimezone = getTimezoneFromIP(req);
                const sessionParam = buildSessionParam(
                    urlSessionID,
                    null,
                    undefined,
                    null,
                    undefined
                );
                const { images: cookieImages } = parseCookies(req);
                const imagesCookie = cookieImages !== undefined ? parseInt(cookieImages, 10) : 1;
                discordResultsHtml = await renderMessageSearchResults(
                    bot,
                    dguild,
                    dq.trim(),
                    dchannel,
                    discordID,
                    clientTimezone,
                    sessionParam,
                    req,
                    imagesCookie
                );
            }
        }
    }

    const pageTitle = 'Search - Discross';
    const seoDescription =
        'Search the web or your Discord messages on Discross, the universal Discord client.';

    const response = renderTemplate(search_template, {
        WHITE_THEME_ENABLED: themeClass,
        MENU_OPTIONS: menuOptions,
        QUERY_VALUE: escape(query),
        DUCKDUCKGO_CHECKED: safeEngine === 'duckduckgo' ? 'checked' : '',
        WIBY_CHECKED: safeEngine === 'wiby' ? 'checked' : '',
        GOOGLE_CHECKED: safeEngine === 'google' ? 'checked' : '',
        SESSION_ID: escape(urlSessionID),
        DISCORD_QUERY_VALUE: escape(dq),
        DISCORD_CHANNEL_VALUE: escape(dchannel),
        SERVER_OPTIONS: serverOptions,
        DISCORD_SEARCH_DISABLED: discordSearchDisabled ? 'disabled' : '',
        DISCORD_RESULTS: discordResultsHtml,
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: seoDescription,
        }),
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
