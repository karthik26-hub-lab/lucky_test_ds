# CA Evaluation Tester

A small app that runs on your own computer. It tests how accurately an AI model marks handwritten CA descriptive answers, using your own Gemini API key.

You upload one Word file holding the questions and marking schemes, then the student's handwritten script. The app:
- detects every question, its marks, steps and ICAI keywords from the Word file
- reads the handwriting with Gemini (OCR) and splits the script by question
- marks each answer step by step, for both theory and numerical questions, including the own-figure rule
- checks the AI's output with plain code
- shows how close the AI's marks are to your faculty's marks

Everything is editable: the models, the prompts, the marking rules, the review thresholds and the rate limits.

---

## 1. One-time setup

### What you need
- A Windows, Mac or Linux computer.
- **Node.js 20.12 or newer.** Download the LTS version from https://nodejs.org and install it with the default options.
- **A Gemini API key** (see below).

### Get the app
On this GitHub page, click **Code → Download ZIP**, then unzip it anywhere, for example on the Desktop.
If you use git, run `git clone` with this repository's URL instead.

### Start the app
- **Windows:** double-click `start.bat`
- **Mac / Linux:** open a terminal in the folder and run `./start.sh`

The first start installs everything it needs, which takes about a minute. Your browser then opens at **http://localhost:5050**. Keep the black window open while you use the app; close it to stop.

### Get a Gemini API key
The app has no AI of its own. It sends the scripts to Google's Gemini AI, using **your** Google account. The API key tells Google which account is using it, and any usage or cost is billed to that account.

1. Go to **https://aistudio.google.com/apikey** and sign in with a Google account.
2. Click **Create API key** and copy it.
3. In the app, open **Settings**, paste the key and click **Save key & load models**. You should see "Key works".

**Free or paid?**
- **Free key:** works straight away, but the limits are low (roughly 10 requests a minute and a daily cap), and Google may use the data to improve its products. Use it only for a small test with sample scripts.
- **Paid key:** the same key with billing turned on in Google Cloud. Higher limits, and the data is not used by Google. Use it for real student scripts and larger tests. It costs very little per script.

### Choose the models (Settings)
Google offers several Gemini models. Stronger ones are more accurate; lighter ones (Flash-Lite) are cheaper and faster. After you save the key, each box lists the models your key can use.

| Setting | What it does | Suggestion |
|---|---|---|
| OCR model | Reads the handwriting | A *Flash* model. Reading quality matters most |
| Marking model | Gives step marks against the scheme | Flash. Later, try Flash-Lite to compare accuracy and cost |
| Import model | Detects the questions, steps and keywords in your Word file | Flash |
| Fallback models | Used automatically when a model hits its limit | A Flash-Lite model |

Click **Save settings**.

---

## 2. Running an accuracy test

### Prepare
- **10–30 answer scripts that faculty have already marked**, with the faculty's marks. Marks per step are best.
- For each question:
  - the question text
  - the stepwise marking scheme
  - the ICAI keywords
  - the expected answer layout
  - ideally the ICAI suggested answer

### Step 1: Evaluation materials (once per paper)
**Put everything in one Word (.docx) file and upload it.** There is no fixed format. The AI finds each question and brings together everything that belongs to it, even when the question and its marking scheme are far apart in the file.

**Fastest and most exact: label the file like this.** It is then read directly, with no AI request, so no figure can be miscopied. One file can hold several questions, or upload one file per question.

```
QUESTION:
The question, with its data tables.
Total Marks: 5
STEPS:
Step 1: Start with Net Profit (½ Mark)
Net Profit = ₹10,00,000
Step 2: Add inadmissible expenses (1½ Marks)
...workings, tables and figures...
KEYWORDS:
Income-tax: Disallowed under Section 40(a)(ii).
MARKS DISTRIBUTION:
(a table of steps and marks, used as a cross-check)
FINAL ANSWER: ₹10,70,000
```

For several questions in one file, start each with `QUESTION 1:`, `QUESTION 2:` and so on.

Any other layout goes to the AI. In that case include whatever you have, for each question:
- the topic, question number and marks
- the question, with its data and tables
- the marks split, in any common form: `1 mark`, `(½ M)`, `1M each`, or a marks column in a table
- the ICAI keywords and expected layout
- the suggested answer, with workings, tables and figures

**Numerical questions:** keep workings as real Word tables or typed text. Tables, Word equations and pasted pictures are all read. Older equations made with Equation Editor 3.0 can't be read from a Word file; the app tells you when it finds any, and you can save the file as PDF and upload that instead.

After upload:
1. Read the notes under the upload box. They list each question found, and anything to check, such as marks that don't add up or figures that aren't in your file.
2. Click each question to check its steps and marks, and fix anything. Untick questions you don't want to evaluate.
3. Click **Save all questions** to reuse the paper, then **Next**.

Other formats also work, and you can mix them:

| File | How it's read |
|---|---|
| Word `.docx` or text labelled as shown above | Directly, no AI, any number of questions |
| Word `.docx` in any other layout, PDF, scans, free-form Excel or text | By AI, which detects the questions (keep the AI option ticked) |
| Excel `.xlsx` in the template format | Directly, no AI, one question. Sheets: Question, Steps, Keywords |
| `.txt` / `.docx` in the text template format | Directly, no AI, one question. Headings: `QUESTION:`, `STEPS:`, `KEYWORDS:` … |
| `.csv` with a `Step,Marks…` or `Keyword` header | Directly, no AI |

### Step 2: Student scripts
1. Choose a mode:
   - **One script:** the files you drop are pages (photos or a PDF) of one student's answer.
   - **Several scripts:** each file is a different student.
2. With one question, enter the faculty's marks here. With several, the script is split by question automatically and you enter the marks per question in the results.
3. Click **Evaluate**. A script takes one request to read, one to split, and one per answered question. The app paces these and waits automatically when Google says "slow down", so a long paper on a free key takes a few minutes.

### Check each result
- **Step marks:** each comes with the AI's reason, a quote from the answer as evidence, and a confidence score. A red ⚠ means the quote is not in the transcript.
- **Paper total:** with several questions, click a question at the top of the result to see it. A question with no answer in the script scores 0 and is flagged, so check it against the full transcript.
- **Numerical steps:** the reasoning gives the expected and the student's figure. An **Own figure** tag means the step got credit for correct working on the student's earlier wrong figure.
- **Review flags:** say whether this script would have gone to a human examiner. Numerical answers are also flagged when a step gets full marks but none of its expected figures are in the answer.
- **Faculty marks:** you can enter or correct them per step.
- **Transcript:** if the AI misread the handwriting, correct it and click **Mark again**. This shows whether an error came from the reading or the marking.

### The result: History & accuracy
- The average difference from the faculty, the share of scripts within ±0.5 and ±1 mark, how many steps match exactly, and how many scripts were flagged for review.
- **Export CSV** downloads every result for your report.

**Comparing models:** change the marking model in Settings and evaluate the same scripts again. The saved transcripts are reused, so no extra OCR is done. Then compare the accuracy numbers.

---

## 3. Working within the free tier
The app helps in five ways:
1. **Requests per minute:** requests are spaced to stay under your limit. The default is 8; set it to 0 on a paid key.
2. **Automatic retries:** when Google says "rate limited", the app waits as long as Google asks, then tries again.
3. **Fallback models:** when a model's daily quota runs out, the app moves to the next model in your fallback list.
4. **Fewer requests and tokens:**
   - the same script is never read twice
   - an optional mode does OCR and marking in one request
   - phone photos are shrunk to 2000px
5. **Clear messages** when every model is out of quota.

## 4. Settings you can change
Everything is in the **Settings** tab and saved in `data/settings.json`:
- the models and fallback models, and the temperature
- the rate limits, retries and photo size
- the confidence threshold for flagging a step
- the OCR, marking, numerical marking, question detection and script splitting instructions (prompts). Each has a **Reset to default** button.

## 5. Troubleshooting
| Problem | Fix |
|---|---|
| "Node.js is not installed" | Install the LTS version from nodejs.org, then start again |
| "Gemini rejected the API key" | Copy the key again from aistudio.google.com/apikey |
| "That model is not available" | Pick a model from the list in Settings |
| "No model could complete the request" | Free-tier limit reached. Wait, add fallback models, or enable billing |
| "The answer was too long for the model to finish" | Split the Word file into smaller files |
| Port 5050 already in use | Close the other window running the app, or set `PORT` in a `.env` file |

## Where data is saved
Everything stays on your computer in the `data` folder:
- `settings.json`: settings and prompts
- `questions.json`: saved questions
- `runs.json`: every evaluation
- `ocr-cache.json`: saved transcripts

To start fresh, delete the `data` folder.

## For developers
```
npm install
npm test
npm run dev
```
- `server.js`: the routes
- `gemini.js`: Gemini calls, rate limiting, retry and fallback
- `lib.js`: prompts, schemas and result checks
- `importer.js`: reading Word (tables, equations, pictures), Excel, CSV and text files, and the templates
- `public/`: the UI
