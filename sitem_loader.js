(function () {
  'use strict';

  // Bu dosya sunucudaki sitem.js'i yükler. Lampa'ya yalnızca bu dosyanın adresini ekle.
  var script = document.currentScript;
  if (!script) {
    var scripts = document.getElementsByTagName('script');
    script = scripts[scripts.length - 1];
  }

  var src = script && script.src ? script.src : '';
  var match = src.match(/^(https:\/\/[^\/]+)/);
  var host = match ? match[1] : '';
  if (!host) return;

  // ?v= her açılışta taze dosya çekilmesini sağlar (önbellek sorunu olmaz)
  Lampa.Utils.putScriptAsync([host + '/sitem.js?v=' + new Date().getTime()], function () {});
})();
