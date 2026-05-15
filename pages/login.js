'use strict';
const escape = require('escape-html');

const auth = require('../src/authentication.js');
const {
    renderTemplate,
    render,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');

const login_template = loadAndRenderPageTemplate('login', 'auth');
const error_template = getTemplate('error', 'login');
const logged_out_template = getTemplate('logged-out', 'index');

exports.processLogin = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
    if (discordID) {
        res.writeHead(301, { Location: '/server/', 'Content-Type': 'text/html' });
        res.end(
            render('misc/redirect-page', {
                REDIRECT_URL: '/server/',
            })
        );
    } else {
        const parsedurl = new URL(req.url, 'http://localhost');
        const rawRedirect = parsedurl.searchParams.get('redirect');
        const redirectUrl = rawRedirect ? rawRedirect.replaceAll('"', '%22') : '/server/';
        const rawErrorText = parsedurl.searchParams.get('errortext');
        const errorHtml = rawErrorText
            ? render('login/error', {
                  ERROR_MESSAGE: escape(rawErrorText).replaceAll(
                      '\n',
                      getTemplate('line-break', 'misc')
                  ),
              })
            : '';
        const response = renderTemplate(login_template, {
            MENU_OPTIONS: logged_out_template,
            REDIRECT_URL: redirectUrl,
            ERROR: errorHtml,
            WHITE_THEME_ENABLED: getPageThemeAttr(req),
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(response);
    }
};
