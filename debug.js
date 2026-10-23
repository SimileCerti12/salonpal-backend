// Run:  node debug.js
// Prints every salon, its services and its bookings, so you can see why
// a booking is (or isn't) on a dashboard.
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'badboy1235',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'salonpal',
  port: Number(process.env.DB_PORT || 5432),
});

async function main() {
  const salons = await pool.query('SELECT id, salon_name, email FROM salons ORDER BY id');
  console.log('\n=== SALONS (sign in as one of these; its booking link is #/book/<id>) ===');
  console.table(salons.rows);

  const services = await pool.query('SELECT id, salon_id, name, price, duration FROM services ORDER BY salon_id, id');
  console.log('\n=== SERVICES (salon_id says which dashboard and booking page show them) ===');
  console.table(services.rows);

  const bookings = await pool.query(
    'SELECT b.id, b.salon_id, s.salon_id AS service_salon, b.client_name, sv.name AS service, ' +
    'LEFT(b.booking_date::text, 10) AS date, LEFT(b.booking_time::text, 5) AS time, b.status, b.payment_status ' +
    'FROM bookings b LEFT JOIN services sv ON sv.id = b.service_id LEFT JOIN services s ON s.id = b.service_id ' +
    'ORDER BY b.id DESC LIMIT 30'
  );
  console.log('\n=== LATEST BOOKINGS (salon_id must match the salon you sign in as) ===');
  console.table(bookings.rows);

  const ids = new Set(salons.rows.map((r) => r.id));
  const lost = bookings.rows.filter((b) => !ids.has(b.salon_id));
  if (lost.length) {
    console.log('\nWARNING: ' + lost.length + ' booking(s) belong to no existing salon, so no dashboard shows them: ids ' +
      lost.map((b) => b.id).join(', '));
  }
  console.log('');
}

main()
  .catch((err) => console.error('Debug failed: ' + err.message))
  .finally(() => pool.end());
