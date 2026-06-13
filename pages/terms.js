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

const terms_template = loadAndRenderPageTemplate('terms');

const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

exports.processTerms = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, true);
    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;
    const pageTitle = 'Terms of Service - Discross';
    const response = renderTemplate(terms_template, {
        MENU_OPTIONS: menuOptions,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: 'Read the terms of service for using Discross.',
        }),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
