const sqlite3 = require('better-sqlite3');
const db = new sqlite3('db/discross.db');

const body = "username=pheonix+star2006&password=password";
const params = Object.fromEntries(new URLSearchParams(body));

console.log("params.username:", params.username);
console.log("length:", params.username.length);

const match = db.prepare('SELECT * FROM users WHERE username=?').get(params.username);
console.log("match:", match ? match.username : "not found");

