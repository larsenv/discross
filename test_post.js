const auth = require('./src/authentication');
const http = require('http');

async function run() {
    const req = {
        url: '/login',
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: ''
        }
    };
    
    const res = {
        writeHead: (code, headers) => console.log('writeHead:', code, headers),
        end: (body) => console.log('end:', body)
    };
    
    const body = "username=pheonix+star2006&password=wrongpassword";
    
    try {
        await auth.handleLoginRegister(req, res, body);
        console.log("Finished handleLoginRegister");
    } catch(e) {
        console.error("Error:", e);
    }
}
run();
