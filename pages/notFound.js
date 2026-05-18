'use strict';

const { renderTemplate, getPageThemeAttr, loadAndRenderPageTemplate, generateSEOMetadata } = require('./utils.js');

const template404 = loadAndRenderPageTemplate('404');

exports.serve404 = function (req, res, message, backUrl, backLabel) {
    const pageTitle = 'Not Found - Discross';
    const html = renderTemplate(template404, {
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        MESSAGE: message || 'Page not found.',
        BACK_URL: backUrl || '/',
        BACK_LABEL: backLabel || 'Back to Home',
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: 'The page you are looking for does not exist on Discross.',
        }),
    });
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end(html);
};
