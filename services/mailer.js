// Nodemailer helpers
import nodemailer from 'nodemailer';

export function createTransporterFromCredentials(credentials) {
  return nodemailer.createTransport({
    host: credentials.smtpHost,
    port: Number(credentials.smtpPort) || 587,
    secure: false,
    auth: {
      user: credentials.emailUser,
      pass: credentials.emailPass,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

export function sanitizeEmailHeader(str) {
  return String(str).replace(/[\r\n]/g, '').slice(0, 200);
}
