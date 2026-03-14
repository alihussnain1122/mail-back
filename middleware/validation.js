// Express-validator helpers
import { body, param, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';

export { body, param };

export function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
}

// Rate limiting
export const emailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Email rate limit exceeded, please slow down' },
});
