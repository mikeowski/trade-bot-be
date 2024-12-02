import express from 'express';
import dotenv from 'dotenv';
import apiRoutes from './routes/apiRoutes';

dotenv.config();

const app = express();
app.use(express.json());

// Timeout ayarlarını güncelle
app.use((req, res, next) => {
  // Sunucu timeout süresini 10 dakikaya çıkar
  req.setTimeout(600000); // 10 dakika
  res.setTimeout(600000); // 10 dakika
  next();
});

// CORS ve diğer middleware'ler
app.use((req, res, next) => {
  res.header('Connection', 'keep-alive');
  res.header('Keep-Alive', 'timeout=600'); // 10 dakika
  next();
});

// API Routes
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Server timeout ayarları
server.timeout = 600000; // 10 dakika
server.keepAliveTimeout = 600000; // 10 dakika
server.headersTimeout = 601000; // Keep-alive headerından biraz daha uzun
