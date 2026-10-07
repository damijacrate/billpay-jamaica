require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initializePostgres } = require('./postgres');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      status: 'healthy',
      database: 'connected',
      service: 'billpay-jamaica'
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    service: 'BillPay Jamaica API',
    status: 'online'
  });
});

app.post('/api/customers', async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Customer name is required'
      });
    }

    const result = await pool.query(
      `INSERT INTO customers (name, phone, email)
       VALUES ($1, $2, $3)
       RETURNING id, name, phone, email, created_at`,
      [name, phone || null, email || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: 'Customer could not be created',
      details: error.message
    });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, email, created_at
       FROM customers
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: 'Customers could not be loaded',
      details: error.message
    });
  }
});

app.post('/api/bill-accounts', async (req, res) => {
  try {
    const {
      customer_id,
      provider,
      account_number,
      account_name
    } = req.body;

    if (!customer_id || !provider || !account_number) {
      return res.status(400).json({
        error: 'customer_id, provider and account_number are required'
      });
    }

    const customer = await pool.query(
      'SELECT id FROM customers WHERE id = $1',
      [customer_id]
    );

    if (customer.rows.length === 0) {
      return res.status(404).json({
        error: 'Customer not found'
      });
    }

    const result = await pool.query(
      `INSERT INTO bill_accounts
       (customer_id, provider, account_number, account_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, customer_id, provider, account_number,
                 account_name, created_at`,
      [
        customer_id,
        provider,
        account_number,
        account_name || null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: 'Bill account could not be created',
      details: error.message
    });
  }
});

app.get('/api/bill-accounts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ba.id,
              ba.customer_id,
              c.name AS customer_name,
              ba.provider,
              ba.account_number,
              ba.account_name,
              ba.created_at
       FROM bill_accounts ba
       JOIN customers c ON c.id = ba.customer_id
       ORDER BY ba.id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: 'Bill accounts could not be loaded',
      details: error.message
    });
  }
});

app.post('/api/bills', async (req, res) => {
  try {
    const {
      account_id,
      amount,
      due_date
    } = req.body;

    if (!account_id || amount === undefined) {
      return res.status(400).json({
        error: 'account_id and amount are required'
      });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({
        error: 'Amount must be greater than zero'
      });
    }

    const account = await pool.query(
      'SELECT id FROM bill_accounts WHERE id = $1',
      [account_id]
    );

    if (account.rows.length === 0) {
      return res.status(404).json({
        error: 'Bill account not found'
      });
    }

    const result = await pool.query(
      `INSERT INTO bills
       (account_id, amount, due_date, status)
       VALUES ($1, $2, $3, 'unpaid')
       RETURNING id, account_id, amount, due_date,
                 status, created_at`,
      [
        account_id,
        amount,
        due_date || null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: 'Bill could not be created',
      details: error.message
    });
  }
});

app.get('/api/bills', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id,
              b.account_id,
              ba.provider,
              ba.account_number,
              ba.account_name,
              b.amount,
              b.due_date,
              b.status,
              b.created_at
       FROM bills b
       JOIN bill_accounts ba ON ba.id = b.account_id
       ORDER BY b.id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: 'Bills could not be loaded',
      details: error.message
    });
  }
});

app.post('/api/payments', async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      bill_id,
      amount,
      reference
    } = req.body;

    if (!bill_id || amount === undefined || !reference) {
      return res.status(400).json({
        error: 'bill_id, amount and reference are required'
      });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({
        error: 'Amount must be greater than zero'
      });
    }

    await client.query('BEGIN');

    const billResult = await client.query(
      `SELECT id, amount, status
       FROM bills
       WHERE id = $1
       FOR UPDATE`,
      [bill_id]
    );

    if (billResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Bill not found'
      });
    }

    const bill = billResult.rows[0];

    if (bill.status === 'paid') {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Bill is already paid'
      });
    }

    if (Number(amount) > Number(bill.amount)) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Payment cannot exceed bill amount'
      });
    }

    const paymentResult = await client.query(
      `INSERT INTO payments
       (bill_id, amount, reference, status)
       VALUES ($1, $2, $3, 'completed')
       RETURNING id, bill_id, amount, reference,
                 status, created_at`,
      [bill_id, amount, reference]
    );

    if (Number(amount) === Number(bill.amount)) {
      await client.query(
        `UPDATE bills
         SET status = 'paid'
         WHERE id = $1`,
        [bill_id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json(paymentResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');

    res.status(500).json({
      error: 'Payment could not be created',
      details: error.message
    });
  } finally {
    client.release();
  }
});

app.get('/api/payments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, bill_id, amount, reference,
              status, created_at
       FROM payments
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: 'Payments could not be loaded',
      details: error.message
    });
  }
});

async function startServer() {
  try {
    await initializePostgres();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`BillPay production server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Unable to start BillPay server:', error);
    process.exit(1);
  }
}

startServer();
