'use strict';

const fs = require('fs');
const { strReplace, getPageThemeAttr } = require('./utils.js');

const commonHead = fs.readFileSync('pages/templates/partials/head.html', 'utf-8');
const template404 = fs
  .readFileSync('pages/templates/404.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(commonHead);

exports.serve404 = function (req, res, message, backUrl, backLabel) {
  let html = strReplace(template404, '{$WHITE_THEME_ENABLED}', getPageThemeAttr(req));
  html = strReplace(html, '{$MESSAGE}', message || 'Page not found.');
  html = strReplace(html, '{$BACK_URL}', backUrl || '/');
  html = strReplace(html, '{$BACK_LABEL}', backLabel || 'Back to Home');
  res.writeHead(404, { 'Content-Type': 'text/html' });
  return res.end(html);
};
