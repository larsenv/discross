'use strict';
const fs = require('fs');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { strReplace, getPageThemeAttr } = require('./utils.js');

const register_template = fs
  .readFileSync('pages/templates/register.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_out_template = fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8');

exports.processRegister = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
  if (discordID) {
    res.writeHead(302, { Location: '/server/' });
    res.end('Logged in! Click <a href="/server/">here</a> to continue.');
  } else {
    const parsedurl = new URL(req.url, 'http://localhost');
    let response = register_template;
    response = strReplace(response, '{$MENU_OPTIONS}', logged_out_template);
    if (parsedurl.searchParams.get('errortext')) {
      response = strReplace(
        response,
        '{$ERROR}',
        strReplace(
          error_template,
          '{$ERROR_MESSAGE}',
          strReplace(escape(parsedurl.searchParams.get('errortext')), '\n', '<br>')
        )
      );
    } else {
      response = strReplace(response, '{$ERROR}', '');
    }
    response = strReplace(response, '{$WHITE_THEME_ENABLED}', getPageThemeAttr(req));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
  }
};
