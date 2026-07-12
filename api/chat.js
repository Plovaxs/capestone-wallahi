import { GoogleGenerativeAI } from '@google/generative-ai';

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 20;
const requestBuckets = new Map();

const getClientKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const sourceIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0]?.trim();
  return sourceIp || req.socket?.remoteAddress || 'unknown';
};

const checkRateLimit = (key) => {
  const now = Date.now();
  const bucket = requestBuckets.get(key) || [];
  const recent = bucket.filter((timestamp) => now - timestamp < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS) {
    const retryAfterMs = WINDOW_MS - (now - recent[0]);
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  requestBuckets.set(key, [...recent, now]);
  return { allowed: true };
};

const readJsonBody = (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const clientKey = getClientKey(req);
  const rateLimit = checkRateLimit(clientKey);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rateLimit.retryAfterMs / 1000)));
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
    return;
  }

  const body = readJsonBody(req);
  const systemPrompt = String(body?.systemPrompt || '').slice(0, 6000);
  const input = String(body?.input || '').slice(0, 2000);

  if (!systemPrompt || !input) {
    res.status(400).json({ error: 'Missing prompt or input.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server AI key is not configured.' });
    return;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'Understood. I will help with specific tasks or provide general customs-related suggestions if needed.' }] },
      ],
    });

    const result = await chat.sendMessage(input);
    const response = await result.response;
    const text = response.text();

    res.status(200).json({ text });
  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({ error: 'AI request failed.' });
  }
}