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
import { loadTemplates } from '../services/data.js';
import { supabase } from '../services/supabase.js';

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
      console.error('Send error:', err.message);
      
      const errorMessage = err.message.toLowerCase();
      const isBounce = errorMessage.includes('not exist') || 
                       errorMessage.includes('invalid') ||
                       errorMessage.includes('rejected') ||
                       errorMessage.includes('undeliverable') ||
                       errorMessage.includes('mailbox not found') ||
                       errorMessage.includes('user unknown');
      
      if (isBounce && supabase && userId) {
        try {
          await supabase.from('bounced_emails').upsert({
            user_id: userId,
            email,
            bounce_type: 'hard',
            reason: err.message,
            campaign_id: campaignId,
          }, { onConflict: 'user_id,email' });
        } catch (bounceErr) {
          console.error('Failed to record bounce:', bounceErr);
        }
      }
      
      res.status(500).json({ 
        success: false, 
        error: err.message,
        isBounce,
      });
    } finally {
      if (transporter) transporter.close();
    }
  }
);

// Send test email
router.post('/test',
  emailLimiter,
  body('email').isEmail().withMessage('Valid email is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  handleValidationErrors,
  async (req, res) => {
    const { email, templateIndex = 0, senderName, credentials } = req.body;
    
    const idx = parseInt(templateIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: 'Invalid template index' });
    }
    
    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ error: credError });
    }
    
    let transporter;
    try {
      const templates = loadTemplates();
      const template = templates[idx];
      
      if (!template) {
        return res.status(400).json({ error: 'Template not found' });
      }
      
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
