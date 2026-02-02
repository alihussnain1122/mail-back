import fs from 'fs';
import csv from 'csv-parser';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Load email templates from JSON file
const templates = JSON.parse(fs.readFileSync('email_templates.json', 'utf-8'));
let templateIndex = 0;

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Get email from templates (cycles through all 50 templates)
function getEmailFromTemplate() {
  const template = templates[templateIndex];
  templateIndex = (templateIndex + 1) % templates.length;
  
  // Convert plain text body to HTML format
  const htmlBody = template.body
    .replace(/\n/g, '<br>')
    .replace(/•/g, '•');
  
  return {
    subject: template.subject,
    body: htmlBody
  };
}

// Human-like delay
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Send cold emails
async function sendColdEmails(csvFile) {
  const contacts = [];

  fs.createReadStream(csvFile)
    .pipe(csv({ headers: ['Email'], skipLines: 1 }))
    .on('data', row => contacts.push(row))
    .on('end', async () => {
      console.log(`Total contacts: ${contacts.length}`);
      console.log(`Total templates available: ${templates.length}`);

      for (const contact of contacts) {
        const email = contact.Email?.trim();
        if (!email) continue;

        try {
          console.log(`Preparing email for: ${email}`);
          const emailContent = getEmailFromTemplate();

          if (!emailContent.subject || !emailContent.body) {
            console.error(`Skipping ${email}: No subject/body`);
            continue;
          }

          await transporter.sendMail({
            from: `"Ali" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: emailContent.subject,
            html: emailContent.body,
          });

          console.log(`Email sent to: ${email} | Template #${templateIndex === 0 ? templates.length : templateIndex}`);

          // Human-like delay 10-110 seconds
          const delay = Math.floor(Math.random() * 110000) + 10000;
          console.log(`Waiting for ${Math.round(delay / 1000)} seconds...`);
          await wait(delay);

        } catch (err) {
          console.error(`Failed for ${email}:`, err.message);
        }
      }

      console.log("All emails processed!");
    });
}

// Run the script
sendColdEmails('contacts.csv');
