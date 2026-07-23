'use strict';
const {
    renderTemplate,
    render,
    getPageThemeAttr,
    loadAndRenderPageTemplate,
    getTemplate,
} = require('./utils');
const escape = require('escape-html');
const auth = require('../src/authentication');

const setup2fa_template = loadAndRenderPageTemplate('setup-2fa', 'auth');
const disable2fa_template = loadAndRenderPageTemplate('disable-2fa', 'auth');
const backup_codes_template = loadAndRenderPageTemplate('backup-codes', 'auth');
const error_template = getTemplate('error', 'login');
const logged_in_template = getTemplate('logged-in', 'index');

function injectMenuAndError(response, username, parsedUrl, sessionParam) {
    const menuOptions = render('index/logged-in', { USER: escape(username || '') });
    const errorText = parsedUrl.searchParams.get('errortext');
    const errorHtml = errorText
        ? render('login/error', {
              ERROR_MESSAGE: escape(errorText).replaceAll('\n', getTemplate('br', 'misc')),
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

    // No DM is sent just because this page was loaded: a cross-site link or a
    // prefetch would then be enough to make someone's account send them a code
    // they never asked for. The code goes out only when the user asks for it,
    // through the token-bound link below.
    // A failed send still reports through the errortext parameter that
    // /sendactioncode redirects back with.
    const dmErrorText = '';

    const sendCodeUrl =
        '/sendactioncode?action=' +
        action +
        '&token=' +
        encodeURIComponent(auth.createActionToken(auth.getRequestSessionID(req), action)) +
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

    const menuOptions = render('index/logged-in', { USER: escape(username || '') });
    const errorHtml = (() => {
        if (dmErrorText) {
            return render('login/error', {
                ERROR_MESSAGE: escape(dmErrorText).replaceAll('\n', getTemplate('br', 'misc')),
            });
        }
        const urlError = parsedUrl.searchParams.get('errortext');
        if (urlError) {
            return render('login/error', {
                ERROR_MESSAGE: escape(urlError).replaceAll('\n', getTemplate('br', 'misc')),
            });
        }
        if (parsedUrl.searchParams.get('codesent')) {
            return getTemplate('verification-sent', 'partials');
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
                '/setup-2fa.html' +
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
                '/setup-2fa.html' +
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
    const rows = result.backupCodes
        .map((code) =>
            render('auth/partials/backup-codes-row', {
                CODE: escape(code),
            })
        )
        .join('');
    const codesHtml = render('auth/partials/backup-codes-table', {
        ROWS: rows,
    });

    const menuOptions = render('index/logged-in', { USER: escape(username || '') });
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
                '/setup-2fa.html' +
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
                '/setup-2fa.html' +
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
