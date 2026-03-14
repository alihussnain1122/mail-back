// ===================
// VALIDATION & SANITIZATION HELPERS
// ===================

import crypto from 'crypto';
import { HMAC_SECRET } from '../config/index.js';

export const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Sanitize string for email headers (prevent header injection)
export const sanitizeEmailHeader = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .replace(/"/g, "'")
    .slice(0, 200);
};

// Sanitize HTML to prevent XSS
export const sanitizeHtml = (html) => {
  if (!html) return '';
  
  let clean = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '');
  
  clean = clean.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  clean = clean.replace(/href\s*=\s*["']?\s*javascript:[^"'>]*/gi, 'href="#"');
  clean = clean.replace(/href\s*=\s*["']?\s*data:[^"'>]*/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*["']?\s*javascript:[^"'>]*/gi, '');
  clean = clean.replace(/src\s*=\s*["']?\s*data:[^"'>]*/gi, '');
  clean = clean.replace(/expression\s*\(/gi, '');
  clean = clean.replace(/url\s*\(\s*["']?\s*javascript:/gi, 'url(');
  
  return clean;
};

// Validate SMTP credentials
export const validateCredentials = (credentials) => {
  if (!credentials) return 'SMTP credentials required. Please configure in Settings.';
  if (!credentials.smtpHost) return 'SMTP host is required';
  if (!credentials.emailUser) return 'Email address is required';
  if (!credentials.emailPass) return 'Email password is required';
  return null;
};

// ===================
// SECURE TRACKING ID GENERATION (HMAC signed)
// ===================

/**
 * Generate a secure, signed tracking ID
 * Format: base64url(data).signature
 * Data contains campaignId and a random nonce (NOT the email address)
 */
export const generateTrackingId = (campaignId, emailHash, userId) => {
  // Create a unique ID without exposing the actual email
  const emailHashShort = crypto.createHash('sha256').update(emailHash).digest('hex').slice(0, 16);
  const nonce = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  
  const data = {
    c: campaignId,       // campaign ID
    e: emailHashShort,   // hashed email (first 16 chars of SHA256)
    u: userId,           // user ID
    n: nonce,            // random nonce
    t: timestamp,        // timestamp
  };
  
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', HMAC_SECRET || 'default-secret')
    .update(payload)
    .digest('base64url')
    .slice(0, 16); // Use first 16 chars of signature
  
  return `${payload}.${signature}`;
};

/**
 * Verify and decode a signed tracking ID
 * Returns null if signature is invalid
 */
export function decodeTrackingId(trackingId) {
  try {
    const [payload, signature] = trackingId.split('.');
    
    if (!payload || !signature) {
      return null;
    }
    
    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', HMAC_SECRET || 'default-secret')
      .update(payload)
      .digest('base64url')
      .slice(0, 16);
    
    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      console.warn('Invalid tracking ID signature');
      return null;
    }
    
    // Decode payload
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    
    return {
      campaignId: data.c,
      emailHash: data.e,
      userId: data.u,
      nonce: data.n,
      timestamp: data.t,
    };
  } catch (error) {
    console.error('Error decoding tracking ID:', error.message);
    return null;
  }
}

/**
 * Generate email hash for looking up tracking data
 * Used to map tracking events back to specific emails
 */
export function hashEmail(email) {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 16);
}
