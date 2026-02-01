import fs from 'fs';
import csv from 'csv-parser';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

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

// Generate email using Gemini API
async function generateEmail(email) {
  try {
    const prompt = `Write a cold email for guest posting opportunities that closely matches the following sample. Do not use any placeholders, names, or company variables. Do not mention any specific articles, topics, or use brackets.

  The email must be in proper email format: subject, greeting, body (with clear paragraphs and line breaks using <br> for HTML), and closing. The subject line must be unique for each email and relevant to guest posting. Do not use any placeholder text or variables.

  The closing must be a greeting (such as Regards, Best, or Kind regards), then 'Ali' on the next line, and 'Tech Malba' on the line after that, each separated by <br> for HTML. Example:

  Kind regards,<br>Ali<br>Tech Malba<br>

  Sample:
  Subject: Guest Posting Opportunity

  Hi,<br><br>
  I’m contacting you to explore guest posting opportunities on your website.<br><br>
  We specialize in:<br>
  • High-authority content placements<br>
  • Contextual, niche-relevant backlinks<br>
  • SEO strategies focused on long-term results<br><br>
  If you’re interested, feel free to reply and I’ll share more details.<br><br>
  Kind regards,<br>Ali<br>Tech Malba<br>

  Respond only with JSON: { "subject": "...", "body": "..." }.`;

    const urlWithKey = `${process.env.GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(urlWithKey, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json" }
      }),
    });

    const data = await response.json();
    console.log('Gemini response data:', data);

    // Parse Gemini response
    if (data.candidates && data.candidates[0].content.parts[0].text) {
      const rawText = data.candidates[0].content.parts[0].text;
      return JSON.parse(rawText); // { subject: "...", body: "..." }
    } else {
      throw new Error("Invalid response structure from Gemini");
    }

  } catch (err) {
    console.warn(`Gemini failed for ${email}, using fallback.`, err.message);
    return {
      subject: `Guest post opportunity for ${email}`,
      body: `Hi there, I would love to contribute a guest post to your website. Let me know if you're interested. Best Ali`
    };
  }
}

// Human-like delay
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Send cold emails
async function sendColdEmails(csvFile) {
  const contacts = [];

  fs.createReadStream(csvFile)
    .pipe(csv({ headers: ['Email'], skipLines: 1 })) // skip header
    .on('data', row => contacts.push(row))
    .on('end', async () => {
      console.log(`Total contacts: ${contacts.length}`);

      for (const contact of contacts) {
        const email = contact.Email?.trim();
        if (!email) continue;

        try {
          console.log(`Generating email for: ${email}`);
          const emailContent = await generateEmail(email);

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

          console.log(`Email sent to: ${email}`);

          // Human-like delay 10-90 seconds
          const delay = Math.floor(Math.random() * 80000) + 10000;
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
