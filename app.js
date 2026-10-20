'use strict';
// أرشيفي — كل شيء يحدث على الجوال: القراءة (OCR) والحفظ (IndexedDB). لا يوجد أي رفع.

const $ = s => document.querySelector(s);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ---------- قاعدة البيانات على الجوال ---------- */
const STORE = 'docs';
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('arshifi', 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = mode => db.transaction(STORE, mode).objectStore(STORE);
const asPromise = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const getAll = () => asPromise(store('readonly').getAll());
const putDoc = d => asPromise(store('readwrite').put(d));
const delDoc = id => asPromise(store('readwrite').delete(id));

/* ---------- أدوات النص ---------- */
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const latinDigits = s => (s || '').replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d)).replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d));
// توحيد الكتابة للبحث: بدون تشكيل، وأ/إ/آ = ا، ى = ي، ة = ه
function norm(s) {
  return latinDigits(s).replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ء/g, '')
    .toLowerCase();
}
const cleanPart = s => (s || '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');

// إزالة ألقاب المخاطبة من اسم الملف (عطوفة الأخ وكيل الوزارة ← وكيل الوزارة)
const shortParty = s => cleanPart(s)
  .replace(/^(عطوف[ةه]|معالي|سعاد[ةه]|حضر[ةه]|فضيل[ةه]|سماح[ةه])\s*/, '')
  .replace(/^(الأخ|الاخ|الأخت|الاخت|السيد|السيدة|السادة)\s*/, '').trim();

// اسم الملف: التاريخ - الموضوع - من ... - إلى ...
function makeName(d) {
  const parts = [d.date, cleanPart(d.subject).slice(0, 80)];
  if (d.from) parts.push('من ' + shortParty(d.from).slice(0, 45));
  if (d.to) parts.push('إلى ' + shortParty(d.to).slice(0, 45));
  const name = parts.filter(Boolean).join(' - ');
  return d.subject || d.from || d.to ? name : cleanPart(d.origName.replace(/\.[^.]+$/, ''));
}

/* ---------- التصنيف حسب النوع ---------- */
// الترتيب مهم: أول تطابق يفوز. الكلمات مكتوبة بعد التوحيد (ة ← ه، أ ← ا)
const CATEGORY_RULES = [
  ['طلبات شراء وتوريد', /طلب شرا|شراء|شرا |توريد|عرض سعر|عروض اسعار|مناقصه|عطاء/],
  ['مالية وفواتير', /فاتوره|فواتير|سند صرف|سند قبض|دفعه|مستحقات|صرف مبلغ|موازنه|سلفه|رواتب|حواله/],
  ['إجازات ومغادرات', /اجازه|مغادره/],
  ['شؤون الموظفين', /تعيين|نقل الموظف|انتداب|ندب|تكليف|ترقيه|علاوه|استقاله|تقاعد|دوام|حضور وانصراف|عقوبه|انذار|لفت نظر/],
  ['اجتماعات ودعوات', /اجتماع|دعوه|ورشه|لقاء|مؤتمر|محضر|زياره/],
  ['تعاميم وقرارات', /تعميم|قرار/],
  ['صيانة وخدمات', /صيانه|اصلاح|عطل|مولد|ماتور|كهربا|مياه|تنظيف|سياره|مركبه|وقود|محروقات|اوفرلود/],
  ['تقارير', /تقرير|احصاء/],
  ['شكر وتهنئة', /شكر|تهنئه|تعزيه|تقدير/],
  ['عقود واتفاقيات', /عقد|اتفاقيه|مذكره تفاهم/],
];
const DEFAULT_CATEGORY = 'مراسلات عامة';
function classify(subject, text) {
  const s = norm(subject), t = norm((text || '').slice(0, 1500));
  for (const [cat, re] of CATEGORY_RULES) if (re.test(s)) return cat;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return DEFAULT_CATEGORY;
}
async function sha256(blob) {
  if (!crypto.subtle) return '';
  const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const fileExt = d => d.mime === 'application/pdf' ? '.pdf' : (d.mime === 'image/png' ? '.png' : '.jpg');

/* ---------- استخراج المعلومات من نص الورقة ---------- */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function validDate(y, m, d) {
  y = +y; m = +m; d = +d;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}
function findDate(text, fileName) {
  // تصحيح أخطاء شائعة في قراءة الأرقام (I0 ← 10، O ← 0)
  const t = latinDigits(text).replace(/(?<=[\d\/\-.])[IlO]|[IlO](?=[\d\/\-.])/g, c => (c === 'O' ? '0' : '1'));
  let m, r;
  const ymd = /(20\d{2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/g;
  while ((m = ymd.exec(t))) if ((r = validDate(m[1], m[2], m[3]))) return r;
  const dmy = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(20\d{2})/g;
  while ((m = dmy.exec(t))) if ((r = validDate(m[3], m[2], m[1]))) return r;
  // من اسم ملف Adobe Scan: "Adobe Scan 20 Oct 2026"
  m = (fileName || '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(20\d{2})/);
  if (m && MONTHS[m[2].toLowerCase()]) return validDate(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  return '';
}
// حذف بقايا القراءة الخاطئة: كلمات لاتينية قصيرة أو أرقام منفردة (مثل «4 W i» أو «yh)»)
const dropNoise = s => s.split(' ').filter(w => !/^\(?(?:[A-Za-z]{1,4}|\d{1,2})\)?[.,]?$/.test(w)).join(' ').trim();
const stripMarks = s => (s || '').replace(/[‎‏‪-‮⁦-⁩]/g, '');

function extractInfo(text, fileName) {
  text = stripMarks(text);
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 1);
  const info = { date: findDate(text, fileName), subject: '', from: '', to: '' };

  // الموضوع: السطر الذي فيه «الموضوع»
  const si = lines.findIndex(l => /الموضوع|موضوع\s*[:：]/.test(norm(l)));
  if (si >= 0) {
    let s = lines[si].replace(/^.*?موضوع\s*[:：.\-–]?\s*/, '');
    if (s.replace(/[^؀-ۿA-Za-z]/g, '').length < 4 && lines[si + 1]) s = lines[si + 1];
    info.subject = dropNoise(s).replace(/^[^؀-ۿA-Za-z(]+|[^؀-ۿA-Za-z)]+$/g, '');
  }

  // إلى: سطر قبل الموضوع فيه لقب مخاطبة
  const toRe = /(عطوف[ةه]|معالي|سعاد[ةه]|حضر[ةه]|فضيل[ةه]|سماح[ةه]|السادة|السيد[ةه]?|الأخ(?:ت)?\s*\/|الاخ(?:ت)?\s*\/|^إلى|^الى)/;
  const before = (si >= 0 ? lines.slice(0, si) : lines.slice(0, 12));
  const toLine = before.find(l => toRe.test(l));
  if (toLine) {
    info.to = dropNoise(toLine.slice(toLine.search(toRe)))
      .replace(/\s*(المحترم|المحترمة|المحترمين|حفظه الله).*$/, '').replace(/\s*\/\s*/g, ' ').replace(/[^؀-ۿ)]+$/, '');
  }

  // من: آخر سطر فيه منصب، بعد الموضوع
  const fromRe = /(مدير|رئيس|وكيل|وزير|مسؤول|منسق|امين|نائب|مساعد)/;
  const after = si >= 0 ? lines.slice(si + 1) : lines;
  const fromLine = [...after].reverse().find(l => fromRe.test(norm(l)) && l.length < 70 && l !== toLine);
  if (fromLine) info.from = fromLine.replace(/^[^؀-ۿ]+|[^؀-ۿ)]+$/g, '');
  return info;
}

/* ---------- قراءة الورقة (على الجوال) ---------- */
let ocrWorker = null, onOcrProgress = null;
async function getOcr() {
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker(['ara', 'eng'], 1, {
      logger: m => onOcrProgress && onOcrProgress(m)
    });
  }
  return ocrWorker;
}
// تبييض الخلفية وتغميق الحبر حتى تقل العلامة المائية وتسهل القراءة
function cleanCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height), p = img.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    const o = v > 165 ? 255 : v < 90 ? 0 : (v - 90) * 3.4;
    p[i] = p[i + 1] = p[i + 2] = o;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
async function pdfPages(blob) {
  return pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
}
async function renderPdfPage(pdf, n, targetWidth) {
  const page = await pdf.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: targetWidth / v1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}
async function imageCanvas(blob, maxW) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
const thumbOf = canvas => {
  const s = 240 / canvas.width, c = document.createElement('canvas');
  c.width = 240; c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75);
};

async function analyse(file, setMsg, setPct) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const canvases = [];
  setMsg('جاري فتح الملف…');
  if (isPdf) {
    const pdf = await pdfPages(file);
    const n = Math.min(pdf.numPages, 4); // أول ٤ صفحات تكفي للبحث
    for (let i = 1; i <= n; i++) canvases.push(await renderPdfPage(pdf, i, 1800));
  } else {
    canvases.push(await imageCanvas(file, 1800));
  }
  const thumb = thumbOf(canvases[0]);
  setMsg('جاري تجهيز القارئ… (أول مرة فقط قد تأخذ دقيقة)');
  const w = await getOcr();
  let text = '';
  for (let i = 0; i < canvases.length; i++) {
    setMsg(canvases.length > 1 ? `جاري قراءة الصفحة ${i + 1} من ${canvases.length}…` : 'جاري قراءة الورقة…');
    onOcrProgress = m => { if (m.status === 'recognizing text') setPct(Math.round(m.progress * 100) + '٪'); };
    const r = await w.recognize(cleanCanvas(canvases[i]));
    text += (i ? '\n\n' : '') + stripMarks(r.data.text);
  }
  onOcrProgress = null;
  return { text, thumb, isPdf };
}

/* ---------- القائمة والبحث ---------- */
let docs = [];
async function refresh() {
  docs = (await getAll()).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created);
  renderList();
}
function highlight(s, words) {
  let out = esc(s);
  for (const w of words) {
    if (w.length < 2) continue;
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, x => `<mark>${x}</mark>`);
  }
  return out;
}
let activeCat = ''; // '' = الكل، '!' = يحتاج مراجعة
const catOf = d => d.category || DEFAULT_CATEGORY;
function renderChips() {
  const counts = {};
  docs.forEach(d => counts[catOf(d)] = (counts[catOf(d)] || 0) + 1);
  const review = docs.filter(d => d.review).length;
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (activeCat && activeCat !== '!' && !counts[activeCat]) activeCat = '';
  if (activeCat === '!' && !review) activeCat = '';
  const chip = (val, label, n, cls = '') => `<button class="chip ${cls} ${activeCat === val ? 'on' : ''}" data-cat="${esc(val)}">${esc(label)} <b>${n}</b></button>`;
  $('#chips').innerHTML = docs.length ? chip('', 'الكل', docs.length) + (review ? chip('!', 'يحتاج مراجعة', review, 'warn') : '') +
    cats.map(c => chip(c, c, counts[c])).join('') : '';
}
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  activeCat = b.dataset.cat;
  renderList();
});
function renderList() {
  renderChips();
  const q = norm($('#q').value.trim());
  const words = q.split(/\s+/).filter(Boolean);
  const shown = docs.filter(d => {
    if (activeCat === '!' ? !d.review : activeCat && catOf(d) !== activeCat) return false;
    if (!words.length) return true;
    const hay = norm([d.name, d.subject, d.from, d.to, d.kind, d.category, d.notes, d.date, d.text].join(' '));
    return words.every(w => hay.includes(w));
  });
  const filtered = words.length || activeCat;
  $('#count').textContent = docs.length ? (filtered ? `${shown.length} من ${docs.length} كتاب` : `${docs.length} كتاب`) : '';
  const L = $('#list');
  if (!docs.length) {
    L.innerHTML = `<div class="empty"><b>لا يوجد كتب بعد</b>اضغطي «إضافة كتب»، وادخلي على المجلد، واضغطي «تحديد» ثم «تحديد الكل».<br>التطبيق بيقرأ كل كتاب، وبيصنّفه حسب نوعه، وبيسمّيه لحاله.</div>`;
    return;
  }
  if (!shown.length) { L.innerHTML = `<div class="empty"><b>ما في نتائج</b>جرّبي كلمة ثانية أو جزء من الكلمة.</div>`; return; }
  const rawWords = $('#q').value.trim().split(/\s+/).filter(Boolean);
  L.innerHTML = shown.map(d => `
    <div class="item" data-id="${d.id}">
      <img src="${d.thumb}" alt="">
      <div style="min-width:0">
        <div class="t">${highlight(d.subject || d.name, rawWords)}</div>
        <div class="m"><bdi dir="ltr">${esc(d.date || 'بدون تاريخ')}</bdi><span class="tag">${esc(catOf(d))}</span>${d.kind ? `<span class="tag">${esc(d.kind)}</span>` : ''}${d.review ? '<span class="tag warn">راجعيه</span>' : ''}</div>
        ${d.from ? `<div class="m">من: ${highlight(shortParty(d.from), rawWords)}</div>` : ''}
        ${d.to ? `<div class="m">إلى: ${highlight(shortParty(d.to), rawWords)}</div>` : ''}
      </div>
    </div>`).join('');
}
$('#q').addEventListener('input', renderList);
$('#list').addEventListener('click', e => {
  const it = e.target.closest('.item');
  if (it) openView(it.dataset.id);
});

/* ---------- الإضافة والتعديل ---------- */
let queue = [], editing = null;
const open = id => { $(id).classList.add('open'); $(id).scrollTop = 0; };
const close = id => $(id).classList.remove('open');
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 2200);
}

$('#btnAdd').onclick = () => $('#file').click();
$('#file').onchange = e => {
  queue = [...e.target.files]; e.target.value = '';
  if (queue.length) runBatch();
};

// أرشفة كل الملفات المختارة واحداً تلو الآخر، والحفظ تلقائياً
let batchStop = false;
async function runBatch() {
  batchStop = false;
  const total = queue.length, results = [];
  let skipped = 0, failed = 0;
  const known = new Set(docs.map(d => d.hash).filter(Boolean));
  $('#batchRun').hidden = false; $('#batchDone').hidden = true;
  open('#batch');
  for (let i = 0; queue.length && !batchStop; i++) {
    const file = queue.shift();
    $('#bTitle').textContent = `جاري أرشفة الملف ${i + 1} من ${total}`;
    $('#bFile').textContent = file.name;
    $('#bBar').style.width = Math.round(i / total * 100) + '%';
    $('#busyPct2').textContent = '';
    try {
      const hash = await sha256(file);
      if (hash && known.has(hash)) { skipped++; continue; }
      const r = await analyse(file, m => $('#bMsg').textContent = m, p => $('#busyPct2').textContent = p);
      const info = extractInfo(r.text, file.name);
      const d = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now(), hash,
        origName: file.name, mime: r.isPdf ? 'application/pdf' : (file.type || 'image/jpeg'), blob: file,
        thumb: r.thumb, text: r.text, kind: '', notes: '', ...info,
        category: classify(info.subject, r.text)
      };
      d.review = !d.subject || !d.date;
      d.name = makeName(d);
      await putDoc(d);
      if (hash) known.add(hash);
      results.push(d);
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  queue = [];
  $('#bBar').style.width = '100%';
  await refresh();
  const review = results.filter(d => d.review).length;
  $('#bSummary').innerHTML =
    `<div><span>تمت أرشفتها</span><span>${results.length}</span></div>` +
    (review ? `<div><span>تحتاج مراجعة</span><span>${review}</span></div>` : '') +
    (skipped ? `<div><span>موجودة من قبل (تخطّيتها)</span><span>${skipped}</span></div>` : '') +
    (failed ? `<div><span>ما قدرت أفتحها</span><span>${failed}</span></div>` : '');
  $('#bList').innerHTML = results.map(d => `
    <div class="item" data-id="${d.id}"><img src="${d.thumb}" alt="">
      <div style="min-width:0"><div class="t">${esc(d.name)}</div>
      <div class="m"><span class="tag">${esc(d.category)}</span>${d.review ? '<span class="tag warn">راجعيه</span>' : ''}</div></div>
    </div>`).join('');
  $('#batchRun').hidden = true; $('#batchDone').hidden = false;
}
$('#bStop').onclick = () => { batchStop = true; $('#bMsg').textContent = 'جاري الإيقاف بعد هذا الملف…'; };
$('#bClose').onclick = () => close('#batch');
$('#bList').addEventListener('click', e => {
  const it = e.target.closest('.item');
  if (it) { close('#batch'); openView(it.dataset.id); }
});
function nextInQueue() {}

function fillForm(d) {
  $('#editThumb').src = d.thumb;
  $('#fDate').value = d.date || '';
  $('#fSubject').value = d.subject || '';
  $('#fFrom').value = d.from || '';
  $('#fTo').value = d.to || '';
  $('#fKind').value = d.kind || '';
  $('#fCat').value = d.category || DEFAULT_CATEGORY;
  $('#catList').innerHTML = [...new Set([...CATEGORY_RULES.map(r => r[0]), DEFAULT_CATEGORY, ...docs.map(catOf)])]
    .map(c => `<option value="${esc(c)}">`).join('');
  $('#fNotes').value = d.notes || '';
  $('#editBusy').hidden = true; $('#editForm').hidden = false;
  updateName();
}
function readForm() {
  return { date: $('#fDate').value, subject: $('#fSubject').value.trim(), from: $('#fFrom').value.trim(),
    to: $('#fTo').value.trim(), kind: $('#fKind').value, notes: $('#fNotes').value.trim(),
    category: $('#fCat').value.trim() || DEFAULT_CATEGORY };
}
function updateName() {
  if (!editing) return;
  $('#fName').textContent = makeName({ ...editing, ...readForm() }) + fileExt(editing);
}
['#fDate', '#fSubject', '#fFrom', '#fTo', '#fKind', '#fCat', '#fNotes'].forEach(id => $(id).addEventListener('input', updateName));

async function saveEdit() {
  if (!editing || $('#editForm').hidden) return;
  const d = { ...editing, ...readForm(), review: false };
  delete d.isNew;
  d.name = makeName(d);
  await putDoc(d);
  close('#edit');
  toast('تم الحفظ ✓');
  await refresh();
  if (viewing && viewing.id === d.id) openView(d.id);
  editing = null;
  nextInQueue();
}
$('#editSave').onclick = saveEdit;
$('#editSave2').onclick = saveEdit;
$('#editCancel').onclick = () => {
  if (editing && editing.isNew && !confirm('إلغاء هذا الكتاب بدون حفظ؟')) return;
  close('#edit'); editing = null; nextInQueue();
};

/* ---------- العرض ---------- */
let viewing = null;
async function openView(id) {
  const d = docs.find(x => x.id === id);
  if (!d) return;
  viewing = d;
  const rows = [['التاريخ', d.date], ['الموضوع', d.subject], ['من', d.from], ['إلى', d.to], ['التصنيف', catOf(d)], ['وارد/صادر', d.kind], ['ملاحظات', d.notes], ['اسم الملف', d.name + fileExt(d)]]
    .filter(r => r[1]).map(r => `<div><span>${r[0]}</span><bdi>${esc(r[1])}</bdi></div>`).join('');
  $('#viewMeta').innerHTML = rows;
  $('#viewText').textContent = d.text || '';
  const P = $('#viewPages');
  P.innerHTML = `<img src="${d.thumb}" alt="">`;
  open('#view');
  try {
    if (d.mime === 'application/pdf') {
      const pdf = await pdfPages(d.blob);
      const w = Math.min(1400, P.clientWidth * (window.devicePixelRatio || 2));
      const frag = [];
      for (let i = 1; i <= pdf.numPages; i++) frag.push(await renderPdfPage(pdf, i, w));
      if (viewing === d) { P.innerHTML = ''; frag.forEach(c => P.appendChild(c)); }
    } else {
      const img = new Image(); img.src = URL.createObjectURL(d.blob);
      if (viewing === d) { P.innerHTML = ''; P.appendChild(img); }
    }
  } catch (e) { console.error(e); }
}
$('#viewBack').onclick = () => { close('#view'); viewing = null; };
$('#viewEdit').onclick = () => {
  editing = { ...viewing };
  $('#editTitle').textContent = 'تعديل';
  fillForm(editing);
  open('#edit');
};
$('#viewDelete').onclick = async () => {
  if (!confirm('حذف هذا الكتاب نهائياً من الجوال؟')) return;
  await delDoc(viewing.id);
  close('#view'); viewing = null;
  toast('تم الحذف'); refresh();
};
const asFile = d => new File([d.blob], d.name + fileExt(d), { type: d.mime });
async function shareFiles(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
    return;
  }
  // الكمبيوتر: تنزيل عادي
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    await new Promise(r => setTimeout(r, 300));
  }
}
$('#viewShare').onclick = () => shareFiles([asFile(viewing)]);

/* ---------- الإعدادات ---------- */
$('#btnSettings').onclick = async () => {
  let used = '';
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    used = (e.usage / 1048576).toFixed(1) + ' ميغا';
  }
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $('#setInfo').innerHTML = `<div><span>عدد الكتب</span><span>${docs.length}</span></div>` +
    (used ? `<div><span>المساحة المستعملة</span><span>${used}</span></div>` : '') +
    `<div><span>الحفظ الدائم</span><span>${persisted ? 'مفعّل ✓' : 'غير مؤكد'}</span></div>`;
  fillMonths();
  open('#settings');
};
$('#setBack').onclick = () => close('#settings');
const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const monthOf = d => (d.date || '').slice(0, 7) || 'بدون تاريخ';
const monthLabel = m => /^\d{4}-\d{2}$/.test(m) ? `${MONTH_NAMES[+m.slice(5) - 1]} ${m.slice(0, 4)}` : m;
function fillMonths() {
  const months = [...new Set(docs.map(monthOf))].sort().reverse();
  $('#repMonth').innerHTML = `<option value="">كل الأشهر</option>` +
    months.map(m => `<option value="${esc(m)}">${esc(monthLabel(m))} (${docs.filter(d => monthOf(d) === m).length})</option>`).join('');
}

// ملف مضغوط: مجلد لكل تصنيف + (اختياري) ملف Excel فيه رابط لكل معاملة
async function buildArchive(list, withExcel, title) {
  const zip = new JSZip(), used = new Set(), paths = new Map();
  for (const d of list) {
    let path = `${cleanPart(catOf(d))}/${d.name}`, n = 2;
    while (used.has(path + fileExt(d))) path = `${cleanPart(catOf(d))}/${d.name} (${n++})`;
    used.add(path + fileExt(d));
    paths.set(d.id, path + fileExt(d));
    zip.file(path + fileExt(d), d.blob);
  }
  if (withExcel) {
    const wb = XLSX.utils.book_new();
    const months = [...new Set(list.map(monthOf))].sort();
    for (const m of months) {
      const rows = list.filter(d => monthOf(d) === m).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const head = ['#', 'التاريخ', 'الموضوع (اضغطي لفتح المعاملة)', 'التصنيف', 'من', 'إلى', 'وارد/صادر', 'ملاحظات', 'اسم الملف'];
      const data = [head, ...rows.map((d, i) => [i + 1, d.date || '', d.subject || d.name, catOf(d), d.from || '', d.to || '', d.kind || '', d.notes || '', paths.get(d.id)])];
      const ws = XLSX.utils.aoa_to_sheet(data);
      rows.forEach((d, i) => {
        const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 2 })];
        cell.l = { Target: paths.get(d.id).replace(/ /g, '%20'), Tooltip: 'فتح المعاملة' };
      });
      ws['!cols'] = [{ wch: 4 }, { wch: 11 }, { wch: 50 }, { wch: 18 }, { wch: 32 }, { wch: 32 }, { wch: 10 }, { wch: 25 }, { wch: 60 }];
      ws['!autofilter'] = { ref: ws['!ref'] };
      XLSX.utils.book_append_sheet(wb, ws, cleanPart(monthLabel(m)).slice(0, 31));
    }
    wb.Workbook = { Views: [{ RTL: true }] };
    zip.file(`سجل المعاملات - ${title}.xlsx`, XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
  }
  return zip.generateAsync({ type: 'blob' });
}
async function exportZip(btn, list, withExcel, title) {
  if (!list.length) return toast('لا يوجد كتب');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'جاري التجهيز…';
  try {
    const blob = await buildArchive(list, withExcel, title);
    await shareFiles([new File([blob], `أرشيفي - ${title}.zip`, { type: 'application/zip' })]);
  } catch (e) { alert(e.message); }
  btn.disabled = false; btn.textContent = label;
}
$('#repExport').onclick = () => {
  const m = $('#repMonth').value;
  exportZip($('#repExport'), m ? docs.filter(d => monthOf(d) === m) : docs, true, m ? monthLabel(m) : 'كل الأشهر');
};
// نسخة احتياطية كاملة
$('#setExport').onclick = () => {
  const t = new Date();
  exportZip($('#setExport'), docs, true, `نسخة ${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`);
};

/* ---------- البدء ---------- */
(async () => {
  db = await openDB();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await refresh();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
