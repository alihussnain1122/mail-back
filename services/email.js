import nodemailer from 'nodemailer';

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildRawMime({ from, to, subject, html, text }) {
  const boundary = `boundary_${Date.now().toString(16)}`;
  const plainText = text || (html || '').replace(/<[^>]+>/g, '');

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject || ''}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    plainText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html || '',
    '',
    `--${boundary}--`,
    '',
  ];

  return toBase64Url(lines.join('\r\n'));
}

async function gmailApiRequest(path, accessToken, method = 'GET', body) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Gmail API error (${response.status})`;

    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || message;
    } catch {
      if (text) message = text;
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Google authorization expired or missing Gmail permissions. Reconnect Google in Settings and try again.');
    }

    throw new Error(message);
  }

  if (response.status === 204) return null;
  return response.json();
}

function createGoogleApiTransport(credentials) {
  return {
    async verify() {
      await gmailApiRequest('profile', credentials.googleAccessToken, 'GET');
      return true;
    },
    async sendMail(mailOptions) {
      const raw = buildRawMime({
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject,
        html: mailOptions.html,
        text: mailOptions.text,
      });

      const result = await gmailApiRequest('messages/send', credentials.googleAccessToken, 'POST', { raw });
      return {
        messageId: result?.id || null,
        response: 'OK',
      };
    },
    close() {
      // No persistent connection to close for Gmail API transport.
    },
  };
}

// Create transporter from request credentials
export const createTransporterFromCredentials = (credentials) => {
  if (credentials.authType === 'google' && credentials.googleAccessToken) {
    return createGoogleApiTransport(credentials);
  }

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

