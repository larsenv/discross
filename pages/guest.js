/*var url = require('url');
var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');

var auth = require('../authentication.js');

const guest_login_template = minifier.htmlMinify(fs.readFileSync('pages/templates/guest.html', 'utf-8'));
const error_template = minifier.htmlMinify(fs.readFileSync('pages/templates/login/error.html', 'utf-8'));

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

exports.processGuestLogin = async function (bot, req, res, args) {
  discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
  if (discordID) {
    // res.writeHead(200, {'Content-Type': 'text/html'});
    res.writeHead(303, { "Location": "/server/", "Content-Type": "text/html" });
    res.write('Logged in! Click <a href="/server/">here</a> to continue.');
  } else {
    parsedurl = url.parse(req.url, true);
    response = guest_login_template;
    if (parsedurl.query.redirect) {
      response = strReplace(response, "{$REDIRECT_URL}", strReplace(parsedurl.query.redirect, '"', "%22"));
    } else {
      response = strReplace(response, "{$REDIRECT_URL}", "/server/");
    }
    if (parsedurl.query.errortext) {
      response = strReplace(response, "{$ERROR}", strReplace(error_template, "{$ERROR_MESSAGE}", strReplace(escape(parsedurl.query.errortext), "\n", "<br>")));
    } else {
      response = strReplace(response, "{$ERROR}", "");
    }
    res.write(response);
  }
  res.end();
}*/