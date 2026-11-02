/* Word-level tracked-changes diff, shared by the review copy and the dashboard. */
(function (root) {
  "use strict";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function tokenize(s) {
    return String(s || "").match(/\s+|[0-9A-Za-zÀ-ɏ]+(?:['’][A-Za-z]+)?|[^\s0-9A-Za-zÀ-ɏ]/g) || [];
  }

  // Returns [{t:"eq"|"del"|"ins", s:"text"}], with nearby changes grouped like Word does.
  function diff(a, b) {
    var A = tokenize(a), B = tokenize(b);
    if (A.length * B.length > 4000000) return [{ t: "del", s: String(a) }, { t: "ins", s: String(b) }];
    var n = A.length, m = B.length, W = m + 1;
    var dp = new Uint16Array((n + 1) * (m + 1));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    var ops = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: "eq", s: A[i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ t: "del", s: A[i++] }); }
      else { ops.push({ t: "ins", s: B[j++] }); }
    }
    while (i < n) ops.push({ t: "del", s: A[i++] });
    while (j < m) ops.push({ t: "ins", s: B[j++] });

    // A lone space between two changes belongs to the change, so "old words" -> "new words" reads as one edit.
    for (var k = 1; k < ops.length - 1; k++) {
      if (ops[k].t === "eq" && /^\s+$/.test(ops[k].s) && ops[k - 1].t !== "eq" && ops[k + 1].t !== "eq") ops[k].t = "both";
    }
    var out = [], del = "", ins = "";
    function flush() {
      if (del) out.push({ t: "del", s: del });
      if (ins) out.push({ t: "ins", s: ins });
      del = ""; ins = "";
    }
    ops.forEach(function (o) {
      if (o.t === "eq") { flush(); var last = out[out.length - 1]; if (last && last.t === "eq") last.s += o.s; else out.push({ t: "eq", s: o.s }); }
      else if (o.t === "del") del += o.s;
      else if (o.t === "ins") ins += o.s;
      else { del += o.s; ins += o.s; }
    });
    flush();
    return out;
  }

  function toHtml(a, b) {
    return diff(a, b).map(function (o) {
      if (o.t === "eq") return esc(o.s);
      if (o.t === "del") return '<del class="rv-del">' + esc(o.s) + "</del>";
      return '<ins class="rv-ins">' + esc(o.s) + "</ins>";
    }).join("");
  }

  function changed(a, b) {
    return String(a).replace(/\s+/g, " ").trim() !== String(b).replace(/\s+/g, " ").trim();
  }

  root.RVDiff = { diff: diff, toHtml: toHtml, changed: changed, esc: esc };
})(window);
