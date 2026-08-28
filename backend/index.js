const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Database connection pool
let pool;

async function initializeDatabase() {
  const sslConfig = process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: true };

  // First connect without database to create it if needed
  const tempConnection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 3306,
    ssl: sslConfig
  });

  await tempConnection.execute(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'banking_db'}\``);
  await tempConnection.end();

  // Create pool with database
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || 'banking_db',
    ssl: sslConfig,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0
  });

  // Create tables
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      date_of_birth DATE,
      address VARCHAR(500),
      city VARCHAR(100),
      state VARCHAR(100),
      country VARCHAR(100),
      role ENUM('user', 'admin') DEFAULT 'user',
      status ENUM('active', 'inactive') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      account_number VARCHAR(8) NOT NULL UNIQUE,
      account_type ENUM('savings', 'current') DEFAULT 'savings',
      balance DECIMAL(14,2) DEFAULT 50000.00,
      status ENUM('active', 'inactive', 'frozen') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      reference_id VARCHAR(50) NOT NULL UNIQUE,
      sender_account VARCHAR(8),
      receiver_account VARCHAR(8),
      amount DECIMAL(12,2) NOT NULL,
      type ENUM('TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'REFUND') NOT NULL,
      description VARCHAR(500),
      status ENUM('COMPLETED', 'PENDING', 'FAILED') DEFAULT 'COMPLETED',
      sender_balance_after DECIMAL(14,2),
      receiver_balance_after DECIMAL(14,2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS beneficiaries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      beneficiary_account VARCHAR(8) NOT NULL,
      beneficiary_name VARCHAR(255),
      nickname VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      type ENUM('CREDIT', 'DEBIT', 'SYSTEM', 'SECURITY') DEFAULT 'SYSTEM',
      is_read BOOLEAN DEFAULT FALSE,
      reference_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS cards (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      card_number VARCHAR(16) NOT NULL UNIQUE,
      card_type ENUM('DEBIT', 'CREDIT') DEFAULT 'DEBIT',
      card_network ENUM('VISA', 'MASTERCARD', 'RUPAY') DEFAULT 'RUPAY',
      expiry_date VARCHAR(7),
      credit_limit DECIMAL(12,2) DEFAULT 0,
      available_balance DECIMAL(12,2) DEFAULT 0,
      status ENUM('ACTIVE', 'BLOCKED') DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS loans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      loan_type ENUM('PERSONAL', 'HOME', 'VEHICLE', 'EDUCATION', 'BUSINESS') DEFAULT 'PERSONAL',
      principal DECIMAL(14,2) NOT NULL,
      interest_rate DECIMAL(5,2) NOT NULL,
      tenure_months INT NOT NULL,
      emi DECIMAL(12,2) NOT NULL,
      total_payable DECIMAL(14,2) NOT NULL,
      amount_paid DECIMAL(14,2) DEFAULT 0,
      status ENUM('PENDING', 'APPROVED', 'ACTIVE', 'REJECTED', 'CLOSED') DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  console.log('Veera_NareshIT_Bank database initialized successfully');
}

// Helper: Generate unique 8-digit account number
async function generateAccountNumber() {
  let accountNumber;
  let exists = true;
  while (exists) {
    accountNumber = String(Math.floor(10000000 + Math.random() * 90000000));
    const [rows] = await pool.execute('SELECT id FROM accounts WHERE account_number = ?', [accountNumber]);
    exists = rows.length > 0;
  }
  return accountNumber;
}

// Helper: Generate transaction reference ID - TXN + YYYYMMDD + HHmmss + 4 random digits
function generateReferenceId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const random = String(Math.floor(1000 + Math.random() * 9000));
  return `TXN${year}${month}${day}${hours}${minutes}${seconds}${random}`;
}

// ==================== AUTH ROUTES ====================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { full_name, email, password, phone, date_of_birth, address, city, state, country } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Full name, email, and password are required' });
    }

    // Check if email already exists
    const [existingUsers] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // Create user
    const [userResult] = await pool.execute(
      `INSERT INTO users (full_name, email, password_hash, phone, date_of_birth, address, city, state, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [full_name, email, password_hash, phone || null, date_of_birth || null, address || null, city || null, state || null, country || null]
    );

    const userId = userResult.insertId;

    // Generate unique account number
    const accountNumber = await generateAccountNumber();

    // Create account with initial balance
    const [accountResult] = await pool.execute(
      `INSERT INTO accounts (user_id, account_number, account_type, balance) VALUES (?, ?, 'savings', 50000.00)`,
      [userId, accountNumber]
    );

    // Create welcome notification
    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'SYSTEM')`,
      [userId, 'Welcome to Veera_NareshIT_Bank!', `Your account ${accountNumber} has been created with an initial balance of ₹50,000.00`]
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      user: {
        id: userId,
        full_name,
        email,
        phone,
        role: 'user',
        status: 'active'
      },
      account: {
        id: accountResult.insertId,
        account_number: accountNumber,
        account_type: 'savings',
        balance: 50000.00,
        status: 'active'
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const user = users[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    if (user.status === 'inactive') {
      return res.status(403).json({ success: false, message: 'Account is inactive. Contact support.' });
    }

    // Get account info
    const [accounts] = await pool.execute('SELECT * FROM accounts WHERE user_id = ?', [user.id]);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        date_of_birth: user.date_of_birth,
        address: user.address,
        city: user.city,
        state: user.state,
        country: user.country,
        role: user.role,
        status: user.status,
        created_at: user.created_at
      },
      account: accounts.length > 0 ? {
        id: accounts[0].id,
        account_number: accounts[0].account_number,
        account_type: accounts[0].account_type,
        balance: parseFloat(accounts[0].balance),
        status: accounts[0].status,
        created_at: accounts[0].created_at
      } : null
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== ACCOUNT ROUTES ====================

// GET /api/account/:accountId
app.get('/api/account/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    const [accounts] = await pool.execute(
      `SELECT a.*, u.full_name FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.id = ?`,
      [accountId]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const account = accounts[0];
    res.json({
      success: true,
      account: {
        id: account.id,
        user_id: account.user_id,
        full_name: account.full_name,
        account_number: account.account_number,
        account_type: account.account_type,
        balance: parseFloat(account.balance),
        status: account.status,
        created_at: account.created_at
      }
    });
  } catch (error) {
    console.error('Get account error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/account/:accountId/balance
app.get('/api/account/:accountId/balance', async (req, res) => {
  try {
    const { accountId } = req.params;

    const [accounts] = await pool.execute('SELECT balance, account_number FROM accounts WHERE id = ?', [accountId]);

    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    res.json({
      success: true,
      account_number: accounts[0].account_number,
      balance: parseFloat(accounts[0].balance)
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/account/lookup/:accountNumber
app.get('/api/account/lookup/:accountNumber', async (req, res) => {
  try {
    const { accountNumber } = req.params;

    if (!/^\d{8}$/.test(accountNumber)) {
      return res.status(400).json({ success: false, message: 'Invalid account number format' });
    }

    const [accounts] = await pool.execute(
      `SELECT a.account_number, a.status, u.full_name FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.account_number = ?`,
      [accountNumber]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const account = accounts[0];
    // Mask the name: show first 2 chars + *** + last char
    const name = account.full_name;
    const maskedName = name.length > 3
      ? name.substring(0, 2) + '***' + name.substring(name.length - 1)
      : name.substring(0, 1) + '***';

    res.json({
      success: true,
      account_number: account.account_number,
      account_holder: maskedName,
      status: account.status
    });
  } catch (error) {
    console.error('Lookup error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== TRANSFER ROUTE (ATOMIC) ====================

// POST /api/transfer
app.post('/api/transfer', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { sender_account, receiver_account, amount, description } = req.body;

    // Input validation
    if (!sender_account || !receiver_account || !amount) {
      connection.release();
      return res.status(400).json({ success: false, message: 'sender_account, receiver_account, and amount are required' });
    }

    const transferAmount = parseFloat(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) {
      connection.release();
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    if (sender_account === receiver_account) {
      connection.release();
      return res.status(400).json({ success: false, message: 'Cannot transfer to the same account' });
    }

    // Start transaction
    await connection.beginTransaction();

    // Lock sender and receiver rows
    const [senderRows] = await connection.execute(
      'SELECT a.*, u.id as uid FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.account_number = ? FOR UPDATE',
      [sender_account]
    );

    if (senderRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Sender account not found' });
    }

    const sender = senderRows[0];

    if (sender.status !== 'active') {
      await connection.rollback();
      connection.release();
      return res.status(403).json({ success: false, message: 'Sender account is not active' });
    }

    const [receiverRows] = await connection.execute(
      'SELECT a.*, u.id as uid FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.account_number = ? FOR UPDATE',
      [receiver_account]
    );

    if (receiverRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Receiver account not found' });
    }

    const receiver = receiverRows[0];

    if (receiver.status !== 'active') {
      await connection.rollback();
      connection.release();
      return res.status(403).json({ success: false, message: 'Receiver account is not active' });
    }

    // Check sufficient balance
    const senderBalance = parseFloat(sender.balance);
    if (senderBalance < transferAmount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Calculate new balances
    const senderBalanceAfter = senderBalance - transferAmount;
    const receiverBalanceAfter = parseFloat(receiver.balance) + transferAmount;

    // Deduct from sender
    await connection.execute(
      'UPDATE accounts SET balance = ? WHERE account_number = ?',
      [senderBalanceAfter, sender_account]
    );

    // Credit to receiver
    await connection.execute(
      'UPDATE accounts SET balance = ? WHERE account_number = ?',
      [receiverBalanceAfter, receiver_account]
    );

    // Generate reference ID
    const referenceId = generateReferenceId();

    // Create transaction record
    await connection.execute(
      `INSERT INTO transactions (reference_id, sender_account, receiver_account, amount, type, description, status, sender_balance_after, receiver_balance_after)
       VALUES (?, ?, ?, ?, 'TRANSFER', ?, 'COMPLETED', ?, ?)`,
      [referenceId, sender_account, receiver_account, transferAmount, description || 'Fund Transfer', senderBalanceAfter, receiverBalanceAfter]
    );

    // Create notification for sender
    await connection.execute(
      `INSERT INTO notifications (user_id, title, message, type, reference_id) VALUES (?, ?, ?, 'DEBIT', ?)`,
      [sender.uid, 'Debit - Fund Transfer', `₹${transferAmount.toFixed(2)} debited from account ${sender_account}. Sent to ${receiver_account}. Balance: ₹${senderBalanceAfter.toFixed(2)}`, referenceId]
    );

    // Create notification for receiver
    await connection.execute(
      `INSERT INTO notifications (user_id, title, message, type, reference_id) VALUES (?, ?, ?, 'CREDIT', ?)`,
      [receiver.uid, 'Credit - Fund Transfer', `₹${transferAmount.toFixed(2)} credited to account ${receiver_account}. Received from ${sender_account}. Balance: ₹${receiverBalanceAfter.toFixed(2)}`, referenceId]
    );

    // Commit transaction
    await connection.commit();
    connection.release();

    res.json({
      success: true,
      message: 'Transfer successful',
      transaction: {
        reference_id: referenceId,
        sender_account,
        receiver_account,
        amount: transferAmount,
        type: 'TRANSFER',
        description: description || 'Fund Transfer',
        status: 'COMPLETED',
        sender_balance_after: senderBalanceAfter,
        receiver_balance_after: receiverBalanceAfter,
        created_at: new Date()
      }
    });
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error('Transfer error:', error);
    res.status(500).json({ success: false, message: 'Transfer failed. Please try again.' });
  }
});

// ==================== DEPOSIT ROUTE ====================

// POST /api/deposit
app.post('/api/deposit', async (req, res) => {
  try {
    const { account_id, amount, description } = req.body;

    if (!account_id || !amount) {
      return res.status(400).json({ success: false, message: 'account_id and amount are required' });
    }

    const depositAmount = parseFloat(amount);
    if (isNaN(depositAmount) || depositAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const [accounts] = await pool.execute('SELECT a.*, u.id as uid FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.id = ?', [account_id]);
    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const account = accounts[0];
    if (account.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is not active' });
    }

    const newBalance = parseFloat(account.balance) + depositAmount;
    const referenceId = generateReferenceId();

    await pool.execute('UPDATE accounts SET balance = ? WHERE id = ?', [newBalance, account_id]);

    await pool.execute(
      `INSERT INTO transactions (reference_id, receiver_account, amount, type, description, status, receiver_balance_after)
       VALUES (?, ?, ?, 'DEPOSIT', ?, 'COMPLETED', ?)`,
      [referenceId, account.account_number, depositAmount, description || 'Cash Deposit', newBalance]
    );

    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type, reference_id) VALUES (?, ?, ?, 'CREDIT', ?)`,
      [account.uid, 'Credit - Deposit', `₹${depositAmount.toFixed(2)} deposited to account ${account.account_number}. Balance: ₹${newBalance.toFixed(2)}`, referenceId]
    );

    res.json({
      success: true,
      message: 'Deposit successful',
      transaction: {
        reference_id: referenceId,
        account_number: account.account_number,
        amount: depositAmount,
        type: 'DEPOSIT',
        balance_after: newBalance,
        status: 'COMPLETED'
      }
    });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== WITHDRAW ROUTE ====================

// POST /api/withdraw
app.post('/api/withdraw', async (req, res) => {
  try {
    const { account_id, amount, description } = req.body;

    if (!account_id || !amount) {
      return res.status(400).json({ success: false, message: 'account_id and amount are required' });
    }

    const withdrawAmount = parseFloat(amount);
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const [accounts] = await pool.execute('SELECT a.*, u.id as uid FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.id = ?', [account_id]);
    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const account = accounts[0];
    if (account.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is not active' });
    }

    const currentBalance = parseFloat(account.balance);
    if (currentBalance < withdrawAmount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    const newBalance = currentBalance - withdrawAmount;
    const referenceId = generateReferenceId();

    await pool.execute('UPDATE accounts SET balance = ? WHERE id = ?', [newBalance, account_id]);

    await pool.execute(
      `INSERT INTO transactions (reference_id, sender_account, amount, type, description, status, sender_balance_after)
       VALUES (?, ?, ?, 'WITHDRAWAL', ?, 'COMPLETED', ?)`,
      [referenceId, account.account_number, withdrawAmount, description || 'Cash Withdrawal', newBalance]
    );

    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type, reference_id) VALUES (?, ?, ?, 'DEBIT', ?)`,
      [account.uid, 'Debit - Withdrawal', `₹${withdrawAmount.toFixed(2)} withdrawn from account ${account.account_number}. Balance: ₹${newBalance.toFixed(2)}`, referenceId]
    );

    res.json({
      success: true,
      message: 'Withdrawal successful',
      transaction: {
        reference_id: referenceId,
        account_number: account.account_number,
        amount: withdrawAmount,
        type: 'WITHDRAWAL',
        balance_after: newBalance,
        status: 'COMPLETED'
      }
    });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== TRANSACTIONS ROUTES ====================

// GET /api/transactions/:accountId
app.get('/api/transactions/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { type, date_from, date_to, limit, offset } = req.query;

    // Get account number from account ID
    const [accounts] = await pool.execute('SELECT account_number FROM accounts WHERE id = ?', [accountId]);
    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const accountNumber = accounts[0].account_number;
    let query = 'SELECT * FROM transactions WHERE (sender_account = ? OR receiver_account = ?)';
    let countQuery = 'SELECT COUNT(*) as total FROM transactions WHERE (sender_account = ? OR receiver_account = ?)';
    let params = [accountNumber, accountNumber];
    let countParams = [accountNumber, accountNumber];

    if (type) {
      query += ' AND type = ?';
      countQuery += ' AND type = ?';
      params.push(type);
      countParams.push(type);
    }

    if (date_from) {
      query += ' AND created_at >= ?';
      countQuery += ' AND created_at >= ?';
      params.push(date_from);
      countParams.push(date_from);
    }

    if (date_to) {
      query += ' AND created_at <= ?';
      countQuery += ' AND created_at <= ?';
      params.push(date_to + ' 23:59:59');
      countParams.push(date_to + ' 23:59:59');
    }

    // Get total count
    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    // Add ordering and pagination
    query += ' ORDER BY created_at DESC';
    const queryLimit = parseInt(limit) || 20;
    const queryOffset = parseInt(offset) || 0;
    query += ' LIMIT ? OFFSET ?';
    params.push(queryLimit, queryOffset);

    const [transactions] = await pool.execute(query, params);

    res.json({
      success: true,
      total,
      limit: queryLimit,
      offset: queryOffset,
      transactions: transactions.map(t => ({
        ...t,
        amount: parseFloat(t.amount),
        sender_balance_after: t.sender_balance_after ? parseFloat(t.sender_balance_after) : null,
        receiver_balance_after: t.receiver_balance_after ? parseFloat(t.receiver_balance_after) : null
      }))
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/transactions/detail/:referenceId
app.get('/api/transactions/detail/:referenceId', async (req, res) => {
  try {
    const { referenceId } = req.params;

    const [transactions] = await pool.execute('SELECT * FROM transactions WHERE reference_id = ?', [referenceId]);

    if (transactions.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const t = transactions[0];
    res.json({
      success: true,
      transaction: {
        ...t,
        amount: parseFloat(t.amount),
        sender_balance_after: t.sender_balance_after ? parseFloat(t.sender_balance_after) : null,
        receiver_balance_after: t.receiver_balance_after ? parseFloat(t.receiver_balance_after) : null
      }
    });
  } catch (error) {
    console.error('Get transaction detail error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== BENEFICIARIES ROUTES ====================

// GET /api/beneficiaries/:userId
app.get('/api/beneficiaries/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [beneficiaries] = await pool.execute(
      'SELECT * FROM beneficiaries WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    res.json({ success: true, beneficiaries });
  } catch (error) {
    console.error('Get beneficiaries error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/beneficiaries
app.post('/api/beneficiaries', async (req, res) => {
  try {
    const { user_id, beneficiary_account, nickname } = req.body;

    if (!user_id || !beneficiary_account) {
      return res.status(400).json({ success: false, message: 'user_id and beneficiary_account are required' });
    }

    if (!/^\d{8}$/.test(beneficiary_account)) {
      return res.status(400).json({ success: false, message: 'Invalid account number format' });
    }

    // Validate account exists
    const [accounts] = await pool.execute(
      'SELECT a.account_number, u.full_name FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.account_number = ?',
      [beneficiary_account]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Beneficiary account not found' });
    }

    // Check for duplicate
    const [existing] = await pool.execute(
      'SELECT id FROM beneficiaries WHERE user_id = ? AND beneficiary_account = ?',
      [user_id, beneficiary_account]
    );

    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Beneficiary already added' });
    }

    const beneficiaryName = accounts[0].full_name;

    const [result] = await pool.execute(
      'INSERT INTO beneficiaries (user_id, beneficiary_account, beneficiary_name, nickname) VALUES (?, ?, ?, ?)',
      [user_id, beneficiary_account, beneficiaryName, nickname || beneficiaryName]
    );

    res.status(201).json({
      success: true,
      message: 'Beneficiary added successfully',
      beneficiary: {
        id: result.insertId,
        user_id,
        beneficiary_account,
        beneficiary_name: beneficiaryName,
        nickname: nickname || beneficiaryName
      }
    });
  } catch (error) {
    console.error('Add beneficiary error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// DELETE /api/beneficiaries/:id
app.delete('/api/beneficiaries/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.execute('DELETE FROM beneficiaries WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Beneficiary not found' });
    }

    res.json({ success: true, message: 'Beneficiary removed successfully' });
  } catch (error) {
    console.error('Delete beneficiary error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== NOTIFICATIONS ROUTES ====================

// GET /api/notifications/:userId
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [notifications] = await pool.execute(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    res.json({ success: true, notifications });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT /api/notifications/:id/read
app.put('/api/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.execute('UPDATE notifications SET is_read = TRUE WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT /api/notifications/read-all/:userId
app.put('/api/notifications/read-all/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    await pool.execute('UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE', [userId]);

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== DASHBOARD ROUTE ====================

// GET /api/dashboard/:accountId
app.get('/api/dashboard/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    // Get account info
    const [accounts] = await pool.execute(
      'SELECT a.*, u.id as uid, u.full_name FROM accounts a JOIN users u ON a.user_id = u.id WHERE a.id = ?',
      [accountId]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const account = accounts[0];
    const accountNumber = account.account_number;

    // Get first day of current month
    const now = new Date();
    const firstDayOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    // Total credits this month
    const [credits] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE receiver_account = ? AND status = 'COMPLETED' AND created_at >= ?`,
      [accountNumber, firstDayOfMonth]
    );

    // Total debits this month
    const [debits] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE sender_account = ? AND status = 'COMPLETED' AND created_at >= ?`,
      [accountNumber, firstDayOfMonth]
    );

    // Transaction count
    const [txnCount] = await pool.execute(
      `SELECT COUNT(*) as count FROM transactions
       WHERE (sender_account = ? OR receiver_account = ?) AND status = 'COMPLETED'`,
      [accountNumber, accountNumber]
    );

    // Recent 5 transactions
    const [recentTransactions] = await pool.execute(
      `SELECT * FROM transactions
       WHERE sender_account = ? OR receiver_account = ?
       ORDER BY created_at DESC LIMIT 5`,
      [accountNumber, accountNumber]
    );

    // Unread notifications count
    const [unreadCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE',
      [account.uid]
    );

    res.json({
      success: true,
      dashboard: {
        account_number: accountNumber,
        full_name: account.full_name,
        balance: parseFloat(account.balance),
        total_credits_this_month: parseFloat(credits[0].total),
        total_debits_this_month: parseFloat(debits[0].total),
        transaction_count: txnCount[0].count,
        recent_transactions: recentTransactions.map(t => ({
          ...t,
          amount: parseFloat(t.amount),
          sender_balance_after: t.sender_balance_after ? parseFloat(t.sender_balance_after) : null,
          receiver_balance_after: t.receiver_balance_after ? parseFloat(t.receiver_balance_after) : null
        })),
        unread_notifications_count: unreadCount[0].count
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== PROFILE ROUTES ====================

// GET /api/profile/:userId
app.get('/api/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [users] = await pool.execute(
      'SELECT id, full_name, email, phone, date_of_birth, address, city, state, country, role, status, created_at, updated_at FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const [accounts] = await pool.execute('SELECT * FROM accounts WHERE user_id = ?', [userId]);

    res.json({
      success: true,
      profile: users[0],
      account: accounts.length > 0 ? {
        ...accounts[0],
        balance: parseFloat(accounts[0].balance)
      } : null
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT /api/profile/:userId
app.put('/api/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { phone, address, city, state } = req.body;

    const fields = [];
    const values = [];

    if (phone !== undefined) { fields.push('phone = ?'); values.push(phone); }
    if (address !== undefined) { fields.push('address = ?'); values.push(address); }
    if (city !== undefined) { fields.push('city = ?'); values.push(city); }
    if (state !== undefined) { fields.push('state = ?'); values.push(state); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    values.push(userId);
    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

    // Return updated profile
    const [users] = await pool.execute(
      'SELECT id, full_name, email, phone, date_of_birth, address, city, state, country, role, status, created_at, updated_at FROM users WHERE id = ?',
      [userId]
    );

    res.json({ success: true, message: 'Profile updated successfully', profile: users[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== CARDS ROUTES ====================

function maskCardNumber(cardNumber) {
  return '•••• •••• •••• ' + cardNumber.slice(-4);
}

// GET /api/cards/:accountId
app.get('/api/cards/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const [cards] = await pool.execute('SELECT * FROM cards WHERE account_id = ? ORDER BY created_at DESC', [accountId]);

    res.json(cards.map(c => ({
      id: c.id,
      account_id: c.account_id,
      card_number_masked: maskCardNumber(c.card_number),
      card_type: c.card_type,
      card_network: c.card_network,
      expiry_date: c.expiry_date,
      credit_limit: parseFloat(c.credit_limit),
      available_balance: parseFloat(c.available_balance),
      status: c.status,
      created_at: c.created_at
    })));
  } catch (error) {
    console.error('Get cards error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/cards
app.post('/api/cards', async (req, res) => {
  try {
    const { account_id, card_type, card_network } = req.body;

    if (!account_id || !card_type) {
      return res.status(400).json({ success: false, message: 'account_id and card_type are required' });
    }

    const [accounts] = await pool.execute('SELECT id FROM accounts WHERE id = ?', [account_id]);
    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    // Generate unique 16-digit card number
    let cardNumber;
    let exists = true;
    while (exists) {
      cardNumber = '4' + String(Math.floor(100000000000000 + Math.random() * 899999999999999));
      const [rows] = await pool.execute('SELECT id FROM cards WHERE card_number = ?', [cardNumber]);
      exists = rows.length > 0;
    }

    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 5);
    const expiry = `${String(expiryDate.getMonth() + 1).padStart(2, '0')}/${expiryDate.getFullYear()}`;

    const creditLimit = card_type === 'CREDIT' ? 100000 : 0;

    const [result] = await pool.execute(
      `INSERT INTO cards (account_id, card_number, card_type, card_network, expiry_date, credit_limit, available_balance, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [account_id, cardNumber, card_type, card_network || 'RUPAY', expiry, creditLimit, creditLimit]
    );

    res.status(201).json({
      success: true,
      message: 'Card issued successfully',
      card: {
        id: result.insertId,
        account_id,
        card_number_masked: maskCardNumber(cardNumber),
        card_type,
        card_network: card_network || 'RUPAY',
        expiry_date: expiry,
        credit_limit: creditLimit,
        available_balance: creditLimit,
        status: 'ACTIVE'
      }
    });
  } catch (error) {
    console.error('Create card error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/cards/:id/reveal
// Returns the full (unmasked) card number for a single card.
// NOTE: like every other route in this app, this is unauthenticated — see README security notes.
app.get('/api/cards/:id/reveal', async (req, res) => {
  try {
    const { id } = req.params;
    const [cards] = await pool.execute('SELECT card_number, expiry_date, card_type, card_network FROM cards WHERE id = ?', [id]);

    if (cards.length === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    const c = cards[0];
    res.json({
      success: true,
      card: {
        id: Number(id),
        card_number: c.card_number,
        card_number_formatted: c.card_number.replace(/(\d{4})(?=\d)/g, '$1 '),
        expiry_date: c.expiry_date,
        card_type: c.card_type,
        card_network: c.card_network
      }
    });
  } catch (error) {
    console.error('Reveal card error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PATCH /api/cards/:id/block
app.patch('/api/cards/:id/block', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute("UPDATE cards SET status = 'BLOCKED' WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    res.json({ success: true, message: 'Card blocked successfully', status: 'BLOCKED' });
  } catch (error) {
    console.error('Block card error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PATCH /api/cards/:id/unblock
app.patch('/api/cards/:id/unblock', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute("UPDATE cards SET status = 'ACTIVE' WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    res.json({ success: true, message: 'Card unblocked successfully', status: 'ACTIVE' });
  } catch (error) {
    console.error('Unblock card error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== LOANS ROUTES ====================

// GET /api/loans/:accountId
app.get('/api/loans/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const [loans] = await pool.execute('SELECT * FROM loans WHERE account_id = ? ORDER BY created_at DESC', [accountId]);

    res.json(loans.map(l => ({
      ...l,
      principal: parseFloat(l.principal),
      interest_rate: parseFloat(l.interest_rate),
      emi: parseFloat(l.emi),
      total_payable: parseFloat(l.total_payable),
      amount_paid: parseFloat(l.amount_paid)
    })));
  } catch (error) {
    console.error('Get loans error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/loans
app.post('/api/loans', async (req, res) => {
  try {
    const { account_id, loan_type, principal, interest_rate, tenure_months } = req.body;

    if (!account_id || !loan_type || !principal || !interest_rate || !tenure_months) {
      return res.status(400).json({ success: false, message: 'All loan fields are required' });
    }

    const P = parseFloat(principal);
    const annualRate = parseFloat(interest_rate);
    const N = parseInt(tenure_months);

    if (P < 10000) {
      return res.status(400).json({ success: false, message: 'Minimum loan amount is ₹10,000' });
    }

    const [accounts] = await pool.execute('SELECT id FROM accounts WHERE id = ?', [account_id]);
    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    // EMI calculation
    const r = annualRate / 12 / 100;
    const emi = P * r * Math.pow(1 + r, N) / (Math.pow(1 + r, N) - 1);
    const totalPayable = emi * N;

    const [result] = await pool.execute(
      `INSERT INTO loans (account_id, loan_type, principal, interest_rate, tenure_months, emi, total_payable, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [account_id, loan_type, P, annualRate, N, emi, totalPayable]
    );

    res.status(201).json({
      success: true,
      message: 'Loan application submitted successfully',
      loan: {
        id: result.insertId,
        account_id,
        loan_type,
        principal: P,
        interest_rate: annualRate,
        tenure_months: N,
        emi,
        total_payable: totalPayable,
        amount_paid: 0,
        status: 'PENDING'
      }
    });
  } catch (error) {
    console.error('Create loan error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== ADMIN ROUTES ====================

// GET /api/admin/stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const [totalUsers] = await pool.execute('SELECT COUNT(*) as count FROM users');
    const [activeAccounts] = await pool.execute("SELECT COUNT(*) as count FROM accounts WHERE status = 'active'");
    const [totalTransactions] = await pool.execute('SELECT COUNT(*) as count FROM transactions');
    const [totalCredits] = await pool.execute("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type IN ('TRANSFER', 'DEPOSIT') AND status = 'COMPLETED'");
    const [totalDebits] = await pool.execute("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type IN ('TRANSFER', 'WITHDRAWAL') AND status = 'COMPLETED'");

    res.json({
      success: true,
      stats: {
        total_users: totalUsers[0].count,
        active_accounts: activeAccounts[0].count,
        total_transactions: totalTransactions[0].count,
        total_credits: parseFloat(totalCredits[0].total),
        total_debits: parseFloat(totalDebits[0].total)
      }
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/admin/users
app.get('/api/admin/users', async (req, res) => {
  try {
    const [users] = await pool.execute(`
      SELECT u.id, u.full_name, u.email, u.phone, u.role, u.status, u.created_at,
             a.account_number, a.account_type, a.balance, a.status as account_status
      FROM users u
      LEFT JOIN accounts a ON u.id = a.user_id
      ORDER BY u.created_at DESC
    `);

    res.json({
      success: true,
      users: users.map(u => ({
        ...u,
        balance: u.balance ? parseFloat(u.balance) : null
      }))
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/admin/transactions
app.get('/api/admin/transactions', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const queryLimit = parseInt(limit) || 50;
    const queryOffset = parseInt(offset) || 0;

    const [transactions] = await pool.execute(
      'SELECT * FROM transactions ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [queryLimit, queryOffset]
    );

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM transactions');

    res.json({
      success: true,
      total: countResult[0].total,
      transactions: transactions.map(t => ({
        ...t,
        amount: parseFloat(t.amount),
        sender_balance_after: t.sender_balance_after ? parseFloat(t.sender_balance_after) : null,
        receiver_balance_after: t.receiver_balance_after ? parseFloat(t.receiver_balance_after) : null
      }))
    });
  } catch (error) {
    console.error('Admin transactions error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==================== HEALTH CHECK ====================

// GET /health
app.get('/health', async (req, res) => {
  try {
    await pool.execute('SELECT 1');
    res.json({ status: 'healthy', service: 'Veera_NareshIT_Bank Backend', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
});

// ==================== START SERVER ====================

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Veera_NareshIT_Bank backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
