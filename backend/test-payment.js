const fetch = require('node-fetch');

const API = 'http://localhost:3000/api';

async function test() {
  console.log('🧪 Starting manual payment workflow API tests...');
  
  // 1. Login
  const loginRes = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'aruljothiarasu620@gmail.com', password: '123456' })
  }).then(r => r.json());
  
  if (!loginRes.success) {
    console.error('❌ Login failed:', loginRes);
    process.exit(1);
  }
  const token = loginRes.token;
  console.log('✅ Logged in successfully. Token:', token);

  // 2. Clear previous test transactions
  console.log('➡️ Submitting manual payment proof...');
  const submitRes = await fetch(`${API}/payment/submit-upi`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ amount: 250, transaction_id: '987654321012' })
  }).then(r => r.json());

  if (!submitRes.success) {
    console.error('❌ Payment submission failed:', submitRes);
    process.exit(1);
  }
  console.log('✅ Payment submission registered:', submitRes.message);

  // 3. Fetch admin transactions to find our pending transaction
  console.log('➡️ Fetching admin transaction logs...');
  const adminTxnsRes = await fetch(`${API}/admin/transactions`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  if (!adminTxnsRes.success) {
    console.error('❌ Admin transaction fetch failed:', adminTxnsRes);
    process.exit(1);
  }

  const pendingTxn = adminTxnsRes.transactions.find(t => t.razorpay_payment_id === 'UPI:987654321012' && t.status === 'pending');
  if (!pendingTxn) {
    console.error('❌ Submitted transaction not found in admin logs!');
    process.exit(1);
  }
  console.log('✅ Found pending transaction! ID:', pendingTxn.id, 'Status:', pendingTxn.status);

  // 4. Approve the transaction as admin
  console.log(`➡️ Approving transaction ID ${pendingTxn.id}...`);
  const approveRes = await fetch(`${API}/admin/transactions/${pendingTxn.id}/approve`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  if (!approveRes.success) {
    console.error('❌ Approval failed:', approveRes);
    process.exit(1);
  }
  console.log('✅ Transaction approved:', approveRes.message);

  // 5. Check user balance updated
  const profileRes = await fetch(`${API}/profile`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  if (!profileRes.success) {
     console.error('❌ Failed to fetch user profile:', profileRes);
     process.exit(1);
  }

  console.log('🎉 Current user balance:', profileRes.user.balance);
  if (profileRes.user.balance >= 250) {
    console.log('🚀 SUCCESS! Manual payment workflow is 100% verified.');
  } else {
    console.error('❌ Error: balance was not updated correctly.');
    process.exit(1);
  }
}

test().catch(console.error);
