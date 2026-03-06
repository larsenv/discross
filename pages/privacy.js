'use strict';
const { strReplace, getPageThemeAttr } = require('./utils.js');
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
  response = strReplace(response, '{$WHITE_THEME_ENABLED}', getPageThemeAttr(req));
  res.end(response);
};
