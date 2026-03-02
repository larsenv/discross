var fs = require('fs');
var escape = require('escape-html');
var { parse } = require('querystring');

var auth = require('../authentication.js');

const changepassword_template = fs.readFileSync('pages/templates/changepassword.html', 'utf-8').split('{$COMMON_HEAD}').join(fs.readFileSync('pages/templates/partials/head.html', 'utf-8'));
const error_template = fs.readFileSync('pages/templates/login/error.html', 'utf-8');
const logged_in_template = fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
}

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

exports.processChangePassword = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, false);
  if (!discordID) return; // checkAuth already redirected

  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
  const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';

  const username = await auth.getUsername(discordID);

  let response = changepassword_template;
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
  } else if (parsedUrl.searchParams.get('success')) {
    response = strReplace(response, "{$ERROR}",
      '<br><font color="#00cc00" face="\'rodin\', Arial, Helvetica, sans-serif">Password changed successfully! Please log in again.</font>'
    );
  } else {
    response = strReplace(response, "{$ERROR}", "");
  }

  response = applyTheme(response, req);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.write(response);
  res.end();
};

exports.handleChangePassword = async function (bot, req, res, body, discordID) {
  const params = parse(body);

  if (!params.current_password || !params.new_password || !params.confirm_password) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';
    res.writeHead(302, { Location: '/changepassword.html' + sessionParam + (sessionParam ? '&' : '?') + 'errortext=' + encodeURIComponent('Please fill in all fields.') });
    res.end();
    return;
  }

  if (params.new_password !== params.confirm_password) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';
    res.writeHead(302, { Location: '/changepassword.html' + sessionParam + (sessionParam ? '&' : '?') + 'errortext=' + encodeURIComponent("New password confirmation doesn't match.") });
    res.end();
    return;
  }

  const result = await auth.changePassword(discordID, params.current_password, params.new_password);

  if (result.status === 'success') {
    // Sessions are cleared by changePassword (all DB sessions deleted); redirect to login
    res.writeHead(302, { Location: '/login.html?errortext=' + encodeURIComponent('Password changed. Please log in with your new password.') });
    res.end();
  } else {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const urlSessionID = parsedUrl.searchParams.get('sessionID') || '';
    const sessionParam = urlSessionID ? '?sessionID=' + encodeURIComponent(urlSessionID) : '';
    res.writeHead(302, { Location: '/changepassword.html' + sessionParam + (sessionParam ? '&' : '?') + 'errortext=' + encodeURIComponent(result.reason) });
    res.end();
  }
};
