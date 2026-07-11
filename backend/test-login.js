const http = require('http');

const data = JSON.stringify({
    email: 'test@example.com',
    password: 'wrong'
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/login',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = http.request(options, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => console.log(JSON.parse(body)));
});

req.write(data);
req.end();
