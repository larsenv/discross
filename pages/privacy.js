'use strict';
const { strReplace } = require('./utils.js');
const fs = require('fs');
const escape = require('escape-html');
const auth = require('../authentication.js');

const privacy_template = fs
  .readFileSync('pages/templates/privacy.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));

const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');
const logged_out_template = fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8');

exports.processPrivacy = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, true);
  let response = privacy_template;
  if (discordID) {
    response = strReplace(
      response,
      '{$MENU_OPTIONS}',
      strReplace(logged_in_template, '{$USER}', escape(await auth.getUsername(discordID)))
    );
  } else {
    response = strReplace(response, '{$MENU_OPTIONS}', logged_out_template);
  }
  const parsedurl = new URL(req.url, 'http://localhost');
  const urlTheme = parsedurl.searchParams.get('theme');
  const whiteThemeCookie = req.headers.cookie
    ?.split('; ')
    ?.find((cookie) => cookie.startsWith('whiteThemeCookie='))
    ?.split('=')[1];

  const theme =
    urlTheme !== null
      ? parseInt(urlTheme, 10)
      : whiteThemeCookie !== undefined
        ? parseInt(whiteThemeCookie, 10)
        : 0;

  if (theme === 1) {
    response = strReplace(response, '{$WHITE_THEME_ENABLED}', 'class="light-theme"');
  } else if (theme === 2) {
    response = strReplace(response, '{$WHITE_THEME_ENABLED}', 'class="amoled-theme"');
  } else {
    response = strReplace(response, '{$WHITE_THEME_ENABLED}', 'bgcolor="303338"');
  }
  res.end(response);
};
