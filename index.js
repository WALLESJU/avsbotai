require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AVS Backend OK', version: '1.0.0' });
});

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server jalan di port ${PORT}`);
  });
}).catch(err => {
  console.error('❌ Gagal init DB:', err);
  process.exit(1);
});
