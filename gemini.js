// Gemini calls with the free-tier protections: a requests-per-minute throttle, retries that
// honour Google's retryDelay, and fallback to the next model when one runs out of quota.
import { GoogleGenAI, createPartFromUri } from '@google/genai';

const INLINE_LIMIT_BYTES = 15 * 1024 * 1024;
const ALLOWED_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createClient(apiKey) {
  if (!apiKey) throw new HttpError(400, 'No API key. Open Settings and enter your Gemini API key.');
  return new GoogleGenAI({ apiKey });
}

export function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Gemini rejected the API key. Check it in Settings.';
  return msg;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One shared slot schedule for the whole app, so parallel requests still respect the limit.
let nextSlotAt = 0;
async function waitForSlot(requestsPerMinute) {
  if (!requestsPerMinute) return;
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + 60000 / requestsPerMinute;
  if (at > now) await sleep(at - now);
}

function classify(err) {
  const msg = String(err?.message || '');
  const status = Number(err?.status) || 0;
  const retryDelay = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return {
    rateLimited: status === 429 || /RESOURCE_EXHAUSTED/.test(msg),
    overloaded: status === 503 || status === 500 || /UNAVAILABLE|overloaded/i.test(msg),
    daily: /PerDay/i.test(msg),
    missingModel: status === 404 || /models\/\S+ is not found|not supported for generateContent/i.test(msg),
    retryAfterMs: retryDelay ? Math.ceil(Number(retryDelay[1]) * 1000) : null
  };
}

// Tries each model in `models` in turn. Returns { resp, model, notes }.
export async function generate(ai, models, request, settings) {
  const notes = [];
  for (const model of models) {
    for (let attempt = 0; ; attempt++) {
      await waitForSlot(settings.requestsPerMinute);
      try {
        const resp = await ai.models.generateContent({ ...request, model });
        return { resp, model, notes };
      } catch (err) {
        const c = classify(err);
        if (c.missingModel) {
          notes.push(`${model}: not available for this key`);
          break;
        }
        if (!c.rateLimited && !c.overloaded) throw err;
        if (c.daily) {
          notes.push(`${model}: daily quota used up`);
          break;
        }
        const waitMs = c.retryAfterMs ?? Math.min(60000, 4000 * 2 ** attempt);
        if (attempt >= settings.maxRetries || waitMs > settings.maxWaitSeconds * 1000) {
          notes.push(`${model}: still ${c.rateLimited ? 'rate-limited' : 'overloaded'} after ${attempt + 1} attempt(s)`);
          break;
        }
        notes.push(`${model}: ${c.rateLimited ? 'rate limit' : 'server busy'}, waited ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    }
  }
  throw new HttpError(
    429,
    `No model could complete the request. ${notes.join('; ')}. ` +
      'On the free tier, wait for the limit to reset, add fallback models in Settings, or enable billing on the API key.'
  );
}

export function usageOf(resp, model) {
  const u = resp.usageMetadata || {};
  return {
    model,
    inputTokens: u.promptTokenCount || 0,
    outputTokens: u.candidatesTokenCount || 0,
    thinkingTokens: u.thoughtsTokenCount || 0
  };
}

// Sends files inline when small; larger uploads go through the Gemini Files API.
export async function filesToParts(ai, files) {
  for (const f of files) {
    if (!ALLOWED_TYPES.test(f.mimetype)) {
      throw new HttpError(400, `${f.originalname}: only PDF, PNG, JPG, WEBP or HEIC files are supported.`);
    }
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const parts = [];
  for (const [i, f] of files.entries()) {
    parts.push({ text: `File ${i + 1} of ${files.length}: ${f.originalname}` });
    if (total <= INLINE_LIMIT_BYTES) {
      parts.push({ inlineData: { mimeType: f.mimetype, data: f.buffer.toString('base64') } });
      continue;
    }
    let uploaded = await ai.files.upload({
      file: new Blob([f.buffer], { type: f.mimetype }),
      config: { mimeType: f.mimetype, displayName: f.originalname }
    });
    while (uploaded.state === 'PROCESSING') {
      await sleep(2000);
      uploaded = await ai.files.get({ name: uploaded.name });
    }
    if (uploaded.state === 'FAILED') throw new HttpError(422, `Gemini could not process ${f.originalname}.`);
    parts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
  }
  return parts;
}

export function parseJson(resp) {
  try {
    return JSON.parse(resp.text || '');
  } catch {
    throw new HttpError(502, 'The model did not return valid JSON. Try again or pick another model.');
  }
}
