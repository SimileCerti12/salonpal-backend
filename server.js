// SalonPal backend
// Plain strings only (no template literals) so this file survives Windows tools.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');

// Optional: only needed to email password-reset links (npm install nodemailer).
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* not installed: reset links print in this terminal */ }

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-launch';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000/salonpal-frontend';

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'badboy1235',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'salonpal',
  port: Number(process.env.DB_PORT || 5432),
});

// ======================================================================
// Terminal logging
// ======================================================================
function stamp() {
  return new Date().toLocaleString('en-GB', { hour12: false });
}

// Event log: log('BOOKING', 'New booking #2 ...')
function log(tag, message) {
  console.log('[' + stamp() + '] ' + (tag + '        ').slice(0, 9) + message);
}

function naira(n) {
  return 'N' + Number(n || 0).toLocaleString('en-NG');
}

app.use(cors());
app.use(express.json());

// Request log: every call to the API, with status and time taken. Never logs passwords.
app.use(function (req, res, next) {
  if (req.method === 'OPTIONS') return next();
  const started = Date.now();
  res.on('finish', function () {
    const ms = Date.now() - started;
    const mark = res.statusCode >= 500 ? 'ERROR  ' : res.statusCode >= 400 ? 'WARN   ' : 'OK     ';
    log('REQUEST', mark + req.method + ' ' + req.originalUrl + ' -> ' + res.statusCode + ' (' + ms + 'ms)');
  });
  next();
});

// Wraps async routes so a database error returns a message instead of crashing the server.
function safe(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ======================================================================
// Database setup (safe to run on every start)
// ======================================================================
async function migrate() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS salons (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE, password VARCHAR(255), salon_name VARCHAR(255))'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS services (id SERIAL PRIMARY KEY, salon_id INT, name VARCHAR(255), price INT, duration INT)'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS bookings (id SERIAL PRIMARY KEY, salon_id INT, service_id INT, client_name VARCHAR(255), ' +
    'client_phone VARCHAR(20), client_email VARCHAR(255), booking_date DATE, booking_time TIME)'
  );
  await pool.query(
    'ALTER TABLE bookings ' +
    "ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'booked', " +
    "ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'unpaid', " +
    'ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(100), ' +
    'ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ, ' +
    'ADD COLUMN IF NOT EXISTS price INT, ' +
    'ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, salon_id INT NOT NULL, token_hash VARCHAR(64) NOT NULL, ' +
    'expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ)'
  );
  await pool.query("UPDATE bookings SET status = 'booked' WHERE status IS NULL");
  // Older bookings: copy the service price onto the booking so later price changes don't alter them.
  await pool.query('UPDATE bookings b SET price = s.price FROM services s WHERE s.id = b.service_id AND b.price IS NULL');
  await pool.query("UPDATE bookings SET payment_status = 'unpaid' WHERE payment_status IS NULL");

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM services');
  if (count.rows[0].n === 0) {
    await pool.query(
      'INSERT INTO services (name, price, duration) VALUES ' +
      "('Hair Braiding', 5000, 120), ('Hair Coloring', 8000, 90), ('Facial Treatment', 6000, 60), " +
      "('Manicure', 3000, 45), ('Pedicure', 3500, 45)"
    );
    log('SETUP', 'Added 5 starter services');
  }
}

// ======================================================================
// Helpers
// ======================================================================
function makeToken(salonId) {
  return jwt.sign({ id: salonId }, JWT_SECRET, { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    req.salonId = jwt.verify(token, JWT_SECRET).id;
    next();
  } catch (e) {
    log('AUTH', 'Rejected an expired or invalid sign-in token');
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

function isEmail(v) { return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function isDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
function isTime(v) { return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v); }

function sessionFor(salon) {
  return { token: makeToken(salon.id), salon_id: salon.id, salon_name: salon.salon_name, email: salon.email };
}

// Works whether the date/time columns are DATE/TIME or plain text.
const BOOKING_COLUMNS =
  'b.id, b.salon_id, b.service_id, b.client_name, b.client_phone, b.client_email, ' +
  'LEFT(b.booking_date::text, 10) AS booking_date, LEFT(b.booking_time::text, 5) AS booking_time, ' +
  "COALESCE(b.status, 'booked') AS status, COALESCE(b.payment_status, 'unpaid') AS payment_status, " +
  'b.paid_at, b.created_at, s.name AS service_name, COALESCE(b.price, s.price) AS price, s.duration';

async function findBooking(id) {
  const result = await pool.query(
    'SELECT ' + BOOKING_COLUMNS + ' FROM bookings b LEFT JOIN services s ON s.id = b.service_id WHERE b.id = $1',
    [id]
  );
  return result.rows[0];
}

function describe(b) {
  return '#' + b.id + ' ' + b.client_name + ', ' + (b.service_name || 'service') + ', ' + b.booking_date + ' ' + b.booking_time;
}

async function markPaid(bookingId, how) {
  await pool.query(
    "UPDATE bookings SET payment_status = 'paid', paid_at = COALESCE(paid_at, NOW()), " +
    "status = CASE WHEN status = 'booked' THEN 'confirmed' ELSE status END WHERE id = $1",
    [bookingId]
  );
  const b = await findBooking(bookingId);
  log('PAYMENT', '*** PAID *** ' + describe(b) + ' - ' + naira(b.price) + ' (' + how + ')');
  return b;
}

const STARTER_SERVICES = [
  ['Hair Braiding', 5000, 120], ['Hair Coloring', 8000, 90], ['Facial Treatment', 6000, 60],
  ['Manicure', 3000, 45], ['Pedicure', 3500, 45],
];

// The whole database at a glance: which salon owns which services and bookings.
async function dbSummary() {
  const salons = await pool.query(
    'SELECT s.id, s.salon_name, s.email, ' +
    '(SELECT COUNT(*)::int FROM services v WHERE v.salon_id = s.id) AS services, ' +
    '(SELECT COUNT(*)::int FROM bookings b WHERE b.salon_id = s.id) AS bookings ' +
    'FROM salons s ORDER BY s.id'
  );
  const orphanServices = await pool.query('SELECT COUNT(*)::int AS n FROM services WHERE salon_id IS NULL');
  const orphanBookings = await pool.query(
    'SELECT COUNT(*)::int AS n FROM bookings b WHERE b.salon_id IS NULL OR NOT EXISTS (SELECT 1 FROM salons s WHERE s.id = b.salon_id)'
  );
  const recent = await pool.query(
    'SELECT ' + BOOKING_COLUMNS + ' FROM bookings b LEFT JOIN services s ON s.id = b.service_id ORDER BY b.id DESC LIMIT 10'
  );
  return {
    salons: salons.rows,
    services_with_no_salon: orphanServices.rows[0].n,
    bookings_with_no_matching_salon: orphanBookings.rows[0].n,
    latest_bookings: recent.rows.map((b) => ({
      id: b.id, salon_id: b.salon_id, client: b.client_name, service: b.service_name,
      date: b.booking_date, time: b.booking_time, status: b.status, payment: b.payment_status,
    })),
  };
}

function logSummary(summary) {
  log('DEBUG', 'Database: ' + summary.salons.length + ' salon(s)');
  summary.salons.forEach((s) => {
    log('DEBUG', '  salon ' + s.id + ' "' + s.salon_name + '" <' + s.email + '>: ' +
      s.services + ' services, ' + s.bookings + ' bookings, booking link #/book/' + s.id);
  });
  if (summary.services_with_no_salon) log('DEBUG', '  ' + summary.services_with_no_salon + ' service(s) belong to no salon');
  if (summary.bookings_with_no_matching_salon) {
    log('DEBUG', '  WARNING ' + summary.bookings_with_no_matching_salon + ' booking(s) belong to no existing salon, so no dashboard shows them');
  }
}

function isLocal(req) {
  const ip = req.ip || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function sendResetEmail(to, link) {
  const ready = nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
  if (!ready) {
    log('RESET', 'Email is not set up, so here is the reset link for ' + to + ':');
    log('RESET', '  ' + link);
    return;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: to,
    subject: 'Reset your SalonPal password',
    text: 'Someone asked to reset the password for your SalonPal account.\n\n' +
      'Open this link within 30 minutes to choose a new password:\n' + link + '\n\n' +
      'If this was not you, ignore this email. Your password will not change.',
  });
  log('RESET', 'Reset email sent to ' + to);
}

// ======================================================================
// Health
// ======================================================================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ======================================================================
// Auth
// ======================================================================
app.post('/api/auth/register', safe(async (req, res) => {
  const { email, password, salon_name } = req.body || {};
  if (!salon_name || !String(salon_name).trim()) return res.status(400).json({ error: 'Enter your salon name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const hash = await bcrypt.hash(String(password), 10);
  let salon;
  try {
    const result = await pool.query(
      'INSERT INTO salons (email, password, salon_name) VALUES ($1, $2, $3) RETURNING id, email, salon_name',
      [email.toLowerCase().trim(), hash, String(salon_name).trim()]
    );
    salon = result.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      log('AUTH', 'Register refused, email already used: ' + email);
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    }
    throw err;
  }

  // Every new salon starts with its own editable copy of the starter price list.
  const claimed = await pool.query('UPDATE services SET salon_id = $1 WHERE salon_id IS NULL', [salon.id]);
  if (claimed.rowCount === 0) {
    for (const [name, price, duration] of STARTER_SERVICES) {
      await pool.query('INSERT INTO services (salon_id, name, price, duration) VALUES ($1, $2, $3, $4)', [salon.id, name, price, duration]);
    }
  }
  log('AUTH', 'New salon registered: "' + salon.salon_name + '" (id ' + salon.id + ', ' + salon.email + '), ' +
    'starter price list added. Booking link: #/book/' + salon.id);
  res.status(201).json(sessionFor(salon));
}));

app.post('/api/auth/login', safe(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  const result = await pool.query('SELECT * FROM salons WHERE email = $1', [email.toLowerCase().trim()]);
  const salon = result.rows[0];
  const ok = salon && salon.password && (await bcrypt.compare(String(password), salon.password));
  if (!ok) {
    log('AUTH', 'Failed sign-in for ' + email);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  log('AUTH', 'Signed in: "' + salon.salon_name + '" (salon ' + salon.id + ', booking link #/book/' + salon.id + ')');
  res.json(sessionFor(salon));
}));

app.get('/api/auth/me', requireAuth, safe(async (req, res) => {
  const result = await pool.query('SELECT id, email, salon_name FROM salons WHERE id = $1', [req.salonId]);
  if (!result.rows[0]) return res.status(401).json({ error: 'Salon not found. Sign in again.' });
  res.json(result.rows[0]);
}));

// Forgot password: always answers the same way so nobody can test which emails exist.
app.post('/api/auth/forgot', safe(async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const reply = { message: 'If that email has a SalonPal account, a reset link is on its way. It works for 30 minutes.' };
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const found = await pool.query('SELECT id, email FROM salons WHERE email = $1', [email]);
  const salon = found.rows[0];
  if (!salon) {
    log('RESET', 'Reset asked for unknown email ' + email + ' (nothing sent)');
    return res.json(reply);
  }
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE salon_id = $1 AND used_at IS NULL', [salon.id]);
  await pool.query(
    "INSERT INTO password_resets (salon_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
    [salon.id, hashToken(token)]
  );
  await sendResetEmail(salon.email, FRONTEND_URL + '/#/reset-password?token=' + token);
  res.json(reply);
}));

app.post('/api/auth/reset', safe(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'This reset link is incomplete. Ask for a new one.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const found = await pool.query(
    'SELECT r.id, r.salon_id, s.salon_name, s.email FROM password_resets r JOIN salons s ON s.id = r.salon_id ' +
    'WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > NOW()',
    [hashToken(String(token))]
  );
  const row = found.rows[0];
  if (!row) {
    log('RESET', 'Rejected an expired or already-used reset link');
    return res.status(400).json({ error: 'This reset link has expired or was already used. Ask for a new one.' });
  }
  const hash = await bcrypt.hash(String(password), 10);
  await pool.query('UPDATE salons SET password = $1 WHERE id = $2', [hash, row.salon_id]);
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [row.id]);
  log('RESET', 'Password changed for "' + row.salon_name + '" (salon ' + row.salon_id + ')');
  res.json(sessionFor({ id: row.salon_id, salon_name: row.salon_name, email: row.email }));
}));

// Public: salon name for the booking page header
app.get('/api/salons/:id', safe(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'This booking link is not valid.' });
  const result = await pool.query('SELECT id, salon_name FROM salons WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) {
    log('BOOKING', 'Someone opened a booking link for salon ' + req.params.id + ', which does not exist');
    return res.status(404).json({ error: 'This booking link is not valid. Ask the salon for their link.' });
  }
  res.json(result.rows[0]);
}));

// Debug: open http://localhost:5000/api/debug in your browser. Only works on this computer.
app.get('/api/debug', safe(async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Debug info is only available on the server computer.' });
  const summary = await dbSummary();
  logSummary(summary);
  res.json(summary);
}));

// Debug for the signed-in owner: what their dashboard should be seeing.
app.get('/api/debug/me', requireAuth, safe(async (req, res) => {
  const salon = await pool.query('SELECT id, salon_name, email FROM salons WHERE id = $1', [req.salonId]);
  const services = await pool.query('SELECT COUNT(*)::int AS n FROM services WHERE salon_id = $1', [req.salonId]);
  const bookings = await pool.query('SELECT COUNT(*)::int AS n FROM bookings WHERE salon_id = $1', [req.salonId]);
  const elsewhere = await pool.query(
    'SELECT b.salon_id, COUNT(*)::int AS n FROM bookings b WHERE b.salon_id IS DISTINCT FROM $1 GROUP BY b.salon_id', [req.salonId]
  );
  const info = {
    signed_in_as_salon: req.salonId,
    salon: salon.rows[0] || null,
    your_booking_link: '#/book/' + req.salonId,
    your_services: services.rows[0].n,
    your_bookings: bookings.rows[0].n,
    bookings_for_other_salons: elsewhere.rows,
  };
  log('DEBUG', 'Dashboard check for salon ' + req.salonId + ': ' + info.your_services + ' services, ' +
    info.your_bookings + ' bookings' + (elsewhere.rowCount ? ', other salons hold ' +
    elsewhere.rows.map((r) => r.n + ' (salon ' + r.salon_id + ')').join(', ') : ''));
  res.json(info);
}));

// ======================================================================
// Services (price list)
// ======================================================================
app.get('/api/services', safe(async (req, res) => {
  const salonId = req.query.salon_id;
  const result = salonId
    ? await pool.query('SELECT * FROM services WHERE salon_id = $1 ORDER BY id', [salonId])
    : await pool.query('SELECT * FROM services ORDER BY id');
  res.json(result.rows);
}));

function readService(body) {
  const name = String((body && body.name) || '').trim();
  const price = Math.round(Number(body && body.price));
  const duration = Math.round(Number(body && body.duration));
  if (!name || !(price > 0) || !(duration > 0)) return null;
  return { name: name, price: price, duration: duration };
}

app.post('/api/services', requireAuth, safe(async (req, res) => {
  const s = readService(req.body);
  if (!s) return res.status(400).json({ error: 'Enter a name, a price and a duration in minutes.' });
  const result = await pool.query(
    'INSERT INTO services (salon_id, name, price, duration) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.salonId, s.name, s.price, s.duration]
  );
  log('SERVICE', 'Added "' + s.name + '" at ' + naira(s.price) + ', ' + s.duration + ' mins (salon ' + req.salonId + ')');
  res.status(201).json(result.rows[0]);
}));

app.patch('/api/services/:id', requireAuth, safe(async (req, res) => {
  const s = readService(req.body);
  if (!s) return res.status(400).json({ error: 'Enter a name, a price and a duration in minutes.' });
  const before = await pool.query('SELECT * FROM services WHERE id = $1 AND salon_id = $2', [req.params.id, req.salonId]);
  if (!before.rows[0]) return res.status(404).json({ error: 'Service not found.' });
  const result = await pool.query(
    'UPDATE services SET name = $1, price = $2, duration = $3 WHERE id = $4 AND salon_id = $5 RETURNING *',
    [s.name, s.price, s.duration, req.params.id, req.salonId]
  );
  const old = before.rows[0];
  log('SERVICE', 'Updated "' + s.name + '": ' + naira(old.price) + ' -> ' + naira(s.price) +
    ', ' + old.duration + ' -> ' + s.duration + ' mins');
  res.json(result.rows[0]);
}));

app.delete('/api/services/:id', requireAuth, safe(async (req, res) => {
  const result = await pool.query('DELETE FROM services WHERE id = $1 AND salon_id = $2 RETURNING name', [req.params.id, req.salonId]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Service not found.' });
  log('SERVICE', 'Removed "' + result.rows[0].name + '"');
  res.json({ deleted: true });
}));

// ======================================================================
// Bookings
// ======================================================================
app.post('/api/bookings/create', safe(async (req, res) => {
  const { salon_id, service_id, booking_date, booking_time, client_name, client_phone, client_email } = req.body || {};
  if (!service_id || !isDate(booking_date) || !isTime(booking_time)) {
    return res.status(400).json({ error: 'Choose a service, a day and a time.' });
  }
  if (!client_name || !client_phone) return res.status(400).json({ error: 'Enter your name and phone number.' });

  const svc = await pool.query('SELECT * FROM services WHERE id = $1', [service_id]);
  const service = svc.rows[0];
  if (!service) return res.status(404).json({ error: 'That service no longer exists. Pick another.' });
  if (salon_id && service.salon_id && Number(salon_id) !== Number(service.salon_id)) {
    log('BOOKING', 'Refused: service ' + service.id + ' belongs to salon ' + service.salon_id + ', link was for salon ' + salon_id);
    return res.status(400).json({ error: 'That service is not offered by this salon. Refresh the page.' });
  }
  const salonId = service.salon_id || Number(salon_id) || null;

  const today = new Date().toISOString().slice(0, 10);
  if (booking_date < today) return res.status(400).json({ error: 'That day has passed. Pick another day.' });

  const clash = await pool.query(
    'SELECT 1 FROM bookings WHERE salon_id IS NOT DISTINCT FROM $1 AND LEFT(booking_date::text, 10) = $2 ' +
    "AND LEFT(booking_time::text, 5) = $3 AND COALESCE(status, 'booked') <> 'cancelled'",
    [salonId, booking_date, booking_time]
  );
  if (clash.rowCount > 0) {
    log('BOOKING', 'Slot already taken: ' + booking_date + ' ' + booking_time + ' (asked by ' + client_name + ')');
    return res.status(409).json({ error: 'That time was just taken. Pick another time.' });
  }

  const result = await pool.query(
    'INSERT INTO bookings (salon_id, service_id, client_name, client_phone, client_email, booking_date, booking_time, price) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [salonId, service.id, String(client_name).trim(), String(client_phone).trim(), client_email || null, booking_date, booking_time, service.price]
  );
  const b = await findBooking(result.rows[0].id);
  log('BOOKING', '*** NEW *** ' + describe(b) + ' - ' + naira(b.price) + ' (phone ' + b.client_phone + ')');
  res.status(201).json({ booking_id: b.id, message: 'Booking created' });
}));

// Owner: all bookings for their salon
app.get('/api/bookings', requireAuth, safe(async (req, res) => {
  const result = await pool.query(
    'SELECT ' + BOOKING_COLUMNS + ' FROM bookings b LEFT JOIN services s ON s.id = b.service_id ' +
    'WHERE b.salon_id = $1 ORDER BY b.booking_date, b.booking_time',
    [req.salonId]
  );
  res.json(result.rows);
}));

// Client: their own receipt (no phone or email returned)
app.get('/api/bookings/:id/receipt', safe(async (req, res) => {
  const b = await findBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  res.json({
    id: b.id, client_name: b.client_name, service_name: b.service_name, price: b.price, duration: b.duration,
    booking_date: b.booking_date, booking_time: b.booking_time, status: b.status, payment_status: b.payment_status,
  });
}));

// Client chose to pay in person
app.post('/api/bookings/:id/pay-at-salon', safe(async (req, res) => {
  const result = await pool.query(
    "UPDATE bookings SET payment_status = 'pay_at_salon' WHERE id = $1 AND COALESCE(payment_status, 'unpaid') = 'unpaid'",
    [req.params.id]
  );
  const b = await findBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (result.rowCount) log('PAYMENT', 'Will pay at the salon: ' + describe(b) + ' - ' + naira(b.price));
  res.json({ payment_status: b.payment_status });
}));

// Owner: done / cancelled / no-show
app.patch('/api/bookings/:id/status', requireAuth, safe(async (req, res) => {
  const allowed = ['booked', 'confirmed', 'done', 'cancelled', 'no_show'];
  const status = req.body && req.body.status;
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  const result = await pool.query('UPDATE bookings SET status = $1 WHERE id = $2 AND salon_id = $3', [status, req.params.id, req.salonId]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Booking not found.' });
  const b = await findBooking(req.params.id);
  log('BOOKING', 'Status -> ' + status.toUpperCase() + ': ' + describe(b));
  res.json(b);
}));

// Owner: client paid cash or transfer at the salon
app.patch('/api/bookings/:id/payment', requireAuth, safe(async (req, res) => {
  const owned = await pool.query('SELECT 1 FROM bookings WHERE id = $1 AND salon_id = $2', [req.params.id, req.salonId]);
  if (!owned.rowCount) return res.status(404).json({ error: 'Booking not found.' });
  const b = await markPaid(req.params.id, 'marked paid by salon');
  res.json(b);
}));

// ======================================================================
// Payments (Paystack)
// ======================================================================
async function paystack(path, options) {
  const res = await fetch('https://api.paystack.co' + path, Object.assign({
    headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
  }, options || {}));
  return res.json();
}

app.post('/api/payment/initialize', safe(async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) {
    log('PAYMENT', 'Online payment tried but PAYSTACK_SECRET_KEY is not set in .env');
    return res.status(503).json({ error: 'Online payment is not set up yet. Choose to pay at the salon.' });
  }
  const { booking_id, email } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email for your receipt.' });

  const booking = await findBooking(booking_id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.payment_status === 'paid') return res.status(409).json({ error: 'This booking is already paid.' });

  const reference = 'SP-' + booking.id + '-' + Date.now();
  const data = await paystack('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: email,
      amount: Number(booking.price) * 100, // kobo
      reference: reference,
      callback_url: FRONTEND_URL + '/#/payment/' + booking.id,
      metadata: { booking_id: booking.id },
    }),
  });
  if (!data.status) {
    log('PAYMENT', 'Paystack refused: ' + (data.message || 'unknown reason'));
    return res.status(502).json({ error: data.message || 'Paystack did not accept the payment.' });
  }

  await pool.query('UPDATE bookings SET payment_reference = $1, client_email = COALESCE(client_email, $2) WHERE id = $3',
    [reference, email, booking.id]);
  log('PAYMENT', 'Sent to Paystack: ' + describe(booking) + ' - ' + naira(booking.price) + ' (ref ' + reference + ')');
  res.json({ authorization_url: data.data.authorization_url, reference: reference });
}));

app.get('/api/payment/verify/:reference', safe(async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Online payment is not set up yet.' });
  const ref = req.params.reference;
  const found = await pool.query('SELECT id FROM bookings WHERE payment_reference = $1', [ref]);
  if (!found.rows[0]) return res.status(404).json({ error: 'Payment reference not found.' });

  const data = await paystack('/transaction/verify/' + encodeURIComponent(ref));
  const paid = data.status && data.data && data.data.status === 'success';
  if (paid) {
    await markPaid(found.rows[0].id, 'Paystack ' + ref);
  } else {
    log('PAYMENT', 'Not completed: ref ' + ref + ' (' + ((data.data && data.data.status) || data.message) + ')');
  }
  res.json({ paid: Boolean(paid) });
}));

// ======================================================================
// Errors
// ======================================================================
app.use(function (req, res) {
  res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.originalUrl });
});

app.use(function (err, req, res, next) {
  log('ERROR', req.method + ' ' + req.originalUrl + ' failed: ' + err.message);
  res.status(500).json({ error: 'Something went wrong on the server. Check the backend terminal.' });
});

// ======================================================================
// Start
// ======================================================================
migrate()
  .then(() => app.listen(PORT, () => {
    log('SERVER', 'SalonPal backend running on http://localhost:' + PORT);
    log('SERVER', PAYSTACK_SECRET_KEY ? 'Paystack is ON' : 'Paystack is OFF (no PAYSTACK_SECRET_KEY in .env)');
    log('SERVER', nodemailer && process.env.SMTP_HOST ? 'Reset emails are ON' : 'Reset emails are OFF (links print here instead)');
    log('SERVER', 'Debug info: http://localhost:' + PORT + '/api/debug');
    dbSummary().then(logSummary).catch((e) => log('ERROR', 'Summary failed: ' + e.message));
  }))
  .catch((err) => {
    console.error('Database problem: ' + err.message);
    if (err.code === '28P01') console.error('Fix: put your PostgreSQL password in .env as DB_PASSWORD=yourpassword');
    else if (err.code === '3D000') console.error('Fix: create the database first: CREATE DATABASE salonpal;');
    else console.error('Check that PostgreSQL is running.');
    process.exit(1);
  });
