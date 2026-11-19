// TOKEN_RADAR dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board: sortable columns, text search, category filter, pre-token and
// live tabs, per-protocol detail with model inputs and farm plan, model explainer, deep
// links through the URL hash. No network: every byte shown is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  function fmtUsd(n) {
    if (n === null || n === undefined) return 'n/a';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + String(Math.round(n));
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unlisted';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    var y = Math.floor(days / 365);
    var m = Math.round((days - y * 365) / 30);
    return m > 0 ? y + 'y ' + m + 'mo' : y + 'y';
  }
  function fmtMult(n) {
    return 'x' + Number(n).toFixed(3);
  }
  // Same arithmetic as lib/model.ts so the page can re-derive the board number.
  function impliedOf(row, model, catMult) {
    var growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var growthMult = 1 + Math.tanh(growthPct / 50) * model.growth_weight;
    var age = row.age_days === null ? model.unknown_age_days : row.age_days;
    var clamped = Math.min(Math.max(age, 0), model.maturity_days);
    var maturityMult = model.maturity_floor + (Math.log1p(clamped) / Math.log1p(model.maturity_days)) * model.maturity_range;
    var tvlScale = Math.pow(Math.max(row.tvl_usd, 1) / model.tvl_reference_usd, model.tvl_exponent - 1);
    var chainMult = 1 + Math.min((row.chains || []).length, model.chain_max) * model.chain_bonus;
    return Math.max(1, Math.round(row.tvl_usd * catMult * tvlScale * growthMult * maturityMult * chainMult));
  }
  function catMultOf(row) {
    if (DATA.category_multiples && DATA.category_multiples[row.category || 'Other'] !== undefined) {
      return DATA.category_multiples[row.category || 'Other'];
    }
    return row.category_multiplier !== undefined ? row.category_multiplier : DATA.model.base_multiple;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        child.forEach(function (c) { if (c !== null && c !== undefined && c !== false) node.appendChild(c.nodeType ? c : document.createTextNode(String(c))); });
      } else if (child.nodeType) {
        node.appendChild(child);
      } else if (typeof child === 'string' || typeof child === 'number') {
        node.appendChild(document.createTextNode(String(child)));
      }
    }
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'onclick' || k === 'onkeydown' || k === 'oninput' || k === 'onchange') node[k] = v;
        else node.setAttribute(k, String(v));
      });
    }
    return node;
  }

  // Farm plan: same derivation main.ts writes to board.json — category picks the action,
  // TVL picks the capital, the chain record picks the gas, age picks the hold window.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5000000000) return 250;
    if (p.tvl_usd >= 1000000000) return 150;
    if (p.tvl_usd >= 100000000) return 100;
    return 50;
  }
  function gasFor(p) {
    var chains = (p.chains || []).join(' ').toLowerCase();
    if (chains.indexOf('ethereum') >= 0) return 6;
    if (!chains) return 2;
    return 1;
  }
  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + '\u2019s main pool on ' + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + ' of the chain\u2019s staking asset through ' + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + ' of the protocol\u2019s yield asset on ' + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var gas = gasFor(p);
    var hold = holdFor(p.age_days);
    var weeks = Math.max(2, Math.round(hold / 7));
    var totalGas = gas * (2 + weeks * 2);
    return [
      { b: 'Use a fresh wallet that holds only the farming funds, seed phrase offline.', c: 'under $3 of gas for the first transaction \u00b7 5 minutes' },
      { b: actionFor(p, capital, chain), c: '$' + capital + ' of capital and about $' + gas + ' of gas on ' + chain + ' \u00b7 15 minutes to set up' },
      { b: 'Make ' + weeks + ' qualifying actions, about one a week: a deposit, borrow, swap or vote, each on a different day.', c: 'about $' + gas * 2 + ' of gas a week, $' + gas * weeks * 2 + ' over the whole window \u00b7 10 minutes a week for ' + weeks + ' weeks' },
      { b: 'Hold the position for at least ' + hold + ' days so the activity lands in more than one snapshot.', c: 'the $' + capital + ' stays in the position; budget $' + (capital + totalGas) + ' all-in with gas \u00b7 ' + hold + ' days' },
      { b: 'Before withdrawing, open the protocol\u2019s own points or rewards page and claim only from the link it publishes.', c: 'no fee to check, never pay to claim \u00b7 10 minutes' },
      { b: 'Write the wallet, dates and every transaction in a farm log so you can repeat or unwind the position.', c: 'nothing but the log \u00b7 5 minutes' }
    ];
  }

  function readHash() {
    var h = (window.location.hash || '').replace(/^#/, '');
    var parts = h.split('&');
    parts.forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      var k = kv.slice(0, i);
      var v = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      if (k === 'q') state.q = v;
      else if (k === 'cat') state.category = v;
      else if (k === 'tab' && (v === 'pre-token' || v === 'live')) state.tab = v;
      else if (k === 'sort' && ['implied', 'name', 'tvl', 'growth', 'age'].indexOf(v) >= 0) state.sort = v;
      else if (k === 'sel') state.selected = v;
    });
  }
  function writeHash() {
    var bits = [];
    if (state.q) bits.push('q=' + encodeURIComponent(state.q));
    if (state.category !== 'all') bits.push('cat=' + encodeURIComponent(state.category));
    if (state.tab !== 'pre-token') bits.push('tab=' + state.tab);
    if (state.sort !== 'implied') bits.push('sort=' + state.sort);
    if (state.selected) bits.push('sel=' + encodeURIComponent(state.selected));
    var next = bits.length ? '#' + bits.join('&') : ' ';
    try {
      if (('' + window.location.hash) !== next) window.history.replaceState(null, '', next === ' ' ? window.location.pathname + window.location.search : next);
    } catch (e) { /* older viewer: hash stays as-is */ }
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || 'Other', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function topbar() {
    return el('header', { class: 'topbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'prompt', text: '$' }),
        'TOKEN_RADAR',
        el('span', { class: 'cursor', 'aria-hidden': 'true' })
      ),
      el('div', { class: 'meta' },
        el('span', { class: 'chip' }, 'snapshot ', el('b', { text: DATA.as_of })),
        el('span', { class: 'chip' }, 'model ', el('b', { text: DATA.model_version })),
        el('span', { class: 'chip' }, el('b', { text: String(DATA.board_size) }), ' rows')
      )
    );
  }

  function hero() {
    var m = DATA.model;
    return el('section', { class: 'hero' },
      el('div', null,
        el('h1', null, 'Pre-token board: ', el('span', { class: 'glow', text: DATA.watchlist_size + ' watchlist protocols' }), ' ranked by implied value'),
        el('p', { class: 'lede' },
          'The watchlist is the floor: every protocol above $' + Math.round(DATA.floor_usd / 1e6) + 'M TVL with no token on record. ',
          'The early radar adds ', el('b', { text: String(DATA.early_size) + ' pre-token protocols' }), ' below that floor. ',
          'Each base multiple is the category\u2019s own live-token median market-cap-per-TVL (from this snapshot, shrunk toward the global median), ',
          'scaled sublinearly with size, dampened on 7-day momentum, matured on log-age, and bonused per chain. ',
          'Implied value is a model, ', el('b', { text: 'not a promise' }), '.'
        )
      ),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', { text: 'watchlist covered' }), el('b', { text: DATA.watchlist_size + '/' + DATA.watchlist_size })),
        el('div', { class: 'stat' }, el('span', { text: 'rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'stat' }, el('span', { text: 'early rows' }), el('b', { class: 'amber', text: String(DATA.early_size) })),
        el('div', { class: 'stat' }, el('span', { text: 'live set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function toolbar() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'grep name, category, chain\u2026', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; state.selected = null; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'all categories' }),
      categories.map(function (c) {
        var opt = el('option', { value: c, text: c + ' (' + DATA.rows.filter(function (r) { return (r.category || 'Other') === c; }).length + ')' });
        if (c === state.category) opt.setAttribute('selected', 'selected');
        return opt;
      })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'live-token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'toolbar' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'category' }), select),
      el('div', { class: 'field' }, el('label', { text: 'status' }), el('div', { class: 'tabs', role: 'group', 'aria-label': 'Token status' }, pre, live)),
      el('span', { class: 'count' },
        state.tab === 'pre-token'
          ? [el('b', { text: String(filtered().length) }), ' / ' + DATA.board_size + ' rows shown']
          : [el('b', { text: String(DATA.live.length) }), ' live-token protocols']
      )
    );
  }

  function sortBtn(key, label) {
    var mark = state.sort === key ? (state.dir < 0 ? ' \u25bc' : ' \u25b2') : '';
    return el('th', { scope: 'col', 'aria-sort': state.sort === key ? (state.dir < 0 ? 'descending' : 'ascending') : 'none' },
      el('button', { type: 'button', 'aria-label': 'Sort by ' + label, onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } writeHash(); render(); } }, label + mark)
    );
  }

  function boardTable() {
    var list = sorted(filtered());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: '0 rows match that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'clear filters', onclick: function () { state.q = ''; state.category = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list.reduce(function (m, r) { return r.implied_value_usd > m ? r.implied_value_usd : m; }, 1);
    var tbody = el('tbody');
    var cap = list.slice(0, 400);
    cap.forEach(function (r) {
      var g = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var sub = (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') : 'chain n/a');
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num rankcell', text: '#' + r.rank }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('div', { class: 'sub', text: sub }))),
        el('td', null, el('span', { class: 'tag', text: r.category || 'Other' })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + gc, text: g }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'pill', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    var note = list.length > cap.length ? 'First ' + cap.length + ' of ' + list.length + ' rows shown \u2014 narrow the search or category to see the rest. Select a row for its model and farm plan.' : 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.';
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: note }),
          el('thead', null, el('tr', null,
            sortBtn('implied', 'rank'),
            sortBtn('name', 'protocol'),
            el('th', { scope: 'col', text: 'category' }),
            sortBtn('tvl', 'tvl'),
            sortBtn('growth', '7d'),
            sortBtn('age', 'age'),
            sortBtn('implied', 'implied'),
            el('th', { scope: 'col', text: 'token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', { tabindex: '0' },
        el('td', null, el('span', { class: 'pill live', text: 'live' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('div', { class: 'sub', text: (r.category || 'Other') + ' \u00b7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'chain n/a') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num sub', text: r.mcap_usd && r.tvl_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a' })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Already trading: market cap is a fact, not a model. Set aside from the pre-token ranking; their multiples feed the category comps above.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'status' }), el('th', { scope: 'col', text: 'protocol' }),
            el('th', { scope: 'col', text: 'tvl' }), el('th', { scope: 'col', text: '7d' }),
            el('th', { scope: 'col', text: 'market cap' }), el('th', { scope: 'col', text: 'mcap/tvl' })
          )),
          tbody
        )
      )
    );
  }

  function explainer() {
    var m = DATA.model;
    var comps = Object.keys(DATA.category_multiples || {}).sort().slice(0, 14);
    return el('section', { class: 'panel explainer', 'aria-label': 'How implied value is computed' },
      el('div', { class: 'explainer-head' },
        el('h2', { text: '$ cat model.txt' }),
        el('span', { class: 'chip' }, 'same fn scores every row \u00b7 no name special-cased')
      ),
      el('div', { class: 'formula' },
        el('b', { text: 'implied = round( tvl \u00d7 catMult \u00d7 tvlScale \u00d7 growthMult \u00d7 maturity \u00d7 chainMult )' }),
        el('div', { text: 'catMult = category median mcap/tvl among live tokens, shrunk to global median (floor ' + m.category_floor + ', cap ' + m.category_cap + ')' }),
        el('div', { text: 'tvlScale = (tvl / ' + (m.tvl_reference_usd / 1e6) + 'M)^' + (m.tvl_exponent - 1).toFixed(2) + ' \u00b7 sublinear: size discounts itself' }),
        el('div', { text: 'growthMult = 1 + tanh(clamp(7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 50) \u00d7 ' + m.growth_weight + ' \u00b7 momentum saturates' }),
        el('div', { text: 'maturity = ' + m.maturity_floor + ' + ln(1 + min(age, ' + m.maturity_days + ')) / ln(1 + ' + m.maturity_days + ') \u00d7 ' + m.maturity_range + ' \u00b7 survival saturates' }),
        el('div', { text: 'chainMult = 1 + min(chains, ' + m.chain_max + ') \u00d7 ' + m.chain_bonus + ' \u00b7 distribution premium' })
      ),
      el('div', { class: 'comps' }, comps.map(function (c) {
        return el('span', { class: 'comp' }, c + ' ', el('b', { text: fmtMult(DATA.category_multiples[c]) }));
      })),
      el('p', { class: 'note', text: 'TVL and 7-day change come from the snapshot. Age is days since first listing, the record of running with no token; unlisted age uses ' + m.unknown_age_days + ' days. Early radar: pre-token protocols below the floor by TVL. Live tokens are set aside with market caps shown.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    render();
    dialog.textContent = '';
    var inner = el('div', { class: 'detail-inner' });
    var m = impliedOf(row, DATA.model, catMultOf(row));
    var match = m === row.implied_value_usd;
    inner.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'chip' }, 'rank ', el('b', { text: '#' + row.rank + ' / ' + DATA.board_size })),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' \u00b7 ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'chain n/a') + ' \u00b7 ' + row.slug })
      ),
      el('button', { class: 'close', type: 'button', text: '[esc]', 'aria-label': 'Close details', onclick: function () { dialog.close(); } })
    ));
    inner.appendChild(el('div', { class: 'kv' },
      el('div', null, el('span', { text: 'tvl' }), el('b', { text: fmtUsd(row.tvl_usd) })),
      el('div', null, el('span', { text: '7d change' }), el('b', { class: row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg', text: fmtPct(row.change_7d) })),
      el('div', null, el('span', { text: 'age, no token' }), el('b', { text: fmtAge(row.age_days) }))
    ));
    inner.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'model inputs \u00d7 multipliers' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'category base (live median mcap/tvl)' }), el('b', { text: fmtMult(catMultOf(row)) })),
        el('div', null, el('span', { text: 'tvl scale (sublinear)' }), el('b', { text: fmtMult(row.tvl_scale !== undefined ? row.tvl_scale : 1) })),
        el('div', null, el('span', { text: 'growth \u00d7 (dampened)' }), el('b', { text: fmtMult(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'maturity \u00d7 (log-age)' }), el('b', { text: fmtMult(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'chain \u00d7 (' + (row.chains || []).length + ' chains)' }), el('b', { text: fmtMult(row.chain_multiplier !== undefined ? row.chain_multiplier : 1) })),
        el('div', { class: 'total' }, el('span', { text: 'implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'math', text: 'page recomputes ' + fmtUsd(m) + (match ? ' = board.json carries ' + fmtUsd(row.implied_value_usd) + '. same fn, same inputs.' : ' \u2260 board ' + fmtUsd(row.implied_value_usd) + ': data would be stale.') + ' an estimate, not a price.' })
    ));
    inner.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'farm plan \u2014 cost + time per step' }),
      el('ol', { class: 'steps' }, farmSteps(row).map(function (s) {
        return el('li', null, el('b', { text: s.b }), el('span', { class: 'cost', text: 'cost: ' + s.c }));
      }))
    ));
    if (!match) inner.appendChild(el('p', { class: 'warn', text: 'recomputed value differs from the board row: regenerate data.js before trusting this page.' }));
    dialog.appendChild(inner);
    try {
      if (!dialog.open) dialog.showModal();
    } catch (e) {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(topbar());
    shell.appendChild(hero());
    shell.appendChild(toolbar());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(explainer());
    shell.appendChild(el('footer', { class: 'footer' },
      el('span', { text: 'TOKEN_RADAR ' + DATA.model_version + ' \u00b7 snapshot ' + DATA.as_of }),
      el('span', { text: 'implied value is a model, not a promise \u00b7 offline page, no network' })
    ));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected && (!dialog.open || !dialog.querySelector('#detail-title'))) {
      var row = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0];
      if (row && state.tab === 'pre-token') openDetail(state.selected);
    }
  }

  readHash();
  // Unknown slugs or categories in the hash reset to the board instead of rendering empty.
  if (state.selected && !DATA.rows.some(function (r) { return r.slug === state.selected; })) state.selected = null;
  render();
  if (state.selected && dialog && !dialog.open) {
    var again = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0];
    if (again) openDetail(state.selected);
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
    if (e.key === '/' && document.activeElement !== document.getElementById('q')) {
      e.preventDefault();
      var q = document.getElementById('q');
      if (q) q.focus();
    }
  });
  window.addEventListener('hashchange', function () {
    state = { q: '', category: 'all', tab: state.tab, sort: state.sort, dir: state.dir, selected: null };
    readHash();
    render();
  });
})();
