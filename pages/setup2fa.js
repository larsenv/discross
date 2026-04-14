'use strict';
const {
    renderTemplate,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils.js');
const fs = require('fs');
const escape = require('escape-html');
const auth = require('../authentication.js');

const setup2fa_template = loadAndRenderPageTemplate('setup2fa', 'auth');
const disable2fa_template = loadAndRenderPageTemplate('disable2fa', 'auth');
const backup_codes_template = loadAndRenderPageTemplate('backup_codes', 'auth');
const error_template = getTemplate('error', 'login');
const logged_in_template = getTemplate('logged_in', 'index');

function injectMenuAndError(response, username, parsedUrl, sessionParam) {
    const menuOptions = renderTemplate(logged_in_template, { USER: escape(username || '') });
    const errorText = parsedUrl.searchParams.get('errortext');
    const errorHtml = errorText
        ? renderTemplate(error_template, {
              ERROR_MESSAGE: escape(errorText).replaceAll('\n', '<br>'),
          })
        : '';

    return renderTemplate(response, {
        MENU_OPTIONS: menuOptions,
        SESSION_PARAM: sessionParam,
        ERROR: errorHtml,
    });
}

exports.processSetup2FA = async function (bot, req, res, args) {
    const discordID = await auth.checkAuth(req, res, false);
    if (!discordID) return; // checkAuth already redirected

    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

    const username = await auth.getUsername(discordID);
    const totpEnabled = auth.getTOTPStatus(discordID);

    const action = totpEnabled ? 'disable2fa' : 'setup2fa';

    // Send 6-digit action code via Discord DM on fresh page load (not on error/codesent redirects)
    const dmErrorText = await (async () => {
        if (parsedUrl.searchParams.get('errortext') || parsedUrl.searchParams.get('codesent')) {
            return '';
        }
        const code = auth.createActionCode(discordID, action);
        const dmResult = await bot.sendDM(
            discordID,
            'Your Discross verification code to ' +
                (totpEnabled ? 'disable' : 'set up') +
                ' two-factor authentication: **' +
                code +
                '**\nThis code expires in 10 minutes.'
        );
        return dmResult.success
            ? ''
            : 'Could not send a verification code to your Discord DMs. Make sure you allow DMs from server members, then try again.';
    })();

    const sendCodeUrl =
        '/sendactioncode?action=' +
        action +
        (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

    const baseTemplate = await (async () => {
        if (totpEnabled) {
            // 2FA already enabled — show the disable page
            return disable2fa_template;
        }
        // 2FA not yet enabled — show setup page with QR code
        const { secret, qrDataUrl } = await auth.beginTOTPSetup(discordID, username || discordID);
        return renderTemplate(setup2fa_template, {
            QR_CODE: qrDataUrl,
            SECRET: escape(secret),
        });
    })();

    const menuOptions = renderTemplate(logged_in_template, { USER: escape(username || '') });
    const errorHtml = (() => {
        if (dmErrorText) {
            return renderTemplate(error_template, {
                ERROR_MESSAGE: escape(dmErrorText).replaceAll('\n', '<br>'),
            });
        }
        const urlError = parsedUrl.searchParams.get('errortext');
        if (urlError) {
            return renderTemplate(error_template, {
                ERROR_MESSAGE: escape(urlError).replaceAll('\n', '<br>'),
            });
        }
        if (parsedUrl.searchParams.get('codesent')) {
            return getTemplate('verification_sent', 'partials');
        }
        return '';
    })();

    const response = renderTemplate(baseTemplate, {
        MENU_OPTIONS: menuOptions,
        SESSION_PARAM: sessionParam,
        SEND_CODE_URL: sendCodeUrl,
        ERROR: errorHtml,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};

exports.handleSetup2FA = async function (bot, req, res, body, discordID) {
    const params = Object.fromEntries(new URLSearchParams(body));
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

    if (!auth.verifyAndConsumeActionCode(discordID, 'setup2fa', params.discord_code)) {
        res.writeHead(302, {
            Location:
                '/setup2fa.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent('Invalid or expired Discord verification code.'),
        });
        res.end();
        return;
    }

    const result = await auth.verifyAndEnableTOTP(
        discordID,
        params.password || '',
        params.totp_code || ''
    );

    if (!result.success) {
        res.writeHead(302, {
            Location:
                '/setup2fa.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent(result.error),
        });
        res.end();
        return;
    }

    // Render backup codes page inline (codes are shown exactly once)
    const username = await auth.getUsername(discordID);
    const codesHtml =
        '<table style="font-family: monospace; font-size: 16px;">' +
        result.backupCodes
            .map(
                (code) =>
                    `<tr><td style="padding: 4px 0;"><code style="background: #393c40; padding: 6px 12px; color: #dddddd;">${escape(code)}</code></td></tr>`
            )
            .join('') +
        '</table>';

    const menuOptions = renderTemplate(logged_in_template, { USER: escape(username || '') });
    const response = renderTemplate(backup_codes_template, {
        MENU_OPTIONS: menuOptions,
        BACKUP_CODES_LIST: codesHtml,
        WHITE_THEME_ENABLED: getPageThemeAttr(req),
    });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(response);
};

exports.handleDisable2FA = async function (bot, req, res, body, discordID) {
    const params = Object.fromEntries(new URLSearchParams(body));
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

    if (!auth.verifyAndConsumeActionCode(discordID, 'disable2fa', params.discord_code)) {
        res.writeHead(302, {
            Location:
                '/setup2fa.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent('Invalid or expired Discord verification code.'),
        });
        res.end();
        return;
    }

    const result = await auth.disableTOTP(discordID, params.password || '');

    if (!result.success) {
        res.writeHead(302, {
            Location:
                '/setup2fa.html' +
                sessionParam +
                (sessionParam ? '&' : '?') +
                'errortext=' +
                encodeURIComponent(result.error),
        });
        res.end();
        return;
    }

    // Redirect to server page with success message
    res.writeHead(302, { Location: '/server/' + (sessionParam || '') });
    res.end();
};
