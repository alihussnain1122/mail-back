import nodemailer from 'nodemailer';
import { CONFIG } from '../config/index.js';

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

// Inject tracking pixel and wrap links
export const injectTracking = (htmlBody, trackingId, enableTracking = true) => {
  if (!enableTracking) return htmlBody;
  
  const BACKEND_URL = CONFIG.backendUrl;
  let trackedHtml = htmlBody;
  
  // Wrap all links for click tracking (more flexible regex to handle all href positions)
  trackedHtml = trackedHtml.replace(
    /<a\s+([^>]*?)href=(["'])([^"']+)\2([^>]*)>/gi,
    (match, before, quote, url, after) => {
      if (url.includes('/api/track/') || url.includes('/api/unsubscribe/')) {
        return match;
      }
      const trackedUrl = `${BACKEND_URL}/api/track/click/${trackingId}?url=${encodeURIComponent(url)}`;
      return `<a ${before}href=${quote}${trackedUrl}${quote}${after}>`;
    }
  );
  
  // Add tracking pixel
  const trackingPixel = `<img src="${BACKEND_URL}/api/track/open/${trackingId}" width="1" height="1" style="display:none;visibility:hidden;" alt="" />`;
  
  if (trackedHtml.includes('</body>')) {
    trackedHtml = trackedHtml.replace('</body>', `${trackingPixel}</body>`);
  } else {
    trackedHtml += trackingPixel;
  }
  
  return trackedHtml;
};

// Tracking pixel (1x1 transparent GIF)
export const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);
