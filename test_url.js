const { URL } = require('url');
const reqUrl = "/login.html?errortext=" + encodeURIComponent("That account doesn't exist!");
const parsedurl = new URL(reqUrl, 'http://localhost');
console.log(parsedurl.searchParams.get('errortext'));
