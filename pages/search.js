'use strict';

const fs = require('fs');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { strReplace, THEME_CONFIG } = require('./utils.js');

const search_template = fs
  .readFileSync('pages/templates/search.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

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
  const urlTheme = parsedUrl.searchParams.get('theme');
  const whiteThemeCookie = req.headers.cookie
    ?.split('; ')
    ?.find((c) => c.startsWith('whiteThemeCookie='))
    ?.split('=')[1];
  const themeValue =
    urlTheme !== null
      ? parseInt(urlTheme, 10)
      : whiteThemeCookie !== undefined
        ? parseInt(whiteThemeCookie, 10)
        : 0;

  // If a query is provided, redirect to the chosen search engine
  if (query.trim()) {
    const safeEngine = VALID_ENGINES.includes(engine) ? engine : 'frogfind';
    const searchUrl = SEARCH_ENGINES[safeEngine] + encodeURIComponent(query.trim());
    res.writeHead(302, { Location: searchUrl });
    res.end();
    return;
  }

  const themeClass = THEME_CONFIG[themeValue]?.themeClass ?? '';

  const safeEngine = VALID_ENGINES.includes(engine) ? engine : 'frogfind';

  let response = strReplace(search_template, '{$WHITE_THEME_ENABLED}', themeClass);
  response = strReplace(
    response,
    '{$MENU_OPTIONS}',
    strReplace(logged_in_template, '{$USER}', escape(await auth.getUsername(discordID)))
  );
  response = strReplace(response, '{$QUERY_VALUE}', escape(query));
  response = strReplace(
    response,
    '{$FROGFIND_CHECKED}',
    safeEngine === 'frogfind' ? 'checked' : ''
  );
  response = strReplace(response, '{$WIBY_CHECKED}', safeEngine === 'wiby' ? 'checked' : '');
  response = strReplace(response, '{$GOOGLE_CHECKED}', safeEngine === 'google' ? 'checked' : '');
  response = strReplace(response, '{$SESSION_ID}', escape(urlSessionID));

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(response);
};
