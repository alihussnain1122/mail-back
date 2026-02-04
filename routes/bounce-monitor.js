import express from 'express';
import { createBounceMonitor } from '../services/bounce-monitor.js';

const router = express.Router();

// Global bounce monitor instance
let bounceMonitor = null;

/**
 * Start bounce monitoring
 * POST /api/bounce-monitor/start
 * Body: { smtpConfig: { host, emailUser, emailPass } }
 */
router.post('/start', express.json(), async (req, res) => {
  const { smtpConfig } = req.body;

  if (!smtpConfig || !smtpConfig.emailUser || !smtpConfig.emailPass) {
    return res.status(400).json({ 
      error: 'SMTP config required (emailUser, emailPass, host)' 
    });
  }

  try {
    // Stop existing monitor if running
    if (bounceMonitor) {
      bounceMonitor.stop();
    }

    // Create and start new monitor
    bounceMonitor = createBounceMonitor(smtpConfig);
    await bounceMonitor.start();

    res.json({ 
      success: true, 
      message: 'Bounce monitor started',
      config: {
        host: bounceMonitor.config.host,
        user: bounceMonitor.config.user,
        checkInterval: bounceMonitor.checkInterval / 1000 + ' seconds'
      }
    });
  } catch (error) {
    console.error('Failed to start bounce monitor:', error);
    res.status(500).json({ 
      error: 'Failed to start bounce monitor: ' + error.message 
    });
  }
});

/**
 * Stop bounce monitoring
 * POST /api/bounce-monitor/stop
 */
router.post('/stop', (req, res) => {
  if (!bounceMonitor) {
    return res.json({ message: 'Bounce monitor is not running' });
  }

  try {
    bounceMonitor.stop();
    bounceMonitor = null;
    res.json({ success: true, message: 'Bounce monitor stopped' });
  } catch (error) {
    console.error('Failed to stop bounce monitor:', error);
    res.status(500).json({ error: 'Failed to stop: ' + error.message });
  }
});

/**
 * Get bounce monitor status
 * GET /api/bounce-monitor/status
 */
router.get('/status', (req, res) => {
  if (!bounceMonitor || !bounceMonitor.isRunning) {
    return res.json({ 
      running: false,
      message: 'Bounce monitor is not running'
    });
  }

  res.json({
    running: true,
    config: {
      host: bounceMonitor.config.host,
      user: bounceMonitor.config.user,
      checkInterval: bounceMonitor.checkInterval / 1000 + ' seconds',
    },
    lastCheck: bounceMonitor.lastCheck,
  });
});

/**
 * Check for bounces now (manual trigger)
 * POST /api/bounce-monitor/check
 */
router.post('/check', async (req, res) => {
  if (!bounceMonitor) {
    return res.status(400).json({ 
      error: 'Bounce monitor is not running. Start it first.' 
    });
  }

  try {
    const bounces = await bounceMonitor.checkForBounces();
    res.json({ 
      success: true, 
      message: `Found ${bounces.length} bounce(s)`,
      bounces: bounces.map(b => ({ email: b.email, type: b.bounce_type }))
    });
  } catch (error) {
    console.error('Failed to check bounces:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
