'use strict';
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');
const escape = require('escape-html');
const auth = require('../src/authentication.js');

const changepassword_template = loadAndRenderPageTemplate('change-password', 'auth');
const error_template = getTemplate('error', 'login');
const logged_in_template = getTemplate('logged-in', 'index');

exports.processChangePassword = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, false);
    if (!discordID) return; // checkAuth already redirected

    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

    const username = await auth.getUsername(discordID);

    // Send 6-digit action code via Discord DM (only on fresh page load, not on error/success/codesent redirects)
    const dmErrorText =
        !parsedUrl.searchParams.get('errortext') &&
        !parsedUrl.searchParams.get('success') &&
        !parsedUrl.searchParams.get('codesent')
            ? await (async () => {
                  const code = auth.createActionCode(discordID, 'changepassword');
                  const dmResult = await bot.sendDM(
                      discordID,
                      'Your Discross verification code to change your password: **' +
                          code +
                          '**\nThis code expires in 10 minutes.'
                  );
                  return dmResult.success
                      ? ''
                      : 'Could not send a verification code to your Discord DMs. Make sure you allow DMs from server members, then try again.';
              })()
            : '';

    const sendCodeUrl =
        '/sendactioncode?action=changepassword' +
        (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

    const errortext = parsedUrl.searchParams.get('errortext');
    const buildErrorMsg = (text) =>
        renderTemplate(error_template, {
            ERROR_MESSAGE: escape(text).replaceAll('\n', getTemplate('line-break', 'misc')),
        });
    const errorHtml = dmErrorText
        ? buildErrorMsg(dmErrorText)
        : errortext
          ? buildErrorMsg(errortext)
          : parsedUrl.searchParams.get('codesent')
            ? getTemplate('verification-sent', 'partials')
            : parsedUrl.searchParams.get('success')
              ? getTemplate('password-changed', 'misc')
              : '';

    const response = renderTemplate(changepassword_template, {
        MENU_OPTIONS: renderTemplate(logged_in_template, { USER: escape(username || '') }),
        SESSION_PARAM: sessionParam,
        SEND_CODE_URL: sendCodeUrl,
        ERROR: errorHtml,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};

exports.handleChangePassword = async function (bot, req, res, body, discordID) {
    const params = Object.fromEntries(new URLSearchParams(body));

    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

    if (!params.current_password || !params.new_password || !params.confirm_password) {
        res.writeHead(302, {
            Location:
                '/change-password.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent('Please fill in all fields.'),
        });
        res.end();
        return;
    }

    if (params.new_password !== params.confirm_password) {
        res.writeHead(302, {
            Location:
                '/change-password.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent("New password confirmation doesn't match."),
        });
        res.end();
        return;
    }

    if (!auth.verifyAndConsumeActionCode(discordID, 'changepassword', params.discord_code)) {
        res.writeHead(302, {
            Location:
                '/change-password.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent('Invalid or expired Discord verification code.'),
        });
        res.end();
        return;
    }

    const result = await auth.changePassword(
        discordID,
        params.current_password,
        params.new_password
    );

    if (result.status === 'success') {
        // Sessions are cleared by changePassword (all DB sessions deleted); redirect to login
        res.writeHead(302, {
            Location:
                '/login.html?errortext=' +
                encodeURIComponent('Password changed. Please log in with your new password.'),
        });
        res.end();
    } else {
        res.writeHead(302, {
            Location:
                '/change-password.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent(result.reason),
        });
        res.end();
    }
};
