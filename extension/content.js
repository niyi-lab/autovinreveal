/* AutoVINReveal VIN Checker — finds VINs on a listing page. */
(function () {
  // 17 chars, no I/O/Q. Word-bounded so it doesn't grab fragments of longer ids.
  const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/gi;
  const seen = new Set();

  function isVin(v) {
    const s = v.toUpperCase();
    // Reject all-digit strings — those are almost always order/stock numbers.
    return /[A-HJ-NPR-Z]/.test(s) && /[0-9]/.test(s);
  }

  function scanText() {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 17) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      let m;
      VIN_RE.lastIndex = 0;
      while ((m = VIN_RE.exec(n.nodeValue))) {
        const vin = m[1].toUpperCase();
        if (isVin(vin) && !seen.has(vin)) { seen.add(vin); found.push(vin); }
      }
    }
    return found;
  }

  let pill = null;
  function showPill(vin) {
    if (pill) pill.remove();
    pill = document.createElement("div");
    pill.className = "avr-vin-pill";
    pill.innerHTML =
      '<span class="avr-x" title="Dismiss">&times;</span>' +
      "<b>VIN found on this page</b>" +
      "<code></code>" +
      "<button type=\"button\">Check history — $5.99</button>";
    pill.querySelector("code").textContent = vin;
    pill.querySelector(".avr-x").addEventListener("click", () => pill.remove());
    pill.querySelector("button").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "open-vin", vin });
    });
    document.body.appendChild(pill);
  }

  function run() {
    const hits = scanText();
    if (hits.length) showPill(hits[0]);
  }

  // Listing pages are heavily dynamic — rescan on mutation, throttled.
  let t = null;
  const obs = new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(run, 1200);
  });

  setTimeout(() => {
    run();
    obs.observe(document.body, { childList: true, subtree: true });
  }, 1500);
})();
