'use strict'

const fs = require('fs')
const { strReplace } = require('./utils.js');

const commonHead = fs.readFileSync('pages/templates/partials/head.html', 'utf-8')
const template404 = fs.readFileSync('pages/templates/404.html', 'utf-8')
  .split('{$COMMON_HEAD}').join(commonHead)


function getThemeAttr(req) {
  const cookie = req.headers.cookie || ''
  const c = cookie.split('; ').find(x => x.startsWith('whiteThemeCookie='))
  const val = c ? parseInt(c.split('=')[1]) : 0
  if (val === 1) return 'class="light-theme"'
  if (val === 2) return 'class="amoled-theme"'
  return 'bgcolor="303338"'
}

exports.serve404 = function (req, res, message, backUrl, backLabel) {
  let html = strReplace(template404, '{$WHITE_THEME_ENABLED}', getThemeAttr(req))
  html = strReplace(html, '{$MESSAGE}', message || 'Page not found.')
  html = strReplace(html, '{$BACK_URL}', backUrl || '/')
  html = strReplace(html, '{$BACK_LABEL}', backLabel || 'Back to Home')
  res.writeHead(404, { 'Content-Type': 'text/html' })
  return res.end(html)
}
