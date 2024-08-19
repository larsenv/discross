var url = require('url');
var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');

var auth = require('../authentication.js');

const forgot_template = minifier.htmlMinify(fs.readFileSync('pages/templates/forgot.html', 'utf-8'));
const error_template = minifier.htmlMinify(fs.readFileSync('pages/templates/login/error.html', 'utf-8'));

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
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='));
  const whiteThemeCookieValue = whiteThemeCookie?.split('=')[1]
  whiteThemeCookieValue == 1 ? template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"") : template = strReplace(template, "{$WHITE_THEME_ENABLED}", "")
  res.write(response);
  res.end();
}