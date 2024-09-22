var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');

var auth = require('../authentication.js');

const index_template = minifier.htmlMinify(fs.readFileSync('pages/templates/index.html', 'utf-8'));

const logged_in_template = minifier.htmlMinify(fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8'));
const logged_out_template = minifier.htmlMinify(fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8'));

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

exports.processIndex = async function (bot, req, res, args) {
  discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
  if (discordID) {
    response = strReplace(index_template, "{$MENU_OPTIONS}",
      strReplace(logged_in_template, "{$USER}", escape(await auth.getUsername(discordID)))
    );
  } else {
    response = strReplace(index_template, "{$MENU_OPTIONS}", logged_out_template);
  }
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  whiteThemeCookie == 1 ? template = strReplace(template, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"") : template = strReplace(template, "{$WHITE_THEME_ENABLED}", "")
  res.write(response);
  res.end();
}
