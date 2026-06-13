'use strict';
const escape = require('escape-html');
const auth = require('../src/authentication.js');
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
} = require('./utils.js');

const forgot_template = loadAndRenderPageTemplate('forgot', 'auth');
const error_template = getTemplate('error', 'login');
const logged_out_template = getTemplate('logged-out', 'index');

exports.processForgot = function (bot, req, res, args) {
    const parsedurl = new URL(req.url, 'http://localhost');
    const rawError = parsedurl.searchParams.get('errortext');
    const errorHtml = rawError
        ? renderTemplate(error_template, {
              ERROR_MESSAGE: escape(rawError).replaceAll('\n', getTemplate('line-break', 'misc')),
          })
        : '';
    const pageTitle = 'Forgot Password - Discross';
    const response = renderTemplate(forgot_template, {
        MENU_OPTIONS: logged_out_template,
        ERROR: errorHtml,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: 'Recover your Discross account password.',
        }),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
