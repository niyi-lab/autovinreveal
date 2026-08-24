/* AutoVINReveal VIN Checker — context menu + click routing. */
const SITE = "https://www.autovinreveal.com";

// Strict VIN test: 17 chars, no I/O/Q, and not all digits (rules out order numbers).
function looksLikeVin(raw) {
  const v = String(raw || "").toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
  return v.length === 17 && /[A-HJ-NPR-Z]/.test(v) ? v : null;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "check-vin",
    title: "Check this VIN's history",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "check-vin") return;
  const vin = looksLikeVin(info.selectionText);
  chrome.tabs.create({
    url: vin ? `${SITE}/?vin=${encodeURIComponent(vin)}` : `${SITE}/free-vin-decoder`,
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "open-vin" && msg.vin) {
    chrome.tabs.create({ url: `${SITE}/?vin=${encodeURIComponent(msg.vin)}` });
  }
});
