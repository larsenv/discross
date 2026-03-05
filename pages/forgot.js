const fs = require('fs');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { strReplace } = require('./utils.js');

const forgot_template = fs.readFileSync('pages/templates/forgot.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_out_template = fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8');

exports.processForgot = async function (bot, req, res, args) {
  const parsedurl = new URL(req.url, 'http://localhost');
  let response = forgot_template;
  response = strReplace(response, "{$MENU_OPTIONS}", logged_out_template);
  if (parsedurl.searchParams.get('errortext')) {
    response = strReplace(response, "{$ERROR}", strReplace(error_template, "{$ERROR_MESSAGE}", strReplace(escape(parsedurl.searchParams.get('errortext')), "\n", "<br>")));
  } else {
    response = strReplace(response, "{$ERROR}", "");
  }
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
