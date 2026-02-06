import express from 'express';
import Groq from 'groq-sdk';
import { body } from 'express-validator';
import { handleValidationErrors } from '../middleware/validation.js';
import { CONFIG } from '../config/index.js';

const router = express.Router();

// Initialize Groq client (lazy initialization)
let groq = null;

function getGroqClient() {
  if (!groq) {
    if (!CONFIG.groqApiKey) {
      throw new Error('GROQ_API_KEY is not configured');
    }
    groq = new Groq({ apiKey: CONFIG.groqApiKey });
  }
  return groq;
}

// Rate limiting for AI requests (simple in-memory)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 25; // 25 per minute (safe under Groq's 30 limit)

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = rateLimitMap.get(userId) || [];
  
  // Filter requests within the window
  const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= MAX_REQUESTS) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitMap.set(userId, recentRequests);
  return true;
}

// Generate email template
router.post('/generate-template',
  body('purpose').notEmpty().withMessage('Purpose is required'),
  body('tone').notEmpty().withMessage('Tone is required'),
  handleValidationErrors,
  async (req, res) => {
    const { 
      purpose, 
      industry, 
      tone, 
      audience, 
      keyPoints,
      userId 
    } = req.body;

    // Check rate limit
    if (userId && !checkRateLimit(userId)) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Please wait a minute before generating more templates.' 
      });
    }

    const prompt = `You are an expert cold email copywriter. Generate a high-converting cold email template.

REQUIREMENTS:
- Purpose: ${purpose}
- Industry: ${industry || 'General'}
- Tone: ${tone}
- Target Audience: ${audience || 'Business professionals'}
- Key Points to Include: ${keyPoints?.length > 0 ? keyPoints.join(', ') : 'Value proposition, clear CTA'}

STRICT RULES:
1. MUST include these personalization variables exactly as shown:
   - {{firstName}} - Recipient's first name
   - {{company}} - Recipient's company name
2. Subject line MUST be under 50 characters
3. Email body MUST be under 150 words
4. Include ONE clear call-to-action
5. Be professional but engaging
6. No spam trigger words
7. Make it feel personal, not mass-sent

RESPOND ONLY WITH VALID JSON (no markdown, no code blocks):
{"subject": "your subject here", "body": "your email body here with proper line breaks using actual newlines"}`;

    try {
      const client = getGroqClient();
      const completion = await client.chat.completions.create({
        messages: [
          { 
            role: 'system', 
            content: 'You are an expert cold email copywriter. Always respond with valid JSON only, no markdown formatting.' 
          },
          { role: 'user', content: prompt }
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 600,
        response_format: { type: 'json_object' }
      });

      const content = completion.choices[0].message.content;
      
      // Parse the JSON response
      let template;
      try {
        template = JSON.parse(content);
      } catch (parseError) {
        // If JSON parsing fails, try to extract from the response
        const subjectMatch = content.match(/"subject"\s*:\s*"([^"]+)"/);
        const bodyMatch = content.match(/"body"\s*:\s*"([^"]+)"/s);
        
        if (subjectMatch && bodyMatch) {
          template = {
            subject: subjectMatch[1],
            body: bodyMatch[1].replace(/\\n/g, '\n')
          };
        } else {
          throw new Error('Could not parse AI response');
        }
      }

      // Clean up the template
      if (template.body) {
        template.body = template.body.replace(/\\n/g, '\n');
      }

      res.json({
        success: true,
        template: {
          subject: template.subject,
          body: template.body,
          name: `AI: ${purpose} - ${tone}`
        }
      });

    } catch (error) {
      console.error('AI generation error:', error);
      
      if (error.status === 429) {
        return res.status(429).json({ 
          error: 'AI service rate limit reached. Please try again in a moment.' 
        });
      }
      
      res.status(500).json({ 
        error: 'Failed to generate template. Please try again.' 
      });
    }
  }
);

// Generate variations of existing template
router.post('/improve-template',
  body('subject').notEmpty().withMessage('Subject is required'),
  body('body').notEmpty().withMessage('Body is required'),
  body('instruction').notEmpty().withMessage('Instruction is required'),
  handleValidationErrors,
  async (req, res) => {
    const { subject, body: emailBody, instruction, userId } = req.body;

    // Check rate limit
    if (userId && !checkRateLimit(userId)) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Please wait a minute.' 
      });
    }

    const prompt = `You are an expert cold email copywriter. Improve this email template.

CURRENT TEMPLATE:
Subject: ${subject}
Body: ${emailBody}

IMPROVEMENT INSTRUCTION: ${instruction}

RULES:
1. Keep personalization variables: {{firstName}}, {{company}}
2. Subject under 50 characters
3. Body under 150 words
4. Maintain professional tone

RESPOND ONLY WITH VALID JSON:
{"subject": "improved subject", "body": "improved body"}`;

    try {
      const client = getGroqClient();
      const completion = await client.chat.completions.create({
        messages: [
          { role: 'system', content: 'You are an expert cold email copywriter. Respond with valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 600,
        response_format: { type: 'json_object' }
      });

      const content = completion.choices[0].message.content;
      const template = JSON.parse(content);
      
      if (template.body) {
        template.body = template.body.replace(/\\n/g, '\n');
      }

      res.json({
        success: true,
        template: {
          subject: template.subject,
          body: template.body
        }
      });

    } catch (error) {
      console.error('AI improvement error:', error);
      res.status(500).json({ 
        error: 'Failed to improve template. Please try again.' 
      });
    }
  }
);

export default router;
