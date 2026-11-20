// Token Radar dashboard: renders window.RADAR with no network and no framework.
// Views: board (filterable table), live tokens, method. URL params set the
// opening state, so a link can open straight on a detail or a filter:
//   ?detail=<slug>  ?category=<name>  ?chain=<name>  ?q=<text>
(function () {
  'use strict';

  var R = window.RADAR;
  if (!R || !Array.isArray(R.rows)) {
    document.getElementById('meta').textContent = 'No radar data found (data.js missing).';
    return;
  }

  var params = new URLSearchParams(window.location.search);

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + String(n);
  }

  function pct(n) {
    if (n === null || n === undefined) return '—';
    var s = (n > 0 ? '+' : '') + n.toFixed(1) + '%';
    return '<span class="' + (n >= 0 ? 'up' : 'down') + '">' + s + '</span>';
  }

  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- header + stats -------------------------------------------------
  document.getElementById('meta').textContent =
    'Snapshot ' + R.as_of + ' · floor ' + money(R.floor_usd) + ' · model ' + R.model_version + ' · ' + R.rows.length + ' rows';
  document.getElementById('source').textContent = 'Source: ' + R.source;
  document.getElementById('method-text').textContent = R.model_note;

  var top = R.rows[0];
  document.getElementById('stats').innerHTML =
    stat(R.rows.length, 'protocols ranked') +
    stat(R.watchlist_size, 'on the watchlist') +
    stat(R.early_size, 'early finds below the floor') +
    stat(top ? money(top.implied_value_usd) : '—', top ? 'top implied · ' + top.name : 'top implied');
  function stat(value, label) {
    return '<div class="stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  }

  // ---- filter controls ------------------------------------------------
  var cats = [];
  var chains = [];
  R.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) === -1) chains.push(c); });
  });
  cats.sort();
  chains.sort();
  fillSelect('category', cats);
  fillSelect('chain', chains);
  function fillSelect(id, values) {
    var el = document.getElementById(id);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      el.appendChild(o);
    });
  }

  var qEl = document.getElementById('q');
  var catEl = document.getElementById('category');
  var chainEl = document.getElementById('chain');
  var minEl = document.getElementById('min-implied');
  if (params.get('q')) qEl.value = params.get('q');
  if (params.get('category')) catEl.value = params.get('category');
  if (params.get('chain')) chainEl.value = params.get('chain');
  if (params.get('min')) minEl.value = params.get('min');

  [qEl, catEl, chainEl, minEl].forEach(function (el) {
    el.addEventListener('input', function () { renderBoard(); });
  });
  document.getElementById('reset').addEventListener('click', function () {
    qEl.value = '';
    catEl.value = '';
    chainEl.value = '';
    minEl.value = '';
    renderBoard();
  });

  // ---- board ----------------------------------------------------------
  var tbody = document.getElementById('rows');
  function filtered() {
    var q = qEl.value.trim().toLowerCase();
    var cat = catEl.value;
    var chain = chainEl.value;
    var min = parseFloat(minEl.value);
    return R.rows.filter(function (r) {
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) === -1) return false;
      if (cat && r.category !== cat) return false;
      if (chain && r.chains.indexOf(chain) === -1) return false;
      if (!isNaN(min) && r.implied_value_usd < min) return false;
      return true;
    });
  }

  function renderBoard() {
    var rows = filtered();
    tbody.innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (r.rank <= 3 ? 'top3' : '') + '">' +
        '<td>' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b><br><span class="pill">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + r.chains.slice(0, 3).map(esc).join(', ') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '</tr>';
    }).join('');
    document.getElementById('count').textContent =
      rows.length + ' of ' + R.rows.length + ' rows shown';
    tbody.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
  }

  // ---- detail ---------------------------------------------------------
  var detailView = document.getElementById('detail-view');
  var boardView = document.getElementById('board-view');
  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < R.rows.length; i++) {
      if (R.rows[i].slug === slug) { r = R.rows[i]; break; }
    }
    if (!r) return;
    var m = r.model;
    detailView.innerHTML =
      '<button class="back" type="button" id="back">← Back to the board</button>' +
      '<div class="detail">' +
      '<h2><span class="rank-badge">#' + r.rank + '</span>' + esc(r.name) + '</h2>' +
      '<p class="sub">' + esc(r.category || 'Uncategorized') + ' · ' + r.chains.map(esc).join(', ') +
      ' · tracked since ' + esc(r.listed_at || 'unknown') + '</p>' +
      '<div class="kv">' +
      '<div><b>' + money(r.implied_value_usd) + '</b><span>implied value</span></div>' +
      '<div><b>' + money(r.tvl_usd) + '</b><span>TVL</span></div>' +
      '<div><b>' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b><span>TVL change, 7d</span></div>' +
      '<div><b>' + ageText(r.age_days) + '</b><span>age</span></div>' +
      '</div>' +
      '<h3>Why this value</h3>' +
      '<p>' + (m.peer_count >= 3
        ? 'Peer multiple <b>' + m.peer_multiple + '</b> (median mcap/TVL of ' + m.peer_count + ' trading ' + esc(r.category || 'peers') + ' protocols)'
        : 'Peer multiple <b>' + m.peer_multiple + '</b> (global median across all trading protocols; only ' + m.peer_count + ' trading ' + esc(r.category || 'peers') + ' to compare against)') +
      ', momentum <b>' + m.momentum +
      '</b> (7d change ' + m.growth_pct + '%), seasoning <b>' + m.seasoning +
      '</b> (age ' + (m.age_days === null ? 'unknown' : m.age_days + ' days') + '). ' +
      'Implied = TVL × peer multiple × momentum × seasoning.</p>' +
      '<h3>Farm plan</h3>' +
      '<ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '</div>';
    boardView.hidden = true;
    detailView.hidden = false;
    document.getElementById('back').addEventListener('click', function () {
      detailView.hidden = true;
      boardView.hidden = false;
    });
    detailView.scrollIntoView();
  }

  // ---- live -----------------------------------------------------------
  document.getElementById('live-rows').innerHTML = R.live.map(function (p) {
    return '<tr>' +
      '<td><b>' + esc(p.name) + '</b><br><span class="pill">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td>' +
      '<td class="num">' + money(p.mcap_usd) + '</td>' +
      '<td class="num">' + p.multiple + '×</td>' +
      '</tr>';
  }).join('');

  // ---- view switching -------------------------------------------------
  var views = { board: 'board-view', live: 'live-view', method: 'method-view' };
  function show(name) {
    Object.keys(views).forEach(function (k) {
      document.getElementById(views[k]).hidden = (k !== name);
    });
    document.getElementById('view-board').classList.toggle('active', name === 'board');
    document.getElementById('view-live').classList.toggle('active', name === 'live');
    document.getElementById('view-method').classList.toggle('active', name === 'method');
    document.getElementById('controls').style.display = name === 'board' ? '' : 'none';
    if (name === 'board') detailView.hidden = true;
  }
  document.getElementById('view-board').addEventListener('click', function () { show('board'); });
  document.getElementById('view-live').addEventListener('click', function () { show('live'); });
  document.getElementById('view-method').addEventListener('click', function () { show('method'); });

  renderBoard();
  var detailSlug = params.get('detail');
  if (detailSlug) openDetail(detailSlug);
})();
