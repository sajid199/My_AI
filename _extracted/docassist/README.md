# Marginalia — AI Documentation Assistant

A fully static, backend-free RAG chat assistant for PDF documents. Upload PDFs,
ask questions in a ChatGPT-style interface, and get answers grounded strictly
in what you uploaded — with page citations. Runs entirely in the browser and
deploys as-is to GitHub Pages.

## How it works

1. **PDF.js** extracts text from every page of every uploaded PDF, client-side.
2. The text is split into ~900-character overlapping chunks, each tagged with
   its source document and page number.
3. **Fuse.js** builds a fuzzy-search index over those chunks.
4. When you ask a question, the top matching chunks are retrieved and sent —
   along with a strict system instruction — to the **Google Gemini API**
   (free tier). The model is told to answer *only* from that context, or say
   so explicitly if the answer isn't there.
5. Citations (document name + page) are shown as badges under every answer.

No server, no build step, no database. Your PDFs and API key never leave your
browser except for the specific text chunks sent to Google's Gemini endpoint
when you ask a question.

## Folder structure

```
/
├── index.html        entry point, all markup
├── style.css          full styling (light + dark themes)
├── script.js          app logic: PDF parsing, chunking, search, RAG, chat UI
├── js/
│   ├── pdf.js          PDF.js (Mozilla) — reads PDF files
│   ├── pdf.worker.js   PDF.js background worker
│   ├── fuse.min.js     Fuse.js — fuzzy search over extracted text
│   └── marked.min.js   Marked — renders Markdown in AI answers
├── assets/            (empty — reserved for icons/images)
└── README.md
```

All libraries are vendored locally in `js/` — nothing is loaded from a CDN,
so the app works offline once loaded and has no third-party runtime
dependency besides the Gemini API call itself.

## Running locally

You cannot simply double-click `index.html` in some browsers, because
`fetch`/module loading of local files is blocked under the `file://`
protocol in some cases. Easiest fix — serve the folder with any static
server, for example:

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .
```

Then open `http://localhost:8000`.

(In most modern browsers `index.html` opened directly does still work,
since this app uses plain `<script src>` tags rather than ES modules —
try that first.)

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick your
   default branch and the `/ (root)` folder.
4. Save — your site will be published at
   `https://<username>.github.io/<repo>/` within a minute or two.

No secrets or environment variables are needed at build time — the Gemini API
key is entered by each visitor in **Settings** and stored only in their own
browser's `localStorage`.

## Getting a free Gemini API key

1. Visit [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Sign in and click **Create API key**.
3. Paste it into Marginalia's **Settings** panel (gear icon in the sidebar).

The free tier is sufficient for personal / light use. Usage and limits are
governed entirely by Google — Marginalia does not proxy or meter your calls.

## Features

- Multi-file PDF upload, drag-and-drop, upload progress
- Client-side text extraction and chunking (cached in memory for the session)
- Fuzzy full-text search across all uploaded documents, from the sidebar
- Chat interface with Markdown rendering and code syntax formatting
- Retrieval-augmented answers: only the most relevant chunks are sent per
  question, keeping prompts small
- Strict "answer only from documents" system prompt, with an explicit
  fallback message when nothing relevant was found
- Citation badges (document name + page number) under every answer
- Copy-answer button, chat export to `.txt`, clear-chat button
- Session-persistent chat history (until you refresh or clear it)
- Light / dark theme toggle
- Fully responsive, including a collapsible sidebar on mobile

## Notes & limitations

- Text extraction relies on PDFs having a real text layer — scanned/image-only
  PDFs won't yield extractable text (no OCR is included, to keep this
  lightweight and free).
- Everything is held in memory for the current browser tab; refreshing the
  page clears uploaded documents (by design — "no backend" means nothing is
  persisted server-side, and we avoid writing large PDF text into
  `localStorage` to respect its size limits).
- This is intentionally simple: no bundler, no framework, no build pipeline —
  just three files plus vendored libraries.
