import nodemailer from 'nodemailer';

// Create transporter from request credentials
export const createTransporterFromCredentials = (credentials) => {
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
