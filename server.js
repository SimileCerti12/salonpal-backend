const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'salonpal',
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, salon_name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO salons (email, password, salon_name) VALUES ($1, $2, $3) RETURNING id, email, salon_name',
      [email, hashedPassword, salon_name]
    );
    const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.status(201).json({ salon_id: result.rows[0].id, email: result.rows[0].email, salon_name: result.rows[0].salon_name, token });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM salons WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const salon = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, salon.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: salon.id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
    res.json({ salon_id: salon.id, email: salon.email, salon_name: salon.salon_name, token });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
