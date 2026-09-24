const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'salonpal',
});

// Initialize Database
async function initializeDatabase() {
  try {
    await pool.query(\
      CREATE TABLE IF NOT EXISTS salons (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        salon_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    \);

    await pool.query(\
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        salon_id INTEGER NOT NULL REFERENCES salons(id),
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        duration INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    \);

    await pool.query(\
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        salon_id INTEGER NOT NULL REFERENCES salons(id),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    \);

    await pool.query(\
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        salon_id INTEGER NOT NULL REFERENCES salons(id),
        service_id INTEGER NOT NULL REFERENCES services(id),
        client_name VARCHAR(255) NOT NULL,
        client_phone VARCHAR(20),
        client_email VARCHAR(255),
        booking_date DATE NOT NULL,
        booking_time TIME NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        deposit_amount DECIMAL(10, 2),
        payment_status VARCHAR(50) DEFAULT 'unpaid',
        reference VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    \);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Routes

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, salon_name } = req.body;

    if (!email || !password || !salon_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO salons (email, password, salon_name) VALUES (\, \, \) RETURNING id, email, salon_name',
      [email, hashedPassword, salon_name]
    );

    const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

    res.status(201).json({
      salon_id: result.rows[0].id,
      email: result.rows[0].email,
      salon_name: result.rows[0].salon_name,
      token,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query('SELECT * FROM salons WHERE email = \', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const salon = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, salon.password);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: salon.id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

    res.json({
      salon_id: salon.id,
      email: salon.email,
      salon_name: salon.salon_name,
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.salonId = decoded.id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Services Routes
app.get('/api/services/:salonId', async (req, res) => {
  try {
    const { salonId } = req.params;
    const result = await pool.query('SELECT * FROM services WHERE salon_id = \', [salonId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

app.post('/api/services', verifyToken, async (req, res) => {
  try {
    const { name, price, duration } = req.body;
    const salonId = req.salonId;

    if (!name || !price || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(
      'INSERT INTO services (salon_id, name, price, duration) VALUES (\, \, \, \) RETURNING *',
      [salonId, name, price, duration]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating service:', error);
    res.status(500).json({ error: 'Failed to create service' });
  }
});

// Bookings Routes
app.get('/api/bookings', verifyToken, async (req, res) => {
  try {
    const salonId = req.salonId;
    const result = await pool.query(
      'SELECT b.*, s.name as service_name FROM bookings b JOIN services s ON b.service_id = s.id WHERE b.salon_id = \ ORDER BY b.booking_date DESC',
      [salonId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

app.post('/api/bookings/create', async (req, res) => {
  try {
    const { salon_id, service_id, client_name, client_phone, client_email, booking_date, booking_time } = req.body;

    if (!salon_id || !service_id || !client_name || !booking_date || !booking_time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check for double-booking
    const existing = await pool.query(
      'SELECT * FROM bookings WHERE salon_id = \ AND booking_date = \ AND booking_time = \ AND status != \\'cancelled\\'',
      [salon_id, booking_date, booking_time]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Time slot already booked' });
    }

    // Get service price for deposit calculation
    const serviceResult = await pool.query('SELECT price FROM services WHERE id = \', [service_id]);
    const depositAmount = (serviceResult.rows[0].price * 0.3).toFixed(2);

    const result = await pool.query(
      'INSERT INTO bookings (salon_id, service_id, client_name, client_phone, client_email, booking_date, booking_time, deposit_amount, status) VALUES (\, \, \, \, \, \, \, \, \) RETURNING *',
      [salon_id, service_id, client_name, client_phone, client_email, booking_date, booking_time, depositAmount, 'pending']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Payment Routes
app.post('/api/payment/initialize', async (req, res) => {
  try {
    const { booking_id, email, amount } = req.body;

    const paystackUrl = 'https://api.paystack.co/transaction/initialize';
    const response = await axios.post(
      paystackUrl,
      {
        email,
        amount: Math.round(amount * 100),
        reference: \ooking_\_\\,
      },
      {
        headers: {
          Authorization: \Bearer \\,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

app.post('/api/payment/verify', async (req, res) => {
  try {
    const { reference } = req.body;

    const paystackUrl = \https://api.paystack.co/transaction/verify/\\;
    const response = await axios.get(paystackUrl, {
      headers: {
        Authorization: \Bearer \\,
      },
    });

    if (response.data.data.status === 'success') {
      // Update booking status
      const bookingId = reference.split('_')[1];
      await pool.query(
        'UPDATE bookings SET payment_status = \, status = \, reference = \ WHERE id = \',
        ['paid', 'confirmed', reference, bookingId]
      );
    }

    res.json(response.data);
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// WhatsApp Reminder - Daily at 1 PM
cron.schedule('0 13 * * *', async () => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const formattedDate = tomorrow.toISOString().split('T')[0];

    const result = await pool.query(
      'SELECT b.*, s.name as service_name, sal.salon_name FROM bookings b JOIN services s ON b.service_id = s.id JOIN salons sal ON b.salon_id = sal.id WHERE b.booking_date = \ AND b.status = \\'confirmed\\'',
      [formattedDate]
    );

    for (const booking of result.rows) {
      // Send WhatsApp reminder (placeholder)
      console.log(\WhatsApp reminder: \ has appointment tomorrow at \\);
      // In production, integrate with WhatsApp Business API
    }
  } catch (error) {
    console.error('Reminder cron error:', error);
  }
});

// Start Server
app.listen(PORT, () => {
  initializeDatabase();
  console.log(\Server running on port \\);
});
