import express from 'express';
import { body, param } from 'express-validator';
import { handleValidationErrors } from '../middleware/validation.js';
import { loadTemplates, saveTemplates } from '../services/data.js';
import { sanitizeHtml } from '../services/helpers.js';

const router = express.Router();

// Get all templates
router.get('/', (req, res) => {
  const templates = loadTemplates();
  res.json(templates);
});

// Save all templates
router.post('/',
  body('templates').isArray().withMessage('Templates must be an array'),
  handleValidationErrors,
  (req, res) => {
    const { templates } = req.body;
    
    const sanitizedTemplates = templates.map(t => ({
      subject: String(t.subject || '').slice(0, 200),
      body: sanitizeHtml(String(t.body || '')),
    }));
    
    saveTemplates(sanitizedTemplates);
    res.json({ success: true });
  }
);

// Add a template
router.post('/add',
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
router.delete('/:index',
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

export default router;
