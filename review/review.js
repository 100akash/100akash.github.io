/* Review layer for akashto.com.
   Reviewers click text, type their version, and see it as tracked changes.
   Suggestions go to a Google Sheet through an Apps Script web app (see Code.gs). */
(function () {
  "use strict";

  var CFG = window.REVIEW_CONFIG || {};
  var API = String(CFG.api || "").trim();
  var DEMO = !API;
  var params = new URLSearchParams(location.search);
  var TOKEN = (params.get("r") || "").trim();
  var D = window.RVDiff;
  var PAGES = { home: "Home", academic: "Academic", professional: "Professional", tools: "Helpful Tools", contact: "Contact" };
  var SEL = "h1,h2,h3,p,li,.tl-meta,.tl-org,.tl-loc,.tl-pill,.proj-sponsor,.proj-amt,.status,.dmeta span,.ticket__value," +
    ".ticket__stub span,.tool-go,.degree-trigger,.btn,.cv-cta__title,.cv-cta__meta,.yr,.loc,.row__side .mono";
  var SKIP = ".divider,.card-kicker,.course-drawer-overlay,svg,.rv-ui";
  var GENERAL = "general|Overall|1";
  var WORD_SKIP = ".row__side .mono,.tool-go,.degree-trigger,.btn,.ticket__stub span,.cv-cta__meta";
  var LS_PENDING = "rv-pending-" + (DEMO ? "demo" : TOKEN);
  var LS_DEMO = "rv-demo-suggestions";
  var LS_WELCOME = "rv-welcome-" + (DEMO ? "demo" : TOKEN);

  var state = {
    name: "", canEdit: false, mode: "suggest", done: false,
    blocks: [], byKey: {}, sugg: {}, active: null, retryTimer: null, saving: 0, failed: false
  };

  /* ---------- small helpers ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function esc(s) { return D.esc(s); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function where(page, section) { return (PAGES[page] || "Overall") + (section && section !== "Overall" ? " › " + section : ""); }

  /* ---------- 1. index every text block on the site ---------- */
  // Line breaks count as spaces, so "collaboration<br>and" reads "collaboration and".
  function textOf(n) {
    var c = n.cloneNode(true);
    [].forEach.call(c.querySelectorAll("br"), function (br) { br.replaceWith(" "); });
    return norm(c.textContent);
  }
  function hasOwnText(n) {
    return [].some.call(n.childNodes, function (c) { return c.nodeType === 3 && c.nodeValue.trim(); });
  }
  function renderTarget(b) {
    var t = b;
    while (t.children.length === 1 && !hasOwnText(t) && !(t.children[0] instanceof SVGElement)) t = t.children[0];
    return t;
  }
  function indexBlocks() {
    Object.keys(PAGES).forEach(function (page) {
      var view = document.getElementById("view-" + page);
      if (!view) return;
      var section = "Intro", counts = {};
      $$(SEL + ",.divider b", view).forEach(function (n) {
        if (n.matches(".divider b")) { section = norm(n.textContent) || section; return; }
        if (n.closest(SKIP) || n.querySelector(SEL)) return;
        var text = textOf(n);
        if (!text) return;
        counts[section] = (counts[section] || 0) + 1;
        var key = page + "|" + section + "|" + counts[section];
        var target = renderTarget(n);
        var b = { el: n, target: target, html: target.innerHTML, key: key, page: page, section: section, text: text, tag: n.tagName.toLowerCase() };
        n.classList.add("rv-block");
        n.setAttribute("data-rv", key);
        state.blocks.push(b);
        state.byKey[key] = b;
      });
    });
  }

  /* ---------- 2. show the whole site: open hidden lists and details ---------- */
  function unfold() {
    $$(".rows.is-collapsed").forEach(function (r) { r.classList.remove("is-collapsed"); });
    $$(".more-btn").forEach(function (b) { b.hidden = true; });
    $$(".mini-detail").forEach(function (d) { d.classList.add("is-open"); });
    $$(".mentee-trigger").forEach(function (b) { b.setAttribute("aria-expanded", "true"); });
  }

  /* ---------- 3. match saved suggestions to blocks and paint them ---------- */
  function locate(s) {
    var b = state.byKey[s.block];
    if (b && b.text === norm(s.original)) return { b: b, stale: false };
    var same = state.blocks.filter(function (x) { return x.page === s.page && x.text === norm(s.original); })[0];
    if (same) return { b: same, stale: false };
    if (b) return { b: b, stale: true };
    return { b: null, stale: true };
  }
  function paint(b) {
    var s = state.sugg[b.key];
    b.el.classList.remove("rv-has", "rv-note", "rv-stale");
    b.el.removeAttribute("title");
    b.target.innerHTML = b.html;
    if (!s) return;
    b.el.classList.add("rv-has");
    if (s.stale) { b.el.classList.add("rv-stale"); b.el.title = "This text changed after your suggestion. Click to see it."; return; }
    if (D.changed(b.text, s.suggested)) b.target.innerHTML = D.toHtml(b.text, s.suggested);
    if (norm(s.comment)) { b.el.classList.add("rv-note"); b.el.title = "Your comment: " + s.comment; }
  }
  function adopt(list) {
    var fresh = {};
    (list || []).forEach(function (s) {
      if (s.block === GENERAL) { fresh[GENERAL] = s; return; }
      var hit = locate(s);
      var key = hit.b ? hit.b.key : s.block;
      fresh[key] = { block: s.block, page: s.page, section: s.section, original: s.original, suggested: s.suggested,
        comment: s.comment || "", updated: s.updated || "", stale: hit.stale, orphan: !hit.b };
    });
    state.sugg = fresh;
    state.blocks.forEach(paint);
  }

  /* ---------- 4. saving, with a retry queue so nothing is lost ---------- */
  function apiGet(q) {
    return fetch(API + "?" + new URLSearchParams(q).toString(), { cache: "no-store", redirect: "follow" })
      .then(function (r) { return r.json(); });
  }
  function apiPost(body) {
    return fetch(API, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function demoStore() {
    lsSet(LS_DEMO, Object.keys(state.sugg).map(function (k) { return state.sugg[k]; }));
  }
  function queue(op) {
    var p = lsGet(LS_PENDING, {});
    p[op.block] = op;
    lsSet(LS_PENDING, p);
    flush();
  }
  function flush() {
    if (DEMO) { demoStore(); lsSet(LS_PENDING, {}); setStatus(); return Promise.resolve(); }
    var p = lsGet(LS_PENDING, {});
    var keys = Object.keys(p);
    if (!keys.length) { state.failed = false; setStatus(); return Promise.resolve(); }
    if (state.saving) return Promise.resolve();
    state.saving = keys.length; setStatus();
    var chain = Promise.resolve();
    keys.forEach(function (k) {
      chain = chain.then(function () {
        var op = p[k];
        return apiPost(op).then(function (res) {
          if (res && res.ok) {
            var now = lsGet(LS_PENDING, {});
            if (now[k] && JSON.stringify(now[k]) === JSON.stringify(op)) { delete now[k]; lsSet(LS_PENDING, now); }
          } else if (res && res.error === "inactive") {
            throw new Error("inactive");
          } else {
            throw new Error((res && res.error) || "save failed");
          }
        });
      });
    });
    return chain.then(function () {
      state.saving = 0; state.failed = false; setStatus();
      if (Object.keys(lsGet(LS_PENDING, {})).length) flush();
    }).catch(function (err) {
      state.saving = 0; state.failed = true; setStatus(err && err.message === "inactive" ? "This link is no longer active." : null);
      clearTimeout(state.retryTimer);
      state.retryTimer = setTimeout(flush, 15000);
    });
  }
  function commit(b, suggested, comment) {
    var key = b ? b.key : GENERAL;
    var keep = suggested != null && (b ? D.changed(b.text, suggested) : false) || norm(comment);
    if (!keep) return remove(key);
    var rec = {
      block: b ? b.key : GENERAL, page: b ? b.page : "general", section: b ? b.section : "Overall",
      original: b ? b.text : "", suggested: b ? suggested : "", comment: comment || "", updated: new Date().toISOString(), stale: false, orphan: false
    };
    state.sugg[key] = rec;
    if (b) paint(b);
    updateCount();
    queue({ action: "save", r: TOKEN, block: rec.block, page: rec.page, section: rec.section, original: rec.original, suggested: rec.suggested, comment: rec.comment });
    toast("Saved");
  }
  function remove(key) {
    var s = state.sugg[key];
    if (!s) return;
    delete state.sugg[key];
    if (state.byKey[key]) paint(state.byKey[key]);
    updateCount();
    queue({ action: "delete", r: TOKEN, block: s.block });
    toast("Suggestion removed");
  }

  /* ---------- 5. interface ---------- */
  var bar, panel, toastEl;

  function buildBar() {
    bar = el("div", "rv-ui rv-bar");
    bar.innerHTML =
      '<div class="rv-bar__who"><span class="rv-tag">Review copy</span><span class="rv-hi"></span></div>' +
      '<div class="rv-seg" role="group" aria-label="Mode">' +
        '<button type="button" data-mode="suggest">Suggest edits</button>' +
        '<button type="button" data-mode="read">Just read</button></div>' +
      '<div class="rv-bar__act">' +
        '<span class="rv-status" aria-live="polite"></span>' +
        '<button type="button" class="rv-b" data-act="mine">My edits <b class="rv-count">0</b></button>' +
        '<button type="button" class="rv-b" data-act="general">Overall comment</button>' +
        '<button type="button" class="rv-b" data-act="word" title="Download all the text as a Word file">Word file</button>' +
        '<button type="button" class="rv-b rv-b--accent" data-act="done">Mark as done</button>' +
        '<button type="button" class="rv-b rv-b--ghost" data-act="help" title="How this works" aria-label="How this works">?</button>' +
      "</div>";
    document.body.appendChild(bar);
    bar.addEventListener("click", function (e) {
      var m = e.target.closest("[data-mode]");
      if (m) { setMode(m.getAttribute("data-mode")); return; }
      var a = e.target.closest("[data-act]");
      if (!a) return;
      var act = a.getAttribute("data-act");
      if (act === "mine") openList();
      else if (act === "general") openGeneral();
      else if (act === "word") downloadWord(a);
      else if (act === "done") markDone();
      else if (act === "help") welcome(true);
    });
    panel = el("aside", "rv-ui rv-panel");
    panel.setAttribute("aria-label", "Suggestion panel");
    document.body.appendChild(panel);
    toastEl = el("div", "rv-ui rv-toast");
    document.body.appendChild(toastEl);
  }

  function refreshBar() {
    $(".rv-hi", bar).textContent = state.name ? "Hi, " + state.name : "";
    $$("[data-mode]", bar).forEach(function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-mode") === state.mode);
      b.disabled = !state.canEdit && b.getAttribute("data-mode") === "suggest";
    });
    $$('[data-act="mine"],[data-act="general"],[data-act="done"]', bar).forEach(function (b) { b.hidden = !state.canEdit; });
    var d = $('[data-act="done"]', bar);
    d.textContent = state.done ? "Done ✓" : "Mark as done";
    d.classList.toggle("is-done", !!state.done);
    updateCount();
    setStatus();
  }
  function updateCount() {
    var n = Object.keys(state.sugg).length;
    var c = bar && $(".rv-count", bar);
    if (c) c.textContent = n;
  }
  function setStatus(msg) {
    if (!bar) return;
    var s = $(".rv-status", bar);
    var pending = Object.keys(lsGet(LS_PENDING, {})).length;
    if (msg) s.textContent = msg;
    else if (!state.canEdit) s.textContent = state.lockMsg || "";
    else if (DEMO) s.textContent = "Demo mode: saved in this browser only";
    else if (state.saving) s.textContent = "Saving…";
    else if (state.failed && pending) s.textContent = "Not saved yet. Retrying…";
    else s.textContent = "All changes saved";
    s.classList.toggle("is-warn", !!(msg || (state.failed && pending) || (!state.canEdit && state.lockMsg)));
  }
  function setMode(m) {
    if (m === "suggest" && !state.canEdit) return;
    state.mode = m;
    document.documentElement.classList.toggle("rv-suggest", m === "suggest");
    if (m !== "suggest") closePanel();
    refreshBar();
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.classList.remove("is-on"); }, 1800);
  }

  function openPanel(html) {
    panel.innerHTML = '<button type="button" class="rv-x" aria-label="Close">&times;</button>' + html;
    document.documentElement.classList.add("rv-panel-open");
    $(".rv-x", panel).addEventListener("click", closePanel);
  }
  function closePanel() {
    document.documentElement.classList.remove("rv-panel-open");
    if (state.active) state.active.el.classList.remove("rv-active");
    state.active = null;
    panel.innerHTML = "";
  }

  function fitArea(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 420) + "px"; }

  function openEditor(b) {
    if (state.active) state.active.el.classList.remove("rv-active");
    state.active = b;
    b.el.classList.add("rv-active");
    var s = state.sugg[b.key];
    var staleNote = s && s.stale
      ? '<p class="rv-warn">This text changed after you suggested an edit. Your earlier version is below. Save it again if it still applies.</p>' +
        '<p class="rv-label">The text you edited before</p><div class="rv-orig">' + esc(s.original) + "</div>"
      : "";
    var start = s && !s.stale && D.changed(b.text, s.suggested) ? s.suggested : (s && s.stale ? s.suggested : b.text);
    openPanel(
      '<p class="rv-kicker">' + esc(where(b.page, b.section)) + "</p>" +
      "<h2>Suggest an edit</h2>" + staleNote +
      '<p class="rv-label">Current text</p><div class="rv-orig">' + esc(b.text) + "</div>" +
      '<label class="rv-label" for="rvText">Your version</label>' +
      '<textarea id="rvText" class="rv-area" spellcheck="true"></textarea>' +
      '<p class="rv-label">Changes</p><div class="rv-preview" aria-live="polite"></div>' +
      '<label class="rv-label" for="rvNote">Comment <span>(optional)</span></label>' +
      '<textarea id="rvNote" class="rv-area rv-area--note" placeholder="Why, or anything I should know"></textarea>' +
      '<div class="rv-row"><button type="button" class="rv-btn rv-btn--go" data-do="save">Save</button>' +
      '<button type="button" class="rv-btn" data-do="cancel">Cancel</button>' +
      (s ? '<button type="button" class="rv-btn rv-btn--del" data-do="remove">Remove my suggestion</button>' : "") + "</div>" +
      '<p class="rv-hint">Ctrl + Enter saves. Esc closes.</p>'
    );
    var ta = $("#rvText", panel), note = $("#rvNote", panel), prev = $(".rv-preview", panel);
    ta.value = start;
    note.value = s ? s.comment || "" : "";
    function upd() {
      prev.innerHTML = D.changed(b.text, ta.value) ? D.toHtml(b.text, ta.value) : '<span class="rv-none">No changes yet. Edit the text above.</span>';
      fitArea(ta);
    }
    ta.addEventListener("input", upd);
    note.addEventListener("input", function () { fitArea(note); });
    upd(); fitArea(note);
    panel.addEventListener("keydown", onPanelKey);
    $$("[data-do]", panel).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var d = btn.getAttribute("data-do");
        if (d === "save") { commit(b, ta.value, note.value); closePanel(); }
        else if (d === "remove") { remove(b.key); closePanel(); }
        else closePanel();
      });
    });
    setTimeout(function () {
      if (document.activeElement !== ta && document.activeElement !== note) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 30);
    keepInView(b);
  }
  // The panel narrows the page on wide screens, so wait for the reflow before checking position.
  function keepInView(b) {
    setTimeout(function () {
      var r = b.el.getBoundingClientRect();
      if (r.top < 96 || r.bottom > innerHeight - 80) b.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 260);
  }
  function onPanelKey(e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { var s = $('[data-do="save"]', panel); if (s) { e.preventDefault(); s.click(); } }
  }

  function openGeneral() {
    if (state.active) state.active.el.classList.remove("rv-active");
    state.active = null;
    var s = state.sugg[GENERAL];
    openPanel(
      '<p class="rv-kicker">Whole site</p><h2>Overall comment</h2>' +
      '<p class="rv-sub">Anything that is not about one piece of text. Structure, tone, what is missing.</p>' +
      '<textarea id="rvNote" class="rv-area rv-area--big"></textarea>' +
      '<div class="rv-row"><button type="button" class="rv-btn rv-btn--go" data-do="save">Save</button>' +
      '<button type="button" class="rv-btn" data-do="cancel">Cancel</button></div>'
    );
    var note = $("#rvNote", panel);
    note.value = s ? s.comment : "";
    panel.addEventListener("keydown", onPanelKey);
    $('[data-do="save"]', panel).addEventListener("click", function () { commit(null, null, note.value); closePanel(); });
    $('[data-do="cancel"]', panel).addEventListener("click", closePanel);
    setTimeout(function () { note.focus(); }, 30);
  }

  function openList() {
    if (state.active) state.active.el.classList.remove("rv-active");
    state.active = null;
    var keys = Object.keys(state.sugg);
    var order = state.blocks.map(function (b) { return b.key; });
    keys.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    });
    var items = keys.map(function (k) {
      var s = state.sugg[k], b = state.byKey[k];
      var body;
      if (k === GENERAL) body = '<p class="rv-li__c">' + esc(s.comment) + "</p>";
      else if (s.orphan) body = '<p class="rv-warn">This text is no longer on the site.</p><div class="rv-li__d">' + D.toHtml(s.original, s.suggested) + "</div>";
      else body = (D.changed(s.original, s.suggested) ? '<div class="rv-li__d">' + D.toHtml(s.original, s.suggested) + "</div>" : "") +
        (s.stale ? '<p class="rv-warn">The text changed after this suggestion.</p>' : "") +
        (norm(s.comment) ? '<p class="rv-li__c">' + esc(s.comment) + "</p>" : "");
      return '<li><button type="button" class="rv-li" data-k="' + esc(k) + '"' + (s.orphan ? " disabled" : "") + ">" +
        '<span class="rv-li__w">' + esc(k === GENERAL ? "Overall comment" : where(s.page, s.section)) + "</span>" + body + "</button></li>";
    }).join("");
    openPanel(
      '<p class="rv-kicker">' + keys.length + (keys.length === 1 ? " suggestion" : " suggestions") + "</p><h2>My edits</h2>" +
      (keys.length ? '<ul class="rv-list">' + items + "</ul>" : '<p class="rv-sub">Nothing yet. Click any text on the page to suggest a change.</p>')
    );
    $$(".rv-li", panel).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var k = btn.getAttribute("data-k");
        if (k === GENERAL) { openGeneral(); return; }
        var b = state.byKey[k];
        if (b) goTo(b);
      });
    });
  }

  function goTo(b) {
    var cur = (location.hash.replace("#/", "") || "home").split("?")[0];
    if (cur !== b.page) {
      location.hash = b.page === "home" ? "#/" : "#/" + b.page;
      setTimeout(function () { b.el.scrollIntoView({ block: "center" }); openEditor(b); }, 650);
    } else {
      b.el.scrollIntoView({ block: "center", behavior: "smooth" });
      openEditor(b);
    }
  }

  function welcome(force) {
    if (!force && lsGet(LS_WELCOME, false)) return;
    var who = state.name ? "Hi " + esc(state.name) + "." : "Hi.";
    var m = el("div", "rv-ui rv-modal");
    m.innerHTML =
      '<div class="rv-modal__card" role="dialog" aria-modal="true" aria-labelledby="rvWelcome">' +
      '<p class="rv-kicker">Review copy of akashto.com</p>' +
      '<h2 id="rvWelcome">' + who + (state.canEdit ? " Thank you for reviewing my website." : " This is a review copy of my website.") + "</h2>" +
      (state.canEdit
        ? '<ol class="rv-steps">' +
          "<li>Click any text to suggest a change. Titles, paragraphs, and bullets all work.</li>" +
          "<li>Type your version in the panel. Your edits show like Track Changes in Word.</li>" +
          "<li>Add a comment if something needs explaining.</li>" +
          "<li>Everything saves on its own. Only I can see your suggestions.</li></ol>" +
          '<p class="rv-sub">Prefer Word? Use <b>Word file</b> at the bottom to download all the text. Edit it with Track Changes and email it back.</p>' +
          '<p class="rv-sub">Use the menu at the top to move between pages. Switch to <b>Just read</b> to click links normally.</p>'
        : '<p class="rv-sub">' + esc(state.lockMsg || "This link does not allow suggestions.") + "</p>") +
      '<p class="rv-sign">Akash</p>' +
      '<button type="button" class="rv-btn rv-btn--go" data-do="start">' + (state.canEdit ? "Start reviewing" : "View the site") + "</button></div>";
    document.body.appendChild(m);
    function close() { m.remove(); lsSet(LS_WELCOME, true); }
    $('[data-do="start"]', m).addEventListener("click", close);
    m.addEventListener("click", function (e) { if (e.target === m) close(); });
    setTimeout(function () { $('[data-do="start"]', m).focus(); }, 30);
  }

  function markDone() {
    state.done = !state.done;
    refreshBar();
    if (DEMO) { toast(state.done ? "Marked as done" : "Marked as not done"); return; }
    apiPost({ action: "done", r: TOKEN, done: state.done }).then(function (res) {
      if (!res || !res.ok) throw new Error();
      toast(state.done ? "Thank you! You can still make changes." : "Marked as not done");
    }).catch(function () { state.done = !state.done; refreshBar(); toast("Could not reach the server. Try again."); });
  }

  /* ---------- 6. Word file of all the text ---------- */
  function loadZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise(function (ok, fail) {
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = function () { ok(window.JSZip); };
      s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  function xml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function para(text, style) {
    return "<w:p>" + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : "") +
      '<w:r><w:t xml:space="preserve">' + xml(text) + "</w:t></w:r></w:p>";
  }
  function downloadWord(btn) {
    var label = btn.textContent;
    btn.textContent = "Preparing…"; btn.disabled = true;
    loadZip().then(function (JSZip) {
      var body = [para("akashto.com: website text for review", "Title"),
        para("Please turn on Track Changes, edit anything, and email this file back to Akash. Comments are welcome too.", "Note")];
      Object.keys(PAGES).forEach(function (page) {
        var list = state.blocks.filter(function (b) { return b.page === page; });
        if (!list.length) return;
        body.push(para(PAGES[page] + " page", "Heading1"));
        var sec = null;
        list.forEach(function (b) {
          if (b.section !== sec) { sec = b.section; body.push(para(sec, "Heading2")); }
          if (b.el.matches(WORD_SKIP)) return;
          var style = /^h[1-3]$/.test(b.tag) ? "Item" : (b.tag === "li" ? "Bullet" : (b.tag === "p" ? null : "Small"));
          body.push(para((b.tag === "li" ? "• " : "") + b.text, style));
        });
      });
      var W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
      var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + W + "><w:body>" + body.join("") +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';
      function st(id, name, rpr, ppr, basedOn) {
        return '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/>' + (basedOn ? '<w:basedOn w:val="Normal"/>' : "") +
          '<w:qFormat/><w:pPr>' + (ppr || "") + "</w:pPr><w:rPr>" + (rpr || "") + "</w:rPr></w:style>";
      }
      var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + W + ">" +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        st("Title", "Title", '<w:b/><w:color w:val="13294B"/><w:sz w:val="36"/>', '<w:spacing w:after="160"/>', true) +
        st("Note", "Note", '<w:i/><w:color w:val="595959"/>', '<w:spacing w:after="240"/>', true) +
        st("Heading1", "heading 1", '<w:b/><w:color w:val="13294B"/><w:sz w:val="30"/>', '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>', true) +
        st("Heading2", "heading 2", '<w:b/><w:color w:val="C2410C"/><w:sz w:val="24"/>', '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/>', true) +
        st("Item", "Item title", "<w:b/>", '<w:keepNext/><w:spacing w:before="120" w:after="40"/>', true) +
        st("Bullet", "Bullet text", "", '<w:ind w:left="360" w:hanging="216"/>', true) +
        st("Small", "Small label", '<w:color w:val="595959"/><w:sz w:val="20"/>', '<w:spacing w:after="60"/>', true) +
        "</w:styles>";
      var zip = new JSZip();
      zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
      zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
      zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
      zip.file("word/document.xml", doc);
      zip.file("word/styles.xml", styles);
      return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    }).then(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "akashto-website-text.docx";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }).catch(function () {
      toast("The Word file could not be made. Please try again.");
    }).then(function () { btn.textContent = label; btn.disabled = false; });
  }

  /* ---------- 7. clicks on the page ---------- */
  function onClick(e) {
    if (state.mode !== "suggest" || !state.canEdit) return;
    if (e.target.closest(".rv-ui")) return;
    var n = e.target.closest(".rv-block");
    if (!n || !n.closest("main")) return;
    e.preventDefault();
    e.stopPropagation();
    var b = state.byKey[n.getAttribute("data-rv")];
    if (b) openEditor(b);
  }
  function onKey(e) {
    if (e.key === "Escape" && document.documentElement.classList.contains("rv-panel-open")) closePanel();
  }

  /* ---------- 8. start ---------- */
  function start() {
    document.documentElement.classList.add("rv-on");
    indexBlocks();
    unfold();
    buildBar();
    window.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", function (e) {
      if (!DEMO && Object.keys(lsGet(LS_PENDING, {})).length) { e.preventDefault(); e.returnValue = ""; }
    });
    window.addEventListener("online", flush);

    if (DEMO) {
      state.canEdit = true;
      adopt(lsGet(LS_DEMO, []));
      ready();
      return;
    }
    if (!TOKEN) {
      lock("This is a review copy. To suggest edits, please use the personal link Akash sent you.", true);
      return;
    }
    setStatus("Connecting…");
    apiGet({ action: "load", r: TOKEN }).then(function (res) {
      if (!res || !res.ok) {
        lock(res && res.error === "inactive" ? "This review link is not active. Please ask Akash for a new one." : "The review server had a problem. Please try again later.");
        return;
      }
      state.name = res.name || "";
      state.done = !!res.done;
      state.canEdit = true;
      var list = res.suggestions || [];
      // edits that never reached the server are newer than what it returned
      var pending = lsGet(LS_PENDING, {});
      Object.keys(pending).forEach(function (k) {
        var op = pending[k];
        list = list.filter(function (s) { return s.block !== op.block; });
        if (op.action === "save") list.push(op);
      });
      adopt(list);
      ready();
      flush();
    }).catch(function () {
      lock("Could not reach the review server. Check your connection and refresh the page.");
    });
  }
  function ready() {
    setMode("suggest");
    refreshBar();
    welcome(false);
  }
  function lock(msg, quiet) {
    state.canEdit = false;
    state.lockMsg = msg;
    setMode("read");
    refreshBar();
    setStatus(msg);
    if (!quiet) welcome(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
