// Emergency password reset, for the person running the server.
// Run:  node reset-password.js owner@email.com NewPassword123
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const email = String(process.argv[2] || '').toLowerCase().trim();
const password = String(process.argv[3] || '');

if (!email || password.length < 8) {
  console.log('Usage: node reset-password.js owner@email.com NewPassword123');
  console.log('The new password must be at least 8 characters.');
  process.exit(1);
}

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'badboy1235',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'salonpal',
  port: Number(process.env.DB_PORT || 5432),
});

bcrypt.hash(password, 10)
  .then((hash) => pool.query('UPDATE salons SET password = $1 WHERE email = $2 RETURNING id, salon_name', [hash, email]))
  .then((result) => {
    if (!result.rowCount) console.log('No salon uses ' + email + '. Run node debug.js to see all accounts.');
    else console.log('Password changed for "' + result.rows[0].salon_name + '" (salon ' + result.rows[0].id + '). Sign in with the new password.');
  })
  .catch((err) => console.error('Reset failed: ' + err.message))
  .finally(() => pool.end());
