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

const DEFAULT_DOCUMENT_PROMPT = `You are setting up the evaluation of a CA (Chartered Accountancy) examination from the attached document(s).
The material may be one Word file holding everything in any order and any format: topics, questions, marks, steps, keywords, marking schemes, ICAI suggested answers, layouts, tables and working notes. It may also be split across several files.

Find EVERY separate question and return one entry in "questions" for each. Sub-parts with their own marks, such as Q1(a) and Q1(b), are separate questions. Bring together everything that belongs to a question, even when its question text and its marking scheme are far apart in the document.

For each question:
- code: the question number or name as written. topic: its topic or chapter, if given.
- questionType: "theory", "numerical" (the answer is mainly computation) or "mixed".
- questionText: the full question, including all its data and tables. Keep tables as Markdown tables.
- maxMarks: the marks stated for the question. Use 0 if none are stated.
- steps: the stepwise marking split, using the marks stated in the scheme, in answer order. Recognise forms like "1 mark", "(½ M)", "1M each", or a marks column in a table. Write ½ as 0.5.
  - title: a short name for the step.
  - expected: what earns the marks, copied from the scheme. For numerical questions include the formula or working AND the expected figures, exactly as written.
  - keywords: comma-separated keywords for that step, if the scheme gives them.
  - dependsOnEarlierFigure: true when the step uses a figure calculated in an earlier step, so the own-figure rule applies.
  - If marks are not split in the document, leave steps empty. Never invent a split.
- keywords: ICAI keywords or key phrases for the question, one per item. Put alternatives for the same keyword in one item, separated by " | ". Use only keywords the document identifies.
- layout: the expected answer format or presentation, if given.
- scheme: the full suggested answer / marking scheme for this question only, including all tables, workings and figures.
- instructions: any examiner notes for this question.

Rules:
- Copy wording and every number exactly. Do not calculate, correct, summarise or invent anything.
- Text like [Embedded image 2] marks an attached image from the document at that position. Read the image and include its content in the right question.
- Leave a field empty (0 for numbers) if the document does not contain it.
- paperTitle: the title of the paper or test, if stated.`;

const DEFAULT_SEGMENT_PROMPT = `You are given the numbered transcript of a student's answer script and the list of questions in the paper.
Work out which lines answer which question. Students may answer out of order, may continue an answer later in the script, and may write the question number differently or not at all, so also use the content of the answer.

For every listed question return its code exactly as listed, whether it was attempted, and the inclusive line ranges of its answer. Use several ranges if the answer is split. Working notes belong to the question they support. Do not give the same line to two questions. If a question was not attempted, set attempted to false and return no ranges.`;

const DEFAULT_NUMERICAL_INSTRUCTIONS = `THIS QUESTION MAY INVOLVE COMPUTATION. ADDITIONAL RULES:
1. Mark each step on its method AND its figure. Re-calculate the student's working yourself, and compare it to the expected working in the scheme.
2. Treat figures as equal when they differ only in format, such as 5,00,000, 500000, ₹5 lakh and Rs. 5.00 lakh. Treat rounding differences that the scheme would accept as correct.
3. Own-figure rule: when a step uses a wrong figure carried from the student's earlier step but applies the correct method with correct arithmetic, award that step's method marks and set ownFigureApplied to true. Deduct only once for the original error. Do not apply this when the later step also has its own error, or when the error makes the problem trivial.
4. A correct final figure with no working earns only the marks the scheme gives for the result. Do not award working-note marks for steps that were not shown.
5. Accept a different valid format, such as a statement instead of a table, or a different valid method, when it reaches the right result. Say so in the reasoning.
6. In reasoning, state the expected figure and the student's figure for each computed step.
7. Lower your confidence for a step when a figure in it is marked [UNCLEAR: ...], and set needsHumanReview to true when an unclear figure affects marks.`;

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
  documentPrompt: DEFAULT_DOCUMENT_PROMPT,
  segmentPrompt: DEFAULT_SEGMENT_PROMPT,
  markingInstructions: DEFAULT_MARKING_INSTRUCTIONS,
  numericalInstructions: DEFAULT_NUMERICAL_INSTRUCTIONS
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
    documentPrompt: str(input.documentPrompt) || d.documentPrompt,
    segmentPrompt: str(input.segmentPrompt) || d.segmentPrompt,
    markingInstructions: str(input.markingInstructions) || d.markingInstructions,
    numericalInstructions: str(input.numericalInstructions) || d.numericalInstructions
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
        confidence: { type: Type.NUMBER },
        ownFigureApplied: { type: Type.BOOLEAN }
      },
      required: ['stepNo', 'title', 'maxMarks', 'awardedMarks', 'evidenceQuote', 'reasoning', 'confidence', 'ownFigureApplied']
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

export const DOCUMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    paperTitle: { type: Type.STRING },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          code: { type: Type.STRING },
          topic: { type: Type.STRING },
          questionType: { type: Type.STRING, enum: ['theory', 'numerical', 'mixed'] },
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
                keywords: { type: Type.STRING },
                dependsOnEarlierFigure: { type: Type.BOOLEAN }
              },
              required: ['title', 'marks', 'expected', 'keywords', 'dependsOnEarlierFigure']
            }
          },
          keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
          layout: { type: Type.STRING },
          scheme: { type: Type.STRING },
          instructions: { type: Type.STRING }
        },
        required: ['code', 'topic', 'questionType', 'questionText', 'maxMarks', 'steps', 'keywords', 'layout', 'scheme', 'instructions'],
        propertyOrdering: ['code', 'topic', 'questionType', 'questionText', 'maxMarks', 'scheme', 'steps', 'keywords', 'layout', 'instructions']
      }
    }
  },
  required: ['paperTitle', 'questions'],
  propertyOrdering: ['paperTitle', 'questions']
};

export const SEGMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    answers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          code: { type: Type.STRING },
          attempted: { type: Type.BOOLEAN },
          ranges: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { startLine: { type: Type.INTEGER }, endLine: { type: Type.INTEGER } },
              required: ['startLine', 'endLine']
            }
          }
        },
        required: ['code', 'attempted', 'ranges']
      }
    }
  },
  required: ['answers']
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
// "Sec. 185(1)" and "sec 185 1" compare equal, and "₹5,00,000" and "5,00,000" too.
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[unclear:\s*([^\]]*)\]/g, '$1')
    .replace(/~~/g, '')
    .replace(/[^a-z0-9%§]+/g, ' ')
    .trim();
}

function containsPhrase(normalizedHaystack, phrase) {
  const needle = normalize(phrase);
  return Boolean(needle) && ` ${normalizedHaystack} `.includes(` ${needle} `);
}

// Numbers of 3+ digits, without commas, so 5,00,000 and 500000 compare equal. Shorter numbers
// are skipped because they are usually section, step or question numbers.
export function extractFigures(text) {
  const figures = String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || [];
  return [...new Set(figures.map((f) => f.replace(/,/g, '').replace(/\.0+$/, '')).filter((f) => f.replace('.', '').length >= 3))];
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
      keywords: str(st.keywords),
      dependsOnEarlierFigure: Boolean(st.dependsOnEarlierFigure)
    }))
    .filter((st) => st.title);
  const stepTotal = steps.reduce((sum, st) => sum + st.marks, 0);
  return {
    id: str(s.id) || null,
    paperTitle: str(s.paperTitle),
    code: str(s.code),
    topic: str(s.topic),
    questionType: ['theory', 'numerical', 'mixed'].includes(s.questionType) ? s.questionType : '',
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
    ...(setup.topic ? [`TOPIC: ${setup.topic}`] : []),
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
      if (st.dependsOnEarlierFigure) lines.push('  Uses a figure from an earlier step: apply the own-figure rule.');
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

// Theory questions don't need the computation rules, which keeps their prompts shorter.
const markingRules = (setup, settings) =>
  setup.questionType === 'theory' ? settings.markingInstructions : `${settings.markingInstructions}\n\n${settings.numericalInstructions}`;

export function buildGradingPrompt(setup, transcript, settings = DEFAULT_SETTINGS) {
  return [
    markingRules(setup, settings),
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
    markingRules(setup, settings),
    '',
    questionBlock(setup)
  ].join('\n');
}

export function buildSegmentPrompt(setups, transcript, settings = DEFAULT_SETTINGS) {
  const questions = setups.map((q) => `- ${q.code}: ${q.questionText.slice(0, 300)}`).join('\n');
  const numbered = String(transcript)
    .split(/\r?\n/)
    .map((line, i) => `L${i + 1}: ${line}`)
    .join('\n');
  return `${settings.segmentPrompt}\n\nQUESTIONS:\n${questions}\n\nNUMBERED TRANSCRIPT:\n${numbered}`;
}

const isContentLine = (line) => Boolean(line.trim()) && !/^-+\s*page\s*\d+\s*-+$/i.test(line.trim());

// Cuts the transcript into one answer per question using the model's line ranges. Codes that
// do not match fall back to list position; out-of-range lines are ignored. Returns the
// answers in setup order and the number of written lines given to no question.
export function sliceAnswers(transcript, setups, segmentation = {}) {
  const lines = String(transcript).split(/\r?\n/);
  const answers = Array.isArray(segmentation.answers) ? segmentation.answers : [];
  const used = new Set();
  const result = setups.map((setup, i) => {
    const answer = answers.find((a) => normalize(a.code) === normalize(setup.code)) || answers[i];
    const picked = new Set();
    (answer?.ranges || []).forEach(({ startLine, endLine }) => {
      for (let n = Math.max(1, startLine); n <= Math.min(lines.length, endLine); n++) picked.add(n);
    });
    const text = [...picked]
      .sort((a, b) => a - b)
      .map((n) => {
        used.add(n);
        return lines[n - 1];
      })
      .join('\n')
      .trim();
    return { code: setup.code, attempted: Boolean(text), text };
  });
  const unassignedLines = lines.filter((line, i) => isContentLine(line) && !used.has(i + 1)).length;
  return { answers: result, unassignedLines };
}

// ---------- result ----------

// Turns the model's JSON into the final result. Marks are re-clamped and re-totalled here
// rather than trusted from the model, and evidence quotes are checked against the transcript.
// options.notAttempted: no answer was found for this question, so every step scores 0.
export function finalizeResult(setup, transcript, raw = {}, settings = DEFAULT_SETTINGS, options = {}) {
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
      confidence: rawSteps[i] ? clamp01(s.confidence) : 0,
      ownFigureApplied: Boolean(s.ownFigureApplied)
    };
  });

  const rawKeywords = Array.isArray(raw.keywords) ? raw.keywords : [];
  const keywords = splitLines(setup.keywords).map((line, i) => {
    const fromModel = rawKeywords.find((k) => normalize(k.keyword) === normalize(line)) || rawKeywords[i] || {};
    return {
      keyword: line,
      // "Income-tax: Disallowed under Section 40(a)(ii)" is a keyword with its explanation; a student only needs the keyword
      exactMatch: line.split('|').some((alt) => containsPhrase(normTranscript, alt.split(':')[0])),
      aiPresent: Boolean(fromModel.present),
      aiMatchedText: str(fromModel.matchedText)
    };
  });

  const totalAwarded = roundTo(steps.reduce((sum, s) => sum + s.awardedMarks, 0), 0.01);
  const stepMax = roundTo(steps.reduce((sum, s) => sum + s.maxMarks, 0), 0.01);

  const flags = [...(options.flags || [])];
  if (options.notAttempted) flags.unshift('No answer to this question was found in the script. Check the full transcript.');
  const unclear = findUnclear(transcript);
  const answerFigures = new Set(extractFigures(transcript));
  if (unclear.length) flags.push(`${unclear.length} unclear word(s) in the transcript: ${unclear.join(', ')}`);
  steps.forEach((s) => {
    if (options.notAttempted) return;
    if (!rawSteps[s.stepNo - 1]) flags.push(`Step ${s.stepNo}: the model did not mark this step`);
    else if (s.confidence < settings.lowConfidence) {
      flags.push(`Step ${s.stepNo}: low confidence (${Math.round(s.confidence * 100)}%)`);
    }
    if (s.awardedMarks > 0 && !s.evidenceQuote) flags.push(`Step ${s.stepNo}: marks given without an evidence quote`);
    if (s.awardedMarks > 0 && !s.evidenceFound) flags.push(`Step ${s.stepNo}: evidence quote not found in the transcript`);
    // Full marks need the expected figure in the answer, unless the own-figure rule explains why it differs
    const expectedFigures = setup.questionType === 'theory' ? [] : extractFigures(setup.steps[s.stepNo - 1]?.expected);
    if (s.maxMarks > 0 && s.awardedMarks >= s.maxMarks && !s.ownFigureApplied && expectedFigures.length && !expectedFigures.some((f) => answerFigures.has(f))) {
      flags.push(`Step ${s.stepNo}: full marks, but none of the expected figures are in the answer (${expectedFigures.slice(0, 4).join(', ')})`);
    }
  });
  // Students abbreviate in computations ("FD int."), so there only "found, but the AI says absent" is a real contradiction
  const isTheory = setup.questionType === 'theory' || !setup.questionType;
  const disagreements = options.notAttempted ? 0 : keywords.filter((k) => (isTheory ? k.exactMatch !== k.aiPresent : k.exactMatch && !k.aiPresent)).length;
  if (disagreements) flags.push(`${disagreements} keyword(s) where the exact text match and the AI disagree`);
  if (raw.needsHumanReview) flags.push(`Model asked for review: ${str(raw.reviewReason) || 'no reason given'}`);

  const warnings = [];
  if (steps.length && Math.abs(stepMax - setup.maxMarks) > 0.001) {
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
