const { strReplace } = require('./utils.js');
var fs = require('fs');
var escape = require('escape-html');

var auth = require('../authentication.js');

const index_template = fs.readFileSync('pages/templates/index.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');
const logged_out_template = fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8');


exports.processIndex = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
  let response;
  if (discordID) {
    response = strReplace(index_template, "{$MENU_OPTIONS}",
      strReplace(logged_in_template, "{$USER}", escape(await auth.getUsername(discordID)))
    );
  } else {
    response = strReplace(index_template, "{$MENU_OPTIONS}", logged_out_template);
  }  const parsedurl = new URL(req.url, 'http://localhost');
  const urlTheme = parsedurl.searchParams.get('theme');
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  
  // URL param takes priority over cookie
  const theme = urlTheme !== null ? parseInt(urlTheme) : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie) : 0);

  // Apply theme class based on value: 0=dark (default), 1=light, 2=amoled
  if (theme === 1) {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (theme === 2) {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "bgcolor=\"303338\"");
  }
  res.write(response);
  res.end();
}
