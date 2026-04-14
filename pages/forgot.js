'use strict';
const fs = require('fs');
const escape = require('escape-html');
const auth = require('../authentication.js');
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');

const forgot_template = loadAndRenderPageTemplate('forgot', 'auth');
const error_template = getTemplate('error', 'login');
const logged_out_template = getTemplate('logged_out', 'index');

exports.processForgot = function (bot, req, res, args) {
    const parsedurl = new URL(req.url, 'http://localhost');
    const rawError = parsedurl.searchParams.get('errortext');
    const errorHtml = rawError
        ? renderTemplate(error_template, {
              ERROR_MESSAGE: escape(rawError).replaceAll('\n', getTemplate('line_break', 'misc')),
          })
        : '';
    const response = renderTemplate(forgot_template, {
        MENU_OPTIONS: logged_out_template,
        ERROR: errorHtml,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
    });
    res.end(response);
};
