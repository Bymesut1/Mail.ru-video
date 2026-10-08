// ============================================================
//  mailru — Nuvio scraper (my.mail.ru/video, kullanıcı yüklemeleri)
//  Akış: TMDB bilgisi -> mail.ru araması -> aday eleme/puanlama
//        -> video meta JSON -> mp4 linkleri
// ============================================================

var AYAR = {
  SITE: 'https://my.mail.ru',
  MOBILE: 'https://m.my.mail.ru',
  EKLENTI_ADI: 'mail.ru',
  // true iken akış çıkmazsa neden çıkmadığını yazan "DEBUG" satırları görünür. Her şey çalışınca false yap.
  DEBUG_MODU: false,
  MAX_ADAY: 8,     // en fazla kaç aday video için kaynak çekilsin
  MAX_SORGU: 14,   // en fazla kaç arama yapılsın
  MAX_SAYFA: 1,    // çok sonuç dönen aramalarda en fazla kaç ek sayfa okunsun
  BELIRSIZ_GOSTER: false, // dili doğrulanamayan (etiketsiz / sadece Dual) adaylar "Dil ?" etiketiyle en sona eklensin
  MAX_BELIRSIZ: 3, // etiketsiz/Dual adaylardan en fazla kaçının ses parçası kontrol edilsin
  ARAMA_SURESI: 4500,  // ms: arama aşaması en geç bu sürede biter (bitmeyenler atlanır)
  GENEL_SURE: 9000,    // ms: toplam üst sınır
  KAYNAK_SURESI: 3000  // ms: kaynak çekme aşaması en geç bu sürede biter
};

// Türkçe adı TMDB'de görünmeyen / farklı yazılan filmler: orijinal ad (harf-rakam, küçük) -> Türkçe adlar
var TR_ALIAS = {
  'nationaltreasure': ['Harbi Define'],
  'nationaltreasurebookofsecrets': ['Harbi Define 2'],
  'thebutterflyeffect': ['Kelebek Etkisi'],
  'thebutterflyeffect2': ['Kelebek Etkisi 2'],
  'thebutterflyeffect3revelations': ['Kelebek Etkisi 3'],
  'themummy': ['Mumya'],
  'themummyreturns': ['Mumya Geri Dönüyor', 'Mumya 2'],
  'themummytombofthedragonemperor': ['Mumya 3', 'Mumya Ejderha İmparatorunun Mezarı'],
  'diehard': ['Zor Ölüm'],
  'diehard2': ['Zor Ölüm 2'],
  'diehardwithavengeance': ['Zor Ölüm 3'],
  'livefreeordiehard': ['Zor Ölüm 4', 'Zor Ölüm 4.0'],
  'agooddaytodiehard': ['Zor Ölüm 5'],
  'insidious': ['Ruhlar Bölgesi'],
  'insidiouschapter2': ['Ruhlar Bölgesi Bölüm 2', 'Ruhlar Bölgesi 2'],
  'insidiouschapter3': ['Ruhlar Bölgesi Bölüm 3', 'Ruhlar Bölgesi 3'],
  'insidiousthelastkey': ['Ruhlar Bölgesi Son Anahtar', 'Ruhlar Bölgesi 4'],
  'insidioustheredddoor': ['Ruhlar Bölgesi Kırmızı Kapı', 'Ruhlar Bölgesi 5'],
  'insidiousthereddoor': ['Ruhlar Bölgesi Kırmızı Kapı', 'Ruhlar Bölgesi 5']
};

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';
var PROVIDER_ID = 'mailru';
var ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';

var dbg = [];
function log(m) { try { console.log('[mailru] ' + m); } catch (e) {} }

// ---------------- Yardımcılar ----------------

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); },
                 function (e) { clearTimeout(t); reject(e); });
  });
}

function pageHeaders(extra) {
  var h = {
    'User-Agent': ANDROID_UA,
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,tr;q=0.8,en;q=0.7',
    'Referer': AYAR.SITE + '/video'
  };
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}

// { status, ok, text, cookie }  — cookie: yanıttaki video_key (varsa)
function getRaw(url, headers, label) {
  return withTimeout(fetch(url, { headers: headers || pageHeaders() }), 5000).then(function (res) {
    var cookie = '';
    try {
      var sc = res.headers && res.headers.get && res.headers.get('set-cookie');
      var m = String(sc || '').match(/video_key=([^;,\s]+)/);
      if (m) cookie = m[1];
    } catch (e) {}
    return withTimeout(res.text(), 5000).then(
      function (t) { return { status: res.status, ok: res.ok, text: t || '', cookie: cookie }; },
      function () { return { status: res.status, ok: false, text: '', cookie: cookie }; }
    );
  }).catch(function (e) {
    return { status: 0, ok: false, text: '', cookie: '', err: (e && e.message) || 'hata' };
  }).then(function (r) {
    if (label) dbg.push(label + ' ' + (r.status || r.err || '?') + '/' + r.text.length);
    return r;
  });
}

function getJson(url) {
  return withTimeout(fetch(url), 10000).then(function (res) { return res.json(); });
}

function decodeHtml(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

var TR_MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function asciiLower(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase()
    .replace(/[çğıöşüâîû]/g, function (c) { return TR_MAP[c]; });
}
function norm(s) { return asciiLower(s).replace(/[^a-z0-9]/g, ''); }
// Türkçe harfleri sadeleştir (büyük/küçük harf korunur): "Zor Ölüm" -> "Zor Olum"
var TR_PLAIN = { 'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I', 'ö': 'o', 'Ö': 'O', 'ş': 's', 'Ş': 'S', 'ü': 'u', 'Ü': 'U' };
function plain(s) { return String(s || '').replace(/[çÇğĞıİöÖşŞüÜ]/g, function (c) { return TR_PLAIN[c]; }); }
// Ünsüz iskeleti: "Captain Phillips" ~ "Kptn.Phlps" (yükleyen kısaltmış)
function skel(s) {
  return asciiLower(s).replace(/[^a-z0-9]/g, '').replace(/c/g, 'k').replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1');
}
function hasTrChars(s) { return /[çğışöüÇĞİŞÖÜ]/.test(String(s || '')); }
// Hepsi bitince ya da süre dolunca devam et (biten sonuçlar kullanılır, bitmeyenler atlanır)
function waitWithin(promises, ms) {
  return new Promise(function (resolve) {
    var left = promises.length, done = false;
    if (!left) { resolve(); return; }
    var t = setTimeout(function () { if (!done) { done = true; resolve(); } }, ms);
    promises.forEach(function (p) {
      p.then(function () {}, function () {}).then(function () {
        left--;
        if (left === 0 && !done) { done = true; clearTimeout(t); resolve(); }
      });
    });
  });
}
// En az `need` iş bitince (ya da hepsi bitince / süre dolunca) devam et
function waitSome(promises, need, ms) {
  return new Promise(function (resolve) {
    var n = promises.length, finished = 0, done = false;
    if (!n) { resolve(); return; }
    need = Math.min(need, n);
    var t = setTimeout(function () { if (!done) { done = true; resolve(); } }, ms);
    promises.forEach(function (p) {
      p.then(function () {}, function () {}).then(function () {
        finished++;
        if (finished >= need && !done) { done = true; clearTimeout(t); resolve(); }
      });
    });
  });
}
function aliasNames(list) {
  var out = [];
  list.forEach(function (t) { var a = TR_ALIAS[norm(t)]; if (a) out = out.concat(a); });
  return uniq(out);
}

function uniq(list) {
  var out = [];
  list.forEach(function (x) { if (x && out.indexOf(x) === -1) out.push(x); });
  return out;
}

function lev(a, b) {
  if (a === b) return 0;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    for (j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
// "future" ~ "furure" (yükleyenin yazım hatası): 5+ harfli kelimelerde 1 harf farkı kabul
function looseEq(a, b) {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1;
}

// ---------------- Başlık analizi ----------------

var STOP_WORDS = { the: 1, a: 1, an: 1, of: 1, and: 1, ve: 1, ile: 1, film: 1, filmi: 1, izle: 1, movie: 1 };
var ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
var NOISE = {};
['bluray', 'brrip', 'bdrip', 'webrip', 'webdl', 'web', 'dl', 'hdrip', 'hdtv', 'dvdrip', 'x264', 'x265', 'h264', 'h265',
 'hevc', 'aac', 'ac3', 'dts', 'dual', 'tr', 'en', 'eng', 'turkce', 'turkish', 'trdub', 'dublaj', 'dublajli', 'altyazi',
 'altyazili', 'sub', 'subs', 'full', 'hd', 'fhd', 'uhd', 'multi', 'ar', 'arabic', 'arapca', 'imax', 'extended',
 'remastered', 'proper', 'repack', '3dfi', 'yify', 'rarbg', 'mkv', 'mp4', 'avi', 'hdr', 'english', 'ingilizce', 'dub',
 'subtitle', 'subtitles', 'bluray1080p', 'hd1080p', 'video', 'tek', 'parca', 'part']
  .forEach(function (w) { NOISE[w] = 1; });

// Aranan başlıktan anlamlı kelimeler (TMDB tarafı)
function sigTokens(s) {
  var words = [], nums = [];
  asciiLower(s).split(/[^a-z0-9]+/).forEach(function (t) {
    if (!t) return;
    if (/^\d{1,2}$/.test(t)) { nums.push(parseInt(t, 10)); return; }
    if (ROMAN[t]) { nums.push(ROMAN[t]); return; }
    if (STOP_WORDS[t]) return;
    words.push(t);
  });
  return { words: words, nums: nums };
}

// Yüklenen dosya adı: tt0088763.Back.to.the.Future.Part.I.1985.1080p.TR.dual
function analyze(title) {
  var toks = [];
  asciiLower(title).split(/[^a-z0-9]+/).filter(Boolean).forEach(function (t) {
    // "2trdub", "2013tr", "trdub2" gibi rakama yapışık etiketleri ayır
    var m = t.match(/^(\d{1,4})(tr|trdub|trdublaj|dublaj|dual|turkce|altyazi|altyazili)$/) ||
            t.match(/^(tr|trdub|trdublaj|dublaj|dual|turkce)(\d{1,2})$/);
    if (m) { toks.push(m[1]); toks.push(m[2]); } else toks.push(t);
  });
  var info = { imdb: '', years: [], res: 0, tags: {}, words: [], nums: [], part: 0, bag: toks };
  toks.forEach(function (t) {
    var m;
    if (/^tt\d{6,9}$/.test(t)) { info.imdb = t; return; }
    if (/^(19|20)\d{2}$/.test(t)) { info.years.push(parseInt(t, 10)); return; }
    m = t.match(/^(2160|1080|720|480|360)p$/);
    if (m) { info.res = Math.max(info.res, parseInt(m[1], 10)); return; }
    if (t === '4k') { info.res = Math.max(info.res, 2160); return; }
    m = t.match(/^(?:cd|disc|disk|pt|part|kisim)(\d)$/);
    if (m) { info.part = parseInt(m[1], 10); return; }
    if (NOISE[t] || /dublaj|turkce|altyaz|dual/.test(t)) { info.tags[t] = 1; return; }
    if (/^\d{1,2}$/.test(t)) { info.nums.push(parseInt(t, 10)); return; }
    if (ROMAN[t]) { info.nums.push(ROMAN[t]); return; }
    if (STOP_WORDS[t]) return;
    info.words.push(t);
  });
  info.joined = toks.join('');
  return info;
}

function nameMatch(info, wants) {
  for (var i = 0; i < wants.length; i++) {
    var sw = sigTokens(wants[i]), ww = sw.words;
    if (!ww.length) continue;
    var covered = ww.every(function (w) {
      return info.bag.some(function (b) { return looseEq(w, b); });
    });
    if (!covered) {
      // bitişik yazım: "SpiderMan.Homecoming" ~ "Spider-Man: Homecoming"
      var wn = norm(wants[i]);
      if (wn.length >= 6 && info.joined && info.joined.indexOf(wn) > -1) return true;
      continue;
    }
    // kısa başlıklar ("Up", "It"): dosya adı başka kelimelerle dolu ise başka film olabilir
    if (ww.length <= 2 && info.words.length > ww.length * 3) continue;
    // sıra numarası çakışıyorsa (Taken 2 / Taken 3) reddet
    if (sw.nums.length && info.nums.length) {
      var common = sw.nums.some(function (n) { return info.nums.indexOf(n) > -1; });
      if (!common) continue;
    }
    return true;
  }
  return false;
}

// Kısmi ad eşleşmesi: aranan kelimelerin en az yarısı (içinde 5+ harfli biri) dosya adında geçiyor.
// Sadece yıl TAM tutuyor ve süre ±%6 içindeyse kabul edilir (Yenilmezler: Endgame ~ Yenilmezler Son Oyun).
function partialName(info, wants) {
  for (var i = 0; i < wants.length; i++) {
    var ww = sigTokens(wants[i]).words;
    if (!ww.length) continue;
    var hit = 0, long = false;
    ww.forEach(function (w) {
      if (info.bag.some(function (b) { return looseEq(w, b); })) { hit++; if (w.length >= 5) long = true; }
    });
    if (long && hit / ww.length >= 0.5) return true;
  }
  return false;
}

// Ünsüz iskeleti eşleşmesi (Kptn.Phlps ~ Captain Phillips). Sadece yıl TAM + süre ±%6 ise kabul edilir.
function skelMatch(info, wants) {
  var js = skel(info.joined || '');
  for (var i = 0; i < wants.length; i++) {
    var ww = sigTokens(wants[i]).words;
    if (!ww.length) continue;
    var sk = skel(ww.join(''));
    if (sk.length >= 6 && js.indexOf(sk) > -1) return true;
  }
  return false;
}

// Ses parçası bilgisinde Türkçe geçiyor mu (mail.ru meta JSON'unda ses/dil alanları)
function metaTurkishAudio(m) {
  var found = false, KEY = /audio|track|dub|voice|sound|language/i, VAL = /^(tr|tur|trk|turkish|turkce|türkçe)$/i;
  function walk(o, key, depth) {
    if (found || o === null || o === undefined || depth > 6) return;
    if (typeof o === 'string') { if (key && VAL.test(o.trim())) found = true; return; }
    if (typeof o !== 'object') return;
    Object.keys(o).forEach(function (k) {
      if (k === 'videos') return;
      walk(o[k], KEY.test(k) ? k : key, depth + 1);
    });
  }
  try { walk((m && m.raw) || (m && m.meta) || {}, '', 0); } catch (e) {}
  return found;
}

// Dil etiketi. Sadece TÜRKÇE SES kabul edilir:
//   TR / TR Dublaj / Türkçe Dublaj / TR Dual  -> ok (tier 0)
//   TR Altyazı (ses orijinal), sadece Dual, EN, RU, AR, ... -> ok değil
function langInfo(info) {
  var keys = Object.keys(info.tags).concat(info.bag);
  function any(re) { return keys.some(function (k) { return re.test(k); }); }
  var tr = any(/^tr$|^trk$|turkce|turkish|dublaj|^trdub/);
  var dual = any(/dual/);
  var dublaj = any(/dublaj|^trdub/);
  var sub = any(/altyaz|^sub$|^subs$|subtitle/);
  var foreign = any(/^(rus|russian|rusca|ru|ukr|ukrainian|ger|german|deu|fre|french|fra|spa|spanish|ita|italian|hin|hindi|kor|korean|jpn|japanese|chi|chinese|pol|por|arabic|ar|arapca|farsi|persian)$/);
  var en = any(/^en$|^eng$|^english$|ingilizce/);
  if (tr && dublaj) return { label: 'TR Dublaj', tier: 0, ok: true, foreign: foreign, sub: sub, en: en };
  if (tr && dual) return { label: 'TR Dual', tier: 0, ok: true, foreign: foreign, sub: sub, en: en };
  if (tr && sub) return { label: 'TR Altyazı', tier: 5, ok: false, foreign: foreign, sub: true, en: en };
  if (tr) return { label: 'TR', tier: 0, ok: true, foreign: foreign, sub: sub, en: en };
  return { label: dual ? 'Dual' : sub ? 'Altyazı' : foreign ? 'Yabancı' : en ? 'EN' : '?', tier: 5, ok: false, foreign: foreign, sub: sub, en: en };
}

// Puanlama: null = ele, yoksa { score, info }
function rankItem(item, ctx) {
  var info = analyze(item.title);
  if (info.imdb && ctx.imdb && info.imdb !== ctx.imdb) return null;       // başka filmin IMDb numarası
  var imdbOk = !!(info.imdb && info.imdb === ctx.imdb);
  var nameOk = nameMatch(info, ctx.wants);
  var partial = false, skelOk = false;
  if (!imdbOk && !nameOk) {
    if (partialName(info, ctx.wants)) partial = true;
    else if (skelMatch(info, ctx.wants)) skelOk = true;
    else return null;
  }
  var loose = partial || skelOk;   // zayıf ad eşleşmesi: yıl + süre şart

  var score = 0;
  if (imdbOk) score += 100;
  if (nameOk) score += 20;
  if (loose) score += 10;

  if (info.years.length && ctx.year) {
    var yd = 99;
    info.years.forEach(function (y) { yd = Math.min(yd, Math.abs(y - ctx.year)); });
    if (loose && yd !== 0) return null;
    if (yd === 0) score += 30;
    else if (yd === 1) score += 15;
    else if (!imdbOk) return null;                                        // farklı yıl = devam filmi/başka film
    else score -= 10;
  }

  if (item.dur) {
    if (ctx.runtime) {
      var r = item.dur / (ctx.runtime * 60), d = Math.abs(r - 1);
      if (loose && d > 0.06) return null;
      if (d <= 0.06) score += 25;
      else if (d <= 0.15) score += 10;
      else if (d <= 0.3) score += 0;                                      // uzatılmış/kısaltılmış kurgu
      else if (info.part && r >= 0.25 && r <= 0.75) score += 0;           // CD1/CD2 parçası
      else return null;                                                   // fragman, kesit, özet
    } else if (item.dur < 1500) {
      return null;
    }
  }

  if (loose && (!item.dur || !info.years.length)) return null;         // zayıf eşleşme: yıl ve süre ŞART
  var li = langInfo(info);
  if (/[\u0400-\u04FF]/.test(item.title) && !li.ok) return null;       // Rusça (Kiril) başlık
  var maybe = false;
  if (!li.ok) {
    var clean = !li.foreign && !li.sub && !li.en;                        // başka dil / altyazı / EN etiketi yok
    var trNameOk = !!(ctx.trWants && ctx.trWants.length && nameMatch(info, ctx.trWants));
    var trChars = hasTrChars(item.title);
    if (clean && li.label === '?' && (trNameOk || trChars)) {
      // Etiket yok ama Türkçe adla ya da Türkçe harflerle yazılmış: Türkçe say
      // (yıl yoksa süre ±%8 içinde olmalı; başka filmle karışmasın)
      var rr = (ctx.runtime && item.dur) ? Math.abs(item.dur / (ctx.runtime * 60) - 1) : 1;
      if (!imdbOk && !info.years.length && rr > 0.08) return null;
      li = { label: trChars ? 'TR Yazı' : 'TR Ad', tier: 1, ok: true };
    } else if (clean && (li.label === '?' || li.label === 'Dual') && (imdbOk || nameOk)) {
      maybe = true;                                                      // ses parçası meta bilgisinden doğrulanacak
      li = { label: 'TR Ses', tier: 2, ok: true };
    } else return null;                                                  // EN / RU / AR / altyazılı
  }
  if (info.res >= 2160) score += 4; else if (info.res >= 1080) score += 3; else if (info.res >= 720) score += 2;

  if (score < 40) return null;
  return { score: score, info: info, lang: li.label, tier: li.tier, maybe: maybe };
}

// ---------------- Arama sonucu ayrıştırma ----------------

function parseDuration(s) {
  var p = String(s || '').trim().split(':');
  if (p.length < 2 || p.length > 3) return 0;
  var n = 0;
  for (var i = 0; i < p.length; i++) n = n * 60 + (parseInt(p[i], 10) || 0);
  return n;
}

function parseSearch(html) {
  var out = [], chunks = String(html || '').split(/<li class="list-item/);
  var i, c;
  for (i = 1; i < chunks.length; i++) {
    c = chunks[i];
    var path = (c.match(/my\.mail\.ru(\/[^"'#\s:?]*?\/video\/[^"'#\s:?]*?\/\d+\.html)/) || [])[1];
    if (!path) continue;
    out.push({
      path: path,
      id: (c.match(/\/\+\/video\/(?:url|meta)\/(?:[a-z0-9]+\/)?(\d{10,})/) || [])[1] || '',
      durText: (c.match(/list-item__duration">\s*([0-9:]+)/) || [])[1] || '',
      dur: parseDuration((c.match(/list-item__duration">\s*([0-9:]+)/) || [])[1]),
      title: decodeHtml((c.match(/list-item__title[^"]*">\s*([^<]+)/) || [])[1] || '').trim()
    });
  }
  if (out.length) return out;
  // yedek: başka yerleşim (masaüstü) — bağlantı metninden başlık
  var re = /href="(?:https?:\/\/(?:m\.)?my\.mail\.ru)?(\/[^"#?]*\/video\/[^"#?]*\/\d+\.html)[^"]*"[^>]*>\s*([^<]{3,})</g, m;
  while ((m = re.exec(String(html || ''))) !== null) {
    out.push({ path: m[1], id: '', durText: '', dur: 0, title: decodeHtml(m[2]).trim() });
  }
  return out;
}

// Çok sonuç dönen aramalarda "Show more" bağlantısını izleyip ek sayfaları da oku
function morePages(html, items, left, tag, sink) {
  if (left <= 0 || items.length < 30) return Promise.resolve(items);
  var href = (String(html || '').match(/show-more[^>]*\shref="([^"]+)"/) || [])[1];
  if (!href) return Promise.resolve(items);
  var url = decodeHtml(href);
  if (url.indexOf('//') === 0) url = 'https:' + url;
  return getRaw(url, null, 'P' + tag).then(function (r) {
    var more = r.ok ? parseSearch(r.text) : [];
    if (!more.length) return items;
    if (sink) sink.push.apply(sink, more);
    return morePages(r.text, items.concat(more), left - 1, tag, sink);
  });
}

// Bulunan sonuçlar hemen `sink` listesine yazılır (süre dolsa bile biten kısım kullanılır)
function searchOnce(q, tag, pages, sink) {
  var enc = encodeURIComponent(q);
  return getRaw(AYAR.MOBILE + '/video/search?st=search&q=' + enc, null, 'S' + tag).then(function (r) {
    var items = r.ok ? parseSearch(r.text) : [];
    if (items.length) {
      sink.push.apply(sink, items);
      return pages > 0 ? morePages(r.text, items, pages, tag, sink) : items;
    }
    return getRaw(AYAR.SITE + '/video/search?st=search&q=' + enc, null, 'D' + tag).then(function (r2) {
      var it2 = r2.ok ? parseSearch(r2.text) : [];
      sink.push.apply(sink, it2);
      return it2;
    });
  });
}

// ---------------- Video kaynağı ----------------

function jsonHeaders(pageUrl) {
  return pageHeaders({ 'Accept': 'application/json, text/plain, */*', 'Referer': pageUrl, 'X-Requested-With': 'XMLHttpRequest' });
}

function fetchMeta(item) {
  var pageUrl = AYAR.SITE + item.path;

  function fromMeta(url, lbl) {
    return getRaw(url, jsonHeaders(pageUrl), lbl).then(function (r) {
      if (!r.ok || !r.text) return null;
      var data;
      try { data = JSON.parse(r.text); } catch (e) { return null; }
      var vids = (data && data.videos) || [];
      if (!vids.length) return null;
      return { videos: vids, cookie: r.cookie, meta: data.meta || {}, raw: data };
    });
  }

  var first = item.id ? fromMeta(AYAR.SITE + '/+/video/meta/' + item.id, 'M' + item.id.slice(-4)) : Promise.resolve(null);
  return first.then(function (m) {
    if (m) return m;
    // yedek: video sayfasından meta adresini / doğrudan <video src> bul
    return getRaw(pageUrl, null, 'PG').then(function (r) {
      var html = r.text || '';
      var mu = (html.match(/data-meta-url="([^"]+)"/) || html.match(/["']metaUrl["']\s*:\s*["']([^"']+)["']/) || [])[1];
      if (!mu) {
        var xid = (html.match(/\/\+\/video\/meta\/(?:[a-z0-9]+\/)?(\d{8,})/) || html.match(/["']externalId["']\s*:\s*["']?(\d{8,})/) || [])[1];
        if (xid) return fromMeta(AYAR.SITE + '/+/video/meta/' + xid, 'MX');
      }
      if (mu) return fromMeta(decodeHtml(mu).replace(/\\\//g, '/'), 'MU');
      var vm = html.match(/<video[^>]+\ssrc="((?:https?:)?\/\/[^"]+)"/i);
      if (vm) return { videos: [{ url: decodeHtml(vm[1]), key: '' }], cookie: '', meta: {} };
      return null;
    });
  });
}

function heightOf(key) {
  var m = String(key || '').match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function fmtDur(sec) {
  if (!sec) return '';
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return (h ? h + ':' + p(m) : m) + ':' + p(s);
}

function makeStreams(item, ranked, meta) {
  var vids = meta.videos.map(function (v) {
    var u = decodeHtml(String(v.url || '')).replace(/\\\//g, '/');
    if (u.indexOf('//') === 0) u = 'https:' + u;
    return { url: u, key: v.key || '', h: heightOf(v.key) };
  }).filter(function (v) { return /^https?:\/\//.test(v.url); });
  vids.sort(function (a, b) { return b.h - a.h; });
  if (!vids.length) return [];

  // en yüksek kalite + (varsa) en düşük kalite
  var picks = [vids[0]];
  if (ranked.tier <= 1 && vids.length > 1 && vids[vids.length - 1].h !== vids[0].h) picks.push(vids[vids.length - 1]);

  var parts = ['mail.ru', ranked.lang];
  if (ranked.info.part) parts.push('Part ' + ranked.info.part);
  var dur = fmtDur(item.dur);
  return picks.map(function (v) {
    var headers = { 'User-Agent': ANDROID_UA, 'Referer': AYAR.SITE + '/' };
    if (meta.cookie && v.url.indexOf('video_key=') === -1) headers['Cookie'] = 'video_key=' + meta.cookie;
    var label = parts.concat([v.key || (ranked.info.res ? ranked.info.res + 'p' : 'Auto')]);
    if (dur) label.push(dur);
    return {
      name: AYAR.EKLENTI_ADI,
      title: label.join(' | '),
      url: v.url,
      quality: v.key || 'Auto',
      type: 'mp4',
      headers: headers,
      provider: PROVIDER_ID
    };
  });
}

// ============================================================
//  NUVIO GİRİŞ NOKTASI
// ============================================================

function debugStream(msg) {
  if (!AYAR.DEBUG_MODU) return [];
  return [msg].concat(dbg.slice(0, 40)).map(function (r) {
    return { name: 'DEBUG ' + r, title: 'DEBUG ' + r, url: 'https://debug.invalid/', quality: 'Auto', provider: PROVIDER_ID };
  });
}

function dotted(s) { return String(s || '').replace(/[:\-–—!?,.'"’&]+/g, ' ').trim().replace(/\s+/g, '.'); }

// Sorgular (öncelik sırasıyla; MAX_SORGU kadarı kullanılır)
function buildQueries(imdb, year, titles, trTitles) {
  var qs = [], y = year ? ' ' + year : '', dy = year ? '.' + year : '';
  var tr1 = (trTitles || [])[0] || '', tr2 = (trTitles || [])[1] || '';
  var t0 = titles[0] || '', t1 = titles[1] || '', t2 = titles[2] || '';
  function add(q) { if (q) qs.push(q); }
  add(imdb);
  add(tr1 && tr1 + y);
  add(t0 && t0 + y);
  add(tr1 && tr1 + ' Türkçe Dublaj');
  add(t0 && t0 + ' Türkçe Dublaj');
  add(tr1 && plain(tr1) !== tr1 && plain(tr1) + y);        // "Zor Olum 1988"
  add(imdb && t0 && imdb + '.' + dotted(t0) + dy);
  add(t0 && dotted(t0) + dy);
  add(tr1 && dotted(plain(tr1)) + dy);                     // "Zor.Olum.1988"
  add(tr2 && tr2 + y);
  add(t1 && t1 + y);
  add(t0 && t0 + ' TR Dual');
  add(tr1);
  add(tr1 && plain(tr1) !== tr1 && plain(tr1));
  add(t2 && t2 + y);
  add(t0);
  return uniq(qs.map(function (q) { return String(q || '').replace(/\s+/g, ' ').trim(); }).filter(function (q) { return q.length >= 3; }))
    .slice(0, AYAR.MAX_SORGU);
}

function getStreamsInner(tmdbId, mediaType, season, episode) {
  if (mediaType !== 'movie') return Promise.resolve([]);
  dbg = ['v1.3.5'];
  var T0 = Date.now();
  var base = 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=' + TMDB_KEY;

  return Promise.all([
    getJson(base + '&language=tr-TR&append_to_response=alternative_titles,translations'),
    getJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (both) {
    var info = both[0], en = both[1] || {};
    var year = parseInt((info.release_date || '').slice(0, 4), 10) || 0;
    if (!info.title && !info.original_title) return debugStream('TMDB bilgisi eksik');

    var alts = [], trAlts = [];
    try {
      ((info.alternative_titles && info.alternative_titles.titles) || []).forEach(function (a) {
        if (a && a.title && /^(TR|US|GB)$/.test(a.iso_3166_1 || '')) alts.push(a.title);
        if (a && a.title && a.iso_3166_1 === 'TR') trAlts.push(a.title);
      });
    } catch (e) {}
    try {
      ((info.translations && info.translations.translations) || []).forEach(function (t) {
        if (t && t.iso_639_1 === 'tr' && t.data && t.data.title) { alts.push(t.data.title); trAlts.push(t.data.title); }
      });
    } catch (e) {}
    var titles = uniq([info.original_title, en.title, info.title]);
    var aliasTr = aliasNames([info.original_title, en.title, info.title]);   // bilinen Türkçe adlar (Zor Ölüm, Mumya...)
    var wants = uniq(titles.concat(aliasTr).concat(alts.slice(0, 8)));
    var nonTr = [norm(info.original_title), norm(en.title)];
    var trWants = uniq(aliasTr.concat([info.title]).concat(trAlts)).filter(function (t) { return t && nonTr.indexOf(norm(t)) === -1; });
    var ctx = { imdb: info.imdb_id || '', year: year, runtime: info.runtime || en.runtime || 0, wants: wants, trWants: trWants };
    dbg.push('film ' + (info.original_title || info.title) + ' ' + year + ' ' + (ctx.imdb || '-') + ' ' + ctx.runtime + 'dk');

    var queries = buildQueries(ctx.imdb, year, titles, trWants);
    var sinks = queries.map(function () { return []; });
    var jobs = queries.map(function (q, i) { return searchOnce(q, i + 1, i < 4 ? AYAR.MAX_SAYFA : 0, sinks[i]); });
    return waitSome(jobs, 6, AYAR.ARAMA_SURESI).then(function () {
      var seen = {}, all = [];
      sinks.forEach(function (l) {
        l.forEach(function (it) { if (!seen[it.path]) { seen[it.path] = true; all.push(it); } });
      });
      dbg.push('sonuc ' + all.length + ' ' + (Date.now() - T0) + 'ms');

      var ranked = [], rejected = 0;
      all.forEach(function (it) {
        var r = rankItem(it, ctx);
        if (r) ranked.push({ item: it, r: r });
        else { rejected++; if (rejected <= 8) dbg.push('red ' + it.title.slice(0, 38)); }
      });
      ranked.sort(function (a, b) { return (a.r.tier - b.r.tier) || (b.r.score - a.r.score); });
      dbg.push('aday ' + ranked.length);
      if (!ranked.length) return debugStream('uygun video yok: ' + (info.title || info.original_title) + ' ' + year);

      // kesin Türkçe adaylar + (etiketsiz / sadece Dual) birkaç belirsiz aday: bunların ses parçası kontrol edilir
      var sure = ranked.filter(function (x) { return !x.r.maybe; }).slice(0, AYAR.MAX_ADAY);
      var unsure = ranked.filter(function (x) { return x.r.maybe; }).slice(0, AYAR.MAX_BELIRSIZ);
      var top = sure.concat(unsure);
      var metas = top.map(function () { return null; });
      var metaJobs = top.map(function (x, i) {
        return fetchMeta(x.item).then(function (m) { metas[i] = m; }, function () {});
      });
      var tMeta = Date.now();
      return waitWithin(metaJobs.slice(0, sure.length), AYAR.KAYNAK_SURESI)
        .then(function () {
          var kalan = Math.max(700, AYAR.KAYNAK_SURESI - (Date.now() - tMeta));   // belirsizlere de tam süre
          return waitWithin(metaJobs.slice(sure.length), kalan);
        }).then(function () {
        var streams = [], seenUrl = {};
        top.forEach(function (x, i) {
          if (!metas[i]) { dbg.push('meta yok ' + x.item.path); return; }
          if (x.r.maybe) {
            if (metaTurkishAudio(metas[i])) x.r.lang = 'TR Ses';
            else if (AYAR.BELIRSIZ_GOSTER) { x.r.lang = 'Dil ?'; x.r.tier = 3; }
            else { dbg.push('dil belirsiz ' + x.item.title.slice(0, 30)); return; }
          }
          makeStreams(x.item, x.r, metas[i]).forEach(function (s) {
            if (!seenUrl[s.url]) { seenUrl[s.url] = true; streams.push(s); }
          });
        });
        dbg.push('bitti ' + (Date.now() - T0) + 'ms');
        if (!streams.length) return debugStream('kaynak cikmadi');
        return streams;
      });
    });
  }).catch(function (e) { return debugStream('hata ' + (e && e.message)); });
}

// Nuvio'nun süre sınırına takılmamak için genel üst sınır
function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (!done) { done = true; resolve(debugStream('zaman asimi ' + AYAR.GENEL_SURE + 'ms')); }
    }, AYAR.GENEL_SURE);
    getStreamsInner(tmdbId, mediaType, season, episode).then(function (r) {
      if (!done) { done = true; clearTimeout(timer); resolve(r); }
    }, function () {
      if (!done) { done = true; clearTimeout(timer); resolve([]); }
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams, _t: { skelMatch: skelMatch, metaTurkishAudio: metaTurkishAudio, aliasNames: aliasNames, langInfo: langInfo, partialName: partialName, parseSearch: parseSearch, analyze: analyze, rankItem: rankItem, nameMatch: nameMatch, sigTokens: sigTokens, looseEq: looseEq, buildQueries: buildQueries } };
} else {
  global.getStreams = getStreams;
}
