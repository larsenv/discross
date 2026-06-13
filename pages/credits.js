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

const credits_template = loadAndRenderPageTemplate('credits');

const logged_in_template = getTemplate('logged-in', 'index');
const logged_out_template = getTemplate('logged-out', 'index');

exports.processCredits = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
    const menuOptions = discordID
        ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
        : logged_out_template;
    const pageTitle = 'Credits & Dependencies - Discross';
    const response = renderTemplate(credits_template, {
        MENU_OPTIONS: menuOptions,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
        PAGE_TITLE: pageTitle,
        SEO_METADATA: generateSEOMetadata(req, {
            title: pageTitle,
            description: 'Credits and open-source dependencies used in Discross.',
        }),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};
