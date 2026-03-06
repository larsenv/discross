'use strict';
const { parseCookies } = require('./utils.js');
exports.toggleTheme = async function toggleTheme(req, res) {
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlTheme = parsedUrl.searchParams.get('theme');
    const { whiteThemeCookie } = parseCookies(req);

    // URL param takes priority over cookie for determining current theme
    // Validate URL param is a valid theme value (0, 1, or 2)
    const rawTheme = urlTheme !== null ? parseInt(urlTheme, 10) : null;
    const parsedUrlTheme =
      rawTheme !== null && !isNaN(rawTheme) && rawTheme >= 0 && rawTheme <= 2 ? rawTheme : null;
    const currentTheme =
      parsedUrlTheme !== null
        ? parsedUrlTheme
        : whiteThemeCookie !== undefined
          ? parseInt(whiteThemeCookie, 10)
          : 0;

    // Cycle through themes: 0 (dark) -> 1 (light) -> 2 (amoled) -> 0 (dark)
    const NEXT_THEME = [1, 2, 0];
    const nextTheme = NEXT_THEME[currentTheme] ?? 0;

    const referer = req.headers.referer || '/server/';
    const refererUrl = new URL(referer, 'http://dummy.local');
    refererUrl.searchParams.set('theme', nextTheme);
    const location = refererUrl.pathname + refererUrl.search;

    res.writeHead(302, {
      'Set-Cookie': [`whiteThemeCookie=${nextTheme}; path=/`],
      'Content-Type': 'text/html',
      Location: location,
    });
    res.end();
  } catch (error) {
    res.writeHead(302, { Location: '/server/' });
    res.end();
  }
};
