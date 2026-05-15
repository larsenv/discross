'use strict';
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
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
    const response = renderTemplate(privacy_template, {
        MENU_OPTIONS: menuOptions,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
    });
    res.end(response);
};
