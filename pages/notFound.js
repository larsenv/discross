'use strict';

const fs = require('fs');
const { renderTemplate, getPageThemeAttr, loadAndRenderPageTemplate } = require('./utils.js');

const template404 = loadAndRenderPageTemplate('404');

exports.serve404 = function (req, res, message, backUrl, backLabel) {
  const html = renderTemplate(template404, {
    WHITE_THEME_ENABLED: getPageThemeAttr(req),
    MESSAGE: message || 'Page not found.',
    BACK_URL: backUrl || '/',
    BACK_LABEL: backLabel || 'Back to Home',
  });  res.writeHead(404, { 'Content-Type': 'text/html' });
  return res.end(html);
};
