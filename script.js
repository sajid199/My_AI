/* ==========================================================================
   Marginalia — a static, backend-free AI documentation assistant.
   PDF.js extracts text -> chunks are indexed with Fuse.js -> the best
   matching chunks are sent to Gemini as context (RAG) -> the model must
   answer only from that context.
   ========================================================================== */
'use strict';

// ---- library wiring ---------------------------------------------------
pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/pdf.worker.js';

// ---- constants ----------------------------------------------------------
const LS_KEYS = {
  apiKey:  'marginalia.geminiApiKey',
  model:   'marginalia.model',
  chunkN:  'marginalia.chunkCount',
  theme:   'marginalia.theme',
};
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const DEFAULT_MODEL = 'gemini-2.0-flash';
const FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const SYSTEM_INSTRUCTION =
  "You are an AI assistant. Answer ONLY using the provided document context. " +
  "Do not use outside knowledge. If the answer is not present in the provided " +
  "context, clearly state that the information is not available in the uploaded " +
  "documents. Mention the source PDF name and page number whenever possible. " +
  "Keep answers concise and well formatted with Markdown.";
const NO_ANSWER_TEXT =
  "The uploaded documents do not contain enough information to answer this question.";

// ---- state ----------------------------------------------------------------
/** @type {{id:string,name:string,pages:number,status:string}[]} */
let documents = [];
/** @type {{id:string,docId:string,docName:string,page:number,text:string}[]} */
let chunks = [];
let fuseIndex = null;
/** @type {{role:'user'|'ai', text:string, citations?:any[], time:number, noAnswer?:boolean}[]} */
let chatHistory = [];
let docSeq = 0;

// ---- DOM refs ---------------------------------------------------------
const $ = (id) => document.getElementById(id);
const appEl            = $('app');
const sidebar          = $('sidebar');
const sidebarScrim     = $('sidebarScrim');
const fileInput        = $('fileInput');
const uploadBtn        = $('uploadBtn');
const dropzone         = $('dropzone');
const uploadProgress   = $('uploadProgress');
const uploadProgressBar= $('uploadProgressBar');
const uploadProgressText=$('uploadProgressText');
const docList          = $('docList');
const docEmpty         = $('docEmpty');
const docCount         = $('docCount');
const docSearchSection = $('docSearchSection');
const docSearchInput   = $('docSearchInput');
const docSearchResults = $('docSearchResults');
const clearChatBtn     = $('clearChatBtn');
const settingsBtn      = $('settingsBtn');
const themeToggleBtn   = $('themeToggleBtn');
const topbarDocLabel   = $('topbarDocLabel');
const downloadChatBtn  = $('downloadChatBtn');
const chatScroll       = $('chatScroll');
const emptyState       = $('emptyState');
const messagesEl       = $('messages');
const composerForm     = $('composerForm');
const chatInput        = $('chatInput');
const sendBtn          = $('sendBtn');
const sidebarOpenBtn   = $('sidebarOpenBtn');
const sidebarCloseBtn  = $('sidebarCloseBtn');
const toastEl          = $('toast');

const settingsOverlay  = $('settingsOverlay');
const settingsCloseBtn = $('settingsCloseBtn');
const settingsCancelBtn= $('settingsCancelBtn');
const settingsSaveBtn  = $('settingsSaveBtn');
const apiKeyInput      = $('apiKeyInput');
const modelSelect      = $('modelSelect');
const chunkSizeInput   = $('chunkSizeInput');

marked.setOptions({ breaks: true, gfm: true });

// ============================================================================
// Utilities
// ============================================================================
function uid(prefix){ return prefix + '_' + (++docSeq) + '_' + Math.random().toString(36).slice(2,7); }

function showToast(msg, ms = 2400){
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function escapeHtml(str){
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatTime(ts){
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function autoResizeTextarea(){
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
}

// ============================================================================
// Settings (localStorage)
// ============================================================================
function normalizeModelName(model){
  const raw = (model || '').trim();
  if (!raw) return DEFAULT_MODEL;
  const legacyMap = {
    'gemini-1.5-flash': DEFAULT_MODEL,
    'gemini-1.5-pro': DEFAULT_MODEL,
    'gemini-pro': DEFAULT_MODEL,
  };
  return legacyMap[raw] || raw;
}
function getSettings(){
  const storedModel = localStorage.getItem(LS_KEYS.model);
  return {
    apiKey:  localStorage.getItem(LS_KEYS.apiKey)  || '',
    model:   normalizeModelName(storedModel),
    chunkN:  parseInt(localStorage.getItem(LS_KEYS.chunkN) || '5', 10),
  };
}
function openSettings(){
  const s = getSettings();
  apiKeyInput.value = s.apiKey;
  modelSelect.value = s.model || DEFAULT_MODEL;
  chunkSizeInput.value = s.chunkN;
  settingsOverlay.hidden = false;
  apiKeyInput.focus();
}
function closeSettings(){ settingsOverlay.hidden = true; }
function saveSettings(){
  const normalizedModel = normalizeModelName(modelSelect.value || DEFAULT_MODEL);
  localStorage.setItem(LS_KEYS.apiKey, apiKeyInput.value.trim());
  localStorage.setItem(LS_KEYS.model, normalizedModel);
  localStorage.setItem(LS_KEYS.chunkN, String(Math.max(1, Math.min(10, parseInt(chunkSizeInput.value,10) || 5))));
  closeSettings();
  showToast('Settings saved');
}

// ============================================================================
// Theme
// ============================================================================
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? '☀' : '🌙';
  localStorage.setItem(LS_KEYS.theme, theme);
}
(function initTheme(){
  const saved = localStorage.getItem(LS_KEYS.theme);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
})();
themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================================
// Sidebar (mobile)
// ============================================================================
function openSidebar(){ appEl.classList.add('sidebar-open'); }
function closeSidebar(){ appEl.classList.remove('sidebar-open'); }
sidebarOpenBtn.addEventListener('click', openSidebar);
sidebarCloseBtn.addEventListener('click', closeSidebar);
sidebarScrim.addEventListener('click', closeSidebar);

// ============================================================================
// PDF handling
// ============================================================================
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  fileInput.value = '';
});

['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); e.stopPropagation();
  dropzone.classList.add('drag-over');
}));
['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); e.stopPropagation();
  dropzone.classList.remove('drag-over');
}));
dropzone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files || []).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (files.length) handleFiles(files);
  else showToast('Please drop PDF files only');
});
// Allow dropping anywhere on the sidebar, not just the small dropzone box
sidebar.addEventListener('dragover', (e) => e.preventDefault());
sidebar.addEventListener('drop', (e) => {
  if (e.target === dropzone || dropzone.contains(e.target)) return; // already handled
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []).filter(f => f.type === 'application/pdf');
  if (files.length) handleFiles(files);
});

async function handleFiles(fileList){
  const files = Array.from(fileList);
  if (!files.length) return;

  uploadProgress.hidden = false;
  let done = 0;

  for (const file of files){
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf'){
      showToast(`Skipped "${file.name}" — not a PDF`);
      continue;
    }
    const docId = uid('doc');
    const docRecord = { id: docId, name: file.name, pages: 0, status: 'processing' };
    documents.push(docRecord);
    renderDocList();

    uploadProgressText.textContent = `Reading ${file.name}…`;

    try{
      await extractPdf(file, docRecord);
      docRecord.status = 'ready';
      showToast(`"${file.name}" indexed — ${docRecord.pages} page${docRecord.pages===1?'':'s'}`);
    } catch(err){
      console.error(err);
      docRecord.status = 'error';
      showToast(`Failed to read "${file.name}"`);
    }

    done++;
    uploadProgressBar.style.width = Math.round((done/files.length)*100) + '%';
    renderDocList();
  }

  rebuildFuseIndex();
  updateTopbarLabel();
  uploadProgressText.textContent = 'Done';
  setTimeout(() => { uploadProgress.hidden = true; uploadProgressBar.style.width = '0%'; }, 800);
}

async function extractPdf(file, docRecord){
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  docRecord.pages = pdf.numPages;
  renderDocList();

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++){
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (pageText) chunkPageText(pageText, docRecord, pageNum);
    uploadProgressText.textContent = `Reading ${file.name}… page ${pageNum}/${pdf.numPages}`;
  }
}

function chunkPageText(pageText, docRecord, pageNum){
  let start = 0;
  while (start < pageText.length){
    const end = Math.min(start + CHUNK_CHARS, pageText.length);
    const text = pageText.slice(start, end);
    chunks.push({
      id: uid('chunk'),
      docId: docRecord.id,
      docName: docRecord.name,
      page: pageNum,
      text,
    });
    if (end === pageText.length) break;
    start = end - CHUNK_OVERLAP;
  }
}

function rebuildFuseIndex(){
  fuseIndex = new Fuse(chunks, {
    keys: ['text'],
    includeScore: true,
    includeMatches: true,
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 3,
  });
  docSearchSection.hidden = chunks.length === 0;
}

function removeDocument(docId){
  documents = documents.filter(d => d.id !== docId);
  chunks = chunks.filter(c => c.docId !== docId);
  rebuildFuseIndex();
  renderDocList();
  updateTopbarLabel();
}

// ============================================================================
// Sidebar doc list rendering
// ============================================================================
function renderDocList(){
  docList.querySelectorAll('.doc-card').forEach(n => n.remove());
  docEmpty.style.display = documents.length ? 'none' : 'block';
  docCount.textContent = documents.length;

  documents.forEach(doc => {
    const li = document.createElement('li');
    li.className = 'doc-card' + (doc.status === 'processing' ? ' processing' : '');
    const statusLabel = doc.status === 'processing' ? 'Indexing…' : doc.status === 'error' ? 'Failed' : `${doc.pages} pages`;
    li.innerHTML = `
      <div class="doc-card-row">
        <span class="doc-card-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>
        <button class="doc-card-remove" aria-label="Remove ${escapeHtml(doc.name)}">✕</button>
      </div>
      <span class="doc-card-meta ${doc.status === 'processing' ? 'doc-card-status' : ''}">${statusLabel}</span>
    `;
    li.querySelector('.doc-card-remove').addEventListener('click', () => removeDocument(doc.id));
    docList.appendChild(li);
  });
}

function updateTopbarLabel(){
  const ready = documents.filter(d => d.status === 'ready');
  if (!ready.length){ topbarDocLabel.textContent = 'No documents loaded'; return; }
  topbarDocLabel.textContent = ready.length === 1
    ? ready[0].name
    : `${ready.length} documents loaded`;
}

// ============================================================================
// Sidebar document search (independent of chat)
// ============================================================================
let docSearchTimer = null;
docSearchInput.addEventListener('input', () => {
  clearTimeout(docSearchTimer);
  docSearchTimer = setTimeout(runDocSearch, 150);
});
function runDocSearch(){
  const q = docSearchInput.value.trim();
  docSearchResults.innerHTML = '';
  if (!q || !fuseIndex) return;
  const results = fuseIndex.search(q, { limit: 6 });
  if (!results.length){
    docSearchResults.innerHTML = '<li>No matches found.</li>';
    return;
  }
  results.forEach(r => {
    const snippet = highlightSnippet(r.item.text, r.matches);
    const li = document.createElement('li');
    li.innerHTML = `<b>${escapeHtml(r.item.docName)}</b> · p.${r.item.page}<br>${snippet}`;
    docSearchResults.appendChild(li);
  });
}
function highlightSnippet(text, matches, maxLen = 140){
  let snippet = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  if (matches && matches.length){
    const m = matches[0];
    if (m.indices && m.indices.length){
      const [s,e] = m.indices[0];
      const start = Math.max(0, s - 30);
      const end = Math.min(text.length, e + 30);
      snippet = (start > 0 ? '…' : '') +
        escapeHtml(text.slice(start, s)) +
        '<mark>' + escapeHtml(text.slice(s, e+1)) + '</mark>' +
        escapeHtml(text.slice(e+1, end)) +
        (end < text.length ? '…' : '');
      return snippet;
    }
  }
  return escapeHtml(snippet);
}

// ============================================================================
// Chat rendering
// ============================================================================
function renderMessage(msg){
  emptyState.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (msg.role === 'user' ? 'msg-user' : 'msg-ai');

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (msg.role === 'ai'){
    bubble.innerHTML = msg.noAnswer
      ? `<p class="no-answer">${escapeHtml(msg.text)}</p>`
      : marked.parse(msg.text);
  } else {
    bubble.textContent = msg.text;
  }
  wrap.appendChild(bubble);

  if (msg.citations && msg.citations.length){
    const cites = document.createElement('div');
    cites.className = 'citations';
    msg.citations.forEach(c => {
      const badge = document.createElement('span');
      badge.className = 'citation-badge';
      badge.innerHTML = `${escapeHtml(c.docName)} <span class="cb-page">p.${c.page}</span>`;
      cites.appendChild(badge);
    });
    wrap.appendChild(cites);
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = `<span>${msg.role === 'user' ? 'You' : 'Marginalia'} · ${formatTime(msg.time)}</span>`;
  if (msg.role === 'ai' && !msg.pending){
    const actions = document.createElement('span');
    actions.className = 'msg-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(msg.text).then(() => showToast('Copied to clipboard'));
    });
    actions.appendChild(copyBtn);
    meta.appendChild(actions);
  }
  wrap.appendChild(meta);

  messagesEl.appendChild(wrap);
  scrollChatToBottom();
  return wrap;
}

function scrollChatToBottom(){
  requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
}

function renderTypingIndicator(){
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-ai';
  wrap.id = 'typingIndicator';
  wrap.innerHTML = `<div class="msg-bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
  messagesEl.appendChild(wrap);
  scrollChatToBottom();
}
function removeTypingIndicator(){
  const el = $('typingIndicator');
  if (el) el.remove();
}

// ============================================================================
// RAG: retrieve + prompt + call Gemini
// ============================================================================
function retrieveContext(query, topN){
  if (!fuseIndex || !chunks.length) return [];
  const results = fuseIndex.search(query, { limit: topN });
  return results.map(r => r.item);
}

function buildPrompt(question, contextChunks){
  const contextBlock = contextChunks.map((c, i) =>
    `[Source ${i+1}: "${c.docName}", page ${c.page}]\n${c.text}`
  ).join('\n\n---\n\n');

  return `Document context:\n\n${contextBlock || '(no relevant context found)'}\n\n---\n\nQuestion: ${question}\n\n` +
    `Answer using only the context above. If you use a source, cite it inline like (DocName, p.X). ` +
    `If the context does not contain the answer, respond with exactly: "${NO_ANSWER_TEXT}"`;
}

function parseRetryDelay(errText){
  try{
    const data = JSON.parse(errText);
    const retryInfo = data?.error?.details?.find(d => d?.['@type']?.includes('RetryInfo'));
    const delay = retryInfo?.retryDelay;
    if (!delay) return null;
    const secondsMatch = delay.match(/^(\d+(?:\.\d+)?)s$/i);
    if (secondsMatch) return Math.max(1, Math.ceil(Number(secondsMatch[1])));
    const minutesMatch = delay.match(/^(\d+(?:\.\d+)?)m$/i);
    if (minutesMatch) return Math.max(1, Math.ceil(Number(minutesMatch[1]) * 60));
    const hoursMatch = delay.match(/^(\d+(?:\.\d+)?)h$/i);
    if (hoursMatch) return Math.max(1, Math.ceil(Number(hoursMatch[1]) * 3600));
  } catch (e) {
    // ignore malformed JSON
  }
  return null;
}

async function callGemini(prompt){
  const { apiKey, model } = getSettings();
  if (!apiKey) throw new Error('NO_API_KEY');

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };

  const candidates = [normalizeModelName(model), ...FALLBACK_MODELS.filter(m => m !== normalizeModelName(model))];
  let lastError = null;

  for (const modelName of candidates){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok){
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      if (!text) throw new Error('EMPTY_RESPONSE');
      return text;
    }

    const errText = await res.text().catch(() => '');
    const isQuotaError = res.status === 429 || /quota|RESOURCE_EXHAUSTED|rate limit|retryDelay/i.test(errText);
    if (isQuotaError){
      const retryDelay = parseRetryDelay(errText);
      const delayInfo = retryDelay ? ` Please wait ${retryDelay} seconds and try again.` : ' Please wait a little longer and try again later.';
      lastError = new Error(`QUOTA_EXCEEDED${retryDelay ? `:${retryDelay}` : ''}: ${errText.slice(0,200)}`);
      if (retryDelay){
        showToast(`Gemini quota reached. Waiting ${retryDelay}s…`);
        await new Promise(resolve => setTimeout(resolve, retryDelay * 1000));
        continue;
      }
      break;
    }

    lastError = new Error(`API_ERROR: ${res.status} ${errText.slice(0,200)}`);
    if (res.status !== 404 && !/not found|unsupported/i.test(errText)) break;
  }

  throw lastError || new Error('API_ERROR: Unknown error');
}

// ============================================================================
// Chat send flow
// ============================================================================
composerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
chatInput.addEventListener('input', autoResizeTextarea);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage(){
  const question = chatInput.value.trim();
  if (!question) return;

  if (!documents.some(d => d.status === 'ready')){
    showToast('Upload at least one PDF first');
    return;
  }
  const { apiKey } = getSettings();
  if (!apiKey){
    showToast('Add your Gemini API key in Settings first');
    openSettings();
    return;
  }

  chatInput.value = '';
  autoResizeTextarea();
  sendBtn.disabled = true;

  const userMsg = { role: 'user', text: question, time: Date.now() };
  chatHistory.push(userMsg);
  renderMessage(userMsg);

  renderTypingIndicator();

  try{
    const { chunkN } = getSettings();
    const contextChunks = retrieveContext(question, chunkN);
    const prompt = buildPrompt(question, contextChunks);
    const answer = await callGemini(prompt);

    removeTypingIndicator();

    const isNoAnswer = answer.trim().startsWith(NO_ANSWER_TEXT.slice(0, 30));
    const citations = isNoAnswer ? [] : dedupeCitations(contextChunks);

    const aiMsg = { role: 'ai', text: answer.trim(), citations, time: Date.now(), noAnswer: isNoAnswer };
    chatHistory.push(aiMsg);
    renderMessage(aiMsg);
  } catch(err){
    removeTypingIndicator();
    console.error(err);
    let msg = 'Something went wrong talking to Gemini.';
    const errText = String(err.message || err);
    if (errText.includes('NO_API_KEY')) { msg = 'Add your Gemini API key in Settings first.'; openSettings(); }
    else if (errText.includes('QUOTA_EXCEEDED')) {
      const retrySeconds = errText.match(/:(\d+):/);
      const seconds = retrySeconds ? retrySeconds[1] : null;
      msg = seconds
        ? `Gemini free-tier quota is exhausted. Please wait ${seconds} seconds and try again later.`
        : 'Gemini free-tier quota is exhausted. Please wait a little while or use a paid plan.';
    }
    else if (errText.includes('API_ERROR')) msg = 'Gemini API error — check your API key and model in Settings.';
    const aiMsg = { role: 'ai', text: msg, time: Date.now(), noAnswer: true };
    chatHistory.push(aiMsg);
    renderMessage(aiMsg);
  } finally {
    sendBtn.disabled = false;
  }
}

function dedupeCitations(contextChunks){
  const seen = new Set();
  const out = [];
  contextChunks.forEach(c => {
    const key = c.docName + '#' + c.page;
    if (!seen.has(key)){ seen.add(key); out.push({ docName: c.docName, page: c.page }); }
  });
  return out;
}

// ============================================================================
// Clear chat / export
// ============================================================================
clearChatBtn.addEventListener('click', () => {
  if (!chatHistory.length) return;
  chatHistory = [];
  messagesEl.innerHTML = '';
  emptyState.style.display = 'block';
  showToast('Chat cleared');
});

downloadChatBtn.addEventListener('click', () => {
  if (!chatHistory.length){ showToast('No chat to export yet'); return; }
  const lines = chatHistory.map(m => {
    const who = m.role === 'user' ? 'You' : 'Marginalia';
    const cites = m.citations && m.citations.length
      ? '\nSources: ' + m.citations.map(c => `${c.docName} p.${c.page}`).join('; ')
      : '';
    return `[${formatTime(m.time)}] ${who}:\n${m.text}${cites}\n`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `marginalia-chat-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ============================================================================
// Settings modal wiring
// ============================================================================
settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
settingsCancelBtn.addEventListener('click', closeSettings);
settingsSaveBtn.addEventListener('click', saveSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsOverlay.hidden) closeSettings(); });

// ============================================================================
// First-run prompt for API key
// ============================================================================
(function initApiKeyPrompt(){
  const { apiKey } = getSettings();
  if (!apiKey){
    setTimeout(() => showToast('Tip: add a free Gemini API key in Settings to start chatting'), 600);
  }
})();

renderDocList();
