(function () {
  // ===========================================================================
  //  NCB Work Search — looks songs up in a list of works NCB has recently
  //  cleared (built from an ICE export by data-build/build-search-data.js).
  //  Everything runs in the browser: the list is loaded once, then searched
  //  as you type.
  // ===========================================================================

  var DATA_URL = "https://amk-ncb.github.io/Work-Search-BETA/ncb-works.json";

  var OFFICES = [
    ["Denmark", "av.dk@ncb.dk"], ["Finland", "av.fi@ncb.dk"], ["Iceland", "av.is@ncb.dk"],
    ["Norway", "av.no@ncb.dk"], ["Sweden", "av.se@ncb.dk"]
  ];

  // Koda's public work search shows the ISWC for works outside our list
  var KODA_SEARCH = "https://koda.dk/viden-og-hjaelp/rettigheder/brug-af-andres-musik/soeg-i-kodas-vaerkdatabase";
  // The unchanged NCB cue sheet template, published next to the song list
  var CUE_SHEET = "https://amk-ncb.github.io/Work-Search-BETA/NCB-CISAC-Cue-Sheet.xlsx";

  var VERDICT = {
    y: { tag: "Yes",
         body: "NCB can clear this song for usage within NCB’s mandate." },
    p: { tag: "Partially", askIceNo: true,
         body: "NCB represents some, but not all, of the rights holders in this song. Email the ICE work no. to your local NCB office for further details." },
    n: { tag: "No", askIceNo: true,
         body: "We can’t confirm that NCB can clear this song. Email the ICE work no. to your local NCB office and we will check it for you." },
    // A "No" song with no ICE work no. yet (not registered), so there is no number to send
    nr: { tag: "No",
         body: "We can’t confirm that NCB can clear this song. It isn’t registered yet, so email the title and songwriters to your local NCB office and we will check it for you." },
    d: { tag: "Public domain",
         body: "This song is marked as public domain. Arrangements, translations and lyrics can still be protected, so check the version you use." }
  };

  var MAX_RESULTS = 25;

  // Use only the elements in this block (the one just before this script), so a second copy of the
  // search elsewhere on the page, e.g. an old block hidden in the mobile layout, can't take over
  var root = document.currentScript && document.currentScript.previousElementSibling;
  if (!root || !root.classList.contains("ncbws")) root = document.querySelector(".ncbws");
  var $q = root.querySelector("#ws-q");
  var $clear = root.querySelector("#ws-clear");
  var $results = root.querySelector("#ws-results");
  var $count = root.querySelector("#ws-count");
  var $empty = root.querySelector("#ws-empty");

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function officeLinks() {
    return OFFICES.map(function (o) { return '<a href="mailto:' + o[1] + '">' + o[0] + '</a>'; }).join("");
  }

  // Same folding as the data build: case, accents and Nordic letters don't matter
  function fold(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/å/g, "a").replace(/ß/g, "ss")
      .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function words(s) { var f = fold(s); return f ? f.split(" ") : []; }

  // ── Data ──────────────────────────────────────────────────────────────────
  var works = [], byIsrc = {}, byIswc = {}, byKey = {};
  var status = "loading"; // loading → ready | error

  function prepare(data) {
    works = data.works.map(function (r) {
      var w = { key: r[0], title: r[1], alt: r[2], artists: r[3], writers: r[4], verdict: r[5],
                iswc: r[6], isrcs: r[7] ? r[7].split(" ") : [] };
      w.ft = fold(w.title);
      // Searchable words per field, weighted later: title > alt titles/artists > writers > Koda artists
      w.f = [words(w.title), words(w.alt.join(" ")), words(w.artists.join(" ")), words(w.writers.join(" ")), r[8] ? r[8].split(" ") : []];
      w.pop = Math.min(w.isrcs.length, 40) / 20;
      w.isrcs.forEach(function (i) { byIsrc[i] = w; });
      if (w.iswc) byIswc[w.iswc.replace(/\D/g, "")] = w;
      byKey[w.key] = w;
      return w;
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────
  var WEIGHT = [[10, 7], [6, 4], [6, 4], [4, 3], [2, 1]]; // [exact, prefix] per field

  // Small typo tolerance: 1 edit for 4–6 letters, 2 for longer words (swapped letters count as one)
  function near(a, b) {
    var max = a.length >= 7 ? 2 : a.length >= 4 ? 1 : 0;
    if (!max || Math.abs(a.length - b.length) > max) return false;
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        if (d[i][j] < rowMin) rowMin = d[i][j];
      }
      if (rowMin > max) return false;
    }
    return d[a.length][b.length] <= max;
  }

  function scoreWord(w, qw, fuzzy) {
    var best = 0;
    for (var f = 0; f < 5; f++) {
      var list = w.f[f];
      for (var k = 0; k < list.length; k++) {
        var t = list[k], s = 0;
        if (t === qw) s = WEIGHT[f][0];
        else if (t.lastIndexOf(qw, 0) === 0) s = WEIGHT[f][1];
        else if (fuzzy && f < 4 && (near(qw, t) || near(qw, t.slice(0, qw.length)))) s = WEIGHT[f][1] * 0.6;
        if (s > best) best = s;
      }
    }
    return best;
  }

  function codeLookup(raw) {
    var c = raw.replace(/[\s.\-]/g, "").toUpperCase();
    if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(c)) return byIsrc[c] ? [byIsrc[c]] : [];
    if (/^T\d{10}$/.test(c)) return byIswc[c.slice(1)] ? [byIswc[c.slice(1)]] : [];
    if (/^\d{5,}$/.test(c) && byKey[c]) return [byKey[c]];
    return null;
  }

  function search(raw) {
    var codes = codeLookup(raw);
    if (codes) return codes;
    var qw = words(raw), qf = qw.join(" ");
    if (!qw.length) return [];
    function run(fuzzy) {
      var out = [];
      for (var i = 0; i < works.length; i++) {
        var w = works[i], total = 0, ok = true;
        for (var j = 0; j < qw.length; j++) {
          var s = scoreWord(w, qw[j], fuzzy);
          if (!s) { ok = false; break; }
          total += s;
        }
        if (!ok) continue;
        if (w.ft === qf) total += 30;
        else if (w.ft.lastIndexOf(qf, 0) === 0) total += 15;
        out.push({ w: w, s: total + w.pop });
      }
      return out;
    }
    var hits = run(false), fuzzy = false;
    if (!hits.length) { hits = run(true); fuzzy = true; }
    hits.sort(function (a, b) { return b.s - a.s || a.w.title.localeCompare(b.w.title); });
    var result = hits.map(function (h) { return h.w; });
    result.fuzzy = fuzzy; // only near-matches (typo tolerance) were found
    return result;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  var shown = [], hl = -1;

  function subline(w) {
    if (w.artists.length) return w.artists.slice(0, 2).join(", ") + (w.artists.length > 2 ? " +" + (w.artists.length - 2) : "");
    return w.writers.length ? w.writers.join(", ") : "";
  }

  function listMore(items, n, cls) {
    if (!items.length) return '<span class="ws-none">—</span>';
    var head = items.slice(0, n).map(function (x) { return '<span class="' + (cls || "") + '">' + esc(x) + '</span>'; }).join(", ");
    if (items.length <= n) return head;
    return head + ' <button type="button" class="ws-more" data-all="' + esc(JSON.stringify(items)) + '" data-cls="' + (cls || "") + '">Show all ' + items.length + '</button>';
  }

  function kodaLink(text) {
    return '<a href="' + KODA_SEARCH + '" target="_blank" rel="noopener">' + text + '</a>';
  }

  function detailHtml(w) {
    var unregistered = w.key.indexOf("NR-") === 0; // songs added from pre-clearance that have no ICE work no. yet
    var v = VERDICT[unregistered && w.verdict === "n" ? "nr" : w.verdict];
    return '<div class="ws-verdict ws-' + w.verdict + '">' + v.body +
      (v.askIceNo || unregistered && w.verdict === "n" ? '<div class="ws-offices">' + officeLinks() + '</div>' : '') + '</div>' +
      '<dl class="ws-dl">' +
      '<dt>ICE work no.</dt><dd>' + (unregistered ? '<span class="ws-none">Not registered</span>' : '<span class="ws-code">' + esc(w.key) + '</span>') + '</dd>' +
      '<dt>Songwriters</dt><dd>' + listMore(w.writers, 8) + '</dd>' +
      '<dt>Artists</dt><dd>' + listMore(w.artists, 6) + '</dd>' +
      (w.alt.length ? '<dt>Also known as</dt><dd>' + listMore(w.alt, 4) + '</dd>' : '') +
      '<dt>ISWC</dt><dd>' + (w.iswc ? '<span class="ws-code">' + esc(w.iswc) + '</span>' : '<span class="ws-none">Not available</span>') + '</dd>' +
      '<dt>ISRC</dt><dd>' + listMore(w.isrcs, 3, "ws-code") + '</dd>' +
      '</dl>';
  }

  function showState(text) {
    $empty.innerHTML = ""; $count.hidden = true; shown = [];
    $results.innerHTML = '<div class="ws-state">' + text + '</div>';
  }

  // The two ways to ask us about a song we don't list (used when nothing is found, and under every result list)
  function waysHtml() {
    return '<ul class="ws-ways">' +
        '<li><strong>One or two songs:</strong> email us the song’s ISWC code. You can look it up in ' + kodaLink("Koda’s work database") + '.</li>' +
        '<li><strong>A longer list:</strong> send us a tentative <a href="' + CUE_SHEET + '">NCB cue sheet</a> for your production, with the ISRC filled in for each song.</li>' +
      '</ul>' +
      '<div class="ws-offices">' + officeLinks() + '</div>';
  }

  // Shown above the results when only near-matches were found; created here so the Squarespace block needn't change
  var $note = document.createElement("p");
  $note.className = "ws-note";
  $note.hidden = true;
  $count.parentNode.insertBefore($note, $count);

  function render(q) {
    $empty.innerHTML = "";
    $note.hidden = true;
    hl = -1;
    if (!q) { $results.innerHTML = ""; $count.hidden = true; shown = []; return; }
    if (status === "loading") return showState("Loading songs…");
    if (status === "error") return showState("The song list couldn’t be loaded. Please reload the page.");
    var all = search(q);
    shown = all.slice(0, MAX_RESULTS);
    if (!shown.length) {
      $results.innerHTML = ""; $count.hidden = true;
      $empty.innerHTML = '<div class="ws-empty"><b>We couldn’t find “' + esc(q) + '”</b>' +
        'That doesn’t necessarily mean we can’t clear it. Send it to your local NCB office and we will check it for you:' +
        waysHtml() + '</div>';
      return;
    }
    if (all.fuzzy) {
      $note.innerHTML = '<strong>No exact match for “' + esc(q) + '”.</strong> Showing similar songs:';
      $note.hidden = false;
    }
    $empty.innerHTML = '<div class="ws-help">' +
      '<button type="button" class="ws-help-toggle" aria-expanded="false">Not the song you’re looking for?</button> ' +
      'Send it to us and we will check it for you.' +
      '<div class="ws-help-body" hidden>' + waysHtml() + '</div></div>';
    $count.hidden = false;
    $count.textContent = all.length > MAX_RESULTS ? "Top " + MAX_RESULTS + " of " + all.length + " songs" : all.length + (all.length === 1 ? " song" : " songs");
    $results.innerHTML = shown.map(function (w, i) {
      return '<div class="ws-item" role="listitem" data-i="' + i + '">' +
        '<div class="ws-row" tabindex="0" aria-expanded="false">' +
          '<div class="ws-txt"><div class="ws-t">' + esc(w.title) + '</div><div class="ws-s">' + esc(subline(w)) + '</div></div>' +
          '<span class="ws-tag ws-' + w.verdict + '">' + VERDICT[w.verdict].tag + '</span>' +
          '<svg class="ws-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
        '</div><div class="ws-detail"></div></div>';
    }).join("");
    // Open a single result straight away, unless it's only a near-match
    if (shown.length === 1 && !all.fuzzy) toggle(0);
  }

  $empty.addEventListener("click", function (e) {
    var btn = e.target.closest(".ws-help-toggle");
    if (!btn) return;
    var body = btn.parentNode.querySelector(".ws-help-body");
    body.hidden = !body.hidden;
    btn.setAttribute("aria-expanded", String(!body.hidden));
  });

  function toggle(i) {
    var item = $results.children[i];
    if (!item || !shown[i]) return;
    var open = !item.classList.contains("ws-open");
    item.classList.toggle("ws-open", open);
    item.firstChild.setAttribute("aria-expanded", open);
    if (open && !item.lastChild.innerHTML) item.lastChild.innerHTML = detailHtml(shown[i]);
  }

  function highlight(i) {
    var items = $results.children;
    if (!shown.length) return;
    hl = Math.max(0, Math.min(items.length - 1, i));
    for (var k = 0; k < items.length; k++) items[k].classList.toggle("ws-hl", k === hl);
    items[hl].scrollIntoView({ block: "nearest" });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  var timer;
  $q.addEventListener("input", function () {
    $clear.classList.toggle("ws-on", !!$q.value);
    clearTimeout(timer);
    timer = setTimeout(function () { render($q.value.trim()); }, 120);
  });
  $q.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(hl + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(hl - 1); }
    else if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); if (hl < 0) render($q.value.trim()); else toggle(hl); }
    else if (e.key === "Escape") { $clear.click(); }
  });
  $clear.addEventListener("click", function () {
    $q.value = ""; $clear.classList.remove("ws-on"); render(""); $q.focus();
  });
  $results.addEventListener("click", function (e) {
    var more = e.target.closest(".ws-more");
    if (more) {
      var cls = more.getAttribute("data-cls");
      more.parentNode.innerHTML = JSON.parse(more.getAttribute("data-all")).map(function (x) {
        return '<span class="' + cls + '">' + esc(x) + '</span>';
      }).join(", ");
      return;
    }
    var row = e.target.closest(".ws-row");
    if (row) toggle(+row.parentNode.getAttribute("data-i"));
  });
  $results.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("ws-row")) {
      e.preventDefault(); toggle(+e.target.parentNode.getAttribute("data-i"));
    }
  });

  fetch(DATA_URL).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then(function (text) {
    prepare(JSON.parse(text));
    status = "ready";
  }).catch(function (err) {
    status = "error";
    console.error("NCB Work Search: could not load " + DATA_URL, err);
  }).then(function () {
    if ($q.value.trim()) render($q.value.trim());
  });
})();
