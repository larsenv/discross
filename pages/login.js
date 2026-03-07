'use strict';
const fs = require('fs');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { strReplace, getPageThemeAttr } = require('./utils.js');

const login_template = fs
  .readFileSync('pages/templates/login.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_out_template = fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8');

exports.processLogin = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
  if (discordID) {
    res.writeHead(301, { Location: '/server/', 'Content-Type': 'text/html' });
    res.end('Logged in! Click <a href="/server/">here</a> to continue.');
  } else {
    const parsedurl = new URL(req.url, 'http://localhost');
    const rawRedirect = parsedurl.searchParams.get('redirect');
    const redirectUrl = rawRedirect ? strReplace(rawRedirect, '"', '%22') : '/server/';
    const rawErrorText = parsedurl.searchParams.get('errortext');
    const errorHtml = rawErrorText
      ? strReplace(
          error_template,
          '{$ERROR_MESSAGE}',
          strReplace(escape(rawErrorText), '\n', '<br>')
        )
      : '';
    const withMenuOptions = strReplace(login_template, '{$MENU_OPTIONS}', logged_out_template);
    const withRedirect = strReplace(withMenuOptions, '{$REDIRECT_URL}', redirectUrl);
    const withError = strReplace(withRedirect, '{$ERROR}', errorHtml);
    const response = strReplace(withError, '{$WHITE_THEME_ENABLED}', getPageThemeAttr(req));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
  }
};
