var url = require('url');
var fs = require('fs');
var { minify } = require('@minify-html/node');
var escape = require('escape-html');

var auth = require('../authentication.js');

const forgot_template = minify(fs.readFileSync('pages/templates/forgot.html'), { preserve_brace_template_syntax: true, ensure_spec_compliant_unquoted_attribute_values: true, do_not_minify_doctype: true, keep_spaces_between_attributes: true }).toString('utf-8');
const error_template = minify(fs.readFileSync('pages/templates/login/error.html'), { preserve_brace_template_syntax: true, ensure_spec_compliant_unquoted_attribute_values: true, do_not_minify_doctype: true, keep_spaces_between_attributes: true }).toString('utf-8');

function strReplace(string, needle, replacement) {
  return string.split(needle).join(replacement || "");
};

exports.processForgot = async function (bot, req, res, args) {
  parsedurl = url.parse(req.url, true);
  response = forgot_template;
  if (parsedurl.query.errortext) {
    response = strReplace(response, "{$ERROR}", strReplace(error_template, "{$ERROR_MESSAGE}", strReplace(escape(parsedurl.query.errortext), "\n", "<br>")));
  } else {
    response = strReplace(response, "{$ERROR}", "");
  }
  res.write(response);
  res.end();
}