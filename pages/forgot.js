'use strict';
const fs = require('fs');
const escape = require('escape-html');

const auth = require('../authentication.js');
const { strReplace, getPageThemeAttr } = require('./utils.js');

const forgot_template = fs
  .readFileSync('pages/templates/forgot.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_out_template = fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8');

exports.processForgot = function (bot, req, res, args) {
  const parsedurl = new URL(req.url, 'http://localhost');
  let response = forgot_template;
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
  res.end(response);
};
