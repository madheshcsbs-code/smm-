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

async function runTests() {
    console.log('--- TEST 1: Empty Fields ---');
    const res1 = await postJson('/api/login', { email: '', password: '' });
    console.log('Returned message:', res1.message);
    console.log('Success:', res1.success);
    console.log('Assert matched:', res1.message === 'Please fill in all required fields.' ? 'PASS 🚀' : 'FAIL ❌');

    console.log('\n--- TEST 2: Email does not exist ---');
    const res2 = await postJson('/api/login', { email: 'nonexistent@example.com', password: 'password123' });
    console.log('Returned message:', res2.message);
    console.log('Success:', res2.success);
    console.log('Assert matched:', res2.message === 'User not found.' ? 'PASS 🚀' : 'FAIL ❌');

    console.log('\n--- TEST 3: Incorrect password ---');
    const res3 = await postJson('/api/login', { email: 'aruljothiarasu620@gmail.com', password: 'wrongpassword' });
    console.log('Returned message:', res3.message);
    console.log('Success:', res3.success);
    console.log('Assert matched:', res3.message === 'Incorrect password.' ? 'PASS 🚀' : 'FAIL ❌');

    console.log('\n--- TEST 4: Correct login ---');
    const res4 = await postJson('/api/login', { email: 'aruljothiarasu620@gmail.com', password: '123456' });
    console.log('Returned message:', res4.message);
    console.log('Success:', res4.success);
    console.log('Assert matched:', res4.message === 'Authentication successful. Redirecting...' ? 'PASS 🚀' : 'FAIL ❌');
}

runTests().catch(console.error);
