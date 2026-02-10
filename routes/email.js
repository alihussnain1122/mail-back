import express from 'express';
import { body } from 'express-validator';
import { handleValidationErrors, emailLimiter } from '../middleware/validation.js';
import { 
  validateCredentials, 
  sanitizeEmailHeader, 
  sanitizeHtml, 
  generateTrackingId 
} from '../services/helpers.js';
import { createTransporterFromCredentials, injectTracking } from '../services/email.js';

const router = express.Router();

// Send a single email
router.post('/single', 
  emailLimiter,
  body('email').isEmail().withMessage('Valid email is required'),
  body('template.subject').notEmpty().withMessage('Template subject is required'),
  body('template.body').notEmpty().withMessage('Template body is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  handleValidationErrors,
  async (req, res) => {
    const { email, template, senderName, credentials, campaignId, userId, enableTracking } = req.body;
    
    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ success: false, error: credError });
    }
    
    let transporter;
    let trackingId = null;
    
    try {
      transporter = createTransporterFromCredentials(credentials);
      await transporter.verify();
      
      const sanitizedSubject = sanitizeEmailHeader(template.subject);
      const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
      let htmlBody = sanitizeHtml(template.body).replace(/\n/g, '<br>');
      
      if (enableTracking && campaignId && userId) {
        trackingId = generateTrackingId(campaignId, email, userId);
        htmlBody = injectTracking(htmlBody, trackingId, true);
      }
      
      const info = await transporter.sendMail({
        from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
        to: email,
        subject: sanitizedSubject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]+>/g, ''),
      });
      
      res.json({ 
        success: true, 
        message: `Email sent to ${email}`, 
        messageId: info.messageId,
        trackingId,
      });
    } catch (err) {
      console.error('Email send error:', err.message);
      res.status(500).json({ 
        success: false, 
        error: err.message
      });
    } finally {
      if (transporter) transporter.close();
    }
  }
);

// Send test email (template passed directly)
router.post('/test',
  emailLimiter,
  body('email').isEmail().withMessage('Valid email is required'),
  body('template.subject').notEmpty().withMessage('Template subject is required'),
  body('template.body').notEmpty().withMessage('Template body is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  handleValidationErrors,
  async (req, res) => {
    const { email, template, senderName, credentials } = req.body;
    
    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ error: credError });
    }
    
    let transporter;
    try {
      transporter = createTransporterFromCredentials(credentials);
      
      const sanitizedSubject = sanitizeEmailHeader(template.subject);
      const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
      const htmlBody = sanitizeHtml(template.body).replace(/\n/g, '<br>');
      
      await transporter.sendMail({
        from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
        to: email,
        subject: sanitizedSubject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]+>/g, ''),
      });
      
      res.json({ success: true, message: `Test email sent to ${email}` });
    } catch (err) {
      console.error('Test email error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      if (transporter) transporter.close();
    }
  }
);

export default router;
