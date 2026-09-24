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

app.post('/api/bookings/create', async (req, res) => {
  res.json({ booking_id: 1, message: 'Booking created' });
});

app.listen(PORT, () => {
  console.log('Server running on 5000');
});
