const { strReplace } = require('./utils.js');
var fs = require('fs');
var escape = require('escape-html');
var { parse } = require('querystring');

var auth = require('../authentication.js');

const setup2fa_template = fs.readFileSync('pages/templates/setup2fa.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const disable2fa_template = fs.readFileSync('pages/templates/disable2fa.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const backup_codes_template = fs.readFileSync('pages/templates/backup_codes.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');


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

  const action = totpEnabled ? 'disable2fa' : 'setup2fa';

  // Send 6-digit action code via Discord DM on fresh page load (not on error/codesent redirects)
  let dmErrorText = '';
  if (!parsedUrl.searchParams.get('errortext') && !parsedUrl.searchParams.get('codesent')) {
    const code = auth.createActionCode(discordID, action);
    const dmResult = await bot.sendDM(discordID, 'Your Discross verification code to ' + (totpEnabled ? 'disable' : 'set up') + ' two-factor authentication: **' + code + '**\nThis code expires in 10 minutes.');
    if (!dmResult.success) {
      dmErrorText = 'Could not send a verification code to your Discord DMs. Make sure you allow DMs from server members, then try again.';
    }
  }

  const sendCodeUrl = '/sendactioncode?action=' + action + (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

  let response;
  if (totpEnabled) {
    // 2FA already enabled — show the disable page
    response = disable2fa_template;
  } else {
    // 2FA not yet enabled — show setup page with QR code
    const { secret, qrDataUrl } = await auth.beginTOTPSetup(discordID, username || discordID);
    response = setup2fa_template;
    response = strReplace(response, "{$QR_CODE}", qrDataUrl);
    response = strReplace(response, "{$SECRET}", escape(secret));
  }

  response = strReplace(response, "{$MENU_OPTIONS}",
    strReplace(logged_in_template, "{$USER}", escape(username || ''))
  );
  response = strReplace(response, "{$SESSION_PARAM}", sessionParam);
  response = strReplace(response, "{$SEND_CODE_URL}", sendCodeUrl);

  if (dmErrorText) {
    response = strReplace(response, "{$ERROR}",
      strReplace(error_template, "{$ERROR_MESSAGE}",
        strReplace(escape(dmErrorText), "\n", "<br>")
      )
    );
  } else if (parsedUrl.searchParams.get('errortext')) {
    response = strReplace(response, "{$ERROR}",
      strReplace(error_template, "{$ERROR_MESSAGE}",
        strReplace(escape(parsedUrl.searchParams.get('errortext')), "\n", "<br>")
      )
    );
  } else if (parsedUrl.searchParams.get('codesent')) {
    response = strReplace(response, "{$ERROR}",
      '<br><font color="#00cc00" face="\'rodin\', Arial, Helvetica, sans-serif">Verification code sent to your Discord DMs!</font>'
    );
  } else {
    response = strReplace(response, "{$ERROR}", "");
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

  if (!auth.verifyAndConsumeActionCode(discordID, 'setup2fa', params.discord_code)) {
    res.writeHead(302, { Location: '/setup2fa.html' + sessionParam + (sessionParam ? '&' : '?') + 'errortext=' + encodeURIComponent('Invalid or expired Discord verification code.') });
    res.end();
    return;
  }

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

  if (!auth.verifyAndConsumeActionCode(discordID, 'disable2fa', params.discord_code)) {
    res.writeHead(302, { Location: '/setup2fa.html' + sessionParam + (sessionParam ? '&' : '?') + 'errortext=' + encodeURIComponent('Invalid or expired Discord verification code.') });
    res.end();
    return;
  }

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

