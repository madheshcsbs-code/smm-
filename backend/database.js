const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let dbPath = path.join(__dirname, 'db.json');

function isDirWritable(dir) {
  try {
    const testFile = path.join(dir, '.write-test-' + Math.random());
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    return false;
  }
}

if (process.env.VERCEL || process.env.NOW_BUILDER || !isDirWritable(path.dirname(dbPath))) {
  const tmpDbPath = path.join('/tmp', 'db.json');
  if (!fs.existsSync(tmpDbPath)) {
    try {
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, tmpDbPath);
      } else {
        fs.writeFileSync(tmpDbPath, JSON.stringify({
          users: [],
          services: [],
          orders: [],
          transactions: []
        }, null, 2), 'utf8');
      }
    } catch (err) {
      console.error('Failed to copy db.json to /tmp:', err);
    }
  }
  dbPath = tmpDbPath;
}

function readData() {
  let data = {
    users: [],
    services: [],
    orders: [],
    transactions: []
  };

  if (fs.existsSync(dbPath)) {
    try {
      data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch (err) { }
  }

  // Ensure Admin exists
  const adminsToSeed = [
    { email: 'rajinikanthra904@gmail.com', name: 'Rajinikanth Admin' }
  ];

  const adminHash = crypto.createHash('sha256').update('123456').digest('hex');
  let dbChanged = false;

  for (const item of adminsToSeed) {
    let currentAdmin = data.users.find(u => u.email.toLowerCase() === item.email.toLowerCase());
    if (!currentAdmin) {
      currentAdmin = {
        id: data.users.length > 0 ? Math.max(...data.users.map(u => u.id)) + 1 : 1,
        name: item.name,
        email: item.email,
        password: adminHash,
        balance: 0,
        token: null,
        role: 'admin',
        created_at: new Date().toISOString()
      };
      data.users.push(currentAdmin);
      dbChanged = true;
    } else {
      if (currentAdmin.role !== 'admin') {
        currentAdmin.role = 'admin';
        dbChanged = true;
      }
    }
  }

  if (dbChanged) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  }

  return data;
}

let cachedData = null;
function getFreshData(force = false) {
  if (force || !cachedData) {
    cachedData = readData();
  }
  return cachedData;
}

function writeData(data) {
  cachedData = data;
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
}

class Statement {
  constructor(sql) {
    this.sql = sql.trim().replace(/\s+/g, ' ');
  }

  get(...params) {
    const data = getFreshData();
    // SELECT id FROM users WHERE email = ?
    if (this.sql.includes('SELECT id FROM users WHERE email = ?')) {
      const email = params[0];
      const user = data.users.find(u => u.email.toLowerCase() === email.toLowerCase());
      return user ? { id: user.id } : undefined;
    }
    // SELECT * FROM users WHERE email = ? AND password = ?
    if (this.sql.includes('SELECT * FROM users WHERE email = ? AND password = ?')) {
      const [email, password] = params;
      const user = data.users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
      return user ? { ...user } : undefined;
    }
    // SELECT * FROM users WHERE email = ?
    if (this.sql.includes('SELECT * FROM users WHERE email = ?')) {
      const email = params[0];
      const user = data.users.find(u => u.email.toLowerCase() === email.toLowerCase());
      return user ? { ...user } : undefined;
    }
    // SELECT * FROM users WHERE name = ?
    if (this.sql.includes('SELECT * FROM users WHERE name = ?')) {
      const name = params[0];
      const user = data.users.find(u => (u.name || '').toLowerCase() === name.toLowerCase());
      return user ? { ...user } : undefined;
    }
    // SELECT id, name, email, balance, role FROM users WHERE id = ?
    if (this.sql.includes('SELECT id, name, email, balance, role FROM users WHERE id = ?')) {
      const id = params[0];
      const user = data.users.find(u => u.id === id);
      return user ? { id: user.id, name: user.name, email: user.email, balance: user.balance, role: user.role } : undefined;
    }
    // SELECT * FROM services WHERE id = ?
    if (this.sql.includes('SELECT * FROM services WHERE id = ?')) {
      const id = params[0];
      const svc = data.services.find(s => s.id === Number(id));
      return svc ? { ...svc } : undefined;
    }
    // SELECT * FROM users WHERE id = ?
    if (this.sql.includes('SELECT * FROM users WHERE id = ?')) {
      const id = params[0];
      const user = data.users.find(u => u.id === id);
      return user ? { ...user } : undefined;
    }
    // SELECT * FROM transactions WHERE razorpay_order_id = ?
    if (this.sql.includes('SELECT * FROM transactions WHERE razorpay_order_id = ?')) {
      const orderId = params[0];
      const txn = data.transactions.find(t => t.razorpay_order_id === orderId);
      return txn ? { ...txn } : undefined;
    }
    // SELECT * FROM transactions WHERE id = ?
    if (this.sql.includes('SELECT * FROM transactions WHERE id = ?')) {
      const id = params[0];
      const txn = data.transactions.find(t => t.id === Number(id));
      return txn ? { ...txn } : undefined;
    }
    // SELECT * FROM users WHERE token = ?
    if (this.sql.includes('SELECT * FROM users WHERE token = ?')) {
      const token = params[0];
      const user = data.users.find(u => u.token === token);
      return user ? { ...user } : undefined;
    }
    // SELECT COUNT(*) as c FROM services
    if (this.sql.includes('SELECT COUNT(*) as c FROM services')) {
      return { c: data.services.length };
    }
    // SELECT * FROM orders WHERE id = ?
    if (this.sql.includes('SELECT * FROM orders WHERE id = ?')) {
      const id = params[0];
      const order = data.orders.find(o => o.id === Number(id));
      return order ? { ...order } : undefined;
    }
    // SELECT id FROM services WHERE provider_service_id = ?
    if (this.sql.includes('SELECT id FROM services WHERE provider_service_id = ?')) {
      const pId = String(params[0]).trim();
      const svc = data.services.find(s => s.provider_service_id && String(s.provider_service_id).trim() === pId);
      return svc ? { id: svc.id } : undefined;
    }
    // SELECT id, rate FROM services WHERE platform = ? AND LOWER(name) = ?
    if (this.sql.includes('SELECT id, rate FROM services WHERE platform = ? AND LOWER(name) = ?')) {
      const [platform, name] = params;
      const svc = data.services.find(s => s.platform === platform && s.name.trim().toLowerCase() === name.trim().toLowerCase());
      return svc ? { id: svc.id, rate: svc.rate } : undefined;
    }
    // SELECT balance FROM users WHERE id = ?
    if (this.sql.includes('SELECT balance FROM users WHERE id = ?')) {
      const id = params[0];
      const user = data.users.find(u => u.id === id);
      return user ? { balance: user.balance } : undefined;
    }
    return undefined;
  }

  run(...params) {
    const data = getFreshData(true);
    let lastInsertRowid = 0;

    // INSERT INTO users
    if (this.sql.includes('INSERT INTO users (name, email, password, balance)')) {
      const [name, email, password] = params;
      const id = data.users.length > 0 ? Math.max(...data.users.map(u => u.id)) + 1 : 1;
      const role = (email.toLowerCase() === 'rajinikanthra904@gmail.com') ? 'admin' : 'user';
      data.users.push({ id, name, email, password, balance: 0, token: null, role, created_at: new Date().toISOString() });
      lastInsertRowid = id;
    }
    // UPDATE users SET token = ?
    else if (this.sql.includes('UPDATE users SET token = ? WHERE id = ?')) {
      const [token, id] = params;
      const user = data.users.find(u => u.id === id);
      if (user) user.token = token;
    }
    // UPDATE users SET balance = balance - ?
    else if (this.sql.includes('UPDATE users SET balance = balance - ? WHERE id = ?')) {
      const [charge, id] = params;
      const user = data.users.find(u => u.id === id);
      if (user) user.balance = parseFloat((user.balance - charge).toFixed(2));
    }
    // UPDATE users SET balance = balance + ?
    else if (this.sql.includes('UPDATE users SET balance = balance + ? WHERE id = ?')) {
      const [amount, id] = params;
      const user = data.users.find(u => u.id === id);
      if (user) user.balance = parseFloat((user.balance + amount).toFixed(2));
    }
    // UPDATE users SET balance = ?
    else if (this.sql.includes('UPDATE users SET balance = ? WHERE id = ?')) {
      const [balance, id] = params;
      const user = data.users.find(u => u.id === id);
      if (user) user.balance = parseFloat(Number(balance).toFixed(2));
    }
    // INSERT INTO orders
    else if (this.sql.includes('INSERT INTO orders (user_id, service_id, link, quantity, charge, status, provider_order_id, created_at)')) {
      const [user_id, service_id, link, quantity, charge] = params;
      const id = data.orders.length > 0 ? Math.max(...data.orders.map(o => o.id)) + 1 : 1;
      data.orders.push({ id, user_id, service_id, link, quantity, charge, status: 'pending', provider_order_id: null, remains: 0, notes: null, created_at: new Date().toISOString() });
      lastInsertRowid = id;
    }
    // UPDATE orders SET provider_order_id
    else if (this.sql.includes("UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?")) {
      const [provider_order_id, id] = params;
      const order = data.orders.find(o => o.id === id);
      if (order) { order.provider_order_id = provider_order_id; order.status = 'processing'; }
    }
    // UPDATE orders SET status (fails/retry)
    else if (this.sql.includes("UPDATE orders SET status = ") && this.sql.includes("notes = ? WHERE id = ?")) {
      const statusMatch = this.sql.match(/status\s*=\s*'([^']+)'/i);
      const status = statusMatch ? statusMatch[1] : 'pending';
      const [notes, id] = params;
      const order = data.orders.find(o => o.id === Number(id));
      if (order) { order.status = status; order.notes = notes; }
    }
    // INSERT INTO transactions
    else if (this.sql.includes('INSERT INTO transactions') && this.sql.includes('razorpay_order_id, amount')) {
      const [user_id, razorpay_order_id, amount] = params;
      const id = data.transactions.length > 0 ? Math.max(...data.transactions.map(t => t.id)) + 1 : 1;
      data.transactions.push({ id, user_id, razorpay_order_id, razorpay_payment_id: null, amount, status: 'pending', created_at: new Date().toISOString() });
      lastInsertRowid = id;
    }
    else if (this.sql.includes('INSERT INTO transactions') && this.sql.includes('razorpay_order_id, razorpay_payment_id')) {
      let user_id, razorpay_order_id, razorpay_payment_id, amount, status;
      if (params.length === 3) {
        [user_id, razorpay_payment_id, amount] = params;
        razorpay_order_id = null; status = 'pending';
      } else if (params.length === 4) {
        [user_id, razorpay_payment_id, amount, status] = params;
        razorpay_order_id = null;
      } else {
        [user_id, razorpay_order_id, razorpay_payment_id, amount, status] = params;
      }
      const id = data.transactions.length > 0 ? Math.max(...data.transactions.map(t => t.id)) + 1 : 1;
      data.transactions.push({ id, user_id, razorpay_order_id, razorpay_payment_id, amount: parseFloat(Number(amount).toFixed(2)), status: status || 'pending', created_at: new Date().toISOString() });
      lastInsertRowid = id;
    }
    // UPDATE transactions SET status
    else if (this.sql.includes('UPDATE transactions SET status = ?, razorpay_payment_id = ? WHERE id = ?')) {
      const [status, razorpay_payment_id, id] = params;
      const txn = data.transactions.find(t => t.id === Number(id));
      if (txn) { txn.status = status; txn.razorpay_payment_id = razorpay_payment_id; }
    }
    else if (this.sql.includes('UPDATE transactions SET status = ? WHERE id = ?')) {
      const [status, id] = params;
      const txn = data.transactions.find(t => t.id === Number(id));
      if (txn) txn.status = status;
    }
    // UPDATE orders SET status
    else if (this.sql.includes('UPDATE orders SET status = ? WHERE id = ?')) {
      const [status, id] = params;
      const order = data.orders.find(o => o.id === Number(id));
      if (order) order.status = status;
    }
    // UPDATE services 
    else if (this.sql.includes('UPDATE services SET provider_service_id = ? WHERE id = ?')) {
      const [provider_service_id, id] = params;
      const svc = data.services.find(s => s.id === Number(id));
      if (svc) svc.provider_service_id = provider_service_id;
    }
    else if (this.sql.includes('UPDATE orders SET status = ?, remains = ? WHERE id = ?')) {
      const [status, remains, id] = params;
      const order = data.orders.find(o => o.id === Number(id));
      if (order) { order.status = status; order.remains = remains; }
    }
    else if (this.sql.includes("UPDATE orders SET status = 'cancelled' WHERE id = ?")) {
      const [id] = params;
      const order = data.orders.find(o => o.id === Number(id));
      if (order) order.status = 'cancelled';
    }
    // INSERT INTO services (10 cols)
    else if (this.sql.includes('INSERT INTO services (platform, name, description, rate, min_qty, max_qty, delivery_time, provider_service_id, active, original_rate)')) {
      const [platform, name, description, rate, min_qty, max_qty, delivery_time, provider_service_id, active, original_rate] = params;
      const id = data.services.length > 0 ? Math.max(...data.services.map(s => s.id)) + 1 : 1;
      data.services.push({ id, platform, name, description, rate, min_qty, max_qty, delivery_time, provider_service_id, active: active !== undefined ? active : 1, original_rate });
      lastInsertRowid = id;
    }
    // UPDATE services with original_rate
    else if (this.sql.includes('UPDATE services SET rate = ?, min_qty = ?, max_qty = ?, original_rate = ? WHERE id = ?')) {
      const [rate, min_qty, max_qty, original_rate, id] = params;
      const svc = data.services.find(s => s.id === Number(id));
      if (svc) { svc.rate = rate; svc.min_qty = min_qty; svc.max_qty = max_qty; svc.original_rate = original_rate; }
    }
    else if (this.sql.includes('UPDATE services SET rate = ?, provider_service_id = ?, min_qty = ?, max_qty = ?, original_rate = ? WHERE id = ?')) {
      const [rate, provider_service_id, min_qty, max_qty, original_rate, id] = params;
      const svc = data.services.find(s => s.id === Number(id));
      if (svc) { svc.rate = rate; svc.provider_service_id = provider_service_id; svc.min_qty = min_qty; svc.max_qty = max_qty; svc.original_rate = original_rate; }
    }

    writeData(data);
    return { lastInsertRowid, changes: 1 };
  }

  all(...params) {
    const data = getFreshData();
    if (this.sql.includes('SELECT * FROM services WHERE active = 1')) return data.services.filter(s => s.active === 1);
    if (this.sql.includes('SELECT * FROM services') && !this.sql.includes('WHERE')) return data.services;
    if (this.sql.includes('SELECT * FROM services WHERE platform = ? AND active = 1')) return data.services.filter(s => s.platform === params[0] && s.active === 1);

    if (this.sql.includes('SELECT o.*, s.name as service_name, s.platform FROM orders')) {
      return data.orders
        .filter(o => o.user_id === params[0])
        .map(o => {
          const s = data.services.find(svc => svc.id === o.service_id);
          return { ...o, service_name: s ? s.name : 'Unknown', platform: s ? s.platform : 'other' };
        }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    if (this.sql.includes('SELECT * FROM transactions WHERE user_id = ?')) {
      return data.transactions.filter(t => t.user_id === params[0]).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    if (this.sql.includes('SELECT t.*, u.name as user_name, u.email as user_email FROM transactions t')) {
      return data.transactions.map(t => {
        const u = data.users.find(usr => usr.id === t.user_id);
        return { ...t, user_name: u ? u.name : 'Unknown', user_email: u ? u.email : 'Unknown' };
      }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    if (this.sql.includes('SELECT o.*, u.name as user_name, s.name as service_name FROM orders')) {
      return data.orders.map(o => {
        const u = data.users.find(usr => usr.id === o.user_id);
        const s = data.services.find(svc => svc.id === o.service_id);
        return { ...o, user_name: u ? u.name : 'Unknown', service_name: s ? s.name : 'Unknown' };
      }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    if (this.sql.includes('SELECT id, name, email, balance, role, created_at FROM users')) return data.users;
    if (this.sql.includes("SELECT id, provider_order_id FROM orders WHERE status IN ('processing', 'pending', 'retry')")) {
      return data.orders.filter(o => ['processing', 'pending', 'retry'].includes(o.status) && o.provider_order_id);
    }
    if (this.sql.includes("SELECT o.*, s.provider_service_id FROM orders o JOIN services s ON o.service_id = s.id WHERE o.status = 'retry'")) {
      return data.orders.filter(o => o.status === 'retry').map(o => {
        const s = data.services.find(svc => svc.id === o.service_id);
        return { ...o, provider_service_id: s ? s.provider_service_id : null };
      }).filter(o => o.provider_service_id);
    }
    return [];
  }
}

module.exports = {
  prepare: (sql) => new Statement(sql),
  getSyncLogs: () => ['Running locally on db.json successfully'],
  syncCloud: async () => true,
  transaction: (fn) => (...args) => fn(...args)
};
