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
  MAX_ADAY: 6,     // en fazla kaç aday video için kaynak çekilsin
  MAX_SORGU: 7     // en fazla kaç arama yapılsın
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
  return withTimeout(fetch(url, { headers: headers || pageHeaders() }), 10000).then(function (res) {
    var cookie = '';
    try {
      var sc = res.headers && res.headers.get && res.headers.get('set-cookie');
      var m = String(sc || '').match(/video_key=([^;,\s]+)/);
      if (m) cookie = m[1];
    } catch (e) {}
    return withTimeout(res.text(), 10000).then(
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
 'remastered', 'proper', 'repack', '3dfi', 'yify', 'rarbg', 'mkv', 'mp4', 'avi', 'hdr']
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
  var toks = asciiLower(title).split(/[^a-z0-9]+/).filter(Boolean);
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
    if (NOISE[t]) { info.tags[t] = 1; return; }
    if (/^\d{1,2}$/.test(t)) { info.nums.push(parseInt(t, 10)); return; }
    if (ROMAN[t]) { info.nums.push(ROMAN[t]); return; }
    if (STOP_WORDS[t]) return;
    info.words.push(t);
  });
  return info;
}

function nameMatch(info, wants) {
  for (var i = 0; i < wants.length; i++) {
    var sw = sigTokens(wants[i]), ww = sw.words;
    if (!ww.length) continue;
    var covered = ww.every(function (w) {
      return info.bag.some(function (b) { return looseEq(w, b); });
    });
    if (!covered) continue;
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

function langLabel(info) {
  var t = info.tags;
  var tr = t.tr || t.turkce || t.turkish || t.dublaj || t.dublajli || t.trdub;
  var en = t.en || t.eng;
  var ar = t.ar || t.arabic || t.arapca;
  var sub = t.altyazi || t.altyazili || t.sub || t.subs;
  if (t.dual) return tr ? 'TR+EN Dual' : 'Dual';
  if (tr && en) return 'TR+EN';
  if (tr) return sub ? 'TR Altyazı' : 'TR';
  if (ar) return 'AR';
  if (en) return 'EN';
  return '?';
}

// Puanlama: null = ele, yoksa { score, info }
function rankItem(item, ctx) {
  var info = analyze(item.title);
  if (info.imdb && ctx.imdb && info.imdb !== ctx.imdb) return null;       // başka filmin IMDb numarası
  var imdbOk = !!(info.imdb && info.imdb === ctx.imdb);
  var nameOk = nameMatch(info, ctx.wants);
  if (!imdbOk && !nameOk) return null;

  var score = 0;
  if (imdbOk) score += 100;
  if (nameOk) score += 20;

  if (info.years.length && ctx.year) {
    var yd = 99;
    info.years.forEach(function (y) { yd = Math.min(yd, Math.abs(y - ctx.year)); });
    if (yd === 0) score += 30;
    else if (yd === 1) score += 15;
    else if (!imdbOk) return null;                                        // farklı yıl = devam filmi/başka film
    else score -= 10;
  }

  if (item.dur) {
    if (ctx.runtime) {
      var r = item.dur / (ctx.runtime * 60), d = Math.abs(r - 1);
      if (d <= 0.06) score += 25;
      else if (d <= 0.15) score += 10;
      else if (d <= 0.3) score += 0;                                      // uzatılmış/kısaltılmış kurgu
      else if (info.part && r >= 0.25 && r <= 0.75) score += 0;           // CD1/CD2 parçası
      else return null;                                                   // fragman, kesit, özet
    } else if (item.dur < 1500) {
      return null;
    }
  }

  var lang = langLabel(info);
  if (lang === 'TR' || lang === 'TR+EN Dual' || lang === 'TR+EN' || lang === 'TR Altyazı' || lang === 'Dual') score += 8;
  if (lang === 'AR') score -= 5;
  if (info.res >= 2160) score += 4; else if (info.res >= 1080) score += 3; else if (info.res >= 720) score += 2;

  if (score < 40) return null;
  return { score: score, info: info, lang: lang };
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

function searchOnce(q, tag) {
  var enc = encodeURIComponent(q);
  return getRaw(AYAR.MOBILE + '/video/search?st=search&q=' + enc, null, 'S' + tag).then(function (r) {
    var items = r.ok ? parseSearch(r.text) : [];
    if (items.length) return items;
    return getRaw(AYAR.SITE + '/video/search?st=search&q=' + enc, null, 'D' + tag).then(function (r2) {
      return r2.ok ? parseSearch(r2.text) : [];
    });
  });
}

// ---------------- Video kaynağı ----------------

function jsonHeaders(pageUrl) {
  return pageHeaders({ 'Accept': 'application/json, text/plain, */*', 'Referer': pageUrl, 'X-Requested-With': 'XMLHttpRequest' });
}

function fetchMeta(item) {
  var pageUrl = AYAR.SITE + item.path;

  function fromMeta(url) {
    return getRaw(url, jsonHeaders(pageUrl), null).then(function (r) {
      if (!r.ok || !r.text) return null;
      var data;
      try { data = JSON.parse(r.text); } catch (e) { return null; }
      var vids = (data && data.videos) || [];
      if (!vids.length) return null;
      return { videos: vids, cookie: r.cookie, meta: data.meta || {} };
    });
  }

  var first = item.id ? fromMeta(AYAR.SITE + '/+/video/meta/' + item.id) : Promise.resolve(null);
  return first.then(function (m) {
    if (m) return m;
    // yedek: video sayfasından meta adresini / doğrudan <video src> bul
    return getRaw(pageUrl, null, null).then(function (r) {
      var html = r.text || '';
      var mu = (html.match(/data-meta-url="([^"]+)"/) || html.match(/["']metaUrl["']\s*:\s*["']([^"']+)["']/) || [])[1];
      if (mu) return fromMeta(decodeHtml(mu).replace(/\\\//g, '/'));
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
  if (vids.length > 1 && vids[vids.length - 1].h !== vids[0].h) picks.push(vids[vids.length - 1]);

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

function buildQueries(imdb, year, titles) {
  var qs = [imdb];
  titles.slice(0, 3).forEach(function (t) { qs.push(t + ' ' + year); });
  titles.slice(0, 2).forEach(function (t) { qs.push(t.replace(/[:\-–—!?,.'"’&]+/g, ' ').replace(/\s+/g, '.') + '.' + year); });
  titles.slice(0, 2).forEach(function (t) { qs.push(t); });
  return uniq(qs.map(function (q) { return String(q || '').replace(/\s+/g, ' ').trim(); }).filter(function (q) { return q.length >= 3; }))
    .slice(0, AYAR.MAX_SORGU);
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType !== 'movie') return Promise.resolve([]);
  dbg = [];
  var base = 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=' + TMDB_KEY;

  return Promise.all([
    getJson(base + '&language=tr-TR&append_to_response=alternative_titles'),
    getJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (both) {
    var info = both[0], en = both[1] || {};
    var year = parseInt((info.release_date || '').slice(0, 4), 10) || 0;
    if (!info.title && !info.original_title) return debugStream('TMDB bilgisi eksik');

    var alts = [];
    try {
      ((info.alternative_titles && info.alternative_titles.titles) || []).forEach(function (a) {
        if (a && a.title && /^(TR|US|GB)$/.test(a.iso_3166_1 || '')) alts.push(a.title);
      });
    } catch (e) {}
    var titles = uniq([info.original_title, en.title, info.title]);
    var wants = uniq(titles.concat(alts.slice(0, 5)));
    var ctx = { imdb: info.imdb_id || '', year: year, runtime: info.runtime || en.runtime || 0, wants: wants };
    dbg.push('film ' + (info.original_title || info.title) + ' ' + year + ' ' + (ctx.imdb || '-') + ' ' + ctx.runtime + 'dk');

    var queries = buildQueries(ctx.imdb, year, titles);
    return Promise.all(queries.map(function (q, i) { return searchOnce(q, i + 1); })).then(function (lists) {
      var seen = {}, all = [];
      lists.forEach(function (l) {
        l.forEach(function (it) { if (!seen[it.path]) { seen[it.path] = true; all.push(it); } });
      });
      dbg.push('sonuc ' + all.length);

      var ranked = [], rejected = 0;
      all.forEach(function (it) {
        var r = rankItem(it, ctx);
        if (r) ranked.push({ item: it, r: r });
        else { rejected++; if (rejected <= 4) dbg.push('red ' + it.title.slice(0, 38)); }
      });
      ranked.sort(function (a, b) { return b.r.score - a.r.score; });
      dbg.push('aday ' + ranked.length);
      if (!ranked.length) return debugStream('uygun video yok: ' + (info.title || info.original_title) + ' ' + year);

      var top = ranked.slice(0, AYAR.MAX_ADAY);
      return Promise.all(top.map(function (x) {
        return fetchMeta(x.item).catch(function () { return null; });
      })).then(function (metas) {
        var streams = [], seenUrl = {};
        top.forEach(function (x, i) {
          if (!metas[i]) { dbg.push('meta yok ' + x.item.path); return; }
          makeStreams(x.item, x.r, metas[i]).forEach(function (s) {
            if (!seenUrl[s.url]) { seenUrl[s.url] = true; streams.push(s); }
          });
        });
        if (!streams.length) return debugStream('kaynak cikmadi');
        return streams;
      });
    });
  }).catch(function (e) { return debugStream('hata ' + (e && e.message)); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams, _t: { parseSearch: parseSearch, analyze: analyze, rankItem: rankItem, nameMatch: nameMatch, sigTokens: sigTokens, looseEq: looseEq, buildQueries: buildQueries } };
} else {
  global.getStreams = getStreams;
}
