var fs = require('fs');
var escape = require('escape-html');
var { parse } = require('querystring');

var auth = require('../authentication.js');

const setup2fa_template = fs.readFileSync('pages/templates/setup2fa.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const disable2fa_template = fs.readFileSync('pages/templates/disable2fa.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const backup_codes_template = fs.readFileSync('pages/templates/backup_codes.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

function applyTheme(response, req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlTheme = parsedUrl.searchParams.get('theme');
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(c => c.startsWith('whiteThemeCookie='))?.split('=')[1];
  const theme = urlTheme !== null ? parseInt(urlTheme) : (whiteThemeCookie !== undefined ? parseInt(whiteThemeCookie) : 0);
  if (theme === 1) {
    return strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (theme === 2) {
    return strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    return strReplace(response, "{$WHITE_THEME_ENABLED}", "bgcolor=\"303338\"");
  }
}

function injectMenuAndError(response, username, parsedUrl, sessionParam) {
  response = strReplace(response, "{$MENU_OPTIONS}",
    strReplace(logged_in_template, "{$USER}", escape(username || ''))
  );
  response = strReplace(response, "{$SESSION_PARAM}", sessionParam);
  if (parsedUrl.searchParams.get('errortext')) {
    response = strReplace(response, "{$ERROR}",
      strReplace(error_template, "{$ERROR_MESSAGE}",
        strReplace(escape(parsedUrl.searchParams.get('errortext')), "\n", "<br>")
      )
    );
  } else {
    response = strReplace(response, "{$ERROR}", "");
  }
  return response;
}

exports.processSetup2FA = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, false);
  if (!discordID) return; // checkAuth already redirected

  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const username = await auth.getUsername(discordID);
  const totpEnabled = auth.getTOTPStatus(discordID);

  let response;
  if (totpEnabled) {
    // 2FA already enabled — show the disable page
    response = disable2fa_template;
    response = injectMenuAndError(response, username, parsedUrl, sessionParam);
  } else {
    // 2FA not yet enabled — show setup page with QR code
    const { secret, qrDataUrl } = await auth.beginTOTPSetup(discordID, username || discordID);
    response = setup2fa_template;
    response = injectMenuAndError(response, username, parsedUrl, sessionParam);
    response = strReplace(response, "{$QR_CODE}", qrDataUrl);
    response = strReplace(response, "{$SECRET}", escape(secret));
  }

  response = applyTheme(response, req);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.write(response);
  res.end();
};

exports.handleSetup2FA = async function (bot, req, res, body, discordID) {
  const params = parse(body);
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const result = await auth.verifyAndEnableTOTP(discordID, params.password || '', params.totp_code || '');

  if (!result.success) {
    res.writeHead(302, { Location: '/setup2fa.html' + sessionParam + (sessionParam ? '&' : '?') + 'errortext=' + encodeURIComponent(result.error) });
    res.end();
    return;
  }

  // Render backup codes page inline (codes are shown exactly once)
  const username = await auth.getUsername(discordID);
  let codesHtml = '<table style="font-family: monospace; font-size: 16px;">';
  result.backupCodes.forEach(code => {
    codesHtml += `<tr><td style="padding: 4px 0;"><code style="background: #393c40; padding: 6px 12px; color: #dddddd;">${escape(code)}</code></td></tr>`;
  });
  codesHtml += '</table>';

  let response = backup_codes_template;
  response = strReplace(response, "{$MENU_OPTIONS}",
    strReplace(logged_in_template, "{$USER}", escape(username || ''))
  );
  response = strReplace(response, "{$BACKUP_CODES_LIST}", codesHtml);
  response = applyTheme(response, req);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.write(response);
  res.end();
};

exports.handleDisable2FA = async function (bot, req, res, body, discordID) {
  const params = parse(body);
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const result = await auth.disableTOTP(discordID, params.password || '');

  if (!result.success) {
    res.writeHead(302, { Location: '/setup2fa.html' + sessionParam + (sessionParam ? '&' : '?') + 'errortext=' + encodeURIComponent(result.error) });
    res.end();
    return;
  }

  // Redirect to server page with success message
  res.writeHead(302, { Location: '/server/' + (sessionParam || '') });
  res.end();
};

