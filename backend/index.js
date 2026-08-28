require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 8080;

// ─── Database Pools ───────────────────────────────────────────────────────────
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
};

const cardsPool = mysql.createPool({ ...dbConfig, database: process.env.CARDS_DB_NAME || 'cards_db' });
const transactionsPool = mysql.createPool({ ...dbConfig, database: process.env.TRANSACTIONS_DB_NAME || 'transactions_db' });
const loansPool = mysql.createPool({ ...dbConfig, database: process.env.LOANS_DB_NAME || 'loans_db' });

// Users table lives in cards_db
const authPool = cardsPool;

// ─── Database Initialization ──────────────────────────────────────────────────
async function init() {
  // Users table
  const authConn = await authPool.getConnection();
  await authConn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(128) NOT NULL,
      email VARCHAR(128) UNIQUE NOT NULL,
      password VARCHAR(256) NOT NULL,
      account_id VARCHAR(64) UNIQUE NOT NULL,
      phone VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  authConn.release();

  // Cards table
  const cardsConn = await cardsPool.getConnection();
  await cardsConn.query(`
    CREATE TABLE IF NOT EXISTS cards (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id VARCHAR(64) NOT NULL,
      card_number_masked VARCHAR(32) NOT NULL,
      card_type VARCHAR(32) NOT NULL,
      card_network VARCHAR(16) DEFAULT 'VISA',
      expiry_date VARCHAR(7),
      credit_limit DECIMAL(12,2) DEFAULT 0,
      available_balance DECIMAL(12,2) DEFAULT 0,
      status VARCHAR(16) DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  cardsConn.release();

  // Transactions table
  const txnConn = await transactionsPool.getConnection();
  await txnConn.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id VARCHAR(64) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      type VARCHAR(16) NOT NULL,
      category VARCHAR(32),
      description VARCHAR(255),
      reference_id VARCHAR(64),
      balance_after DECIMAL(14,2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  txnConn.release();

  // Loans table
  const loansConn = await loansPool.getConnection();
  await loansConn.query(`
    CREATE TABLE IF NOT EXISTS loans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id VARCHAR(64) NOT NULL,
      loan_type VARCHAR(32) NOT NULL,
      principal DECIMAL(14,2) NOT NULL,
      interest_rate DECIMAL(5,2) NOT NULL,
      tenure_months INT NOT NULL,
      emi DECIMAL(12,2),
      total_payable DECIMAL(14,2),
      amount_paid DECIMAL(14,2) DEFAULT 0,
      status VARCHAR(16) DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  loansConn.release();

  console.log('All database tables initialized');
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'backend-service' }));

// ─── Auth API (Simple - no JWT) ───────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { full_name, email, password, phone } = req.body;
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required' });
    }

    const [existing] = await authPool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const account_id = 'ACC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    const [result] = await authPool.query(
      'INSERT INTO users (full_name, email, password, account_id, phone) VALUES (?, ?, ?, ?, ?)',
      [full_name, email, password, account_id, phone || null]
    );

    res.status(201).json({
      message: 'Registration successful',
      user: { id: result.insertId, full_name, email, account_id, phone }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [users] = await authPool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    if (user.password !== password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({
      message: 'Login successful',
      user: { id: user.id, full_name: user.full_name, email: user.email, account_id: user.account_id, phone: user.phone }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cards API ────────────────────────────────────────────────────────────────
app.get('/api/cards/:accountId', async (req, res) => {
  try {
    const [rows] = await cardsPool.query('SELECT * FROM cards WHERE account_id = ?', [req.params.accountId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards', async (req, res) => {
  try {
    const { account_id, card_type, card_network } = req.body;
    const card_number_masked = '**** **** **** ' + Math.floor(1000 + Math.random() * 9000);
    const expiry_date = `${String(new Date().getMonth() + 1).padStart(2, '0')}/${new Date().getFullYear() + 5}`;
    const credit_limit = card_type === 'CREDIT' ? 200000 : 0;

    const [result] = await cardsPool.query(
      'INSERT INTO cards (account_id, card_number_masked, card_type, card_network, expiry_date, credit_limit, available_balance) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [account_id, card_number_masked, card_type || 'DEBIT', card_network || 'VISA', expiry_date, credit_limit, credit_limit]
    );
    res.status(201).json({ id: result.insertId, card_number_masked, card_type, expiry_date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/cards/:id/block', async (req, res) => {
  try {
    await cardsPool.query('UPDATE cards SET status = "BLOCKED" WHERE id = ?', [req.params.id]);
    res.json({ message: 'Card blocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transactions API ─────────────────────────────────────────────────────────
app.get('/api/transactions/:accountId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const [rows] = await transactionsPool.query(
      'SELECT * FROM transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [req.params.accountId, limit, offset]
    );
    const [[{ total }]] = await transactionsPool.query(
      'SELECT COUNT(*) as total FROM transactions WHERE account_id = ?',
      [req.params.accountId]
    );
    res.json({ transactions: rows, total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions', async (req, res) => {
  try {
    const { account_id, amount, type, category, description } = req.body;
    const reference_id = 'TXN' + Date.now().toString(36).toUpperCase();
    const [result] = await transactionsPool.query(
      'INSERT INTO transactions (account_id, amount, type, category, description, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
      [account_id, amount, type, category || 'GENERAL', description || '', reference_id]
    );
    res.status(201).json({ id: result.insertId, reference_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Loans API ────────────────────────────────────────────────────────────────
app.get('/api/loans/:accountId', async (req, res) => {
  try {
    const [rows] = await loansPool.query('SELECT * FROM loans WHERE account_id = ?', [req.params.accountId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/loans', async (req, res) => {
  try {
    const { account_id, loan_type, principal, interest_rate, tenure_months } = req.body;
    const r = interest_rate / 12 / 100;
    const emi = principal * r * Math.pow(1 + r, tenure_months) / (Math.pow(1 + r, tenure_months) - 1);
    const total_payable = emi * tenure_months;

    const [result] = await loansPool.query(
      'INSERT INTO loans (account_id, loan_type, principal, interest_rate, tenure_months, emi, total_payable) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [account_id, loan_type || 'PERSONAL', principal, interest_rate, tenure_months, emi.toFixed(2), total_payable.toFixed(2)]
    );
    res.status(201).json({ id: result.insertId, emi: emi.toFixed(2), total_payable: total_payable.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard API ────────────────────────────────────────────────────────────
app.get('/api/dashboard/:accountId', async (req, res) => {
  try {
    const accountId = req.params.accountId;
    const [[{ cardCount }]] = await cardsPool.query('SELECT COUNT(*) as cardCount FROM cards WHERE account_id = ?', [accountId]);
    const [[{ loanCount }]] = await loansPool.query('SELECT COUNT(*) as loanCount FROM loans WHERE account_id = ?', [accountId]);
    const [[{ txnCount }]] = await transactionsPool.query('SELECT COUNT(*) as txnCount FROM transactions WHERE account_id = ?', [accountId]);
    const [recentTxns] = await transactionsPool.query(
      'SELECT * FROM transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT 5',
      [accountId]
    );
    res.json({
      cards: cardCount,
      loans: loanCount,
      transactions: txnCount,
      recentTransactions: recentTxns
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
init()
  .then(() => app.listen(PORT, () => console.log(`backend-service listening on ${PORT}`)))
  .catch((err) => {
    console.error('DB init failed', err);
    process.exit(1);
  });
