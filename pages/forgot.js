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
  const rawError = parsedurl.searchParams.get('errortext');
  const errorHtml = rawError
    ? strReplace(error_template, '{$ERROR_MESSAGE}', strReplace(escape(rawError), '\n', '<br>'))
    : '';
  const response = strReplace(
    strReplace(
      strReplace(forgot_template, '{$MENU_OPTIONS}', logged_out_template),
      '{$ERROR}',
      errorHtml
    ),
    '{$WHITE_THEME_ENABLED}',
    getPageThemeAttr(req)
  );
  res.end(response);
};
