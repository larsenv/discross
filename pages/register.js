'use strict';
const escape = require('escape-html');

const auth = require('../authentication.js');
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');

const register_template = loadAndRenderPageTemplate('register', 'auth');
const error_template = getTemplate('error', 'login');
const logged_out_template = getTemplate('logged_out', 'index');

exports.processRegister = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
    if (discordID) {
        res.writeHead(302, { Location: '/server/' });
        res.end(
            renderTemplate(getTemplate('redirect_page', 'misc'), {
                REDIRECT_URL: '/server/',
            })
        );
    } else {
        const parsedurl = new URL(req.url, 'http://localhost');
        const rawErrorText = parsedurl.searchParams.get('errortext');
        const errorHtml = rawErrorText
            ? renderTemplate(error_template, {
                  ERROR_MESSAGE: escape(rawErrorText).replaceAll(
                      '\n',
                      getTemplate('line_break', 'misc')
                  ),
              })
            : '';
        const response = renderTemplate(register_template, {
            MENU_OPTIONS: logged_out_template,
            ERROR: errorHtml,
            WHITE_THEME_ENABLED: getPageThemeAttr(req),
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(response);
    }
};
