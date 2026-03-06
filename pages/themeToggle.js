'use strict';
exports.toggleTheme = async function toggleTheme(req, res) {
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlTheme = parsedUrl.searchParams.get('theme');
    const whiteThemeCookie = req.headers.cookie
      ?.split('; ')
      ?.find((cookie) => cookie.startsWith('whiteThemeCookie='))
      ?.split('=')[1];

    // URL param takes priority over cookie for determining current theme
    // Validate URL param is a valid theme value (0, 1, or 2)
    let parsedUrlTheme = urlTheme !== null ? parseInt(urlTheme) : null;
    if (
      parsedUrlTheme !== null &&
      (isNaN(parsedUrlTheme) || parsedUrlTheme < 0 || parsedUrlTheme > 2)
    ) {
      parsedUrlTheme = null;
    }
    const currentTheme =
      parsedUrlTheme !== null
        ? parsedUrlTheme
        : whiteThemeCookie !== undefined
          ? parseInt(whiteThemeCookie)
          : 0;

    // Cycle through themes: 0 (dark) -> 1 (light) -> 2 (amoled) -> 0 (dark)
    let nextTheme = 0;
    if (currentTheme === 0) {
      nextTheme = 1; // dark -> light
    } else if (currentTheme === 1) {
      nextTheme = 2; // light -> amoled
    } else if (currentTheme === 2) {
      nextTheme = 0; // amoled -> dark
    }

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
