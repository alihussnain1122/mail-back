import express from 'express';

const router = express.Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mode: 'session-credentials',
  });
});

// Get SMTP configuration status
router.get('/config', (req, res) => {
  res.json({
    configured: false,
    smtpHost: '',
    smtpPort: '587',
    emailUser: '',
    senderName: 'Support Team',
    message: 'Configure your SMTP credentials in Settings. They are stored in your browser only.',
  });
});

export default router;
