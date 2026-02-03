import express from 'express';
import cors from 'cors';
import fs from 'fs';
import csv from 'csv-parser';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { createObjectCsvWriter } from 'csv-writer';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { body, param, validationResult } from 'express-validator';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();

// Trust proxy for proper IP detection behind reverse proxies (Railway, Render, etc.)
app.set('trust proxy', 1);

// ===================
// CONFIGURATION
// ===================
const CONFIG = {
  port: process.env.PORT || 3001,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  defaultSenderName: process.env.DEFAULT_SENDER_NAME || 'Support Team',
  maxFileSize: 5 * 1024 * 1024, // 5MB
};

// ===================
// SUPABASE CLIENT
// ===================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://otkpdhkerefqaulhagqw.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service role key for backend

let supabase = null;
if (SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('✅ Supabase client initialized for tracking');
} else {
  console.warn('⚠️ SUPABASE_SERVICE_KEY not set - tracking events will only be logged');
}

// ===================
// MIDDLEWARE
// ===================


// CORS - Restrict to frontend URL only

// ... (CORS and other middleware setup here) ...

// Ensure uploads directory exists (only in non-Vercel environment)
if (!isVercel && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Import and use contacts router after middleware
import contactsRouter from './routes/contacts.js';
app.use('/api/contacts', contactsRouter);

// ===================
// VALIDATION HELPERS
// ===================
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
};

// Sanitize string for email headers (prevent header injection)
const sanitizeEmailHeader = (str) => {
  if (!str) return '';
  // Remove newlines, carriage returns, and other control characters
  return String(str)
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .replace(/"/g, "'") // Replace quotes to prevent format breaking
    .slice(0, 200); // Limit length
};

// Sanitize HTML to prevent XSS
// Allowlist-based approach - only allow specific safe tags and attributes
const ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'i', 'u', 'em', 'strong', 'a', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'span', 'div', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
]);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'class', 'style']);

const sanitizeHtml = (html) => {
  if (!html) return '';
  
  // Remove all script, style, iframe, object, embed tags completely
  let clean = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '');
  
  // Remove all event handlers (on*)
  clean = clean.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  
  // Remove javascript: and data: URLs
  clean = clean.replace(/href\s*=\s*["']?\s*javascript:[^"'>]*/gi, 'href="#"');
  clean = clean.replace(/href\s*=\s*["']?\s*data:[^"'>]*/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*["']?\s*javascript:[^"'>]*/gi, '');
  clean = clean.replace(/src\s*=\s*["']?\s*data:[^"'>]*/gi, '');
  
  // Remove dangerous CSS expressions
  clean = clean.replace(/expression\s*\(/gi, '');
  clean = clean.replace(/url\s*\(\s*["']?\s*javascript:/gi, 'url(');
  
  return clean;
};

// ===================
// DATA FUNCTIONS
// ===================

// In-memory storage for Vercel (serverless has no persistent filesystem)
let inMemoryTemplates = [];
let inMemoryContacts = [];

function loadTemplates() {
  // On Vercel, return in-memory data (no file access)
  if (isVercel) {
    return inMemoryTemplates;
  }
  try {
    const data = fs.readFileSync(path.join(__dirname, 'email_templates.json'), 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error loading templates:', err.message);
    }
    return [];
  }
}

function loadContacts() {
  return new Promise((resolve, reject) => {
    // On Vercel, return in-memory data
    if (isVercel) {
      resolve(inMemoryContacts);
      return;
    }
    
    const contacts = [];
    const csvPath = path.join(__dirname, 'contacts.csv');
    
    if (!fs.existsSync(csvPath)) {
      resolve([]);
      return;
    }
    
    const stream = fs.createReadStream(csvPath);
    
    stream
      .pipe(csv({ headers: ['Email'], skipLines: 1 }))
      .on('data', row => {
        const email = row.Email?.trim();
        if (email && validateEmail(email)) {
          contacts.push({ email });
        }
      })
      .on('end', () => {
        stream.destroy();
        resolve(contacts);
      })
      .on('error', (err) => {
        stream.destroy();
        reject(err);
      });
  });
}

async function saveContacts(contacts) {
  // On Vercel, store in memory only
  if (isVercel) {
    inMemoryContacts = contacts;
    return;
  }
  const csvWriter = createObjectCsvWriter({
    path: path.join(__dirname, 'contacts.csv'),
    header: [{ id: 'email', title: 'Email' }]
  });
  await csvWriter.writeRecords(contacts);
}

function saveTemplates(templates) {
  // On Vercel, store in memory only
  if (isVercel) {
    inMemoryTemplates = templates;
    return;
  }
  try {
    fs.writeFileSync(
      path.join(__dirname, 'email_templates.json'),
      JSON.stringify(templates, null, 2)
    );
  } catch (err) {
    console.error('Error saving templates:', err.message);
    throw new Error('Failed to save templates');
  }
}

// Note: createTransporter removed - credentials now come from request body

// ===================
// API ROUTES
// ===================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mode: 'session-credentials', // Credentials provided per-request by user
  });
});

// Get SMTP configuration status - Now just returns defaults
// Actual credentials are stored in user's browser localStorage
app.get('/api/config', (req, res) => {
  res.json({
    configured: false, // Always false - user must configure in browser
    smtpHost: '',
    smtpPort: '587',
    emailUser: '',
    senderName: 'Support Team',
    message: 'Configure your SMTP credentials in Settings. They are stored in your browser only.',
  });
});

// Config update endpoint removed - credentials are now stored client-side only

// ===================
// TEMPLATES ROUTES
// ===================

// Get all templates
app.get('/api/templates', (req, res) => {
  const templates = loadTemplates();
  res.json(templates);
});

// Save all templates
app.post('/api/templates',
  body('templates').isArray().withMessage('Templates must be an array'),
  handleValidationErrors,
  (req, res) => {
    const { templates } = req.body;
    
    // Validate and sanitize each template
    const sanitizedTemplates = templates.map(t => ({
      subject: String(t.subject || '').slice(0, 200),
      body: sanitizeHtml(String(t.body || '')),
    }));
    
    saveTemplates(sanitizedTemplates);
    res.json({ success: true });
  }
);

// Add a template
app.post('/api/templates/add',
  body('subject').notEmpty().withMessage('Subject is required').isLength({ max: 200 }),
  body('body').notEmpty().withMessage('Body is required'),
  handleValidationErrors,
  (req, res) => {
    const { subject, body: templateBody } = req.body;
    const templates = loadTemplates();
    
    templates.push({ 
      subject: subject.slice(0, 200), 
      body: sanitizeHtml(templateBody) 
    });
    
    saveTemplates(templates);
    res.json({ success: true, templates });
  }
);

// Delete a template
app.delete('/api/templates/:index',
  param('index').isInt({ min: 0 }).withMessage('Invalid template index'),
  handleValidationErrors,
  (req, res) => {
    const index = parseInt(req.params.index);
    const templates = loadTemplates();
    
    if (index >= templates.length) {
      return res.status(400).json({ error: 'Invalid template index' });
    }
    
    templates.splice(index, 1);
    saveTemplates(templates);
    res.json({ success: true, templates });
  }
);

// ===================
// CONTACTS ROUTES
// ===================

// Get all contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await loadContacts();
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// Save all contacts
app.post('/api/contacts',
  body('contacts').isArray().withMessage('Contacts must be an array'),
  handleValidationErrors,
  async (req, res) => {
    try {
      const { contacts } = req.body;
      
      // Validate all emails
      const validContacts = contacts
        .filter(c => c.email && validateEmail(c.email))
        .map(c => ({ email: c.email.toLowerCase().trim() }));
      
      await saveContacts(validContacts);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save contacts' });
    }
  }
);

// Add contacts (bulk)
app.post('/api/contacts/add',
  body('emails').isArray().withMessage('Emails must be an array'),
  handleValidationErrors,
  async (req, res) => {
    try {
      const { emails } = req.body;
      const existing = await loadContacts();
      const existingEmails = new Set(existing.map(c => c.email.toLowerCase()));
      
      const newContacts = emails
        .filter(email => email && validateEmail(email) && !existingEmails.has(email.toLowerCase()))
        .map(email => ({ email: email.toLowerCase().trim() }));
      
      const allContacts = [...existing, ...newContacts];
      await saveContacts(allContacts);
      
      res.json({ success: true, added: newContacts.length, contacts: allContacts });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add contacts' });
    }
  }
);

// Delete contact
app.delete('/api/contacts/:email',
  param('email').notEmpty().withMessage('Email is required'),
  handleValidationErrors,
  async (req, res) => {
    try {
      const email = decodeURIComponent(req.params.email).toLowerCase();
      const contacts = await loadContacts();
      const filtered = contacts.filter(c => c.email.toLowerCase() !== email);
      await saveContacts(filtered);
      res.json({ success: true, contacts: filtered });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete contact' });
    }
  }
);

// ===================
// FILE UPLOAD ROUTES
// ===================

// Upload contacts CSV file
app.post('/api/upload/contacts', upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const contacts = [];
    
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath)
        .pipe(csv({ headers: ['Email'], skipLines: 1 }))
        .on('data', row => {
          const email = row.Email?.trim();
          if (email && validateEmail(email)) {
            contacts.push({ email: email.toLowerCase() });
          }
        })
        .on('end', resolve)
        .on('error', (err) => {
          stream.destroy();
          reject(err);
        });
    });
    
    // Remove duplicates
    const uniqueContacts = [...new Map(contacts.map(c => [c.email, c])).values()];
    
    await saveContacts(uniqueContacts);
    
    // Safe cleanup after stream is closed
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    
    res.json({ success: true, contacts: uniqueContacts, count: uniqueContacts.length });
  } catch (err) {
    // Safe cleanup
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
    res.status(500).json({ error: 'Failed to parse CSV file' });
  }
});

// Upload templates JSON file
app.post('/api/upload/templates', upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const templates = JSON.parse(fileContent);
    
    if (!Array.isArray(templates)) {
      throw new Error('Templates must be an array');
    }
    
    // Validate and sanitize
    const sanitizedTemplates = templates.map(t => {
      if (!t.subject || !t.body) {
        throw new Error('Each template must have subject and body');
      }
      return {
        subject: String(t.subject).slice(0, 200),
        body: sanitizeHtml(String(t.body)),
      };
    });
    
    saveTemplates(sanitizedTemplates);
    
    // Safe cleanup
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    
    res.json({ success: true, templates: sanitizedTemplates, count: sanitizedTemplates.length });
  } catch (err) {
    // Safe cleanup
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
    res.status(400).json({ error: 'Invalid JSON format: ' + err.message });
  }
});

// ===================
// EMAIL SENDING ROUTES
// ===================

// Helper to validate credentials from request
const validateCredentials = (credentials) => {
  if (!credentials) return 'SMTP credentials required. Please configure in Settings.';
  if (!credentials.smtpHost) return 'SMTP host is required';
  if (!credentials.emailUser) return 'Email address is required';
  if (!credentials.emailPass) return 'Email password is required';
  return null;
};

// Create transporter from request credentials (not .env)
const createTransporterFromCredentials = (credentials) => {
  return nodemailer.createTransport({
    host: credentials.smtpHost,
    port: Number(credentials.smtpPort) || 587,
    secure: false,
    auth: { 
      user: credentials.emailUser, 
      pass: credentials.emailPass 
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
};

// Generate tracking ID for an email
const generateTrackingId = (campaignId, email, userId) => {
  const data = `${campaignId}:${email}:${userId}`;
  return Buffer.from(data).toString('base64url');
};

// Inject tracking pixel and wrap links
const BACKEND_URL = process.env.BACKEND_URL || 'https://mail-back-nine.vercel.app';

const injectTracking = (htmlBody, trackingId, enableTracking = true) => {
  if (!enableTracking) return htmlBody;
  
  let trackedHtml = htmlBody;
  
  // Wrap all links for click tracking
  trackedHtml = trackedHtml.replace(
    /<a\s+([^>]*href=["'])([^"']+)(["'][^>]*)>/gi,
    (match, prefix, url, suffix) => {
      // Skip tracking for unsubscribe links or already tracked links
      if (url.includes('/api/track/') || url.includes('/api/unsubscribe/')) {
        return match;
      }
      const trackedUrl = `${BACKEND_URL}/api/track/click/${trackingId}?url=${encodeURIComponent(url)}`;
      return `<a ${prefix}${trackedUrl}${suffix}>`;
    }
  );
  
  // Add tracking pixel before closing body tag (or at end if no body tag)
  const trackingPixel = `<img src="${BACKEND_URL}/api/track/open/${trackingId}" width="1" height="1" style="display:none;visibility:hidden;" alt="" />`;
  
  if (trackedHtml.includes('</body>')) {
    trackedHtml = trackedHtml.replace('</body>', `${trackingPixel}</body>`);
  } else {
    trackedHtml += trackingPixel;
  }
  
  // Add unsubscribe link if not present
  if (!trackedHtml.includes('unsubscribe')) {
    const unsubscribeLink = `<p style="font-size:11px;color:#999;margin-top:30px;text-align:center;"><a href="${BACKEND_URL}/api/unsubscribe/${trackingId}" style="color:#999;">Unsubscribe</a></p>`;
    if (trackedHtml.includes('</body>')) {
      trackedHtml = trackedHtml.replace('</body>', `${unsubscribeLink}</body>`);
    } else {
      trackedHtml += unsubscribeLink;
    }
  }
  
  return trackedHtml;
};

// Send a single email (credentials from request body)
app.post('/api/send/single', 
  emailLimiter,
  body('email').isEmail().withMessage('Valid email is required'),
  body('template.subject').notEmpty().withMessage('Template subject is required'),
  body('template.body').notEmpty().withMessage('Template body is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  handleValidationErrors,
  async (req, res) => {
    const { email, template, senderName, credentials, campaignId, userId, enableTracking } = req.body;
    
    // Validate credentials
    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ success: false, error: credError });
    }
    
    let transporter;
    let trackingId = null;
    
    try {
      transporter = createTransporterFromCredentials(credentials);
      
      await transporter.verify();
      
      // Sanitize all inputs for email headers
      const sanitizedSubject = sanitizeEmailHeader(template.subject);
      const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
      let htmlBody = sanitizeHtml(template.body).replace(/\n/g, '<br>');
      
      // Generate tracking ID and inject tracking if enabled
      if (enableTracking && campaignId && userId) {
        trackingId = generateTrackingId(campaignId, email, userId);
        htmlBody = injectTracking(htmlBody, trackingId, true);
      }
      
      const info = await transporter.sendMail({
        from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
        to: email,
        subject: sanitizedSubject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]+>/g, ''), // Plain text fallback
      });
      
      res.json({ 
        success: true, 
        message: `Email sent to ${email}`, 
        messageId: info.messageId,
        trackingId, // Return for storing in campaign_emails
      });
    } catch (err) {
      console.error('Send error:', err.message);
      
      // Check if it's a bounce/delivery failure
      const errorMessage = err.message.toLowerCase();
      const isBounce = errorMessage.includes('not exist') || 
                       errorMessage.includes('invalid') ||
                       errorMessage.includes('rejected') ||
                       errorMessage.includes('undeliverable') ||
                       errorMessage.includes('mailbox not found') ||
                       errorMessage.includes('user unknown');
      
      // Report bounce if applicable
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
      // Close transporter to prevent connection leaks
      if (transporter) transporter.close();
    }
  }
);

// Send test email (credentials from request body)
app.post('/api/send/test',
  emailLimiter,
  body('email').isEmail().withMessage('Valid email is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  handleValidationErrors,
  async (req, res) => {
    const { email, templateIndex = 0, senderName, credentials } = req.body;
    
    // Validate templateIndex is a valid integer
    const idx = parseInt(templateIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: 'Invalid template index' });
    }
    
    // Validate credentials
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
      
      // Sanitize all inputs for email headers
      const sanitizedSubject = sanitizeEmailHeader(template.subject);
      const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
      const htmlBody = sanitizeHtml(template.body).replace(/\n/g, '<br>');
      
      await transporter.sendMail({
        from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
        to: email,
        subject: sanitizedSubject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]+>/g, ''), // Plain text fallback
      });
      
      res.json({ success: true, message: `Test email sent to ${email}` });
    } catch (err) {
      console.error('Test email error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      // Close transporter to prevent connection leaks
      if (transporter) transporter.close();
    }
  }
);

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
// ===================
// EMAIL TRACKING ROUTES
// ===================

// Tracking pixel endpoint (1x1 transparent GIF)
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// Helper: Decode tracking ID to get campaign info
// Tracking ID format: base64 encoded "campaignId:email:userId"
function decodeTrackingId(trackingId) {
  try {
    const decoded = Buffer.from(trackingId, 'base64url').toString('utf8');
    const [campaignId, email, userId] = decoded.split(':');
    return { campaignId, email, userId };
  } catch {
    return null;
  }
}

// Track email open (via pixel)
app.get('/api/track/open/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  
  try {
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    
    let deviceType = 'desktop';
    if (/mobile|android|iphone|ipad/i.test(userAgent)) {
      deviceType = /ipad|tablet/i.test(userAgent) ? 'tablet' : 'mobile';
    }
    
    const trackingInfo = decodeTrackingId(trackingId);
    
    console.log('Email opened:', { trackingId, ...trackingInfo, deviceType });
    
    // Store in Supabase if connected
    if (supabase && trackingInfo) {
      await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email: trackingInfo.email,
        user_id: trackingInfo.userId,
        tracking_type: 'open',
        ip_address: ipAddress,
        user_agent: userAgent.slice(0, 500),
        device_type: deviceType,
      });
      
      // Update campaign_emails opened_at
      await supabase
        .from('campaign_emails')
        .update({ 
          opened_at: new Date().toISOString(),
          open_count: supabase.raw('COALESCE(open_count, 0) + 1')
        })
        .eq('tracking_id', trackingId)
        .is('opened_at', null);
    }
    
  } catch (err) {
    console.error('Tracking error:', err);
  }
  
  // Always return the pixel
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': TRACKING_PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(TRACKING_PIXEL);
});

// Track link click
app.get('/api/track/click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const { url } = req.query;
  
  try {
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    
    let deviceType = 'desktop';
    if (/mobile|android|iphone|ipad/i.test(userAgent)) {
      deviceType = /ipad|tablet/i.test(userAgent) ? 'tablet' : 'mobile';
    }
    
    const trackingInfo = decodeTrackingId(trackingId);
    
    console.log('Link clicked:', { trackingId, url, ...trackingInfo, deviceType });
    
    // Store in Supabase if connected
    if (supabase && trackingInfo) {
      await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email: trackingInfo.email,
        user_id: trackingInfo.userId,
        tracking_type: 'click',
        link_url: url,
        ip_address: ipAddress,
        user_agent: userAgent.slice(0, 500),
        device_type: deviceType,
      });
      
      // Update click count
      await supabase.rpc('increment_click_count', { tracking_id_param: trackingId });
    }
    
  } catch (err) {
    console.error('Click tracking error:', err);
  }
  
  // Redirect to original URL
  if (url && url.startsWith('http')) {
    res.redirect(302, url);
  } else {
    res.status(400).send('Invalid URL');
  }
});

// Unsubscribe endpoint
app.get('/api/unsubscribe/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  
  const trackingInfo = decodeTrackingId(trackingId);
  console.log('Unsubscribe requested:', { trackingId, ...trackingInfo });
  
  // Store in Supabase
  if (supabase && trackingInfo) {
    try {
      // Add to unsubscribed list
      await supabase.from('unsubscribed_emails').upsert({
        user_id: trackingInfo.userId,
        email: trackingInfo.email,
        campaign_id: trackingInfo.campaignId,
        reason: 'User clicked unsubscribe link',
      }, { onConflict: 'user_id,email' });
      
      // Log tracking event
      await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email: trackingInfo.email,
        user_id: trackingInfo.userId,
        tracking_type: 'unsubscribe',
      });
    } catch (err) {
      console.error('Unsubscribe save error:', err);
    }
  }
  
  // Show unsubscribe confirmation page
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Unsubscribed</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f3f4f6; }
        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
        h1 { color: #111827; margin-bottom: 16px; }
        p { color: #6b7280; line-height: 1.6; }
        .icon { font-size: 48px; margin-bottom: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">✅</div>
        <h1>Unsubscribed</h1>
        <p>You have been successfully unsubscribed from our mailing list. You will no longer receive emails from us.</p>
      </div>
    </body>
    </html>
  `);
});

// Report bounce (called when email delivery fails)
app.post('/api/track/bounce',
  body('email').isEmail().withMessage('Valid email required'),
  body('bounceType').isIn(['hard', 'soft']).withMessage('Invalid bounce type'),
  handleValidationErrors,
  async (req, res) => {
    const { email, trackingId, bounceType, reason, campaignId, userId } = req.body;
    
    console.log('Bounce reported:', { email, trackingId, bounceType, reason });
    
    // Store in Supabase
    if (supabase && userId) {
      try {
        // Add to bounced list
        await supabase.from('bounced_emails').upsert({
          user_id: userId,
          email,
          bounce_type: bounceType,
          reason,
          campaign_id: campaignId,
        }, { onConflict: 'user_id,email' });
        
        // Log tracking event
        if (trackingId && campaignId) {
          await supabase.from('email_tracking').insert({
            tracking_id: trackingId,
            campaign_id: campaignId,
            email,
            user_id: userId,
            tracking_type: 'bounce',
          });
          
          // Update campaign_emails
          await supabase
            .from('campaign_emails')
            .update({ bounced: true, bounce_reason: reason })
            .eq('tracking_id', trackingId);
        }
      } catch (err) {
        console.error('Bounce save error:', err);
      }
    }
    
    res.json({ success: true });
  }
);

// ===================
// ERROR HANDLER
// ===================
  
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
  // Give time for logging before exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ===================
// START SERVER WITH GRACEFUL SHUTDOWN
// ===================
const PORT = CONFIG.port;

// Only start the server if not running in Vercel serverless environment
if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`CORS enabled for: ${allowedOrigins.join(', ')}`);
  });

  // Graceful shutdown handler
  function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
      console.error('Forcing shutdown after timeout.');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Export for Vercel serverless (must be at top level)
export default app;
