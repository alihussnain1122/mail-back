// Make sure to include the following import:
import 'dotenv/config';
import {GoogleGenAI} from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-2.5-flash-lite",
  contents: "Write a story about a magic backpack.",
});
console.log(response.text);