require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { OAuth2Client } = require('google-auth-library');
const db = require('./database');
const smm = require('./smmApi');

const rawClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClient = new OAuth2Client(rawClientId);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('../frontend'));

// =============================================
// RAZORPAY SETUP
// =============================================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_HERE',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_SECRET_HERE',
});

// =============================================
// WHATSAPP NOTIFICATION (CallMeBot - Free)
// =============================================
async function sendWhatsApp(message) {
  const phone = process.env.ADMIN_WHATSAPP_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey || apikey === 'YOUR_CALLMEBOT_APIKEY') {
    console.log('📵 WhatsApp not configured — skipping notification');
    return;
  }
  try {
    const encoded = encodeURIComponent(message);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encoded}&apikey=${apikey}`;
    const res = await fetch(url);
    const text = await res.text();
    console.log(`📲 WhatsApp sent: ${text.substring(0, 60)}`);
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
  }
}

// =============================================
// AUTH ROUTES
// =============================================

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || name.trim() === '' || email.trim() === '' || password.trim() === '') {
    return res.json({ success: false, message: 'All fields required' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists)
    return res.json({ success: false, message: 'Email already registered' });

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  db.prepare('INSERT INTO users (name, email, password, balance) VALUES (?, ?, ?, 0)')
    .run(name, email, hash);

  await db.syncCloud();
  res.json({ success: true, message: 'Registered successfully' });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || email.trim() === '' || password.trim() === '') {
    return res.json({ success: false, message: 'Please fill in all required fields.' });
  }

  // Support lookup by email or username
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    user = db.prepare('SELECT * FROM users WHERE name = ?').get(email);
  }

  if (!user) {
    return res.json({ success: false, message: 'User not found.' });
  }

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (user.password !== hash) {
    return res.json({ success: false, message: 'Incorrect password.' });
  }

  // Simple token (use JWT in production)
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, user.id);

  await db.syncCloud();
  res.json({
    success: true,
    message: 'Authentication successful. Redirecting...',
    token,
    user: { id: user.id, name: user.name, email: user.email, balance: user.balance, role: user.role }
  });
});

// Google OAuth Login
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.json({ success: false, message: 'Google credential token is required' });
  }

  try {
    let payload;

    // Check if client ID is configured
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    if (clientId && clientId !== 'YOUR_GOOGLE_CLIENT_ID_HERE') {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } else {
      // Light-weight fallback: decode payload from JWT without cryptographic verification for easier local setup
      console.warn('⚠️ GOOGLE_CLIENT_ID is not configured in .env. Decoding token without signature verification.');
      const parts = credential.split('.');
      if (parts.length !== 3) throw new Error('Invalid JWT format');
      payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    }

    const { email, name, picture } = payload;
    if (!email) {
      return res.json({ success: false, message: 'Google token does not contain email' });
    }

    // Check if user exists in database
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      // Auto-register user (random pass since they login with Google)
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hash = crypto.createHash('sha256').update(randomPassword).digest('hex');

      db.prepare('INSERT INTO users (name, email, password, balance) VALUES (?, ?, ?, 0)')
        .run(name || email.split('@')[0], email, hash);

      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      console.log(`👤 Automatically registered new Google user: ${email} (Role: ${user.role})`);
    }

    // Generate login token
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, user.id);

    await db.syncCloud();
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        balance: user.balance,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Google Auth Error:', err);
    res.json({ success: false, message: 'Google authentication failed: ' + err.message });
  }
});

// Supabase Google Auth
app.post('/api/auth/supabase', async (req, res) => {
  const { session } = req.body;

  if (!session || !session.user || !session.user.email) {
    return res.json({ success: false, message: 'Invalid Supabase session' });
  }

  const { email, user_metadata } = session.user;
  const name = user_metadata?.full_name || email.split('@')[0];

  try {
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      // Auto-register user
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hash = crypto.createHash('sha256').update(randomPassword).digest('hex');

      db.prepare('INSERT INTO users (name, email, password, balance) VALUES (?, ?, ?, 0)')
        .run(name, email, hash);

      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      console.log(`👤 Automatically registered new Supabase user: ${email}`);
    }

    // Generate login token for our local system
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, user.id);

    await db.syncCloud();
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        balance: user.balance,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Supabase Auth Error:', err);
    res.json({ success: false, message: 'Failed to authenticate user' });
  }
});

// Get profile (auth middleware)
app.get('/api/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, balance, role FROM users WHERE id = ?').get(req.userId);
  if (!user) {
    return res.json({ success: false, message: 'User not found in DB.' });
  }
  res.json({ success: true, user });
});

// Get client-side config parameters
app.get('/api/config', (req, res) => {
  res.json({
    google_client_id: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    admin_upi_id: (process.env.ADMIN_UPI_ID || 'akcreates@axl').trim()
  });
});

// =============================================
// SERVICES ROUTES
// =============================================

app.get('/api/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE active = 1').all();
  res.json({ success: true, services });
});

app.get('/api/services/:platform', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE platform = ? AND active = 1').all(req.params.platform);
  res.json({ success: true, services });
});

// =============================================
// ORDER ROUTES
// =============================================

app.post('/api/orders', requireAuth, async (req, res) => {
  const { service_id, link, quantity } = req.body;

  // ── Validate service ──
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(service_id);
  if (!service) return res.json({ success: false, message: 'Service not found' });

  if (quantity < service.min_qty || quantity > service.max_qty)
    return res.json({ success: false, message: `Quantity must be between ${service.min_qty} and ${service.max_qty}` });

  // ── Check balance ──
  const charge = parseFloat(((service.rate * quantity) / 1000).toFixed(2));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (user.balance < charge)
    return res.json({ success: false, message: 'Insufficient balance. Please recharge.' });

  // ── Deduct balance immediately ──
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(charge, req.userId);

  // ── Create order in DB as 'pending' ──
  const result = db.prepare(`
    INSERT INTO orders (user_id, service_id, link, quantity, charge, status, provider_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, datetime('now'))
  `).run(req.userId, service_id, link, quantity, charge);
  const order_id = result.lastInsertRowid;

  // ── Forward to SMM Provider ──
  let providerStatus = 'pending';
  if (service.provider_service_id) {
    try {
      const smmResult = await smm.placeOrder({
        service_id: service.provider_service_id,
        link,
        quantity,
      });

      if (smmResult.success) {
        // Save provider order ID + mark as processing
        db.prepare(`UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?`)
          .run(smmResult.provider_order_id, order_id);
        providerStatus = 'processing';
        console.log(`✅ Order #${order_id} → Provider order #${smmResult.provider_order_id}`);
      } else {
        // Provider failed (e.g. insufficient balance) — HOLD as pending, DO NOT refund
        // Admin will be notified via WhatsApp to top-up and retry
        db.prepare(`UPDATE orders SET status = 'pending', notes = ? WHERE id = ?`)
          .run('Awaiting admin: ' + smmResult.error, order_id);
        providerStatus = 'pending';
        console.warn(`⚠️ Order #${order_id} held pending — provider error: ${smmResult.error}`);
      }
    } catch (err) {
      // Network error — mark for retry
      db.prepare(`UPDATE orders SET status = 'retry', notes = ? WHERE id = ?`)
        .run(err.message, order_id);
      providerStatus = 'retry';
      console.error(`⚠️ Order #${order_id} queued for retry:`, err.message);
    }
  } else {
    // No provider mapped yet — stays as manual 'pending'
    console.log(`⚠️ Service ${service_id} has no provider_service_id mapped`);
  }

  // ── Notify Admin via WhatsApp ──
  const waMsg = `🛒 *New Order #${order_id}*\n` +
    `👤 Customer: ${user.name}\n` +
    `📦 Service: ${service.name}\n` +
    `🔗 Link: ${link}\n` +
    `🔢 Qty: ${quantity}\n` +
    `💰 Charged: ₹${charge}\n` +
    `📊 Status: ${providerStatus.toUpperCase()}\n` +
    (providerStatus === 'pending' ? `⚠️ EasySmmPanel balance check karein & retry karein!` : `✅ Sent to provider`);
  sendWhatsApp(waMsg); // fire and forget

  await db.syncCloud(); // Ensure cloud sync completes in serverless
  res.json({
    success: true,
    message: 'Order placed successfully! It will be processed shortly.',
    order_id,
    charge,
    new_balance: parseFloat((user.balance - charge).toFixed(2)),
  });
});

// Get user orders
app.get('/api/orders', requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, s.name as service_name, s.platform
    FROM orders o
    JOIN services s ON o.service_id = s.id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC
    LIMIT 50
  `).all(req.userId);
  res.json({ success: true, orders });
});

// =============================================
// RAZORPAY PAYMENT ROUTES
// =============================================

// Step 1: Create Razorpay order
app.post('/api/payment/create', requireAuth, async (req, res) => {
  const { amount } = req.body; // amount in ₹

  if (!amount || amount < 10)
    return res.json({ success: false, message: 'Minimum recharge is ₹10' });

  try {
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay needs paise
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: { user_id: req.userId }
    });

    // Save pending transaction
    db.prepare(`
      INSERT INTO transactions (user_id, razorpay_order_id, amount, status, created_at)
      VALUES (?, ?, ?, 'pending', datetime('now'))
    `).run(req.userId, order.id, amount);

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_HERE'
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Payment creation failed' });
  }
});

// Step 2: Verify payment after success
app.post('/api/payment/verify', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const secret = process.env.RAZORPAY_KEY_SECRET || 'YOUR_SECRET_HERE';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature)
    return res.json({ success: false, message: 'Payment verification failed' });

  // Get transaction
  const txn = db.prepare('SELECT * FROM transactions WHERE razorpay_order_id = ?').get(razorpay_order_id);
  if (!txn) return res.json({ success: false, message: 'Transaction not found' });

  // Credit wallet
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(txn.amount, req.userId);
  db.prepare('UPDATE transactions SET status = ?, razorpay_payment_id = ? WHERE id = ?')
    .run('paid', razorpay_payment_id, txn.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);

  // ── Notify Admin via WhatsApp ──
  const payMsg = `💰 *Payment Received!*\n` +
    `👤 Customer: ${user.name} (${user.email})\n` +
    `💵 Amount: ₹${txn.amount}\n` +
    `💳 Payment ID: ${razorpay_payment_id}\n` +
    `👛 New Wallet Balance: ₹${(user.balance + txn.amount).toFixed(2)}`;
  sendWhatsApp(payMsg); // fire and forget

  await db.syncCloud(); // Ensure cloud sync completes in serverless
  res.json({ success: true, message: `₹${txn.amount} added to wallet!`, new_balance: user.balance + txn.amount });
});

// Step 3: Submit manual UPI transaction for admin review
app.post('/api/payment/submit-upi', requireAuth, async (req, res) => {
  const { amount, transaction_id } = req.body;
  const numAmount = parseFloat(amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    return res.json({ success: false, message: 'Please enter a valid amount greater than 0' });
  }
  if (!transaction_id || transaction_id.trim().length < 6) {
    return res.json({ success: false, message: 'Please enter a valid UPI transaction/UTR reference ID' });
  }

  try {
    // Record manual pending transaction history
    db.prepare(`
      INSERT INTO transactions (user_id, razorpay_order_id, razorpay_payment_id, amount, status, created_at)
      VALUES (?, NULL, ?, ?, 'pending', datetime('now'))
    `).run(req.userId, `UPI:${transaction_id.trim()}`, numAmount);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    const upiMsg = `⏳ *Manual UPI Payment Submitted!*\n` +
      `👤 Customer: ${user.name} (${user.email})\n` +
      `💵 Amount: ₹${numAmount}\n` +
      `💳 UPI UTR Ref: ${transaction_id.trim()}\n` +
      `Please verify and approve in your SMM Admin Dashboard.`;
    sendWhatsApp(upiMsg);

    await db.syncCloud();
    res.json({ success: true, message: 'Payment reference submitted! Wallet balance will be updated once verified by admin.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Admin endpoints for transactions (UPI)
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  try {
    const txns = db.prepare(`
      SELECT t.*, u.name as user_name, u.email as user_email
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `).all();
    res.json({ success: true, transactions: txns });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/admin/transactions/:id/approve', requireAdmin, async (req, res) => {
  const txnId = Number(req.params.id);
  try {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
    if (!txn || txn.status !== 'pending') {
      return res.json({ success: false, message: 'Invalid transaction, or already processed.' });
    }

    // Credit user's wallet
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(txn.amount, txn.user_id);
    // Set transaction status to 'paid'
    db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('paid', txnId);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(txn.user_id);
    const appMsg = `✅ *UPI Payment Approved!*\n` +
      `👤 Customer: ${user.name} (${user.email})\n` +
      `💵 Amount: ₹${txn.amount}\n` +
      `👛 Total Wallet Balance: ₹${user.balance.toFixed(2)}`;
    sendWhatsApp(appMsg);

    await db.syncCloud();
    res.json({ success: true, message: 'Transaction approved and wallet credited successfully!' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/admin/transactions/:id/reject', requireAdmin, async (req, res) => {
  const txnId = Number(req.params.id);
  try {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
    if (!txn || txn.status !== 'pending') {
      return res.json({ success: false, message: 'Invalid transaction, or already processed.' });
    }

    db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('rejected', txnId);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(txn.user_id);
    const rejMsg = `❌ *UPI Payment Rejected!*\n` +
      `👤 Customer: ${user.name} (${user.email})\n` +
      `💵 Amount: ₹${txn.amount}\n` +
      `UTR: ${txn.razorpay_payment_id}`;
    sendWhatsApp(rejMsg);

    await db.syncCloud();
    res.json({ success: true, message: 'Transaction rejected successfully.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Transaction history
app.get('/api/transactions', requireAuth, (req, res) => {
  const txns = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.userId);
  res.json({ success: true, transactions: txns });
});

// =============================================
// ADMIN ROUTES
// =============================================

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, u.name as user_name, s.name as service_name
    FROM orders o
    JOIN users u ON o.user_id = u.id
    JOIN services s ON o.service_id = s.id
    ORDER BY o.created_at DESC LIMIT 100
  `).all();
  res.json({ success: true, orders });
});

app.put('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  await db.syncCloud();
  res.json({ success: true, message: 'Order status updated' });
});

// List all registered users (Super Admin only)
app.get('/api/admin/users', requireSuperAdmin, (req, res) => {
  try {
    const users = db.prepare('SELECT id, name, email, balance, role, created_at FROM users').all();
    res.json({ success: true, users });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// List all services for admin with original price calculations (Super Admin only)
app.get('/api/admin/services', requireSuperAdmin, (req, res) => {
  try {
    const services = db.prepare('SELECT * FROM services').all();
    res.json({ success: true, services });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Set exact balance for a user (Super Admin only) - used to reset fake seed balances
app.post('/api/admin/users/:id/set-balance', requireSuperAdmin, async (req, res) => {
  const { balance } = req.body;
  const userId = Number(req.params.id);
  if (balance === undefined || isNaN(balance)) return res.json({ success: false, message: 'Invalid balance' });
  try {
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(balance, userId);
    await db.syncCloud();
    res.json({ success: true, message: `Balance set to ₹${balance}`, new_balance: balance });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Adjust any user's balance (credit or debit - Super Admin only)
app.post('/api/admin/users/:id/balance', requireSuperAdmin, async (req, res) => {
  const { amount, note } = req.body; // positive to credit, negative to debit
  const userId = Number(req.params.id);

  if (amount === undefined || isNaN(amount)) {
    return res.json({ success: false, message: 'Invalid amount' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ success: false, message: 'User not found' });

    // Update balance
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);

    // Record manual transaction history
    const txnType = amount >= 0 ? 'Admin Credit' : 'Admin Debit';
    db.prepare(`
      INSERT INTO transactions (user_id, razorpay_order_id, razorpay_payment_id, amount, status, created_at)
      VALUES (?, NULL, ?, ?, ?, datetime('now'))
    `).run(userId, `ADMIN: ${note || txnType}`, Math.abs(amount), amount >= 0 ? 'paid' : 'debited');

    const updatedUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    await db.syncCloud(); // Ensure cloud sync completes in serverless
    res.json({
      success: true,
      message: `Successfully adjusted balance by ₹${amount}. New balance: ₹${updatedUser.balance}`,
      new_balance: updatedUser.balance
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Get database/cloud sync logs (Super Admin only)
app.get('/api/admin/system-logs', requireSuperAdmin, (req, res) => {
  try {
    const logs = db.getSyncLogs();
    res.json({ success: true, logs });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// =============================================
// MIDDLEWARE
// =============================================

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Login required' });

  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (!user) return res.status(401).json({ success: false, message: 'Invalid token' });

  req.userId = user.id;
  req.userRole = user.role;
  req.userEmail = user.email;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const email = (req.userEmail || '').toLowerCase();
    if (email !== 'rajinikanthra904@gmail.com') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
  });
}

function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const email = (req.userEmail || '').toLowerCase();
    if (email !== 'rajinikanthra904@gmail.com') {
      return res.status(403).json({ success: false, message: 'Super Admin access required' });
    }
    next();
  });
}

// =============================================
// SMM PROVIDER ADMIN ROUTES
// =============================================

// Get provider balance
app.get('/api/admin/provider-balance', requireAdmin, async (req, res) => {
  const result = await smm.getProviderBalance();
  res.json(result);
});

// Import services from provider into DB (Super Admin only)
app.post('/api/admin/import-services', requireSuperAdmin, async (req, res) => {
  const result = await smm.getProviderServices();
  if (!result.success) return res.json({ success: false, message: result.error });

  // Use transaction to perform bulk inserts in-memory and write to disk once
  const runImport = db.transaction((services) => {
    let imported = 0;
    let updated = 0;
    for (const s of services) {
      const platform = guessPlatform(s.category);

      // ONLY import Instagram services per user request
      if (platform !== 'instagram') {
        continue;
      }

      const originalRate = parseFloat(s.rate);
      // Calculate rate based on user's new rule:
      // If original price is in paise (< ₹1), convert base price to ₹1, then apply 80% markup (₹1 base * 1.80 = ₹1.80)
      // Otherwise, apply standard 80% markup (1.80x the rate)
      let newRate;
      if (originalRate < 1.0) {
        newRate = parseFloat((1.0 * 1.80).toFixed(4));
      } else {
        newRate = parseFloat((originalRate * 1.80).toFixed(4));
      }

      // 1. If provider_service_id already exists → update rate and original rate
      const exists = db.prepare('SELECT id FROM services WHERE provider_service_id = ?').get(String(s.service));
      if (exists) {
        db.prepare('UPDATE services SET rate = ?, min_qty = ?, max_qty = ?, original_rate = ? WHERE id = ?')
          .run(newRate, s.min, s.max, originalRate, exists.id);
        updated++;
        continue;
      }

      // 2. Check if duplicate platform + name exists (case-insensitive)
      const existsByName = db.prepare('SELECT id FROM services WHERE platform = ? AND LOWER(name) = ?').get(platform, s.name.trim().toLowerCase());
      if (existsByName) {
        // Update rate + link provider_service_id
        db.prepare('UPDATE services SET rate = ?, provider_service_id = ?, min_qty = ?, max_qty = ?, original_rate = ? WHERE id = ?')
          .run(newRate, String(s.service), s.min, s.max, originalRate, existsByName.id);
        updated++;
        continue;
      }

      // 3. Insert brand new service with original_rate field
      db.prepare(`
        INSERT INTO services (platform, name, description, rate, min_qty, max_qty, delivery_time, provider_service_id, active, original_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        platform,
        s.name,
        s.category,
        newRate,
        s.min,
        s.max,
        s.average_time || 'Varies',
        String(s.service),
        originalRate
      );
      imported++;
    }
    return { imported, updated };
  });

  try {
    const { imported, updated } = runImport(result.services);
    await db.syncCloud(); // Ensure cloud sync completes in serverless
    res.json({ success: true, message: `✅ ${updated} services updated to 80% markup, ${imported} new services added`, total: result.services.length });
  } catch (err) {
    console.error('Import services transaction failed:', err);
    res.json({ success: false, message: 'Failed to save imported services: ' + err.message });
  }
});

// Map existing service to a provider service ID (Super Admin only)
app.put('/api/admin/services/:id/map', requireSuperAdmin, async (req, res) => {
  const { provider_service_id } = req.body;
  db.prepare('UPDATE services SET provider_service_id = ? WHERE id = ?')
    .run(provider_service_id, req.params.id);
  await db.syncCloud();
  res.json({ success: true, message: 'Service mapped to provider' });
});

// Manual order status check
app.get('/api/admin/orders/:id/sync', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order?.provider_order_id) return res.json({ success: false, message: 'No provider order ID' });

  const result = await smm.checkOrderStatus(order.provider_order_id);
  if (!result.success) return res.json(result);

  const newStatus = mapProviderStatus(result.status);
  db.prepare('UPDATE orders SET status = ?, remains = ? WHERE id = ?')
    .run(newStatus, result.remains, order.id);
  await db.syncCloud();
  res.json({ success: true, status: newStatus, remains: result.remains });
});

// Cancel order at provider
app.post('/api/admin/orders/:id/cancel', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order?.provider_order_id) return res.json({ success: false, message: 'No provider order ID' });

  const result = await smm.cancelOrder(order.provider_order_id);
  if (result.success) {
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
    await db.syncCloud();
  }
  res.json(result);
});

// Refill dropped order
app.post('/api/admin/orders/:id/refill', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order?.provider_order_id) return res.json({ success: false, message: 'No provider order ID' });

  const result = await smm.refillOrder(order.provider_order_id);
  res.json(result);
});

// =============================================
// AUTO STATUS SYNC — runs every 5 minutes
// =============================================
async function syncOrderStatuses() {
  // Get all active orders that have a provider_order_id
  const activeOrders = db.prepare(`
    SELECT id, provider_order_id FROM orders
    WHERE status IN ('processing', 'pending', 'retry')
    AND provider_order_id IS NOT NULL
    LIMIT 100
  `).all();

  if (!activeOrders.length) return;

  // Batch check (up to 100 at once — JAP supports this)
  const ids = activeOrders.map(o => o.provider_order_id);
  const result = await smm.checkMultipleOrders(ids);
  if (!result.success) {
    console.error('Status sync failed:', result.error);
    return;
  }

  const updateStmt = db.prepare('UPDATE orders SET status = ?, remains = ? WHERE id = ?');
  const syncMany = db.transaction((orders, providerData) => {
    for (const order of orders) {
      const pd = providerData[order.provider_order_id];
      if (!pd) continue;
      const newStatus = mapProviderStatus(pd.status);
      updateStmt.run(newStatus, pd.remains || 0, order.id);
    }
  });

  syncMany(activeOrders, result.orders);
  console.log(`🔄 Synced ${activeOrders.length} orders at ${new Date().toLocaleTimeString()}`);
}

// Retry orders that failed to reach provider
async function retryFailedOrders() {
  const retryOrders = db.prepare(`
    SELECT o.*, s.provider_service_id FROM orders o
    JOIN services s ON o.service_id = s.id
    WHERE o.status = 'retry' AND s.provider_service_id IS NOT NULL
    LIMIT 20
  `).all();

  for (const order of retryOrders) {
    const result = await smm.placeOrder({
      service_id: order.provider_service_id,
      link: order.link,
      quantity: order.quantity,
    });
    if (result.success) {
      db.prepare("UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?")
        .run(result.provider_order_id, order.id);
      console.log(`♻️ Retried order #${order.id} → provider #${result.provider_order_id}`);
    }
  }
}

// ── Helper: map provider status → our status ──
function mapProviderStatus(providerStatus) {
  const map = {
    'Pending': 'pending',
    'In progress': 'processing',
    'Processing': 'processing',
    'Completed': 'completed',
    'Partial': 'partial',
    'Canceled': 'cancelled',
    'Cancelled': 'cancelled',
  };
  return map[providerStatus] || 'processing';
}

// ── Helper: guess platform from category name ──
function guessPlatform(category = '') {
  const c = category.toLowerCase();
  if (c.includes('instagram')) return 'instagram';
  if (c.includes('youtube')) return 'youtube';
  if (c.includes('facebook')) return 'facebook';
  if (c.includes('tiktok') || c.includes('tik tok')) return 'tiktok';
  if (c.includes('twitter') || c.includes('x.com')) return 'twitter';
  if (c.includes('telegram')) return 'telegram';
  return 'other';
}

// Start cron jobs (only in non-serverless environments)
if (process.env.VERCEL !== '1') {
  setInterval(syncOrderStatuses, 5 * 60 * 1000);   // every 5 min
  setInterval(retryFailedOrders, 10 * 60 * 1000);   // every 10 min
  console.log('⏰ Auto-sync started (every 5 min)');
}

// =============================================
// START SERVER (local) / EXPORT (Vercel)
// =============================================

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ instaboost Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
