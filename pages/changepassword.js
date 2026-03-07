'use strict';
const { strReplace, getPageThemeAttr } = require('./utils.js');
const fs = require('fs');
const escape = require('escape-html');
const auth = require('../authentication.js');

const changepassword_template = fs
  .readFileSync('pages/templates/changepassword.html', 'utf-8')
  .split('{$COMMON_HEAD}')
  .join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

exports.processChangePassword = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, false);
  if (!discordID) return; // checkAuth already redirected

  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const username = await auth.getUsername(discordID);

  // Send 6-digit action code via Discord DM (only on fresh page load, not on error/success/codesent redirects)
  let dmErrorText = '';
  if (
    !parsedUrl.searchParams.get('errortext') &&
    !parsedUrl.searchParams.get('success') &&
    !parsedUrl.searchParams.get('codesent')
  ) {
    const code = auth.createActionCode(discordID, 'changepassword');
    const dmResult = await bot.sendDM(
      discordID,
      'Your Discross verification code to change your password: **' +
        code +
        '**\nThis code expires in 10 minutes.'
    );
    if (!dmResult.success) {
      dmErrorText =
        'Could not send a verification code to your Discord DMs. Make sure you allow DMs from server members, then try again.';
    }
  }

  const sendCodeUrl =
    '/sendactioncode?action=changepassword' +
    (urlSessionID ? '&sessionID=' + encodeURIComponent(urlSessionID) : '');

  const errortext = parsedUrl.searchParams.get('errortext');
  let errorHtml;
  if (dmErrorText) {
    errorHtml = strReplace(
      error_template,
      '{$ERROR_MESSAGE}',
      strReplace(escape(dmErrorText), '\n', '<br>')
    );
  } else if (errortext) {
    errorHtml = strReplace(
      error_template,
      '{$ERROR_MESSAGE}',
      strReplace(escape(errortext), '\n', '<br>')
    );
  } else if (parsedUrl.searchParams.get('codesent')) {
    errorHtml =
      '<br><font color="#00cc00" face="\'rodin\', Arial, Helvetica, sans-serif">Verification code sent to your Discord DMs!</font>';
  } else if (parsedUrl.searchParams.get('success')) {
    errorHtml =
      '<br><font color="#00cc00" face="\'rodin\', Arial, Helvetica, sans-serif">Password changed successfully! Please log in again.</font>';
  } else {
    errorHtml = '';
  }

  const menuOptions = strReplace(logged_in_template, '{$USER}', escape(username || ''));
  const withMenu = strReplace(changepassword_template, '{$MENU_OPTIONS}', menuOptions);
  const withSession = strReplace(withMenu, '{$SESSION_PARAM}', sessionParam);
  const withSendCode = strReplace(withSession, '{$SEND_CODE_URL}', sendCodeUrl);
  const withError = strReplace(withSendCode, '{$ERROR}', errorHtml);
  const response = strReplace(withError, '{$WHITE_THEME_ENABLED}', getPageThemeAttr(req));
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
        '/changepassword.html' +
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
        '/changepassword.html' +
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
        '/changepassword.html' +
        sessionParam +
        (sessionParam ? '&' : '?') +
        'errortext=' +
        encodeURIComponent('Invalid or expired Discord verification code.'),
    });
    res.end();
    return;
  }

  const result = await auth.changePassword(discordID, params.current_password, params.new_password);

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
        '/changepassword.html' +
        sessionParam +
        (sessionParam ? '&' : '?') +
        'errortext=' +
        encodeURIComponent(result.reason),
    });
    res.end();
  }
};
