// ===================
// VALIDATION & SANITIZATION HELPERS
// ===================

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

// Generate tracking ID for an email
export const generateTrackingId = (campaignId, email, userId) => {
  const data = `${campaignId}:${email}:${userId}`;
  return Buffer.from(data).toString('base64url');
};

// Decode tracking ID to get campaign info
export function decodeTrackingId(trackingId) {
  try {
    const decoded = Buffer.from(trackingId, 'base64url').toString('utf8');
    const [campaignId, email, userId] = decoded.split(':');
    return { campaignId, email, userId };
  } catch {
    return null;
  }
}
