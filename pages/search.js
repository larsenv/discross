'use strict';

const fs = require('fs');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { renderTemplate, getPageThemeAttr, loadAndRenderPageTemplate } = require('./utils.js');

const search_template = loadAndRenderPageTemplate('search');

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

const SEARCH_ENGINES = {
  frogfind: 'http://frogfind.com/?q=',
  wiby: 'http://wiby.me/?q=',
  google: 'http://www.google.com/search?q=',
};

const VALID_ENGINES = Object.keys(SEARCH_ENGINES);

exports.processSearch = async function processSearch(req, res) {
  const discordID = await auth.checkAuth(req, res);
  if (!discordID) return;

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

  const menuOptions = renderTemplate(
    logged_in_template,
    {USER: escape(await auth.getUsername(discordID))}
  );
  const response = renderTemplate(search_template, {
    WHITE_THEME_ENABLED: themeClass,
    MENU_OPTIONS: menuOptions,
    QUERY_VALUE: escape(query),
    FROGFIND_CHECKED: safeEngine === 'frogfind' ? 'checked' : '',
    WIBY_CHECKED: safeEngine === 'wiby' ? 'checked' : '',
    GOOGLE_CHECKED: safeEngine === 'google' ? 'checked' : '',
    SESSION_ID: escape(urlSessionID),
  });

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
