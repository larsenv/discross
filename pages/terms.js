'use strict';
const { renderTemplate, getPageThemeAttr, loadAndRenderPageTemplate, getTemplate } = require('./utils.js');
const fs = require('fs');
const escape = require('escape-html');
const auth = require('../authentication.js');

const terms_template = loadAndRenderPageTemplate('terms');

const logged_in_template = getTemplate('logged_in', 'index');
const logged_out_template = getTemplate('logged_out', 'index');

exports.processTerms = async function (bot, req, res, args) {
  const discordID = await auth.checkAuth(req, res, true);
  const menuOptions = discordID
    ? renderTemplate(logged_in_template, { USER: escape(await auth.getUsername(discordID)) })
    : logged_out_template;
  const response = renderTemplate(terms_template, {
    MENU_OPTIONS: menuOptions,
    WHITE_THEME_ENABLED: getPageThemeAttr(req),
  });
  res.end(response);
};
