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
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();

// CORS configuration - allow all origins for API access
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// Check if running on Vercel serverless (only check VERCEL env var)
const isVercel = process.env.VERCEL === '1';

// Configure multer for file uploads
// Use memory storage for serverless (Vercel), disk storage for traditional servers
const storage = isVercel 
  ? multer.memoryStorage()
  : multer.diskStorage({ destination: 'uploads/' });
const upload = multer({ storage });

// Ensure uploads directory exists (local only)
if (!isVercel && !fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

// In-memory storage for Vercel deployment
let inMemoryTemplates = [];
let inMemoryContacts = [];
let inMemoryConfig = {
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: process.env.SMTP_PORT || '587',
  emailUser: process.env.EMAIL_USER || '',
  emailPass: process.env.EMAIL_PASS || '',
};

// Store email sending state
let isSending = false;
let sendingProgress = { 
  sent: 0, 
  total: 0, 
  current: '', 
  failed: [], 
  logs: [],
  currentTemplate: null,
  nextEmailTime: null,
  delaySeconds: 0,
  startTime: null
};
let stopRequested = false;

// Load templates (memory for Vercel, file for local)
function loadTemplates() {
  if (isVercel) {
    return inMemoryTemplates;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'email_templates.json'), 'utf-8'));
  } catch {
    return [];
  }
}

// Load contacts (memory for Vercel, file for local)
function loadContacts() {
  if (isVercel) {
    return Promise.resolve(inMemoryContacts);
  }
  return new Promise((resolve, reject) => {
    const contacts = [];
    const csvPath = path.join(__dirname, 'contacts.csv');
    
    if (!fs.existsSync(csvPath)) {
      resolve([]);
      return;
    }
    
    fs.createReadStream(csvPath)
      .pipe(csv({ headers: ['Email'], skipLines: 1 }))
      .on('data', row => {
        if (row.Email?.trim()) {
          contacts.push({ email: row.Email.trim() });
        }
      })
      .on('end', () => resolve(contacts))
      .on('error', reject);
  });
}

// Save contacts (memory for Vercel, file for local)
async function saveContacts(contacts) {
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

// Save templates (memory for Vercel, file for local)
function saveTemplates(templates) {
  if (isVercel) {
    inMemoryTemplates = templates;
    return;
  }
  fs.writeFileSync(
    path.join(__dirname, 'email_templates.json'),
    JSON.stringify(templates, null, 2)
  );
}

// Create transporter
function createTransporter() {
  const config = isVercel ? inMemoryConfig : {
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT,
    emailUser: process.env.EMAIL_USER,
    emailPass: process.env.EMAIL_PASS,
  };
  
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort),
    secure: false,
    auth: {
      user: config.emailUser,
      pass: config.emailPass,
    },
  });
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    smtp: !!(process.env.SMTP_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS)
  });
});

// Get SMTP configuration status
app.get('/api/config', (req, res) => {
  const configured = isVercel 
    ? !!(inMemoryConfig.smtpHost && inMemoryConfig.emailUser && inMemoryConfig.emailPass)
    : !!(process.env.SMTP_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS);
  
  res.json({
    configured,
    smtpHost: isVercel ? inMemoryConfig.smtpHost : (process.env.SMTP_HOST || ''),
    smtpPort: isVercel ? inMemoryConfig.smtpPort : (process.env.SMTP_PORT || '587'),
    emailUser: isVercel ? inMemoryConfig.emailUser : (process.env.EMAIL_USER || ''),
  });
});

// Update SMTP configuration
app.post('/api/config', (req, res) => {
  const { smtpHost, smtpPort, emailUser, emailPass } = req.body;
  
  if (isVercel) {
    // Store in memory for Vercel
    inMemoryConfig = { smtpHost, smtpPort, emailUser, emailPass };
    res.json({ success: true });
  } else {
    // Write to .env file for local
    const envContent = `SMTP_HOST=${smtpHost}
SMTP_PORT=${smtpPort}
EMAIL_USER=${emailUser}
EMAIL_PASS=${emailPass}
`;
    fs.writeFileSync(path.join(__dirname, '.env'), envContent);
    dotenv.config({ override: true });
    res.json({ success: true });
  }
});

// Get all templates
app.get('/api/templates', (req, res) => {
  const templates = loadTemplates();
  res.json(templates);
});

// Save all templates
app.post('/api/templates', (req, res) => {
  const { templates } = req.body;
  saveTemplates(templates);
  res.json({ success: true });
});

// Add a template
app.post('/api/templates/add', (req, res) => {
  const { subject, body } = req.body;
  const templates = loadTemplates();
  templates.push({ subject, body });
  saveTemplates(templates);
  res.json({ success: true, templates });
});

// Delete a template
app.delete('/api/templates/:index', (req, res) => {
  const index = parseInt(req.params.index);
  const templates = loadTemplates();
  if (index >= 0 && index < templates.length) {
    templates.splice(index, 1);
    saveTemplates(templates);
    res.json({ success: true, templates });
  } else {
    res.status(400).json({ error: 'Invalid template index' });
  }
});

// Get all contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await loadContacts();
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save all contacts
app.post('/api/contacts', async (req, res) => {
  try {
    const { contacts } = req.body;
    await saveContacts(contacts);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add contacts (bulk)
app.post('/api/contacts/add', async (req, res) => {
  try {
    const { emails } = req.body;
    const existing = await loadContacts();
    const existingEmails = new Set(existing.map(c => c.email.toLowerCase()));
    
    const newContacts = emails
      .filter(email => email && !existingEmails.has(email.toLowerCase()))
      .map(email => ({ email }));
    
    const allContacts = [...existing, ...newContacts];
    await saveContacts(allContacts);
    
    res.json({ success: true, added: newContacts.length, contacts: allContacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete contact
app.delete('/api/contacts/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const contacts = await loadContacts();
    const filtered = contacts.filter(c => c.email.toLowerCase() !== email.toLowerCase());
    await saveContacts(filtered);
    res.json({ success: true, contacts: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload contacts CSV file
app.post('/api/upload/contacts', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const contacts = [];
    
    if (isVercel) {
      // Parse from memory buffer for Vercel
      const fileContent = req.file.buffer.toString('utf-8');
      const lines = fileContent.split(/\r?\n/);
      
      // Skip header line, parse rest
      for (let i = 1; i < lines.length; i++) {
        const email = lines[i].trim();
        if (email && email.includes('@')) {
          contacts.push({ email });
        }
      }
      
      await saveContacts(contacts);
      res.json({ success: true, contacts, count: contacts.length });
    } else {
      // Parse from file for local
      const filePath = req.file.path;
      
      fs.createReadStream(filePath)
        .pipe(csv({ headers: ['Email'], skipLines: 1 }))
        .on('data', row => {
          if (row.Email?.trim()) {
            contacts.push({ email: row.Email.trim() });
          }
        })
        .on('end', async () => {
          await saveContacts(contacts);
          fs.unlinkSync(filePath);
          res.json({ success: true, contacts, count: contacts.length });
        })
        .on('error', (err) => {
          fs.unlinkSync(filePath);
          res.status(500).json({ error: 'Failed to parse CSV file' });
        });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload templates JSON file
app.post('/api/upload/templates', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let fileContent;
    
    if (isVercel) {
      // Read from memory buffer for Vercel
      fileContent = req.file.buffer.toString('utf-8');
    } else {
      // Read from file for local
      fileContent = fs.readFileSync(req.file.path, 'utf-8');
    }
    
    try {
      const templates = JSON.parse(fileContent);
      
      if (!Array.isArray(templates)) {
        throw new Error('Templates must be an array');
      }
      
      // Validate template structure
      for (const template of templates) {
        if (!template.subject || !template.body) {
          throw new Error('Each template must have subject and body');
        }
      }
      
      // Save templates
      saveTemplates(templates);
      
      // Clean up uploaded file (local only)
      if (!isVercel && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      
      res.json({ success: true, templates, count: templates.length });
    } catch (parseErr) {
      if (!isVercel && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      res.status(400).json({ error: 'Invalid JSON format: ' + parseErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get sending status
app.get('/api/send/status', (req, res) => {
  res.json({
    isSending,
    progress: sendingProgress
  });
});

// Start sending emails
app.post('/api/send/start', async (req, res) => {
  if (isSending) {
    return res.status(400).json({ error: 'Already sending emails' });
  }
  
  const { selectedContacts, selectedTemplates, delayMin = 10, delayMax = 90, senderName = 'Ali' } = req.body;
  
  const contacts = selectedContacts || await loadContacts();
  const allTemplates = loadTemplates();
  const templates = selectedTemplates 
    ? selectedTemplates.map(i => allTemplates[i]).filter(Boolean)
    : allTemplates;
  
  if (contacts.length === 0) {
    return res.status(400).json({ error: 'No contacts to send to' });
  }
  
  if (templates.length === 0) {
    return res.status(400).json({ error: 'No templates available' });
  }
  
  isSending = true;
  stopRequested = false;
  sendingProgress = { 
    sent: 0, 
    total: contacts.length, 
    current: '', 
    failed: [], 
    logs: [],
    currentTemplate: null,
    nextEmailTime: null,
    delaySeconds: 0,
    startTime: new Date().toISOString()
  };
  
  res.json({ success: true, message: 'Email sending started' });
  
  // Start sending in background
  sendEmails(contacts, templates, delayMin, delayMax, senderName);
});

// Stop sending emails
app.post('/api/send/stop', (req, res) => {
  stopRequested = true;
  isSending = false;
  res.json({ success: true, message: 'Stop requested' });
});

// Send a single email (for Vercel serverless - frontend controls the loop)
app.post('/api/send/single', async (req, res) => {
  const { email, template, senderName = 'Ali' } = req.body;
  
  console.log('Received send request for:', email);
  
  if (!email || !template) {
    console.error('Missing email or template');
    return res.status(400).json({ success: false, error: 'Email and template are required' });
  }
  
  try {
    const emailUser = isVercel ? inMemoryConfig.emailUser : process.env.EMAIL_USER;
    const emailPass = isVercel ? inMemoryConfig.emailPass : process.env.EMAIL_PASS;
    const smtpHost = isVercel ? inMemoryConfig.smtpHost : process.env.SMTP_HOST;
    const smtpPort = isVercel ? inMemoryConfig.smtpPort : process.env.SMTP_PORT;
    
    console.log('SMTP Config:', { host: smtpHost, port: smtpPort, user: emailUser, hasPass: !!emailPass });
    
    if (!emailUser || !emailPass || !smtpHost) {
      console.error('SMTP not configured');
      return res.status(400).json({ success: false, error: 'SMTP not configured. Please set up in Settings.' });
    }
    
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(smtpPort) || 587,
      secure: false,
      auth: { user: emailUser, pass: emailPass },
    });
    
    console.log('Verifying SMTP connection...');
    await transporter.verify();
    console.log('SMTP verified, sending email...');
    
    const htmlBody = template.body.replace(/\n/g, '<br>').replace(/•/g, '•');
    
    const info = await transporter.sendMail({
      from: `"${senderName}" <${emailUser}>`,
      to: email,
      subject: template.subject,
      html: htmlBody,
    });
    
    console.log('Email sent successfully:', info.messageId);
    res.json({ success: true, message: `Email sent to ${email}`, messageId: info.messageId });
  } catch (err) {
    console.error('Send error:', err.message);
    console.error('Full error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send test email
app.post('/api/send/test', async (req, res) => {
  const { email, templateIndex } = req.body;
  
  try {
    const templates = loadTemplates();
    const template = templates[templateIndex || 0];
    
    if (!template) {
      return res.status(400).json({ error: 'Template not found' });
    }
    
    const emailUser = isVercel ? inMemoryConfig.emailUser : process.env.EMAIL_USER;
    const emailPass = isVercel ? inMemoryConfig.emailPass : process.env.EMAIL_PASS;
    const smtpHost = isVercel ? inMemoryConfig.smtpHost : process.env.SMTP_HOST;
    const smtpPort = isVercel ? inMemoryConfig.smtpPort : process.env.SMTP_PORT;
    
    if (!emailUser || !emailPass || !smtpHost) {
      return res.status(400).json({ error: 'SMTP not configured. Please set up in Settings.' });
    }
    
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(smtpPort) || 587,
      secure: false,
      auth: { user: emailUser, pass: emailPass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    
    const htmlBody = template.body.replace(/\n/g, '<br>').replace(/•/g, '•');
    
    await transporter.sendMail({
      from: `"Ali" <${emailUser}>`,
      to: email,
      subject: template.subject,
      html: htmlBody,
    });
    
    res.json({ success: true, message: `Test email sent to ${email}` });
  } catch (err) {
    console.error('Test email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Background email sending function
async function sendEmails(contacts, templates, delayMin, delayMax, senderName) {
  const transporter = createTransporter();
  const emailUser = isVercel ? inMemoryConfig.emailUser : process.env.EMAIL_USER;
  let templateIndex = 0;
  
  for (const contact of contacts) {
    if (stopRequested) {
      sendingProgress.logs.push({ time: new Date().toISOString(), message: 'Sending stopped by user' });
      break;
    }
    
    const email = contact.email || contact;
    sendingProgress.current = email;
    
    try {
      const template = templates[templateIndex];
      sendingProgress.currentTemplate = {
        index: templateIndex + 1,
        subject: template.subject,
        total: templates.length
      };
      
      templateIndex = (templateIndex + 1) % templates.length;
      
      const htmlBody = template.body.replace(/\n/g, '<br>').replace(/•/g, '•');
      
      await transporter.sendMail({
        from: `"${senderName}" <${emailUser}>`,
        to: email,
        subject: template.subject,
        html: htmlBody,
      });
      
      sendingProgress.sent++;
      sendingProgress.logs.push({
        time: new Date().toISOString(),
        message: `✓ Sent to ${email} (Template #${sendingProgress.currentTemplate.index})`,
        success: true
      });
      
      // Random delay between emails
      if (contacts.indexOf(contact) < contacts.length - 1) {
        const delay = Math.floor(Math.random() * (delayMax - delayMin) * 1000) + delayMin * 1000;
        sendingProgress.delaySeconds = Math.round(delay / 1000);
        sendingProgress.nextEmailTime = new Date(Date.now() + delay).toISOString();
        
        sendingProgress.logs.push({
          time: new Date().toISOString(),
          message: `Waiting ${sendingProgress.delaySeconds} seconds...`,
          info: true
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
    } catch (err) {
      sendingProgress.failed.push({ email, error: err.message });
      sendingProgress.logs.push({
        time: new Date().toISOString(),
        message: `✗ Failed for ${email}: ${err.message}`,
        success: false
      });
    }
  }
  
  sendingProgress.current = '';
  sendingProgress.currentTemplate = null;
  sendingProgress.nextEmailTime = null;
  sendingProgress.delaySeconds = 0;
  sendingProgress.logs.push({
    time: new Date().toISOString(),
    message: `Completed! Sent: ${sendingProgress.sent}/${sendingProgress.total}, Failed: ${sendingProgress.failed.length}`,
    info: true
  });
  isSending = false;
}

// Start server (for Render, Railway, local, etc.)
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export for Vercel serverless
export default app;
