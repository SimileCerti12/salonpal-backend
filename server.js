const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: 'postgres',
  password: 'salonpal123',
  host: 'localhost',
  database: 'salonpal',
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM services');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

app.post('/api/bookings/create', async (req, res) => {
  try {
    const { salon_id, service_id, client_name, client_phone, client_email, booking_date, booking_time } = req.body;
    const result = await pool.query('INSERT INTO bookings (salon_id, service_id, client_name, client_phone, client_email, booking_date, booking_time) VALUES (1, 1, 1, 1, 1, 1, 1) RETURNING *');
    res.status(201).json({ booking_id: result.rows[0].id, message: 'Booking created' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.listen(PORT, () => {
  console.log('Server running on 5000');
});
