# CA Evaluation Tester

A small app that runs on your own computer. It tests how accurately an AI model marks handwritten CA descriptive answers, using your own Gemini API key.

You upload the evaluation materials for a question, then the student's handwritten script. The app:
- reads the handwriting with Gemini (OCR)
- marks the answer step by step against your marking scheme and ICAI keywords
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
| Import model | Turns uploaded PDFs or free-form files into question, steps and keywords | Flash |
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

### Step 1: Evaluation materials (once per question)
1. Open **Evaluate → Evaluation materials**.
2. Drop the files for the question. You can mix types:

   | File | How it's read |
   |---|---|
   | Excel `.xlsx` in the template format | Directly, no AI. Sheets: Question, Steps, Keywords |
   | `.txt` / `.docx` in the text template format | Directly, no AI. Headings: `QUESTION:`, `STEPS:`, `KEYWORDS:` … |
   | `.csv` with a `Step,Marks…` or `Keyword` header | Directly, no AI |
   | Question paper PDF, ICAI suggested answer, scans, free-form files | By AI (keep the AI option ticked) |

   The easiest way is to download the **Excel template** from the link under the upload box and fill it in. It comes with an example.
3. Check the fields that get filled in and fix anything. The app shows whether the step marks add up to the max marks.
4. Click **Save question** so you can reuse it, then **Next**.

### Step 2: Student scripts
1. Choose a mode:
   - **One script:** the files you drop are pages (photos or a PDF) of one student's answer.
   - **Several scripts:** each file is a different student.
2. Enter the faculty's marks for each script, then click **Evaluate**.
3. On a free key, each script takes about 15–30 seconds. The app waits automatically when Google says "slow down".

### Check each result
- **Step marks:** each comes with the AI's reason, a quote from the answer as evidence, and a confidence score. A red ⚠ means the quote is not in the transcript.
- **Review flags:** say whether this script would have gone to a human examiner.
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
- the OCR, marking and import instructions (prompts). Each has a **Reset to default** button.

## 5. Troubleshooting
| Problem | Fix |
|---|---|
| "Node.js is not installed" | Install the LTS version from nodejs.org, then start again |
| "Gemini rejected the API key" | Copy the key again from aistudio.google.com/apikey |
| "That model is not available" | Pick a model from the list in Settings |
| "No model could complete the request" | Free-tier limit reached. Wait, add fallback models, or enable billing |
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
- `importer.js`: reading Excel, CSV, text and Word files, and the templates
- `public/`: the UI
