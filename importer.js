// Reads evaluation materials (question, steps, ICAI keywords, layout, marking scheme) from
// Excel, CSV, plain text and Word files, and builds the downloadable fill-in templates.
// Files that follow a template are parsed without AI; anything else is handed to `organize`.
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import path from 'path';
import { sanitizeSetup, splitLines } from './lib.js';

// Sample content used only to fill the downloadable templates, so the format is obvious.
export const EXAMPLE_SETUP = {
  code: 'Law Q1(a)',
  questionText:
    'ABC Private Limited proposes to give a loan of ₹10 lakh to Mr. X, a director of the company, at 6% interest p.a. ' +
    'Examine, with reference to the provisions of the Companies Act, 2013, whether the company can give this loan.',
  maxMarks: 4,
  granularity: 0.5,
  steps: [
    {
      title: 'Relevant provision: Section 185',
      marks: 1,
      expected: 'States that a company shall not, directly or indirectly, advance any loan to any of its directors.',
      keywords: 'Section 185, loan to director'
    },
    {
      title: 'Exemption for private companies',
      marks: 1,
      expected:
        'Section 185 does not apply to a private company where no body corporate has invested in its share capital, ' +
        'borrowings are less than twice its paid-up share capital or ₹50 crore (whichever is lower), and there is no subsisting default.',
      keywords: 'private company, exemption, body corporate'
    },
    { title: 'Application to the facts', marks: 1, expected: 'Applies the provision and the exemption conditions to ABC and Mr. X.', keywords: '' },
    { title: 'Conclusion', marks: 1, expected: 'Loan is prohibited unless ABC meets all the exemption conditions.', keywords: '' }
  ],
  keywords: ['Section 185', 'director', 'loan | advance', 'private company', 'exemption | exempt | not apply', 'body corporate'],
  layout: 'Provision → Facts → Analysis → Conclusion',
  scheme: 'Paste the ICAI suggested answer / marking scheme here.',
  instructions: ''
};

const FIELD_ALIASES = {
  code: ['question code', 'code', 'question no', 'question number', 'q no'],
  questionText: ['question', 'question text'],
  maxMarks: ['max marks', 'maximum marks', 'total marks'],
  granularity: ['mark increment', 'increment', 'mark in steps of', 'marking increment'],
  layout: ['layout', 'expected layout', 'structure', 'answer layout', 'expected layout structure'],
  scheme: ['marking scheme', 'suggested answer', 'model answer', 'icai suggested answer', 'scheme'],
  instructions: ['instructions', 'extra instructions', 'examiner instructions'],
  keywords: ['keywords', 'icai keywords']
};

const labelKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
const fieldFor = (label) => Object.keys(FIELD_ALIASES).find((f) => FIELD_ALIASES[f].includes(labelKey(label)));

function emptySetup() {
  return { code: '', questionText: '', maxMarks: 0, granularity: 0, steps: [], keywords: [], layout: '', scheme: '', instructions: '' };
}

function assignField(into, field, value) {
  const text = String(value ?? '').trim();
  if (!text) return;
  if (field === 'keywords') into.keywords.push(...splitLines(text));
  else if (field === 'maxMarks' || field === 'granularity') into[field] = Number(text) || into[field];
  else if (field === 'code' || field === 'questionText') into[field] = into[field] || text;
  else into[field] = into[field] ? `${into[field]}\n\n${text}` : text;
}

// Recognizes a table by its header row. Returns true when the table was used.
function readTable(rows, into) {
  const header = (rows[0] || []).map(labelKey);
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const body = rows.slice(1);

  const fieldCol = col('field');
  const valueCol = col('value');
  if (fieldCol >= 0 && valueCol >= 0) {
    body.forEach((r) => {
      const field = fieldFor(r[fieldCol]);
      if (field) assignField(into, field, r[valueCol]);
    });
    return true;
  }

  const titleCol = col('step', 'step title', 'title', 'criteria', 'criterion', 'step description');
  const marksCol = col('marks', 'max marks', 'mark');
  if (titleCol >= 0 && marksCol >= 0) {
    const expectedCol = col('what earns the marks', 'what earns marks', 'expected', 'expected answer', 'points', 'description');
    const stepKwCol = col('step keywords', 'keywords');
    body.forEach((r) => {
      const title = String(r[titleCol] ?? '').trim();
      if (!title) return;
      into.steps.push({
        title,
        marks: Number(r[marksCol]) || 0,
        expected: expectedCol >= 0 ? String(r[expectedCol] ?? '').trim() : '',
        keywords: stepKwCol >= 0 ? String(r[stepKwCol] ?? '').trim() : ''
      });
    });
    return true;
  }

  const kwCol = col('keyword', 'keywords', 'icai keyword', 'icai keywords');
  if (kwCol >= 0) {
    body.forEach((r) => {
      const kw = String(r[kwCol] ?? '').trim();
      if (kw) into.keywords.push(kw);
    });
    return true;
  }
  return false;
}

// Title rows above the header are common, so try the first few rows as the header.
function readTableWithOffset(rows, into) {
  for (let start = 0; start < Math.min(5, rows.length); start++) {
    if (readTable(rows.slice(start), into)) return true;
  }
  return false;
}

const tableToText = (rows) => rows.map((r) => r.filter((c) => String(c ?? '').trim()).join(' | ')).filter(Boolean).join('\n');

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const TEXT_HEADINGS = [
  ['question code', 'code'],
  ['code', 'code'],
  ['max marks', 'maxMarks'],
  ['maximum marks', 'maxMarks'],
  ['mark increment', 'granularity'],
  ['question', 'questionText'],
  ['steps', 'steps'],
  ['icai keywords', 'keywords'],
  ['keywords', 'keywords'],
  ['expected layout', 'layout'],
  ['layout', 'layout'],
  ['marking scheme', 'scheme'],
  ['suggested answer', 'scheme'],
  ['instructions', 'instructions']
];
const HEADING_RX = new RegExp(`^\\s*(${TEXT_HEADINGS.map(([h]) => h).join('|')})\\s*:\\s*(.*)$`, 'i');

// Parses the plain-text template ("QUESTION:", "STEPS:", "KEYWORDS:" ...). Returns null when
// fewer than two template headings are present, so free text goes to the AI instead.
export function parseTextTemplate(text) {
  const sections = {};
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = HEADING_RX.exec(line);
    if (m) {
      current = TEXT_HEADINGS.find(([h]) => h === m[1].toLowerCase())[1];
      sections[current] = sections[current] || [];
      if (m[2].trim()) sections[current].push(m[2]);
    } else if (current) {
      sections[current].push(line);
    }
  }
  if (Object.keys(sections).length < 2) return null;

  const into = emptySetup();
  for (const [field, lines] of Object.entries(sections)) {
    if (field === 'steps') {
      lines.forEach((line) => {
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2 || !parts[0] || !Number.isFinite(Number(parts[1]))) return;
        into.steps.push({ title: parts[0], marks: Number(parts[1]), expected: parts[2] || '', keywords: parts[3] || '' });
      });
    } else {
      assignField(into, field, lines.join('\n').trim());
    }
  }
  return into;
}

async function readWorkbook(buffer, into, rawTexts, name) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  let used = 0;
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let i = 1; i <= row.cellCount; i++) cells.push(row.getCell(i).text);
      rows.push(cells);
    });
    if (!rows.length || /^help$/i.test(sheet.name)) return;
    if (readTableWithOffset(rows, into)) used += 1;
    else rawTexts.push(`From ${name}, sheet "${sheet.name}":\n${tableToText(rows)}`);
  });
  return used;
}

function mergeSetups(primary, secondary) {
  const merged = { ...primary };
  for (const key of ['code', 'questionText', 'layout', 'scheme', 'instructions']) {
    if (!merged[key] && secondary[key]) merged[key] = secondary[key];
  }
  if (!merged.maxMarks && secondary.maxMarks) merged.maxMarks = secondary.maxMarks;
  if (!merged.steps.length && secondary.steps?.length) merged.steps = secondary.steps;
  const seen = new Set(merged.keywords.map((k) => k.toLowerCase()));
  (secondary.keywords || []).forEach((k) => {
    if (!seen.has(k.toLowerCase())) merged.keywords.push(k);
  });
  return merged;
}

const BINARY_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/;

// files: multer files. organize(rawTexts, binaryFiles) is called only when some material
// does not follow a template and useAi is true; it must return a setup-shaped object.
export async function importMaterials(files, { useAi, organize }) {
  const into = emptySetup();
  const rawTexts = [];
  const binaries = [];
  const notes = [];

  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    try {
      if (ext === '.xlsx') {
        const used = await readWorkbook(f.buffer, into, rawTexts, f.originalname);
        notes.push(used ? `${f.originalname}: read ${used} table(s) from the template format` : `${f.originalname}: no template tables found, sent to AI`);
      } else if (ext === '.xls') {
        notes.push(`${f.originalname}: old .xls format is not supported. Open it in Excel and save as .xlsx.`);
      } else if (ext === '.csv') {
        const rows = parseCsv(f.buffer.toString('utf-8'));
        if (readTableWithOffset(rows, into)) notes.push(`${f.originalname}: read as a template table`);
        else {
          rawTexts.push(`From ${f.originalname}:\n${tableToText(rows)}`);
          notes.push(`${f.originalname}: not in template format, sent to AI`);
        }
      } else if (['.txt', '.md', '.docx'].includes(ext)) {
        const text = ext === '.docx' ? (await mammoth.extractRawText({ buffer: f.buffer })).value : f.buffer.toString('utf-8');
        const parsed = parseTextTemplate(text);
        if (parsed) {
          Object.assign(into, mergeSetups(into, parsed));
          notes.push(`${f.originalname}: read from the text template format`);
        } else {
          rawTexts.push(`From ${f.originalname}:\n${text.trim()}`);
          notes.push(`${f.originalname}: free text, sent to AI`);
        }
      } else if (BINARY_TYPES.test(f.mimetype)) {
        binaries.push(f);
        notes.push(`${f.originalname}: PDF/image, read by AI`);
      } else {
        notes.push(`${f.originalname}: file type not supported (use .xlsx, .csv, .txt, .docx, .pdf or images)`);
      }
    } catch (err) {
      notes.push(`${f.originalname}: could not be read (${err.message})`);
    }
  }

  let result = into;
  let usage = null;
  if (rawTexts.length || binaries.length) {
    if (useAi) {
      const ai = await organize(rawTexts, binaries);
      usage = ai.usage;
      result = mergeSetups(into, sanitizeAiSetup(ai.setup));
    } else {
      if (rawTexts.length) {
        result.scheme = [result.scheme, ...rawTexts].filter(Boolean).join('\n\n');
        notes.push('AI organizing is off: free text was added to the marking scheme box as it is.');
      }
      if (binaries.length) notes.push('AI organizing is off: PDFs and images were skipped.');
    }
  }

  return { setup: sanitizeSetup({ ...result, granularity: result.granularity || 0.5 }), notes, usage };
}

function sanitizeAiSetup(s = {}) {
  return {
    code: String(s.code || ''),
    questionText: String(s.questionText || ''),
    maxMarks: Number(s.maxMarks) || 0,
    steps: Array.isArray(s.steps) ? s.steps.filter((st) => st && st.title) : [],
    keywords: Array.isArray(s.keywords) ? s.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    layout: String(s.layout || ''),
    scheme: String(s.scheme || ''),
    instructions: String(s.instructions || '')
  };
}

// ---------- templates ----------

export async function buildExcelTemplate() {
  const ex = EXAMPLE_SETUP;
  const wb = new ExcelJS.Workbook();
  const style = (sheet, widths) => {
    sheet.columns = widths.map((width) => ({ width }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEFC' } };
    sheet.eachRow((row) => (row.alignment = { wrapText: true, vertical: 'top' }));
  };

  const q = wb.addWorksheet('Question');
  q.addRows([
    ['Field', 'Value'],
    ['Question code', ex.code],
    ['Question', ex.questionText],
    ['Max marks', ex.maxMarks],
    ['Mark increment', ex.granularity],
    ['Expected layout', ex.layout],
    ['Marking scheme', ex.scheme],
    ['Instructions', ex.instructions]
  ]);
  style(q, [20, 100]);

  const s = wb.addWorksheet('Steps');
  s.addRows([['Step', 'Marks', 'What earns the marks', 'Step keywords'], ...ex.steps.map((st) => [st.title, st.marks, st.expected, st.keywords])]);
  style(s, [34, 8, 80, 34]);

  const k = wb.addWorksheet('Keywords');
  k.addRows([['Keyword'], ...ex.keywords.map((kw) => [kw])]);
  style(k, [50]);

  const h = wb.addWorksheet('Help');
  h.addRows([
    ['How to fill this template'],
    ['Question sheet: keep the Field names in column A; type your values in column B. Mark increment is 0.25, 0.5 or 1.'],
    ['Steps sheet: one row per marking step. Marks for all steps should add up to Max marks.'],
    ['Keywords sheet: one ICAI keyword per row. Put alternative phrasings in the same cell separated by | (e.g. loan | advance).'],
    ['You can leave any sheet empty and upload that information as a separate PDF, Word or text file instead.']
  ]);
  h.getColumn(1).width = 120;
  h.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function buildTextTemplate() {
  const ex = EXAMPLE_SETUP;
  return [
    '# Evaluation template. Keep the headings (QUESTION CODE:, QUESTION:, ...) and replace the example content.',
    '# STEPS: one per line as  Step | Marks | What earns the marks | Step keywords (comma separated)',
    '# KEYWORDS: one per line; alternatives on the same line separated by |',
    '',
    `QUESTION CODE: ${ex.code}`,
    `MAX MARKS: ${ex.maxMarks}`,
    `MARK INCREMENT: ${ex.granularity}`,
    'QUESTION:',
    ex.questionText,
    '',
    'STEPS:',
    ...ex.steps.map((st) => [st.title, st.marks, st.expected, st.keywords].join(' | ')),
    '',
    'KEYWORDS:',
    ...ex.keywords,
    '',
    'LAYOUT:',
    ex.layout,
    '',
    'MARKING SCHEME:',
    ex.scheme,
    '',
    'INSTRUCTIONS:',
    ''
  ].join('\r\n');
}
