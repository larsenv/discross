var fs = require('fs');
var HTMLMinifier = require('@bhavingajjar/html-minify');
var minifier = new HTMLMinifier();
var escape = require('escape-html');
var UAParser = require('ua-parser-js');

var auth = require('../authentication.js');

const index_template = minifier.htmlMinify(fs.readFileSync('pages/templates/index.html', 'utf-8'));

const logged_in_template = minifier.htmlMinify(fs.readFileSync('pages/templates/index/logged_in.html', 'utf-8'));
const logged_out_template = minifier.htmlMinify(fs.readFileSync('pages/templates/index/logged_out.html', 'utf-8'));

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

exports.processIndex = async function (bot, req, res, args) {
  discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
  
  // Parse user agent
  const userAgent = req.headers['user-agent'] || '';
  const parser = new UAParser(userAgent);
  const uaResult = parser.getResult();
  
  // Create user agent display string
  let userAgentDisplay = '';
  if (uaResult.browser.name || uaResult.os.name) {
    const browserName = escape(uaResult.browser.name || '');
    const browserVersion = escape(uaResult.browser.version || '');
    const osName = escape(uaResult.os.name || '');
    const osVersion = escape(uaResult.os.version || '');
    const deviceVendor = escape(uaResult.device.vendor || '');
    const deviceModel = escape(uaResult.device.model || '');
    
    const browserInfo = browserName ? `${browserName}${browserVersion ? ' ' + browserVersion : ''}` : '';
    const osInfo = osName ? `${osName}${osVersion ? ' ' + osVersion : ''}` : '';
    const deviceInfo = deviceVendor || deviceModel ? ` (${[deviceVendor, deviceModel].filter(Boolean).join(' ')})` : '';
    
    // Build display text based on what information is available
    let displayText = 'Platform: ';
    if (browserInfo && osInfo) {
      displayText += `${browserInfo} on ${osInfo}${deviceInfo}`;
    } else if (browserInfo) {
      displayText += `${browserInfo}${deviceInfo}`;
    } else if (osInfo) {
      displayText += `${osInfo}${deviceInfo}`;
    }
    
    userAgentDisplay = `<font color="#aaaaaa" size="2">${displayText}</font>`;
  }
  
  if (discordID) {
    response = strReplace(index_template, "{$MENU_OPTIONS}",
      strReplace(logged_in_template, "{$USER}", escape(await auth.getUsername(discordID)))
    );
  } else {
    response = strReplace(index_template, "{$MENU_OPTIONS}", logged_out_template);
  }
  
  // Add user agent display
  response = strReplace(response, "{$USER_AGENT}", userAgentDisplay);
  
  const whiteThemeCookie = req.headers.cookie?.split('; ')?.find(cookie => cookie.startsWith('whiteThemeCookie='))?.split('=')[1];
  
  // Apply theme class based on cookie value: 0=dark (default), 1=light, 2=amoled
  if (whiteThemeCookie == 1) {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"light-theme\"");
  } else if (whiteThemeCookie == 2) {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "class=\"amoled-theme\"");
  } else {
    response = strReplace(response, "{$WHITE_THEME_ENABLED}", "");
  }
  res.write(response);
  res.end();
}
