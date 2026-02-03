import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';
import { isVercel } from '../config/index.js';
import { validateEmail } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// In-memory storage for Vercel (serverless has no persistent filesystem)
let inMemoryTemplates = [];
let inMemoryContacts = [];

export function loadTemplates() {
  if (isVercel) {
    return inMemoryTemplates;
  }
  try {
    const data = fs.readFileSync(path.join(rootDir, 'email_templates.json'), 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error loading templates:', err.message);
    }
    return [];
  }
}

export function saveTemplates(templates) {
  if (isVercel) {
    inMemoryTemplates = templates;
    return;
  }
  try {
    fs.writeFileSync(
      path.join(rootDir, 'email_templates.json'),
      JSON.stringify(templates, null, 2)
    );
  } catch (err) {
    console.error('Error saving templates:', err.message);
    throw new Error('Failed to save templates');
  }
}

export function loadContacts() {
  return new Promise((resolve, reject) => {
    if (isVercel) {
      resolve(inMemoryContacts);
      return;
    }
    
    const contacts = [];
    const csvPath = path.join(rootDir, 'contacts.csv');
    
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

export async function saveContacts(contacts) {
  if (isVercel) {
    inMemoryContacts = contacts;
    return;
  }
  const csvWriter = createObjectCsvWriter({
    path: path.join(rootDir, 'contacts.csv'),
    header: [{ id: 'email', title: 'Email' }]
  });
  await csvWriter.writeRecords(contacts);
}
