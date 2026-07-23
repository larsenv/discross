'use strict';

const escape = require('escape-html');

const auth = require('../src/authentication');
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
} = require('./utils');

const search_template = loadAndRenderPageTemplate('search');

const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

const SEARCH_ENGINES = {
    frogfind: 'http://frogfind.com/?q=',
    wiby: 'http://wiby.me/?q=',
    google: 'http://www.google.com/search?q=',
};

const VALID_ENGINES = Object.keys(SEARCH_ENGINES);

exports.processSearch = async function processSearch(req, res) {
    // These pages are public — read the session if there is one (so the header
    // can greet the user) but never send a logged-out visitor to the login page.
    const discordID = await auth.checkAuth(req, res, true);

    const parsedUrl = new URL(req.url, 'http://localhost');
    const query = parsedUrl.searchParams.get('q') || '';
    const engine = parsedUrl.searchParams.get('engine') || 'frogfind';
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const safeEngine = VALID_ENGINES.includes(engine) ? engine : 'frogfind';

    // If a query is provided, redirect to the chosen search engine
    if (query.trim()) {
        const searchUrl = SEARCH_ENGINES[safeEngine] + encodeURIComponent(query.trim());
        res.writeHead(302, { Location: searchUrl });
        res.end();
        return;
    }

    const themeClass = getPageThemeAttr(req);

    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;

    const pageTitle = 'Search - Discross';
    const seoDescription =
        'Search the web using FrogFind, Wiby, or Google on Discross, the universal Discord client.';

    const response = renderTemplate(search_template, {
        WHITE_THEME_ENABLED: themeClass,
        MENU_OPTIONS: menuOptions,
        QUERY_VALUE: escape(query),
        FROGFIND_CHECKED: safeEngine === 'frogfind' ? 'checked' : '',
        WIBY_CHECKED: safeEngine === 'wiby' ? 'checked' : '',
        GOOGLE_CHECKED: safeEngine === 'google' ? 'checked' : '',
        SESSION_ID: escape(urlSessionID),
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: seoDescription,
        }),
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
