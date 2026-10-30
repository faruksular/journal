/*!
 * Sitem: Nuvio manifest + provider dosyalarını kullanan Lampa eklentisi (final şablon)
 *
 * MANTIK
 *   Nuvio için hazırlanan manifest.json ve providers/*.js dosyaları tek kaynak olur.
 *   Bu eklenti aynı dosyaları okuyup Lampa'da çalıştırır; böylece iki uygulama için
 *   ayrı kod yazmak gerekmez.
 *
 * KURULUM
 *   1) CONFIG bölümünü doldur (manifestUrl, allowedOrigins).
 *   2) Bu dosyayı bir adrese koy, Lampa > Ayarlar > Eklentiler'e adresini ekle.
 *
 * PROVIDER DOSYASINDAN BEKLENEN (Nuvio ile aynı)
 *   module.exports = { getStreams };
 *   async function getStreams(tmdbId, mediaType, season, episode)
 *     // tmdbId: "550", mediaType: "movie" | "tv", season/episode: sayı (filmde undefined)
 *     // dönüş: [ { name, title, quality, url, subtitles: [ { url, lang } ] } ]
 *     // url: doğrudan .m3u8 veya .mp4
 *
 * ÖNEMLİ
 *   - Provider, Lampa içinde tarayıcı ortamında çalışır: sadece standart fetch kullanmalı.
 *   - Sitenin API'si ve video dosyaları şu başlığı göndermeli: Access-Control-Allow-Origin: *
 *   - Tarayıcı Referer/User-Agent gibi başlıkları değiştirmeye izin vermez; stream.headers yok sayılır.
 *   - Güvenlik: provider kodu uzaktan yüklenip çalıştırıldığı için yalnızca allowedOrigins
 *     listesindeki adreslerden yüklenir. Buraya sadece kendi alan adını yaz.
 *   - Bu dosya herkese açık olacağı için içine gizli anahtar koyma.
 */
(function () {
  'use strict';

  // ===================== AYARLAR =====================
  var CONFIG = {
    id: 'sitem',                                          // boşluksuz, küçük harf
    name: 'Sitem',                                        // butonda görünen ad
    manifestUrl: 'https://SITENIZ.com/nuvio/manifest.json',
    allowedOrigins: ['https://SITENIZ.com'],              // kod yalnızca buradan yüklenir
    tmdbKey: '',                                          // boşsa Lampa'nın anahtarı denenir
    timeout: 20000                                        // provider başına en çok bekleme (ms)
  };
  // ====================================================

  if (window['plugin_' + CONFIG.id + '_ready']) return;
  window['plugin_' + CONFIG.id + '_ready'] = true;

  var providers = null; // manifest'ten okunan provider listesi (önbellek)

  // ---------- Küçük yardımcılar ----------
  function originOf(url) {
    var m = /^(https:\/\/[^\/?#]+)/i.exec(url || '');
    return m ? m[1].toLowerCase() : '';
  }

  function allowed(url) {
    var o = originOf(url);
    return !!o && CONFIG.allowedOrigins.some(function (a) {
      return String(a).toLowerCase().replace(/\/$/, '') === o;
    });
  }

  function resolveUrl(base, rel) {
    try { return new URL(rel, base).href; } catch (e) { return ''; }
  }

  function getText(url, ok, fail) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = 15000;
    x.onload = function () {
      if (x.status >= 200 && x.status < 300) ok(x.responseText);
      else fail();
    };
    x.onerror = x.ontimeout = function () { fail(); };
    x.send();
  }

  function qualityNum(label) {
    var m = String(label || '').match(/(\d{3,4})/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function isHttp(u) { return /^https?:\/\//i.test(u || ''); }

  function loading(on, onCancel) {
    try {
      if (!Lampa.Loading) return;
      if (on) Lampa.Loading.start(onCancel || function () {});
      else Lampa.Loading.stop();
    } catch (e) {}
  }

  function notify(text) { Lampa.Noty.show(text); }

  // Belirli sürede cevap vermeyen işlemi boş sonuçla bitirir (takılmayı önler)
  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(fallback); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); },
                   function () { clearTimeout(t); resolve(fallback); });
    });
  }

  var origin = null; // arayüzü açan denetleyici (geri dönüşte buna dönülür)
  var job = 0;       // iptal edilen isteklerin sonucunu yok saymak için sayaç

  // ---------- Manifest ve provider yükleme ----------
  function loadManifest(done) {
    if (providers) return done(providers);
    if (!allowed(CONFIG.manifestUrl)) return done([]);

    getText(CONFIG.manifestUrl, function (text) {
      var list = [];
      try {
        var m = JSON.parse(text);
        (m.scrapers || []).forEach(function (s) {
          if (!s || s.enabled === false || !s.filename) return;
          var url = resolveUrl(CONFIG.manifestUrl, s.filename);
          if (!allowed(url)) return;
          list.push({
            id: s.id,
            name: s.name || s.id,
            types: s.supportedTypes || ['movie', 'tv'],
            url: url,
            api: null
          });
        });
      } catch (e) {}
      providers = list;
      done(list);
    }, function () { done([]); });
  }

  function loadProvider(p, done) {
    if (p.api) return done(p.api);
    if (typeof window.fetch !== 'function') return done(null);

    getText(p.url, function (code) {
      try {
        var mod = { exports: {} };
        var key = CONFIG.tmdbKey || (Lampa.TMDB && Lampa.TMDB.key && Lampa.TMDB.key()) || '';
        var run = new Function('module', 'exports', 'TMDB_API_KEY', 'fetch', code);
        run(mod, mod.exports, key, window.fetch.bind(window));
        p.api = typeof mod.exports.getStreams === 'function' ? mod.exports : null;
      } catch (e) { p.api = null; }
      done(p.api);
    }, function () { done(null); });
  }

  function normalize(list) {
    return (list || [])
      .filter(function (s) { return s && isHttp(s.url); })
      .map(function (s) {
        return {
          group: s.name || s.title || CONFIG.name,
          quality: s.quality || 'Auto',
          url: s.url,
          subtitles: (s.subtitles || [])
            .filter(function (t) { return t && isHttp(t.url); })
            .map(function (t) { return { label: t.lang || t.label || 'Altyazı', url: t.url }; })
        };
      });
  }

  // Tüm provider'lardan akışları toplar
  function collectStreams(tmdbId, type, season, episode, done) {
    loadManifest(function (list) {
      var usable = list.filter(function (p) { return p.types.indexOf(type) !== -1; });
      if (!usable.length) return done([], 0);

      var tasks = usable.map(function (p) {
        return new Promise(function (resolve) {
          loadProvider(p, function (api) {
            if (!api) return resolve([]);
            var call = Promise.resolve()
              .then(function () { return api.getStreams(String(tmdbId), type, season, episode); });
            withTimeout(call, CONFIG.timeout, []).then(function (res) {
              var multi = usable.length > 1;
              resolve(normalize(res).map(function (s) {
                if (multi && s.group.indexOf(p.name) !== 0) s.group = p.name + ' · ' + s.group;
                return s;
              }));
            });
          });
        });
      });

      Promise.all(tasks).then(function (parts) {
        done([].concat.apply([], parts), usable.length);
      });
    });
  }

  // ---------- Oynatma ----------
  function playGroup(group, title) {
    var sorted = group.slice().sort(function (a, b) {
      return qualityNum(b.quality) - qualityNum(a.quality);
    });

    var quality = {};
    sorted.forEach(function (s, i) {
      var label = s.quality;
      if (quality[label]) label += ' (' + (i + 1) + ')';
      quality[label] = s.url;
    });

    var best = sorted[0];
    var item = {
      url: best.url,
      title: title,
      quality: quality,
      subtitles: best.subtitles && best.subtitles.length ? best.subtitles : false
    };
    Lampa.Player.play(item);
    Lampa.Player.playlist([item]);
  }

  function handleStreams(streams, title) {
    if (!streams.length) return notify(CONFIG.name + ': kaynak bulunamadı');

    var groups = {};
    var order = [];
    streams.forEach(function (s) {
      if (!groups[s.group]) { groups[s.group] = []; order.push(s.group); }
      groups[s.group].push(s);
    });

    if (order.length === 1) return playGroup(groups[order[0]], title);

    Lampa.Select.show({
      title: CONFIG.name,
      items: order.map(function (name) {
        var qs = groups[name].map(function (s) { return s.quality; }).join(' / ');
        return { title: name, subtitle: qs, key: name };
      }),
      onSelect: function (a) { playGroup(groups[a.key], title); },
      onBack: function () { Lampa.Controller.toggle(origin); }
    });
  }

  function fetchAndPlay(movie, type, season, episode, title) {
    var id = ++job;
    loading(true, function () { job++; }); // kullanıcı iptal ederse sonuç yok sayılır
    collectStreams(movie.id, type, season, episode, function (streams) {
      if (id !== job) return;
      loading(false);
      handleStreams(streams, title);
    });
  }

  // ---------- Dizi seçimi ----------
  function chooseEpisode(movie, season, count) {
    var items = [];
    for (var i = 1; i <= count; i++) items.push({ title: 'Bölüm ' + i, episode: i });

    Lampa.Select.show({
      title: 'Sezon ' + season,
      items: items,
      onSelect: function (a) {
        fetchAndPlay(movie, 'tv', season, a.episode,
          (movie.name || movie.title) + ' S' + season + 'E' + a.episode);
      },
      onBack: function () { chooseSeason(movie); }
    });
  }

  function chooseSeason(movie) {
    var seasons = (movie.seasons || []).filter(function (s) { return s.season_number > 0; });

    if (!seasons.length && movie.number_of_seasons) {
      for (var n = 1; n <= movie.number_of_seasons; n++) {
        seasons.push({ season_number: n, episode_count: 30 });
      }
    }
    if (!seasons.length) return notify(CONFIG.name + ': sezon bilgisi yok');

    Lampa.Select.show({
      title: CONFIG.name,
      items: seasons.map(function (s) {
        return {
          title: 'Sezon ' + s.season_number,
          subtitle: s.episode_count ? s.episode_count + ' bölüm' : '',
          s: s
        };
      }),
      onSelect: function (a) { chooseEpisode(movie, a.s.season_number, a.s.episode_count || 30); },
      onBack: function () { Lampa.Controller.toggle(origin); }
    });
  }

  // ---------- Başlatma ----------
  function start(movie) {
    try { origin = Lampa.Controller.enabled().name; } catch (e) { origin = null; }
    var isTv = !!movie.number_of_seasons || (!!movie.name && !movie.title);
    if (isTv) chooseSeason(movie);
    else fetchAndPlay(movie, 'movie', undefined, undefined, movie.title || movie.original_title);
  }

  function addButton() {
    Lampa.Listener.follow('full', function (e) {
      if (e.type !== 'complite') return;

      var root = e.object.activity.render();
      if (root.find('.view--' + CONFIG.id).length) return;

      var btn = $(
        '<div class="full-start__button selector view--' + CONFIG.id + '">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
          '<span>' + CONFIG.name + '</span>' +
        '</div>'
      );
      btn.on('hover:enter', function () { start(e.data.movie); });

      var anchor = root.find('.view--torrent');
      if (anchor.length) anchor.after(btn);
      else root.find('.full-start-new__buttons, .full-start__buttons').first().append(btn);
    });
  }

  if (window.appready) addButton();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') addButton();
    });
  }
})();
