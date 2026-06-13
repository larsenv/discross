'use strict';
const escape = require('escape-html');

const auth = require('../src/authentication.js');
const {
    renderTemplate,
    render,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
    generateSEOMetadata,
} = require('./utils.js');

const register_template = loadAndRenderPageTemplate('register', 'auth');
const error_template = getTemplate('error', 'login');
const logged_out_template = getTemplate('logged-out', 'index');

exports.processRegister = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
    if (discordID) {
        res.writeHead(302, { Location: '/server/' });
        res.end(
            render('misc/redirect-page', {
                REDIRECT_URL: '/server/',
            })
        );
    } else {
        const parsedurl = new URL(req.url, 'http://localhost');
        const rawErrorText = parsedurl.searchParams.get('errortext');
        const errorHtml = rawErrorText
            ? render('login/error', {
                  ERROR_MESSAGE: escape(rawErrorText).replaceAll(
                      '\n',
                      getTemplate('line-break', 'misc')
                  ),
              })
            : '';
        const pageTitle = 'Register - Discross';
        const response = renderTemplate(register_template, {
            MENU_OPTIONS: logged_out_template,
            ERROR: errorHtml,
            WHITE_THEME_ENABLED: getPageThemeAttr(req),
            PAGE_TITLE: pageTitle,
            SEO_METADATA: generateSEOMetadata(req, {
                title: pageTitle,
                description:
                    'Create a Discross account to start using Discord on retro consoles and legacy devices.',
            }),
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(response);
    }
};
