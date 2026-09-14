const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const https = require('https');
const db = require('./db');
const path = require('path');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.use(express.static('public'));

const WALLET = (() => {
  try {
    const w = require('./secrets/wallet.json');
    return (w.address || w.eth || '').toLowerCase();
  } catch (e) {
    return '0x1b8ba746097cb889c1ce4adfc8202354b8750ef1';
  }
})();
const PRICE_USD = 49;

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'invoiceflow' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function ethPriceUsd() {
  try {
    const d = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    return d.ethereum.usd;
  } catch (e) {
    return 3000;
  }
}

function genLicense(emailOrOrder) {
  const seed = crypto.createHash('sha256').update('invoiceflow-license-' + emailOrOrder + '::$49').digest('hex').toUpperCase();
  return 'IVF-' + seed.slice(0, 4) + '-' + seed.slice(4, 8) + '-' + seed.slice(8, 12) + '-' + seed.slice(12, 16);
}

async function checkEthPayment(order) {
  const minEth = (order.expected_eth || 0) * 0.98;
  try {
    const url = `https://eth.blockscout.com/api/v2/addresses/${WALLET}/transactions?items_count=50`;
    const d = await getJson(url);
    for (const tx of d.items || []) {
      if (!tx.to || !tx.to.hash) continue;
      if (tx.to.hash.toLowerCase() !== WALLET) continue;
      const valueWei = tx.value ? tx.value.toString() : '0';
      const valueEth = parseInt(valueWei) / 1e18;
      if (valueEth >= minEth && valueEth > 0) {
        return { ok: true, txHash: tx.hash, valueEth };
      }
    }
  } catch (e) { /* try tokens anyway */ }

  try {
    const url = `https://eth.blockscout.com/api/v2/addresses/${WALLET}/token-transfers?items_count=50`;
    const d = await getJson(url);
    for (const tx of d.items || []) {
      if (!tx.to || !tx.to.hash) continue;
      if (tx.to.hash.toLowerCase() !== WALLET) continue;
      if (!tx.token || !tx.total) continue;
      const symbol = (tx.token.symbol || '').toUpperCase();
      if (symbol !== 'USDT' && symbol !== 'USDC') continue;
      const amt = parseFloat(tx.total.value) / Math.pow(10, tx.total.decimals || 6);
      if (amt >= minEth) {
        return { ok: true, txHash: (tx.transaction_hash || tx.hash), valueEth: amt, token: symbol };
      }
    }
  } catch (e) { /* no detection */ }

  return { ok: false };
}

let demoUser = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@invoiceflow.app');
if (!demoUser) {
  const info = db.prepare('INSERT INTO users (email, company, name) VALUES (?, ?, ?)')
    .run('demo@invoiceflow.app', 'Demo Studio', 'Demo User');
  demoUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const client1 = db.prepare('INSERT INTO clients (user_id, name, email, company, address, phone) VALUES (?,?,?,?,?,?)')
    .run(demoUser.id, 'Alex Johnson', 'alex@acmecorp.com', 'Acme Corp', '123 Main St, San Francisco, CA', '+1 (555) 012-3456');
  const client2 = db.prepare('INSERT INTO clients (user_id, name, email, company, address, phone) VALUES (?,?,?,?,?,?)')
    .run(demoUser.id, 'Sarah Chen', 'sarah@bluepixel.io', 'Blue Pixel', '456 Oak Ave, Seattle, WA', '+1 (555) 987-6543');
  const invInfo = db.prepare('INSERT INTO invoices (user_id, client_id, number, status, issue_date, due_date, subtotal, tax_rate, tax_amount, total, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(demoUser.id, client1.lastInsertRowid, 'INV-001', 'paid', dateISO(-30), dateISO(0), 2500, 8, 200, 2700, 'Design & development services');
  db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)').run(invInfo.lastInsertRowid, 'Website redesign', 1, 1800, 1800);
  db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)').run(invInfo.lastInsertRowid, 'Logo & branding', 1, 700, 700);
  const invInfo2 = db.prepare('INSERT INTO invoices (user_id, client_id, number, status, issue_date, due_date, subtotal, tax_rate, tax_amount, total, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(demoUser.id, client2.lastInsertRowid, 'INV-002', 'pending', dateISO(-10), dateISO(20), 4200, 8, 336, 4536, 'Monthly retainer - Q3');
  db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)').run(invInfo2.lastInsertRowid, 'Development (40h)', 40, 90, 3600);
  db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)').run(invInfo2.lastInsertRowid, 'Consulting (4h)', 4, 150, 600);
}

function dateISO(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().split('T')[0];
}

function nextInvoiceNumber(userId) {
  const row = db.prepare('SELECT MAX(CAST(REPLACE(number, "INV-", "") AS INTEGER)) as max FROM invoices WHERE user_id = ?').get(userId);
  const next = (row.max || 0) + 1;
  return 'INV-' + String(next).padStart(3, '0');
}

function recalcInvoice(invoiceId) {
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  const taxAmount = subtotal * (invoice.tax_rate / 100);
  const total = subtotal - invoice.discount + taxAmount;
  db.prepare('UPDATE invoices SET subtotal = ?, tax_amount = ?, total = ? WHERE id = ?')
    .run(subtotal, taxAmount, total, invoiceId);
  return { ...invoice, subtotal, tax_amount: taxAmount, total, items };
}

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/register', (req, res) => {
  const { email, company, name } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  try {
    const info = db.prepare('INSERT INTO users (email, company, name) VALUES (?,?,?)').run(email, company || '', name || '');
    return res.json({ id: info.lastInsertRowid, email, company, name });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/users', (req, res) => res.json(db.prepare('SELECT * FROM users').all()));

app.get('/api/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.patch('/api/users/:id', (req, res) => {
  const { company, name, currency } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET company = ?, name = ?, currency = ? WHERE id = ?')
    .run(company ?? user.company, name ?? user.name, currency ?? user.currency, req.params.id);
  res.json(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id));
});

app.get('/api/users/:id/clients', (req, res) => {
  res.json(db.prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id));
});

app.post('/api/users/:id/clients', (req, res) => {
  const { name, email, company, address, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name required' });
  const info = db.prepare('INSERT INTO clients (user_id, name, email, company, address, phone) VALUES (?,?,?,?,?,?)')
    .run(req.params.id, name, email || '', company || '', address || '', phone || '');
  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/clients/:id', (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/users/:id/invoices', (req, res) => {
  const invoices = db.prepare(`
    SELECT i.*, c.name as client_name, c.company as client_company,
      (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
    FROM invoices i LEFT JOIN clients c ON i.client_id = c.id
    WHERE i.user_id = ? ORDER BY i.created_at DESC
  `).all(req.params.id);
  res.json(invoices);
});

app.get('/api/invoices/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoice.id);
  invoice.client = db.prepare('SELECT * FROM clients WHERE id = ?').get(invoice.client_id);
  res.json(invoice);
});

app.post('/api/users/:id/invoices', (req, res) => {
  const { client_id, issue_date, due_date, tax_rate, discount, notes } = req.body;
  const number = nextInvoiceNumber(req.params.id);
  const info = db.prepare('INSERT INTO invoices (user_id, client_id, number, status, issue_date, due_date, tax_rate, discount, notes) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(req.params.id, client_id, number, 'draft', issue_date || dateISO(0), due_date || dateISO(30), tax_rate || 0, discount || 0, notes || '');
  res.json({ id: info.lastInsertRowid, number });
});

app.put('/api/invoices/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const { client_id, issue_date, due_date, status, tax_rate, discount, notes } = req.body;
  db.prepare('UPDATE invoices SET client_id = ?, issue_date = ?, due_date = ?, status = ?, tax_rate = ?, discount = ?, notes = ? WHERE id = ?')
    .run(client_id ?? invoice.client_id, issue_date ?? invoice.issue_date, due_date ?? invoice.due_date,
      status ?? invoice.status, tax_rate ?? invoice.tax_rate, discount ?? invoice.discount, notes ?? invoice.notes, req.params.id);
  if (status === 'paid') {
    db.prepare('UPDATE invoices SET paid_at = datetime("now") WHERE id = ?').run(req.params.id);
  }
  res.json(recalcInvoice(req.params.id));
});

db.prepare('CREATE TRIGGER IF NOT EXISTS update_amt BEFORE INSERT ON invoice_items BEGIN SELECT CASE WHEN NEW.amount = 0 THEN RAISE(ABORT, "amount 0") END; END;');

app.post('/api/invoices/:id/items', (req, res) => {
  const { description, quantity, unit_price } = req.body;
  if (!description) return res.status(400).json({ error: 'Description required' });
  const amount = (quantity || 1) * (unit_price || 0);
  db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)')
    .run(req.params.id, description, quantity || 1, unit_price || 0, amount);
  res.json(recalcInvoice(req.params.id));
});

app.delete('/api/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('DELETE FROM invoice_items WHERE id = ?').run(req.params.id);
  res.json(recalcInvoice(item.invoice_id));
});

app.delete('/api/invoices/:id', (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/pricing', async (req, res) => {
  const priceUsd = await ethPriceUsd();
  res.json({ amount_usd: PRICE_USD, eth: +(PRICE_USD / priceUsd).toFixed(5), wallet: WALLET, price_usd: priceUsd });
});

app.post('/api/orders', async (req, res) => {
  const { email } = req.body;
  const id = crypto.randomBytes(6).toString('hex');
  const priceUsd = await ethPriceUsd();
  const expectedEth = +(PRICE_USD / priceUsd).toFixed(5);
  db.prepare('INSERT INTO orders (id, email, amount_usd, expected_eth, status) VALUES (?,?,?,?,?)')
    .run(id, email || '', PRICE_USD, expectedEth, 'pending');
  res.json({ order_id: id, amount_usd: PRICE_USD, eth: expectedEth, wallet: WALLET, price_usd: priceUsd });
});

app.get('/api/orders/:id', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'pending') {
    const r = await checkEthPayment(order);
    if (r.ok) {
      const key = genLicense(order.id + order.email);
      db.prepare('UPDATE orders SET status = ?, tx_hash = ?, license_key = ?, paid_at = datetime("now") WHERE id = ?')
        .run('paid', r.txHash, key, order.id);
      order.status = 'paid';
      order.license_key = key;
      order.tx_hash = r.txHash;
    }
  }
  res.json(order);
});

app.post('/api/orders/:id/confirm', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const r = await checkEthPayment(order);
  if (!r.ok) return res.json({ status: order.status, detected: false });
  const key = genLicense(order.id + order.email);
  db.prepare('UPDATE orders SET status = ?, tx_hash = ?, license_key = ?, paid_at = datetime("now") WHERE id = ?')
    .run('paid', r.txHash, key, order.id);
  res.json({ status: 'paid', detected: true, license_key: key, tx_hash: r.txHash });
});

app.get('/api/orders/:id/download', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order || order.status !== 'paid') return res.status(403).json({ error: 'Not paid' });
  const tarball = path.join(__dirname, 'invoiceflow-source.tar.gz');
  if (!require('fs').existsSync(tarball)) return res.status(404).json({ error: 'Source not prepared yet' });
  res.download(tarball, 'invoiceflow-source.tar.gz');
});

const STATS_STEPS_HOURS = process.env.PORT || 3000;
app.listen(STATS_STEPS_HOURS, () => {
  console.log(`InvoiceFlow running at http://localhost:${STATS_STEPS_HOURS}`);
  const stats = {
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    clients: db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
    invoices: db.prepare('SELECT COUNT(*) as c FROM invoices').get().c,
  };
  console.log('Stats:', stats);
});