/* Card rendering shared by the lobby and the match UI.
   Every card is a real DOM card: a fully legible text frame underneath, with the Scryfall
   image fading in on top when (and only when) it loads, so offline play still reads well. */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ESC[c]));
export const oid = (x) => (x && typeof x === "object" ? x.id : x);
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

/* ---------- mana pips ---------- */
const PIPC = { W: "#f6f0cf", U: "#8ccbf2", B: "#6b5e6e", R: "#f0886a", G: "#6dbd84", C: "#cdc8c2" };
export function pip(sym) {
  const s = String(sym).toUpperCase();
  const parts = s.split("/");
  let style = "", label = s, cls = "gp";
  if (parts.length === 2) {
    const [a, b] = parts;
    const ca = PIPC[a] || "#cdc8c2", cb = b === "P" ? ca : PIPC[b] || "#cdc8c2";
    style = "background:linear-gradient(135deg," + ca + " 50%," + cb + " 50%)";
    label = b === "P" ? "φ" : /^\d+$/.test(a) ? a : "";
    cls += " gp-h";
  } else if (PIPC[s]) {
    style = "background:" + PIPC[s];
    if (s === "B") cls += " gp-dark";
  } else if (s === "T") { label = "↷"; cls += " gp-t"; }
  else if (s === "Q") { label = "↶"; cls += " gp-t"; }
  else if (s === "S") { label = "❄"; cls += " gp-s"; }
  else if (s === "E") { label = "⚡"; cls += " gp-s"; }
  else cls += " gp-n";
  return '<span class="' + cls + '"' + (style ? ' style="' + style + '"' : "") + ' title="{' + esc(s) + '}">' + esc(label) + "</span>";
}
export function manaHtml(cost) {
  if (!cost) return "";
  const syms = [];
  String(cost).replace(/\{([^}]+)\}/g, (m, x) => { syms.push(x); return m; });
  return syms.length ? '<span class="gps" aria-label="' + esc(cost) + '">' + syms.map(pip).join("") + "</span>" : "";
}
export function textHtml(s) {
  if (!s) return "";
  return String(s).split("\n").map((line) => {
    let x = esc(line).replace(/\{([^}]+)\}/g, (m, sym) => pip(sym));
    x = x.replace(/\(([^()]*)\)/g, "<i>($1)</i>");
    return "<p>" + x + "</p>";
  }).join("");
}
export function pipsOfColors(colors) {
  const list = colors && colors.length ? ["W", "U", "B", "R", "G"].filter((c) => colors.indexOf(c) >= 0) : ["C"];
  return '<span class="gps">' + list.map(pip).join("") + "</span>";
}

/* ---------- images ---------- */
export const imgSize = (url, size) => (url ? String(url).replace("/normal/", "/" + size + "/") : "");
export const artCrop = (url) => imgSize(url, "art_crop");

/* ---------- frame colours ---------- */
const FR = {
  W: ["#e9e0bd", "#a89868"], U: ["#5e9fd4", "#254f80"], B: ["#5b5063", "#241d2b"],
  R: ["#dc6c4c", "#862a1a"], G: ["#5fa573", "#25603c"], M: ["#dcc169", "#85691f"],
  A: ["#a4adb8", "#5d6773"], L: ["#b49c72", "#6b5a3a"], N: ["#9a9a9e", "#55555c"],
};
export function frameFor(c) {
  const colors = (c && c.colors) || [];
  const types = (c && c.types) || [];
  let k = "N";
  if (colors.length > 1) k = "M";
  else if (colors.length === 1) k = colors[0];
  else if (types.indexOf("land") >= 0) k = "L";
  else if (types.indexOf("artifact") >= 0) k = "A";
  return FR[k] || FR.N;
}

export function typeLineOf(c) {
  if (!c) return "";
  if (c.type_line) return c.type_line;
  const a = [].concat(c.supertypes || [], c.types || []).map(cap).join(" ");
  const sub = (c.subtypes || []).map(cap).join(" ");
  return a + (sub ? " — " + sub : "");
}

/* A "view" is the display data of one card, from an engine object or from raw card data. */
export function viewOfObj(o) {
  const c = o.c || {};
  const pt = c.power != null && c.toughness != null && (c.types || []).indexOf("creature") >= 0 ? c.power + "/" + c.toughness : "";
  if (o.faceDown && (o.zone === "battlefield" || o.zone === "stack" || o.zone === "phased" || o.zone === "exile"))
    return { name: "Face-down", cost: "", type: o.zone === "exile" ? "Face-down card" : "Creature", text: o.zone === "exile" ? "" : "A face-down 2/2 creature with no name, colour or abilities.", pt: o.zone === "exile" ? "" : pt, img: "", frame: FR.N, token: false, types: o.zone === "exile" ? [] : ["creature"], faceDown: true };
  return {
    name: c.name || "Card", cost: c.cost || "", type: typeLineOf(c), text: c.text || "", pt, img: c.img || "",
    frame: frameFor(c), token: !!o.token, types: c.types || [],
  };
}
export function viewOfData(d) {
  if (!d) return { name: "?", cost: "", type: "", text: "", pt: "", img: "", frame: FR.N, token: false, types: [] };
  const f0 = d.faces && d.faces[0];
  const colors = d.colors || (f0 && f0.colors) || [];
  const tl = d.type_line || (f0 && f0.type_line) || "";
  const types = tl.toLowerCase().split("—")[0].split(/\s+/).filter(Boolean);
  return {
    name: d.name, cost: d.mana_cost || (f0 && f0.mana_cost) || "", type: tl, text: d.oracle_text || (f0 && f0.oracle_text) || "",
    pt: d.pt || (f0 && f0.pt) || "", img: d.img || (f0 && f0.img) || "", frame: frameFor({ colors, types }), token: false, types,
  };
}

/* ---------- the card element ---------- */
export function makeCard() {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML =
    '<div class="fr"><div class="f-top"><span class="f-name"></span><span class="f-cost"></span></div>' +
    '<div class="f-art"><span class="f-ico"></span></div><div class="f-type"></div><div class="f-text"></div><div class="f-pt"></div></div>' +
    '<img class="im" alt="" decoding="async" draggable="false"><div class="ov"></div>';
  const r = (el._r = {
    name: el.querySelector(".f-name"), cost: el.querySelector(".f-cost"), type: el.querySelector(".f-type"),
    text: el.querySelector(".f-text"), pt: el.querySelector(".f-pt"), ico: el.querySelector(".f-ico"),
    img: el.querySelector(".im"), ov: el.querySelector(".ov"),
  });
  r.img.addEventListener("load", () => el.classList.add("ld"));
  r.img.addEventListener("error", () => { el.classList.add("noimg"); el.classList.remove("ld"); });
  return el;
}

const ICO = { creature: "⚔", planeswalker: "✦", artifact: "⚙", enchantment: "❀", land: "▲", instant: "ϟ", sorcery: "✶", battle: "⚑" };
function icoFor(types) {
  for (const t of ["creature", "planeswalker", "land", "artifact", "enchantment", "instant", "sorcery", "battle"]) if ((types || []).indexOf(t) >= 0) return ICO[t];
  return "◆";
}

/* Fill the static face. `size` picks the Scryfall rendition: small | normal | large. */
export function fillCard(el, v, size) {
  const key = v.name + "|" + v.cost + "|" + v.type + "|" + v.text + "|" + v.pt + "|" + v.img + "|" + (size || "small") + "|" + (v.token ? 1 : 0) + "|" + (v.faceDown ? 1 : 0);
  if (el._fk === key) return;
  el._fk = key;
  const r = el._r;
  r.name.textContent = v.name;
  r.cost.innerHTML = manaHtml(v.cost);
  r.type.textContent = v.type;
  r.text.innerHTML = textHtml(v.text);
  r.pt.textContent = v.pt;
  r.pt.hidden = !v.pt;
  r.ico.textContent = v.token ? "❖" : icoFor(v.types);
  el.style.setProperty("--fa", v.frame[0]);
  el.style.setProperty("--fb", v.frame[1]);
  el.classList.toggle("is-token", !!v.token);
  el.classList.toggle("is-facedown", !!v.faceDown);
  el.setAttribute("data-name", v.name);
  const url = v.img ? imgSize(v.img, size || "small") : "";
  if (url) {
    if (r.img.getAttribute("src") !== url) {
      el.classList.remove("ld", "noimg");
      r.img.src = url;
    }
  } else {
    r.img.removeAttribute("src");
    el.classList.add("noimg");
    el.classList.remove("ld");
  }
}

const SHORT = { "+1/+1": "+1/+1", "-1/-1": "−1/−1", loyalty: "", charge: "charge", time: "time" };
/* Live overlay: P/T (coloured when buffed or damaged), counters, loyalty, badges. */
export function setLive(el, o, flags) {
  flags = flags || {};
  const c = o.c || {};
  const types = c.types || [];
  const isCre = types.indexOf("creature") >= 0;
  const isPW = types.indexOf("planeswalker") >= 0;
  const dmg = o.damage || 0;
  const def = o.faceDown ? { power: 2, toughness: 2 } : o.mergeDef || o.copyDef || o.def || {};
  let basePow = def.power, baseTou = def.toughness;
  const counters = o.counters || {};
  const sig = [c.power, c.toughness, dmg, isCre, isPW, JSON.stringify(counters), (c.unparsed || []).length, o.token ? 1 : 0, o.sick ? 1 : 0, flags.n || 0, flags.order || 0, flags.badge || "", c.loyalty, o.attachedTo ? 1 : 0, flags.attcount || 0, o.isCommander ? 1 : 0, o.faceDown ? 1 : 0, (o.pile || []).length, o.zone === "phased" ? 1 : 0, flags.mine ? 1 : 0].join("|");
  if (el._ls === sig) return;
  el._ls = sig;
  let h = "";
  if (isCre && c.power != null) {
    let cls = "pt3";
    const tough = typeof c.toughness === "number" ? c.toughness - dmg : c.toughness;
    const buffP = typeof basePow === "number" && typeof c.power === "number" && c.power > basePow;
    const buffT = typeof baseTou === "number" && typeof c.toughness === "number" && c.toughness > baseTou;
    const nerf = (typeof basePow === "number" && c.power < basePow) || (typeof baseTou === "number" && c.toughness < baseTou);
    if (dmg > 0) cls += " hurt";
    else if (nerf) cls += " nerf";
    else if (buffP || buffT) cls += " buff";
    h += '<span class="' + cls + '"><b>' + esc(c.power) + "</b>/<b>" + esc(tough) + "</b></span>";
  }
  const cn = [];
  Object.keys(counters).forEach((k) => {
    if (!counters[k] || (k === "loyalty" && isPW)) return;
    cn.push('<span class="cn">' + esc(SHORT[k] != null ? SHORT[k] : k) + (counters[k] > 1 || SHORT[k] === "" ? " ×" + counters[k] : "") + "</span>");
  });
  if (cn.length) h += '<span class="cns">' + cn.join("") + "</span>";
  if (isPW) {
    const L = counters.loyalty != null ? counters.loyalty : c.loyalty;
    if (L != null) h += '<span class="loy">' + esc(L) + "</span>";
  }
  const bd = [];
  if (o.token) bd.push('<span class="bd tk" title="Token">T</span>');
  if (c.unparsed && c.unparsed.length) bd.push('<span class="bd warn" title="Partly automated">⚠</span>');
  if (o.isCommander) bd.push('<span class="bd cmd" title="Commander">★</span>');
  if (o.faceDown && flags.mine) bd.push('<span class="bd fd" title="Face down — only you know what it is">◐</span>');
  if (o.pile && o.pile.length > 1) bd.push('<span class="bd mut" title="Mutated: ' + o.pile.length + ' cards">⧉' + o.pile.length + "</span>");
  if (bd.length) h += '<span class="bds">' + bd.join("") + "</span>";
  if (flags.n > 1) h += '<span class="xn">×' + flags.n + "</span>";
  if (flags.order) h += '<span class="ord">' + flags.order + "</span>";
  if (flags.badge) h += '<span class="tag">' + esc(flags.badge) + "</span>";
  if (o.sick && isCre) h += '<span class="zz" title="Summoning sick">z</span>';
  el._r.ov.innerHTML = h;
}

/* A small stand-alone card (lists, pickers, lobby): static data only. */
export function cardFromData(d, size) {
  const el = makeCard();
  fillCard(el, viewOfData(d), size || "small");
  return el;
}
export function cardFromObj(o, size) {
  const el = makeCard();
  fillCard(el, viewOfObj(o), size || "small");
  setLive(el, o);
  return el;
}
