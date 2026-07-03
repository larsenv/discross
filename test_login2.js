const auth = require('./src/authentication');
const http = require('http');

const req = {
    url: '/login',
    headers: {}
};

const res = {
    writeHead: (code, headers) => console.log('writeHead:', code, headers),
    end: (body) => console.log('end:', body)
};

const body = "username=pheonix+star2006&password=wrongpassword";
auth.handleLoginRegister(req, res, body).catch(console.error);

