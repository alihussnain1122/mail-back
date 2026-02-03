import express from 'express';
import { body, param } from 'express-validator';
import { handleValidationErrors } from '../middleware/validation.js';
import { validateEmail } from '../services/utils.js';
import fs from 'fs';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';
import path from 'path';
import multer from 'multer';
import { loadContacts, saveContacts } from '../services/utils.js';

const router = express.Router();

// Get all contacts
router.get('/', async (req, res) => {
	try {
		const contacts = await loadContacts();
		res.json(contacts);
	} catch (err) {
		res.status(500).json({ error: 'Failed to load contacts' });
	}
});

// Save all contacts
router.post('/',
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
router.post('/add',
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
router.delete('/:email',
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

export default router;
