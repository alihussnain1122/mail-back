import express from 'express';
import { emailLimiter } from '../middleware/rateLimit.js';
import { body } from '../middleware/validation.js';
// ...import other helpers as needed

const router = express.Router();

// TODO: Move all /api/send/single, /api/track/open, /api/track/click, /api/track/bounce, /api/unsubscribe endpoints here

export default router;
