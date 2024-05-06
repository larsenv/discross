var fs = require('fs');
var { minify } = require('@minify-html/node');
var escape = require('escape-html');

var auth = require('../authentication.js');

const index_template = minify(fs.readFileSync('pages/templates/index.html'), { preserve_brace_template_syntax: true, ensure_spec_compliant_unquoted_attribute_values: true, do_not_minify_doctype: true, keep_spaces_between_attributes: true }).toString('utf-8');

const logged_in_template = minify(fs.readFileSync('pages/templates/index/logged_in.html'), { preserve_brace_template_syntax: true, ensure_spec_compliant_unquoted_attribute_values: true, do_not_minify_doctype: true, keep_spaces_between_attributes: true }).toString('utf-8');
const logged_out_template = minify(fs.readFileSync('pages/templates/index/logged_out.html'), { preserve_brace_template_syntax: true, ensure_spec_compliant_unquoted_attribute_values: true, do_not_minify_doctype: true, keep_spaces_between_attributes: true }).toString('utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

exports.processIndex = async function (bot, req, res, args) {
  discordID = await auth.checkAuth(req, res, true); // true means that the user isn't redirected to the login page
  if (discordID) {
    response = strReplace(index_template, "{$MENU_OPTIONS}",
      strReplace(logged_in_template, "{$USER}", escape(await auth.getUsername(discordID)))
    );
  } else {
    response = strReplace(index_template, "{$MENU_OPTIONS}", logged_out_template);
  }
  res.write(response);
  res.end();
}