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

const index_template = loadAndRenderPageTemplate('index');

const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

exports.processIndex = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;
    const pageTitle = 'Discross - Use Discord Anywhere';
    const response = renderTemplate(index_template, {
        MENU_OPTIONS: menuOptions,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: 'Discross is a universal Discord client designed to work on any device with a basic HTML web browser. Access Discord on retro consoles, old computers, and modern devices.',
        }),
    });
    res.end(response);
};
