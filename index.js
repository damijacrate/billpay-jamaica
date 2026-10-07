const express = require('express');
const cors = require('cors');
const {
  initializeDatabase,
  saveDatabase,
  getDatabase
} = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'BillPay Jamaica API',
    status: 'online',
    version: '1.1.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    database: 'connected',
    service: 'billpay-jamaica'
  });
});

// ==================== CUSTOMERS ====================

app.post('/api/customers', (req, res) => {
  const { name, phone, email } = req.body;

  if (!name || !phone) {
    return res.status(400).json({
      error: 'Name and phone are required'
    });
  }

  try {
    const db = getDatabase();

    const statement = db.prepare(`
      INSERT INTO customers (name, phone, email)
      VALUES (?, ?, ?)
    `);

    statement.run([name, phone, email || null]);
    statement.free();

    saveDatabase();

    const result = db.exec(`
      SELECT * FROM customers
      WHERE phone = '${phone.replace(/'/g, "''")}'
    `);

    const row = result[0].values[0];

    res.status(201).json({
      id: row[0],
      name: row[1],
      phone: row[2],
      email: row[3],
      created_at: row[4]
    });

  } catch (error) {
    res.status(400).json({
      error: 'Customer could not be created',
      details: error.message
    });
  }
});

app.get('/api/customers', (req, res) => {
  const db = getDatabase();

  const result = db.exec(`
    SELECT * FROM customers
    ORDER BY id DESC
  `);

  const customers = result.length
    ? result[0].values.map(row => ({
        id: row[0],
        name: row[1],
        phone: row[2],
        email: row[3],
        created_at: row[4]
      }))
    : [];

  res.json(customers);
});

// ==================== BILL ACCOUNTS ====================

app.post('/api/bill-accounts', (req, res) => {
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

  try {
    const db = getDatabase();

    // Make sure customer exists
    const customerResult = db.exec(`
      SELECT id, name
      FROM customers
      WHERE id = ${Number(customer_id)}
    `);

    if (!customerResult.length) {
      return res.status(404).json({
        error: 'Customer not found'
      });
    }

    const statement = db.prepare(`
      INSERT INTO bill_accounts
      (customer_id, provider, account_number, account_name)
      VALUES (?, ?, ?, ?)
    `);

    statement.run([
      Number(customer_id),
      provider,
      account_number,
      account_name || null
    ]);

    statement.free();

    saveDatabase();

    const result = db.exec(`
      SELECT *
      FROM bill_accounts
      ORDER BY id DESC LIMIT 1
    `);

    const row = result[0].values[0];

    res.status(201).json({
      id: row[0],
      customer_id: row[1],
      provider: row[2],
      account_number: row[3],
      account_name: row[4],
      created_at: row[5]
    });

  } catch (error) {
    res.status(400).json({
      error: 'Bill account could not be created',
      details: error.message
    });
  }
});

app.get('/api/bill-accounts', (req, res) => {
  const db = getDatabase();

  const result = db.exec(`
    SELECT
      ba.id,
      ba.customer_id,
      c.name AS customer_name,
      ba.provider,
      ba.account_number,
      ba.account_name,
      ba.created_at
    FROM bill_accounts ba
    JOIN customers c ON c.id = ba.customer_id
    ORDER BY ba.id DESC
  `);

  const accounts = result.length
    ? result[0].values.map(row => ({
        id: row[0],
        customer_id: row[1],
        customer_name: row[2],
        provider: row[3],
        account_number: row[4],
        account_name: row[5],
        created_at: row[6]
      }))
    : [];

  res.json(accounts);
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`BillPay server running on port ${PORT}`);
      console.log(`http://127.0.0.1:${PORT}`);
    });
  })
  .catch(error => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });

/* ==================== BILLS API ==================== */

app.post('/api/bills', (req, res) => {
    const { account_id, amount, due_date } = req.body;

    if (!account_id || amount === undefined || amount === null) {
        return res.status(400).json({
            error: 'account_id and amount are required'
        });
    }

    try {
        const db = getDatabase();

        const accountResult = db.exec(`
            SELECT id
            FROM bill_accounts
            WHERE id = ${Number(account_id)}
        `);

        if (!accountResult.length || !accountResult[0].values.length) {
            return res.status(404).json({
                error: 'Bill account not found'
            });
        }

        const statement = db.prepare(`
            INSERT INTO bills
            (account_id, amount, due_date, status)
            VALUES (?, ?, ?, 'unpaid')
        `);

        statement.run([
            Number(account_id),
            Number(amount),
            due_date || null
        ]);

        statement.free();
        saveDatabase();

        const result = db.exec(`
            SELECT *
            FROM bills
            ORDER BY id DESC
            LIMIT 1
        `);

        const row = result[0].values[0];

        res.status(201).json({
            id: row[0],
            account_id: row[1],
            amount: row[2],
            due_date: row[3],
            status: row[4],
            created_at: row[5]
        });

    } catch (error) {
        res.status(400).json({
            error: 'Bill could not be created',
            details: error.message
        });
    }
});

app.get('/api/bills', (req, res) => {
    try {
        const db = getDatabase();

        const result = db.exec(`
            SELECT
                b.id,
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
            ORDER BY b.id DESC
        `);

        const bills = result.length
            ? result[0].values.map(row => ({
                id: row[0],
                account_id: row[1],
                provider: row[2],
                account_number: row[3],
                account_name: row[4],
                amount: row[5],
                due_date: row[6],
                status: row[7],
                created_at: row[8]
            }))
            : [];

        res.json(bills);

    } catch (error) {
        res.status(500).json({
            error: 'Could not retrieve bills',
            details: error.message
        });
    }
});


/* ==================== PAYMENTS API ==================== */

app.post('/api/payments', (req, res) => {
    const { bill_id, amount, reference } = req.body;

    if (!bill_id || amount === undefined || amount === null || !reference) {
        return res.status(400).json({
            error: 'bill_id, amount and reference are required'
        });
    }

    try {
        const db = getDatabase();

        // Make sure the bill exists
        const billResult = db.exec(`
            SELECT id, amount, status
            FROM bills
            WHERE id = ${Number(bill_id)}
        `);

        if (!billResult.length || !billResult[0].values.length) {
            return res.status(404).json({
                error: 'Bill not found'
            });
        }

        const bill = billResult[0].values[0];
        const billAmount = Number(bill[1]);
        const paymentAmount = Number(amount);

        if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
            return res.status(400).json({
                error: 'Payment amount must be greater than zero'
            });
        }

        if (bill[2] === 'paid') {
            return res.status(400).json({
                error: 'Bill is already paid'
            });
        }

        // Prevent overpayment
        if (paymentAmount > billAmount) {
            return res.status(400).json({
                error: 'Payment cannot be greater than the bill amount'
            });
        }

        const statement = db.prepare(`
            INSERT INTO payments
            (bill_id, amount, reference, status)
            VALUES (?, ?, ?, 'completed')
        `);

        statement.run([
            Number(bill_id),
            paymentAmount,
            reference
        ]);

        statement.free();

        // For now, a full payment marks the bill paid.
        if (paymentAmount === billAmount) {
            const update = db.prepare(`
                UPDATE bills
                SET status = 'paid'
                WHERE id = ?
            `);

            update.run([Number(bill_id)]);
            update.free();
        }

        saveDatabase();

        const result = db.exec(`
            SELECT *
            FROM payments
            ORDER BY id DESC
            LIMIT 1
        `);

        const row = result[0].values[0];

        res.status(201).json({
            id: row[0],
            bill_id: row[1],
            amount: row[2],
            reference: row[3],
            status: row[4],
            created_at: row[5]
        });

    } catch (error) {
        res.status(400).json({
            error: 'Payment could not be created',
            details: error.message
        });
    }
});

app.get('/api/payments', (req, res) => {
    try {
        const db = getDatabase();

        const result = db.exec(`
            SELECT
                p.id,
                p.bill_id,
                p.amount,
                p.reference,
                p.status,
                p.created_at
            FROM payments p
            ORDER BY p.id DESC
        `);

        const payments = result.length
            ? result[0].values.map(row => ({
                id: row[0],
                bill_id: row[1],
                amount: row[2],
                reference: row[3],
                status: row[4],
                created_at: row[5]
            }))
            : [];

        res.json(payments);

    } catch (error) {
        res.status(500).json({
            error: 'Could not retrieve payments',
            details: error.message
        });
    }
});

