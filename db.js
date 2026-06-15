const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Buat tabel saat pertama kali jalan
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      plan VARCHAR(10) DEFAULT 'free',   -- 'free' atau 'pro'
      usage_today INT DEFAULT 0,         -- berapa kali sudah analisa hari ini
      last_reset DATE DEFAULT CURRENT_DATE,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database siap');
}

module.exports = { pool, initDB };
