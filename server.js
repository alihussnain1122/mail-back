import express from 'express';
import cors from 'cors';
import multer from 'multer';

import { CONFIG, ALLOWED_ORIGINS, isVercel } from './config/index.js';
import { generalLimiter } from './middleware/validation.js';

// Import routes
import healthRouter from './routes/health.js';
import templatesRouter from './routes/templates.js';
import contactsRouter from './routes/contacts.js';
import uploadsRouter from './routes/uploads.js';
import emailRouter from './routes/email.js';
import trackingRouter from './routes/tracking.js';
import unsubscribeRouter from './routes/unsubscribe.js';

const app = express();

// Trust proxy for proper IP detection behind reverse proxies
app.set('trust proxy', 1);

// ===================
// MIDDLEWARE
// ===================

// CORS
app.use(cors({
  origin: (origin, callback) => {
    if (!origin && process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    console.log('CORS rejected origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Rate limiting & JSON parsing
app.use(generalLimiter);
app.use(express.json({ limit: '10mb' }));

// ===================
// ROUTES
// ===================
app.use('/api', healthRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/upload', uploadsRouter);
app.use('/api/send', emailRouter);
app.use('/api/track', trackingRouter);
app.use('/api/unsubscribe', unsubscribeRouter);

// ===================
// ERROR HANDLING
// ===================
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS not allowed' });
  }
  
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'File upload error: ' + err.message });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ===================
// PROCESS ERROR HANDLERS
// ===================
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ===================
// START SERVER
// ===================
const PORT = CONFIG.port;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`CORS enabled for: ${ALLOWED_ORIGINS.join(', ')}`);
  });

  function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    
    setTimeout(() => {
      console.error('Forcing shutdown after timeout.');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
