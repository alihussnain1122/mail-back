import express from 'express';
import fs from 'fs';
import csv from 'csv-parser';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadContacts, saveContacts, loadTemplates, saveTemplates } from '../services/data.js';
import { validateEmail, sanitizeHtml } from '../services/helpers.js';
import { isVercel, CONFIG } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '..', 'uploads');

// Configure multer
let upload;
if (!isVercel) {
  const storage = multer.diskStorage({ 
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeName = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, safeName);
    }
  });
  upload = multer({ 
    storage,
    limits: { fileSize: CONFIG.maxFileSize },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.csv' || ext === '.json') {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only CSV and JSON files are allowed.'));
      }
    }
  });

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} else {
  upload = multer({ storage: multer.memoryStorage() });
}

const router = express.Router();

// Upload contacts CSV file
router.post('/contacts', upload.single('file'), async (req, res) => {
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
    
    const uniqueContacts = [...new Map(contacts.map(c => [c.email, c])).values()];
    await saveContacts(uniqueContacts);
    
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    
    res.json({ success: true, contacts: uniqueContacts, count: uniqueContacts.length });
  } catch (err) {
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
    res.status(500).json({ error: 'Failed to parse CSV file' });
  }
});

// Upload templates JSON file
router.post('/templates', upload.single('file'), async (req, res) => {
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
    
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    
    res.json({ success: true, templates: sanitizedTemplates, count: sanitizedTemplates.length });
  } catch (err) {
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
    res.status(400).json({ error: 'Invalid JSON format: ' + err.message });
  }
});

export default router;
