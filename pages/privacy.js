'use strict';
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
} = require('./utils.js');
const escape = require('escape-html');
const auth = require('../src/authentication.js');

const privacy_template = loadAndRenderPageTemplate('privacy');

const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

exports.processPrivacy = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, true);
    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;
    const pageTitle = 'Privacy Policy - Discross';
    const response = renderTemplate(privacy_template, {
        MENU_OPTIONS: menuOptions,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: 'Learn how Discross handles your data and protects your privacy.',
        }),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
