// Default settings, prompt assembly, response schemas and the deterministic checks that run on
// every evaluation. Kept free of Express and network code so it can be unit-tested directly.
// Everything a user might want to change lives in DEFAULT_SETTINGS and is editable in the app.
import { Type } from '@google/genai';

const DEFAULT_OCR_PROMPT = `You are transcribing a handwritten answer script from a Chartered Accountancy (CA) examination.

Transcribe exactly what is written, in reading order.
Rules:
- Do not correct spelling, grammar, figures, section numbers or case names.
- Do not complete unfinished sentences and do not add anything that is not written.
- If a word or figure cannot be read with confidence, write [UNCLEAR: best guess] in its place.
- Write struck-through text as ~~text~~.
- Keep headings, numbering, underlined headings, line breaks and tables (as Markdown tables).
- Start every page with a line "--- Page N ---".
Output only the transcript.`;

const DEFAULT_ORGANIZE_PROMPT = `You are setting up the evaluation of ONE question from a CA (Chartered Accountancy) examination.
The attached materials may include the question paper, the marking scheme, the ICAI suggested answer, keyword lists and layout notes.
Fill in the fields from these materials:
- Copy wording exactly. Do not invent content that is not in the materials.
- steps: the stepwise marking split with the marks given in the scheme. Leave empty if the scheme gives no split.
- keywords: the ICAI keywords or key phrases an examiner looks for, one per item. Put alternative phrasings of the same keyword in one item, separated by " | ".
- scheme: the full suggested answer / marking scheme text.
- Leave any field empty (or 0 for numbers) if the materials do not contain it.`;

const DEFAULT_MARKING_INSTRUCTIONS = `You are a strict but fair ICAI examiner marking one answer from a CA examination.
Mark ONLY what is actually written in the student's answer. Never assume content that is not there.

MARKING RULES:
1. Mark step by step. A step earns marks only if the answer contains content that satisfies it. Partial marks are allowed.
2. Own-figure rule: if a figure from an earlier step is wrong but a later step applies the correct method to the student's own figure, give full credit for that later step and say so in the reasoning.
3. Accept equivalent wording, and valid alternative legal views that are correctly reasoned. Say so in the reasoning.
4. Do not deduct for spelling or grammar unless the meaning changes.
5. Text marked [UNCLEAR: ...] was hard to read. Use the guess only if the context makes it clear, and lower your confidence for that step.
6. evidenceQuote must be copied word for word from the student's answer (a short phrase or sentence). Use an empty string when nothing supports the step.
7. confidence is between 0 and 1: how sure you are that a senior ICAI examiner would give the same marks for that step.
8. Set needsHumanReview to true when a step is borderline, the handwriting affects marking, or the answer takes an unusual approach. Explain in reviewReason.`;

export const DEFAULT_SETTINGS = {
  ocrModel: 'gemini-2.5-flash',
  gradingModel: 'gemini-2.5-flash',
  organizeModel: 'gemini-2.5-flash',
  fallbackModels: '',
  temperature: 0,
  combineOcrAndMarking: false,
  reuseTranscripts: true,
  requestsPerMinute: 8,
  maxRetries: 3,
  maxWaitSeconds: 65,
  imageMaxSide: 2000,
  lowConfidence: 0.6,
  ocrPrompt: DEFAULT_OCR_PROMPT,
  organizePrompt: DEFAULT_ORGANIZE_PROMPT,
  markingInstructions: DEFAULT_MARKING_INSTRUCTIONS
};

const str = (value) => String(value ?? '').trim();

function numberIn(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function sanitizeSettings(input = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    ocrModel: str(input.ocrModel) || d.ocrModel,
    gradingModel: str(input.gradingModel) || d.gradingModel,
    organizeModel: str(input.organizeModel) || d.organizeModel,
    fallbackModels: str(input.fallbackModels),
    temperature: numberIn(input.temperature, d.temperature, 0, 2),
    combineOcrAndMarking: input.combineOcrAndMarking === undefined ? d.combineOcrAndMarking : Boolean(input.combineOcrAndMarking),
    reuseTranscripts: input.reuseTranscripts === undefined ? d.reuseTranscripts : Boolean(input.reuseTranscripts),
    requestsPerMinute: numberIn(input.requestsPerMinute, d.requestsPerMinute, 0, 10000),
    maxRetries: numberIn(input.maxRetries, d.maxRetries, 0, 10),
    maxWaitSeconds: numberIn(input.maxWaitSeconds, d.maxWaitSeconds, 1, 600),
    imageMaxSide: numberIn(input.imageMaxSide, d.imageMaxSide, 0, 10000),
    lowConfidence: numberIn(input.lowConfidence, d.lowConfidence, 0, 1),
    ocrPrompt: str(input.ocrPrompt) || d.ocrPrompt,
    organizePrompt: str(input.organizePrompt) || d.organizePrompt,
    markingInstructions: str(input.markingInstructions) || d.markingInstructions
  };
}

// The model to try first, followed by the fallback list, without duplicates.
export function modelChain(primary, fallbackModels) {
  return [primary, ...String(fallbackModels || '').split(/[,\n]/)]
    .map((m) => m.trim())
    .filter((m, i, all) => m && all.indexOf(m) === i);
}

// ---------- schemas ----------

const GRADE_PROPERTIES = {
  steps: {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        stepNo: { type: Type.INTEGER },
        title: { type: Type.STRING },
        maxMarks: { type: Type.NUMBER },
        awardedMarks: { type: Type.NUMBER },
        evidenceQuote: { type: Type.STRING },
        reasoning: { type: Type.STRING },
        confidence: { type: Type.NUMBER }
      },
      required: ['stepNo', 'title', 'maxMarks', 'awardedMarks', 'evidenceQuote', 'reasoning', 'confidence']
    }
  },
  keywords: {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        keyword: { type: Type.STRING },
        present: { type: Type.BOOLEAN },
        matchedText: { type: Type.STRING }
      },
      required: ['keyword', 'present', 'matchedText']
    }
  },
  presentation: {
    type: Type.OBJECT,
    properties: {
      followsLayout: { type: Type.BOOLEAN },
      comments: { type: Type.STRING }
    },
    required: ['followsLayout', 'comments']
  },
  overallFeedback: { type: Type.STRING },
  strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
  improvements: { type: Type.ARRAY, items: { type: Type.STRING } },
  needsHumanReview: { type: Type.BOOLEAN },
  reviewReason: { type: Type.STRING }
};
const GRADE_FIELDS = Object.keys(GRADE_PROPERTIES);

export const GRADE_SCHEMA = {
  type: Type.OBJECT,
  properties: GRADE_PROPERTIES,
  required: GRADE_FIELDS,
  propertyOrdering: GRADE_FIELDS
};

// OCR and marking in one request: the transcript is generated first, then marked.
export const COMBINED_SCHEMA = {
  type: Type.OBJECT,
  properties: { transcript: { type: Type.STRING }, ...GRADE_PROPERTIES },
  required: ['transcript', ...GRADE_FIELDS],
  propertyOrdering: ['transcript', ...GRADE_FIELDS]
};

export const SETUP_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    code: { type: Type.STRING },
    questionText: { type: Type.STRING },
    maxMarks: { type: Type.NUMBER },
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          marks: { type: Type.NUMBER },
          expected: { type: Type.STRING },
          keywords: { type: Type.STRING }
        },
        required: ['title', 'marks', 'expected', 'keywords']
      }
    },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    layout: { type: Type.STRING },
    scheme: { type: Type.STRING },
    instructions: { type: Type.STRING }
  },
  required: ['code', 'questionText', 'maxMarks', 'steps', 'keywords', 'layout', 'scheme', 'instructions']
};

// ---------- text helpers ----------

export function splitLines(text) {
  return str(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function findUnclear(text) {
  return Array.from(String(text || '').matchAll(/\[UNCLEAR:\s*([^\]]*)\]/gi), (m) => m[1].trim());
}

// Lower-case, unwrap [UNCLEAR: x] to x, and reduce punctuation to single spaces so
// "Sec. 185(1)" and "sec 185 1" compare equal.
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[unclear:\s*([^\]]*)\]/g, '$1')
    .replace(/~~/g, '')
    .replace(/[^a-z0-9%₹§]+/g, ' ')
    .trim();
}

function containsPhrase(normalizedHaystack, phrase) {
  const needle = normalize(phrase);
  return Boolean(needle) && ` ${normalizedHaystack} `.includes(` ${needle} `);
}

export function roundTo(value, step) {
  return Math.round(value / step) * step;
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function sanitizeSetup(s = {}) {
  const steps = (Array.isArray(s.steps) ? s.steps : [])
    .map((st) => ({
      title: str(st.title),
      marks: Number(st.marks) || 0,
      expected: str(st.expected),
      keywords: str(st.keywords)
    }))
    .filter((st) => st.title);
  const stepTotal = steps.reduce((sum, st) => sum + st.marks, 0);
  return {
    id: str(s.id) || null,
    code: str(s.code),
    questionText: str(s.questionText),
    maxMarks: Number(s.maxMarks) > 0 ? Number(s.maxMarks) : stepTotal || 10,
    granularity: [0.25, 0.5, 1].includes(Number(s.granularity)) ? Number(s.granularity) : 0.5,
    steps,
    keywords: Array.isArray(s.keywords) ? s.keywords.map(str).filter(Boolean).join('\n') : str(s.keywords),
    layout: str(s.layout),
    scheme: str(s.scheme),
    instructions: str(s.instructions)
  };
}

// ---------- prompts ----------

function questionBlock(setup) {
  const keywords = splitLines(setup.keywords);
  const lines = [
    `QUESTION${setup.code ? ` (${setup.code})` : ''}:`,
    setup.questionText || '(not provided; rely on the marking scheme)',
    '',
    `MAXIMUM MARKS: ${setup.maxMarks}`,
    `AWARD MARKS IN INCREMENTS OF: ${setup.granularity}`,
    ''
  ];

  if (setup.steps.length) {
    lines.push('STEPWISE MARKING SCHEME (return exactly these steps, in this order, with these maximum marks):');
    setup.steps.forEach((st, i) => {
      lines.push(`Step ${i + 1}: ${st.title} (max ${st.marks} marks)`);
      if (st.expected) lines.push(`  Earns marks for: ${st.expected}`);
      if (st.keywords) lines.push(`  Keywords for this step: ${st.keywords}`);
    });
  } else {
    lines.push(
      'No step table was given. Derive the steps from the marking scheme below; their maximum marks must add up to the maximum marks.'
    );
  }

  if (setup.scheme) lines.push('', 'MARKING SCHEME / ICAI SUGGESTED ANSWER:', setup.scheme);
  if (keywords.length) {
    lines.push(
      '',
      'ICAI KEYWORDS (alternatives separated by |). Return one entry per line below, in the same order, with keyword copied exactly:',
      ...keywords.map((k) => `- ${k}`)
    );
  }
  if (setup.layout) lines.push('', 'EXPECTED ANSWER LAYOUT / STRUCTURE:', setup.layout);
  if (setup.instructions) lines.push('', 'ADDITIONAL EXAMINER INSTRUCTIONS FOR THIS QUESTION:', setup.instructions);
  return lines.join('\n');
}

export function buildGradingPrompt(setup, transcript, settings = DEFAULT_SETTINGS) {
  return [
    settings.markingInstructions,
    '',
    questionBlock(setup),
    '',
    '--- STUDENT ANSWER (TRANSCRIPT) START ---',
    transcript,
    '--- STUDENT ANSWER (TRANSCRIPT) END ---'
  ].join('\n');
}

export function buildCombinedPrompt(setup, settings = DEFAULT_SETTINGS) {
  return [
    'This request has two parts. Return a single JSON object.',
    '',
    'PART 1: TRANSCRIBE the attached answer script into the "transcript" field, following these instructions:',
    settings.ocrPrompt,
    '',
    'PART 2: MARK the answer, using your transcript from part 1 as the student answer. Quote evidence from that transcript.',
    settings.markingInstructions,
    '',
    questionBlock(setup)
  ].join('\n');
}

// ---------- result ----------

// Turns the model's JSON into the final result. Marks are re-clamped and re-totalled here
// rather than trusted from the model, and evidence quotes are checked against the transcript.
export function finalizeResult(setup, transcript, raw = {}, settings = DEFAULT_SETTINGS) {
  const normTranscript = normalize(transcript);
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  const source = setup.steps.length ? setup.steps : rawSteps;

  const steps = source.map((base, i) => {
    const s = rawSteps[i] || {};
    const maxMarks = setup.steps.length ? base.marks : Number(s.maxMarks) || 0;
    const awarded = Math.min(maxMarks, Math.max(0, roundTo(Number(s.awardedMarks) || 0, setup.granularity)));
    const quote = str(s.evidenceQuote);
    return {
      stepNo: i + 1,
      title: setup.steps.length ? base.title : str(s.title) || `Step ${i + 1}`,
      maxMarks,
      awardedMarks: awarded,
      evidenceQuote: quote,
      evidenceFound: !quote || containsPhrase(normTranscript, quote),
      reasoning: str(s.reasoning),
      confidence: rawSteps[i] ? clamp01(s.confidence) : 0
    };
  });

  const rawKeywords = Array.isArray(raw.keywords) ? raw.keywords : [];
  const keywords = splitLines(setup.keywords).map((line, i) => {
    const fromModel = rawKeywords.find((k) => normalize(k.keyword) === normalize(line)) || rawKeywords[i] || {};
    return {
      keyword: line,
      exactMatch: line.split('|').some((alt) => containsPhrase(normTranscript, alt)),
      aiPresent: Boolean(fromModel.present),
      aiMatchedText: str(fromModel.matchedText)
    };
  });

  const totalAwarded = roundTo(steps.reduce((sum, s) => sum + s.awardedMarks, 0), 0.01);
  const stepMax = roundTo(steps.reduce((sum, s) => sum + s.maxMarks, 0), 0.01);

  const flags = [];
  const unclear = findUnclear(transcript);
  if (unclear.length) flags.push(`${unclear.length} unclear word(s) in the transcript: ${unclear.join(', ')}`);
  steps.forEach((s) => {
    if (!rawSteps[s.stepNo - 1]) flags.push(`Step ${s.stepNo}: the model did not mark this step`);
    else if (s.confidence < settings.lowConfidence) {
      flags.push(`Step ${s.stepNo}: low confidence (${Math.round(s.confidence * 100)}%)`);
    }
    if (s.awardedMarks > 0 && !s.evidenceQuote) flags.push(`Step ${s.stepNo}: marks given without an evidence quote`);
    if (s.awardedMarks > 0 && !s.evidenceFound) flags.push(`Step ${s.stepNo}: evidence quote not found in the transcript`);
  });
  const disagreements = keywords.filter((k) => k.exactMatch !== k.aiPresent).length;
  if (disagreements) flags.push(`${disagreements} keyword(s) where the exact text match and the AI disagree`);
  if (raw.needsHumanReview) flags.push(`Model asked for review: ${str(raw.reviewReason) || 'no reason given'}`);

  const warnings = [];
  if (Math.abs(stepMax - setup.maxMarks) > 0.001) {
    warnings.push(`Step marks add up to ${stepMax}, but maximum marks is ${setup.maxMarks}. The score uses the step total.`);
  }

  return {
    steps,
    keywords,
    presentation: {
      followsLayout: Boolean(raw.presentation?.followsLayout),
      comments: str(raw.presentation?.comments)
    },
    overallFeedback: str(raw.overallFeedback),
    strengths: Array.isArray(raw.strengths) ? raw.strengths.map(str).filter(Boolean) : [],
    improvements: Array.isArray(raw.improvements) ? raw.improvements.map(str).filter(Boolean) : [],
    totalAwarded,
    maxMarks: stepMax || setup.maxMarks,
    needsReview: flags.length > 0,
    flags,
    warnings
  };
}

export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
