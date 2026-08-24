const SITE = "https://www.autovinreveal.com";
const $ = (id) => document.getElementById(id);

function clean(v) {
  return (v || "").toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "").slice(0, 17);
}
$("vin").addEventListener("input", (e) => { e.target.value = clean(e.target.value); });

function fail(msg) { const e = $("err"); e.textContent = msg; e.style.display = "block"; }
function clearFail() { $("err").style.display = "none"; }

const FIELDS = [["Year","year"],["Make","make"],["Model","model"],["Trim","trim"],
                ["Engine","engine"],["Fuel","fuel"],["Drivetrain","drive"],["Plant","plant"]];

$("decode").addEventListener("click", async () => {
  const vin = clean($("vin").value);
  clearFail(); $("spec").style.display = "none";
  if (vin.length !== 17) return fail("A VIN is exactly 17 characters.");
  $("decode").textContent = "Decoding…"; $("decode").disabled = true;
  try {
    const r = await fetch(`${SITE}/api/decode-vin?vin=${encodeURIComponent(vin)}`);
    const j = await r.json();
    if (!r.ok) return fail(j.error || "Could not decode that VIN.");
    const box = $("spec");
    box.textContent = "";
    FIELDS.forEach(([label, key]) => {
      if (!j[key]) return;
      const row = document.createElement("div");
      const k = document.createElement("span"); k.className = "k"; k.textContent = label;
      const v = document.createElement("span"); v.className = "v"; v.textContent = j[key];
      row.appendChild(k); row.appendChild(v); box.appendChild(row);
    });
    box.style.display = box.children.length ? "block" : "none";
    if (!box.children.length) fail("No spec data returned for that VIN.");
  } catch (e) {
    fail("Network error — please try again.");
  } finally {
    $("decode").textContent = "Decode free"; $("decode").disabled = false;
  }
});

$("full").addEventListener("click", () => {
  const vin = clean($("vin").value);
  chrome.tabs.create({ url: vin.length === 17 ? `${SITE}/?vin=${encodeURIComponent(vin)}` : SITE });
});
