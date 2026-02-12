var url = require('url');
var fs = require('fs');
var escape = require('escape-html');

var auth = require('../authentication.js');

const forgot_template = fs.readFileSync('pages/templates/forgot.html', 'utf-8');
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

exports.processForgot = async function (bot, req, res, args) {
  parsedurl = url.parse(req.url, true);
  response = forgot_template;
  if (parsedurl.query.errortext) {
    response = strReplace(response, "{$ERROR}", strReplace(error_template, "{$ERROR_MESSAGE}", strReplace(escape(parsedurl.query.errortext), "\n", "<br>")));
  } else {
    response = strReplace(response, "{$ERROR}", "");
  }
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  
  // Apply theme class based on cookie value: 0=dark (default), 1=light, 2=amoled
  if (whiteThemeCookie == 1) {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (whiteThemeCookie == 2) {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "bgcolor=\"303338\"");
  }
  res.write(response);
  res.end();
}
