const http = require('http');

function postJson(path, body) {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        }, res => {
            let responseBody = '';
            res.on('data', chunk => responseBody += chunk);
            res.on('end', () => resolve(JSON.parse(responseBody)));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function getJson(path, token) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }, res => {
            let responseBody = '';
            res.on('data', chunk => responseBody += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(responseBody) }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function runTests() {
    console.log('--- TEST: Correct login ---');
    const res = await postJson('/api/login', { email: 'aruljothiarasu620@gmail.com', password: '123456' });
    console.log('Login Response:', res);

    if (res.success) {
        console.log('\n--- TEST: Profile retrieval with stateless token ---');
        const profile = await getJson('/api/profile', res.token);
        console.log('Response Status:', profile.status);
        console.log('Response Body:', profile.data);
        console.log('Assert matched:', (profile.status === 200 && profile.data.success) ? 'PASS 🚀' : 'FAIL ❌');
    } else {
        console.log('Login failed!');
    }
}

runTests().catch(console.error);
