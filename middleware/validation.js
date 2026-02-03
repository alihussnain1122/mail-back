// Express-validator helpers
import { body, param, validationResult } from 'express-validator';

export { body, param };

export function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}
