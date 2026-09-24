"use strict";
/*
 * 上机配伍台主逻辑。
 * 数据分三段承载（见 js/stores.js）：画布数据 / 配伍判定 / 交接记录。
 */

// ---------- 画布状态 ----------
let cols = 18, rows = 14, cells = [], palette = DEFAULT_PALETTE.slice(), block = "dot";
let active = 1, dragging = false, undoStack = [], redoStack = [];

const $ = s => document.querySelector(s);
const STATUS_TEXT = { pending: "待复核", passed: "复核通过", returned: "退回配色", invalid: "已失效·需重排", handed: "已交接上机" };
const ACTIVE_STATUS = ["pending", "returned", "passed"];   // 仍具效力的复核单
const EDITABLE_STATUS = ["pending", "returned"];           // 可登记染缸批次的复核单

// ---------- 小工具 ----------
function djb2(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, "0"); }
function snapshotCanvas() { return { cols, rows, cells: cells.slice(), palette: palette.slice(), block }; }
function fingerprint(snap) { return djb2(JSON.stringify(snap)); }
function diffReasons(a, b) {
  const r = [];
  if (a.cols !== b.cols || a.rows !== b.rows) r.push("图案行列变更");
  if (JSON.stringify(a.palette) !== JSON.stringify(b.palette)) r.push("色位变更");
  if (a.block !== b.block) r.push("基础块变更");
  if (JSON.stringify(a.cells) !== JSON.stringify(b.cells)) r.push("图案纹样变更");
  return r;
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex(r, g, b) { return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
function colorDistance(a, b) { const A = hexToRgb(a), B = hexToRgb(b); return Math.sqrt((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2); }
function jitter(hex) { const c = hexToRgb(hex); const j = () => Math.round((Math.random() * 2 - 1) * 12); return rgbToHex(c[0] + j(), c[1] + j(), c[2] + j()); }
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(ts) { const d = new Date(ts); return (d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
function fmtLeft(ms) { if (ms <= 0) return "00:00"; const s = Math.ceil(ms / 1000); return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60); }
function fmtElapsed(ts) { const m = Math.floor((Date.now() - ts) / 60000); return m < 60 ? "已上机 " + m + " 分钟" : "已上机 " + Math.floor(m / 60) + " 小时 " + (m % 60) + " 分"; }
let toastTimer = null;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600); }

// ---------- 数据访问 ----------
function sheets() { return CompatStore.data.sheets; }
function latestSheet() { const s = sheets(); return s[s.length - 1] || null; }
function vat(id) { return CompatStore.data.vats.find(v => v.id === id); }
function batch(id) { return CompatStore.data.batches.find(b => b.id === id); }
function machine(id) { return HandoverStore.data.machines.find(m => m.id === id); }
function machineName(id) { const m = machine(id); return m ? m.name : "?"; }
function sheetVersion(id) { const s = sheets().find(x => x.id === id); return s ? "v" + s.version : "—"; }
function usedColors() {
  return palette.map((_, i) => ({ index: i, count: cells.filter(v => v === i).length })).filter(o => o.count > 0);
}

// ---------- 复核单失效：行列、色位、基础块、纹样一动即失效 ----------
function invalidateChangedSheets() {
  const snap = snapshotCanvas(), fp = fingerprint(snap);
  let changed = false;
  sheets().forEach(s => {
    if (ACTIVE_STATUS.includes(s.status) && s.fingerprint !== fp) {
      const diffs = diffReasons(s.snapshot, snap);
      s.status = "invalid";
      s.invalidReason = (diffs.length ? diffs.join("、") : "纹样变动") + "，复核单失效，需重排";
      releaseVats(s);
      changed = true;
    }
  });
  if (changed) CompatStore.persist();
}
function releaseVats(s) {
  CompatStore.data.vats.forEach(v => { if (v.sheetId === s.id && v.state === "busy") { v.state = "idle"; v.sheetId = null; } });
}
function afterCanvasMutation() { invalidateChangedSheets(); renderAll(); }

// ---------- 保存纹样 → 生成待复核用色清单 ----------
function savePattern() {
  const snap = snapshotCanvas(), fp = fingerprint(snap);
  const latest = latestSheet();
  if (latest && latest.status !== "invalid" && latest.fingerprint === fp) {
    toast("纹样未变动，复核单 v" + latest.version + " 仍有效。");
    return;
  }
  CanvasStore.save(snap);
  sheets().forEach(s => {
    if (ACTIVE_STATUS.includes(s.status)) {
      const diffs = diffReasons(s.snapshot, snap);
      s.status = "invalid";
      s.invalidReason = (diffs.length ? diffs.join("、") : "纹样变动") + "，复核单失效，需重排";
      releaseVats(s);
    }
  });
  const prev = [...sheets()].reverse().find(s => s.items && s.items.length);
  const sheet = {
    id: "S" + Date.now(), version: nextVersion(), createdAt: Date.now(), fingerprint: fp, snapshot: snap,
    status: "pending", reviewedAt: null, reasons: [], invalidReason: "", items: []
  };
  // 重排时沿用上版可复用的染缸与批次登记
  sheet.items = usedColors().map(c => {
    const it = { colorIndex: c.index, count: c.count, vatId: null, batchId: null };
    const p = prev && prev.items.find(o => o.colorIndex === c.index);
    if (p && p.vatId) {
      const v = vat(p.vatId);
      if (v && v.state === "idle" && !sheet.items.some(o => o.vatId === v.id)) {
        it.vatId = v.id; v.state = "busy"; v.sheetId = sheet.id;
        if (p.batchId) { const b = batch(p.batchId); if (b && b.vatId === v.id && b.colorIndex === c.index) it.batchId = b.id; }
      }
    }
    return it;
  });
  sheets().push(sheet);
  CompatStore.persist();
  renderAll();
  toast("已保存纹样，生成待复核用色清单 v" + sheet.version + "。");
}
function nextVersion() { return sheets().reduce((m, s) => Math.max(m, s.version), 0) + 1; }

// ---------- 配伍判定 ----------
function computeReasons(sheet) {
  const rs = [], tol = CompatStore.data.tolerance;
  sheet.items.forEach(it => {
    const label = "色位" + it.colorIndex;
    const v = it.vatId ? vat(it.vatId) : null;
    const b = it.batchId ? batch(it.batchId) : null;
    if (!v) rs.push(label + "：未登记染缸");
    else if (v.state === "drying") rs.push(label + "：" + v.name + "未晾干，不能接下一份");
    else if (v.state === "busy" && v.sheetId !== sheet.id) rs.push(label + "：" + v.name + "被其他复核单占用");
    if (!b) rs.push(label + "：未登记批次");
    else if (!b.measuredHex) rs.push(label + "：批次" + b.id + "色距未复测");
    else {
      const d = colorDistance(b.measuredHex, b.sampleHex);
      if (d > tol) rs.push(label + "：批次" + b.id + "色距ΔE " + d.toFixed(1) + " 超差（容差≤" + tol + "），与样卡不符");
    }
  });
  return rs;
}
function itemStatus(s, it) {
  const v = it.vatId ? vat(it.vatId) : null;
  const b = it.batchId ? batch(it.batchId) : null;
  if (!v) return '<span class="bad">待登记染缸</span>';
  if (v.state === "drying") return '<span class="bad">染缸未晾干</span>';
  if (!b) return '<span class="bad">待登记批次</span>';
  if (!b.measuredHex) return '<span class="warn-t">待复测色距</span>';
  const d = colorDistance(b.measuredHex, b.sampleHex);
  if (d > CompatStore.data.tolerance) return '<span class="bad">ΔE ' + d.toFixed(1) + ' 超差</span>';
  return '<span class="ok">齐备 ΔE ' + d.toFixed(1) + '</span>';
}
function reviewSheet() {
  const s = latestSheet();
  if (!s || !EDITABLE_STATUS.includes(s.status)) return;
  const rs = computeReasons(s);
  s.reasons = rs;
  s.reviewedAt = Date.now();
  s.status = rs.length ? "returned" : "passed";
  CompatStore.persist();
  renderAll();
  toast(rs.length ? "复核未通过，已退回配色。" : "复核通过，可交接上机。");
}

// ---------- 染缸登记（同一染缸未晾干不能接下一份） ----------
function onItemVat(s, idx, vatId) {
  const it = s.items[idx];
  if (it.vatId) {
    const ov = vat(it.vatId);
    if (ov && ov.sheetId === s.id && ov.state === "busy" && !s.items.some((o, j) => j !== idx && o.vatId === ov.id)) {
      ov.state = "idle"; ov.sheetId = null;
    }
  }
  it.vatId = vatId || null;
  it.batchId = null;
  if (vatId) {
    const v = vat(vatId);
    if (v.state === "drying") { it.vatId = null; toast(v.name + " 未晾干，不能接下一份。"); }
    else { v.state = "busy"; v.sheetId = s.id; }
  }
  CompatStore.persist();
  renderSheet();
  renderVats();
}
function newBatch() {
  const v = vat($("#nbVat").value);
  const ci = Number($("#nbColor").value);
  if (!v) { toast("请选择染缸。"); return; }
  if (v.state === "drying") { toast(v.name + " 未晾干，不能接下一份。"); return; }
  const b = {
    id: "B" + (CompatStore.data.batches.length + 1) + "-" + String(Date.now()).slice(-4),
    vatId: v.id, colorIndex: ci, sampleHex: palette[ci], measuredHex: null, measuredAt: null, createdAt: Date.now()
  };
  CompatStore.data.batches.push(b);
  CompatStore.persist();
  renderBatches();
  renderSheet();
  toast("已开批次 " + b.id + "（色位" + ci + "），待复测。");
}
function remeasure(id) {
  const b = batch(id);
  if (!b) return;
  b.measuredHex = jitter(b.sampleHex);
  b.measuredAt = Date.now();
  CompatStore.persist();
  renderBatches();
  renderSheet();
  const d = colorDistance(b.measuredHex, b.sampleHex);
  toast("批次 " + b.id + " 复测 ΔE " + d.toFixed(1) + (d > CompatStore.data.tolerance ? "，超差，与样卡不符。" : "，合格。"));
}

// ---------- 交接上机 / 机台 ----------
function doHandover() {
  const s = latestSheet();
  if (!s || s.status !== "passed") return;
  const sel = $("#machineSel");
  const m = sel && machine(sel.value);
  if (!m) { toast("暂无空闲机台。"); return; }
  const rs = computeReasons(s);
  if (rs.length) { s.status = "returned"; s.reasons = rs; CompatStore.persist(); renderAll(); toast("配伍状态已变化，已退回配色。"); return; }
  m.sheetId = s.id;
  m.since = Date.now();
  s.status = "handed";
  s.handedAt = Date.now();
  [...new Set(s.items.map(it => it.vatId).filter(Boolean))].forEach(id => {
    const v = vat(id);
    v.state = "drying";
    v.dryingUntil = Date.now() + DRY_MS;
    v.sheetId = s.id;
  });
  HandoverStore.data.records.push({
    id: "J" + Date.now(), sheetId: s.id, version: s.version, machineId: m.id, at: Date.now(), status: "在机", doneAt: null,
    items: s.items.map(it => {
      const b = batch(it.batchId);
      return {
        colorIndex: it.colorIndex, count: it.count,
        vatName: (vat(it.vatId) || {}).name || "?", batchId: it.batchId,
        dE: b && b.measuredHex ? Number(colorDistance(b.measuredHex, b.sampleHex).toFixed(1)) : null
      };
    })
  });
  CompatStore.persist();
  HandoverStore.persist();
  renderAll();
  toast("复核单 v" + s.version + " 已交接" + m.name + "，染缸进入晾干。");
}
function completeMachine(id) {
  const m = machine(id);
  if (!m || !m.sheetId) return;
  const rec = HandoverStore.data.records.find(r => r.machineId === id && r.status === "在机");
  if (rec) { rec.status = "完工"; rec.doneAt = Date.now(); }
  m.sheetId = null;
  m.since = null;
  HandoverStore.persist();
  renderMachines();
  renderRecords();
  toast(m.name + " 已完工释放。");
}

// ---------- 历史版本回排 ----------
function restoreVersion(id) {
  const s = sheets().find(x => x.id === id);
  if (!s) return;
  cols = s.snapshot.cols; rows = s.snapshot.rows;
  cells = s.snapshot.cells.slice();
  palette = s.snapshot.palette.slice();
  block = s.snapshot.block || "dot";
  undoStack = []; redoStack = [];
  $("#cols").value = cols;
  $("#rows").value = rows;
  afterCanvasMutation();
  toast("已回排 v" + s.version + " 纹样，调整后请重新保存生成新复核单。");
}

// ---------- 渲染：画布 ----------
function renderPalette() {
  const pe = $("#palette");
  pe.innerHTML = palette.map((c, i) => '<button class="swatch' + (i === active ? " active" : "") + '" data-color="' + i + '" style="background:' + c + '" title="色位' + i + '"></button>').join("");
  pe.querySelectorAll("[data-color]").forEach(el => el.onclick = () => { active = Number(el.dataset.color); renderAll(); });
  const ce = $("#colorEdit");
  if (document.activeElement !== ce) ce.value = palette[active];
  $("#activeColorLabel").textContent = "色位" + active;
  document.querySelectorAll("[data-block]").forEach(b => b.classList.toggle("active", b.dataset.block === block));
}
function renderGrid() {
  const g = $("#grid");
  g.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
  g.innerHTML = cells.map((v, i) => '<div class="cell" data-i="' + i + '" style="background:' + palette[v] + '"></div>').join("");
  g.querySelectorAll(".cell").forEach(el => {
    el.onpointerdown = () => { dragging = true; paint(Number(el.dataset.i)); };
    el.onpointerenter = () => { if (dragging) paint(Number(el.dataset.i)); };
  });
}
function paint(i) {
  undoStack.push(cells.slice());
  redoStack = [];
  if (undoStack.length > 50) undoStack.shift();
  patternTargets(i).forEach(t => { cells[t] = active; });
  afterCanvasMutation();
}
function patternTargets(i) {
  const x = i % cols, y = Math.floor(i / cols);
  if (block === "cross") return [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)].filter(v => v !== null);
  if (block === "diamond") return [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)].filter(v => v !== null);
  return [i];
}
function idx(x, y) { return x < 0 || x >= cols || y < 0 || y >= rows ? null : y * cols + x; }
function renderStats() {
  const counts = palette.map((_, i) => cells.filter(v => v === i).length);
  $("#stats").innerHTML = counts.map((n, i) => '<div class="stat"><span><span class="sw" style="background:' + palette[i] + '"></span>色位' + i + '</span><b>' + n + '</b></div>').join("");
  $("#preview").innerHTML = Array.from({ length: 36 }, (_, i) => '<div class="mini" style="background:' + palette[cells[(i % 6) + Math.floor(i / 6) * cols] || 0] + '"></div>').join("");
  const riskRows = [];
  for (let y = 0; y < rows; y++) {
    let switches = 0;
    for (let x = 1; x < cols; x++) if (cells[y * cols + x] !== cells[y * cols + x - 1]) switches++;
    if (switches > cols * .62) riskRows.push(y + 1);
  }
  $("#risk").innerHTML = riskRows.length ? '<p class="warning">第' + riskRows.join("、") + '行换色过密，可能断线。</p>' : "<p>暂无明显断线风险。</p>";
}

// ---------- 渲染：复核单 ----------
function renderBanner() {
  const el = $("#banner");
  const s = latestSheet();
  let msg = "", cls = "";
  if (!s) { msg = "尚未生成复核单：保存纹样后自动生成待复核用色清单。"; cls = "info"; }
  else if (s.status === "invalid") { msg = "复核单 v" + s.version + " 已失效（" + s.invalidReason + "）。请重排纹样后点击“保存纹样”重新生成。"; cls = "warn"; }
  else if (ACTIVE_STATUS.includes(s.status) && s.fingerprint !== fingerprint(snapshotCanvas())) { msg = "纹样已变动，复核单需重排。"; cls = "warn"; }
  else if (s.status === "handed" && s.fingerprint !== fingerprint(snapshotCanvas())) { msg = "纹样已有新改动，如需再次上机请重新保存生成复核单。"; cls = "info"; }
  el.className = "banner" + (cls ? " " + cls : "");
  el.textContent = msg;
}
function vatOptions(s, it, i) {
  const used = s.items.filter((o, j) => j !== i && o.vatId).map(o => o.vatId);
  let h = '<select class="vatSel" data-idx="' + i + '"><option value="">选择染缸</option>';
  CompatStore.data.vats.forEach(v => {
    let label = v.name, dis = false;
    if (v.state === "drying") { label += "（未晾干）"; dis = true; }
    else if (v.state === "busy" && v.sheetId !== s.id) { label += "（他单占用）"; dis = true; }
    else if (used.includes(v.id)) { label += "（本单他色已用）"; dis = true; }
    else if (v.state === "busy") { label += "（本单占用）"; }
    h += '<option value="' + v.id + '"' + (it.vatId === v.id ? " selected" : "") + (dis ? " disabled" : "") + ">" + label + "</option>";
  });
  return h + "</select>";
}
function batchOptions(s, it, i) {
  let h = '<select class="batchSel" data-idx="' + i + '"' + (it.vatId ? "" : " disabled") + '><option value="">选择批次</option>';
  CompatStore.data.batches.filter(b => b.vatId === it.vatId && b.colorIndex === it.colorIndex).forEach(b => {
    const d = b.measuredHex ? colorDistance(b.measuredHex, b.sampleHex) : null;
    h += '<option value="' + b.id + '"' + (it.batchId === b.id ? " selected" : "") + ">" + b.id + (d === null ? "（未复测）" : "（ΔE " + d.toFixed(1) + "）") + "</option>";
  });
  return h + "</select>";
}
function renderSheet() {
  const body = $("#sheetBody");
  const s = latestSheet();
  if (!s) { body.innerHTML = '<p class="muted">保存纹样后，自动生成待复核用色清单。</p>'; return; }
  const editable = EDITABLE_STATUS.includes(s.status);
  const snapPalette = s.snapshot.palette || palette;
  let html = '<div class="sheet-head"><b>复核单 v' + s.version + '</b> <span class="badge ' + s.status + '">' + STATUS_TEXT[s.status] + '</span><span class="muted">' + fmtTime(s.createdAt) + " · 指纹 " + s.fingerprint + "</span></div>";
  if (s.status === "invalid") html += '<p class="warning">' + s.invalidReason + '</p><div class="btnrow"><button id="rearrangeBtn">以当前纹样重排并生成新复核单</button></div>';
  html += '<table class="items"><tr><th>色位</th><th>用量</th><th>染缸</th><th>批次</th><th>状态</th></tr>';
  s.items.forEach((it, i) => {
    html += '<tr><td><span class="sw" style="background:' + snapPalette[it.colorIndex] + '"></span>色位' + it.colorIndex + "</td><td>" + it.count + "</td>";
    if (editable) html += "<td>" + vatOptions(s, it, i) + "</td><td>" + batchOptions(s, it, i) + "</td>";
    else {
      const v = it.vatId ? vat(it.vatId) : null, b = it.batchId ? batch(it.batchId) : null;
      html += "<td>" + (v ? v.name : "—") + "</td><td>" + (b ? b.id : "—") + "</td>";
    }
    html += "<td>" + itemStatus(s, it) + "</td></tr>";
  });
  html += "</table>";
  if (editable) {
    const rs = computeReasons(s);
    html += "<h3>待复核原因</h3>" + (rs.length ? '<ul class="reasons">' + rs.map(r => "<li>" + r + "</li>").join("") + "</ul>" : '<p class="ok">各项齐备，可提交复核。</p>');
    html += '<div class="btnrow"><button id="reviewBtn">复核判定</button></div>';
  }
  if (s.status === "passed") {
    const free = HandoverStore.data.machines.filter(m => !m.sheetId);
    html += "<h3>交接上机</h3>" + (free.length
      ? '<div class="btnrow"><select id="machineSel">' + free.map(m => '<option value="' + m.id + '">' + m.name + "</option>").join("") + '</select><button id="handoverBtn">交接上机</button></div>'
      : '<p class="bad">无空闲机台，待完工释放。</p>');
  }
  if (s.status === "handed") {
    const rec = [...HandoverStore.data.records].reverse().find(r => r.sheetId === s.id);
    html += '<p class="ok">已交接 ' + (rec ? machineName(rec.machineId) : "") + " 上机，所用染缸进入晾干。</p>";
  }
  body.innerHTML = html;
  if (editable) {
    body.querySelectorAll("select.vatSel").forEach(sel => sel.onchange = () => onItemVat(s, Number(sel.dataset.idx), sel.value));
    body.querySelectorAll("select.batchSel").forEach(sel => sel.onchange = () => { s.items[Number(sel.dataset.idx)].batchId = sel.value || null; CompatStore.persist(); renderSheet(); });
    const rb = $("#reviewBtn");
    if (rb) rb.onclick = reviewSheet;
  }
  const hb = $("#handoverBtn");
  if (hb) hb.onclick = doHandover;
  const rg = $("#rearrangeBtn");
  if (rg) rg.onclick = savePattern;
}

// ---------- 渲染：染缸与批次 ----------
function renderVats() {
  $("#vatList").innerHTML = CompatStore.data.vats.map(v => {
    let st;
    if (v.state === "drying") st = '<span class="badge drying">晾干中</span> <span class="warn-t" data-cd="' + v.dryingUntil + '" data-prefix="剩余 ">' + fmtLeft(v.dryingUntil - Date.now()) + "</span>";
    else if (v.state === "busy") st = '<span class="badge busy">占用</span> <span class="muted">复核单 ' + sheetVersion(v.sheetId) + "</span>";
    else st = '<span class="badge idle">空闲</span>';
    return '<div class="rowline"><b>' + v.name + "</b> " + st + "</div>";
  }).join("");
  const sel = $("#nbVat");
  const cur = sel.value;
  sel.innerHTML = CompatStore.data.vats.map(v => '<option value="' + v.id + '"' + (v.state === "drying" ? " disabled" : "") + ">" + v.name + (v.state === "drying" ? "（未晾干）" : v.state === "busy" ? "（占用中）" : "") + "</option>").join("");
  if (cur && vat(cur) && vat(cur).state !== "drying") sel.value = cur;
}
function renderBatches() {
  const tol = CompatStore.data.tolerance;
  const bs = [...CompatStore.data.batches].reverse();
  $("#batchList").innerHTML = bs.length ? bs.map(b => {
    const v = vat(b.vatId);
    let mid;
    if (b.measuredHex) {
      const d = colorDistance(b.measuredHex, b.sampleHex);
      mid = '<span class="sw" style="background:' + b.sampleHex + '"></span>→<span class="sw" style="background:' + b.measuredHex + '"></span> <span class="' + (d > tol ? "bad" : "ok") + '">ΔE ' + d.toFixed(1) + (d > tol ? " 超差" : " 合格") + "</span>";
    } else {
      mid = '<span class="sw" style="background:' + b.sampleHex + '"></span>→<span class="warn-t">未复测</span>';
    }
    return '<div class="rowline"><b>' + b.id + '</b> <span class="sw" style="background:' + palette[b.colorIndex] + '"></span>色位' + b.colorIndex + " · " + (v ? v.name : "?") + "<br>" + mid + ' <button class="mini-btn" data-rem="' + b.id + '">复测</button></div>';
  }).join("") : '<p class="muted">暂无批次。</p>';
  document.querySelectorAll("[data-rem]").forEach(btn => btn.onclick = () => remeasure(btn.dataset.rem));
}

// ---------- 渲染：机台与交接 ----------
function renderMachines() {
  $("#machineList").innerHTML = HandoverStore.data.machines.map(m => {
    if (m.sheetId) return '<div class="rowline"><b>' + m.name + '</b> <span class="badge busy">占用中</span> <span class="muted">复核单 ' + sheetVersion(m.sheetId) + '</span> <span data-elapsed="' + m.since + '">' + fmtElapsed(m.since) + '</span> <button class="mini-btn" data-done="' + m.id + '">完工</button></div>';
    return '<div class="rowline"><b>' + m.name + '</b> <span class="badge idle">空闲</span></div>';
  }).join("");
  document.querySelectorAll("[data-done]").forEach(btn => btn.onclick = () => completeMachine(btn.dataset.done));
}
function renderRecords() {
  const rs = [...HandoverStore.data.records].reverse();
  $("#recordList").innerHTML = rs.length ? rs.map(r => {
    const items = r.items.map(it => "色位" + it.colorIndex + "→" + it.vatName + "/" + it.batchId + (it.dE != null ? "（ΔE " + it.dE + "）" : "")).join("，");
    return '<div class="rowline"><b>' + fmtTime(r.at) + "</b> 复核单 v" + r.version + " → " + machineName(r.machineId) + '<br><span class="muted">' + items + '</span><br><span class="badge ' + (r.status === "在机" ? "busy" : "idle") + '">' + r.status + "</span>" + (r.doneAt ? '<span class="muted"> ' + fmtTime(r.doneAt) + "</span>" : "") + "</div>";
  }).join("") : '<p class="muted">暂无交接记录。</p>';
}

// ---------- 渲染：历史版本 ----------
function renderHistory() {
  const ss = [...sheets()].reverse();
  $("#versionList").innerHTML = ss.length ? ss.map(s =>
    '<div class="rowline"><b>v' + s.version + '</b> <span class="badge ' + s.status + '">' + STATUS_TEXT[s.status] + '</span> <span class="muted">' + fmtTime(s.createdAt) + " · 指纹 " + s.fingerprint + "</span>" +
    (s.invalidReason ? '<br><span class="bad">' + s.invalidReason + "</span>" : "") +
    ' <button class="mini-btn" data-restore="' + s.id + '">回排此版</button></div>'
  ).join("") : '<p class="muted">暂无历史版本，保存纹样后生成。</p>';
  document.querySelectorAll("[data-restore]").forEach(btn => btn.onclick = () => restoreVersion(btn.dataset.restore));
}

function renderAll() {
  renderBanner();
  renderPalette();
  renderGrid();
  renderStats();
  renderSheet();
  renderVats();
  renderBatches();
  renderMachines();
  renderRecords();
  renderHistory();
}

// ---------- 定时：晾干倒计时 / 机台时长 ----------
function tick() {
  const now = Date.now();
  let changed = false;
  CompatStore.data.vats.forEach(v => {
    if (v.state === "drying" && v.dryingUntil <= now) { v.state = "idle"; v.dryingUntil = null; v.sheetId = null; changed = true; }
  });
  if (changed) { CompatStore.persist(); renderVats(); renderSheet(); toast("有染缸已晾干，可接下一份。"); }
  document.querySelectorAll("[data-cd]").forEach(el => { el.textContent = (el.dataset.prefix || "") + fmtLeft(Number(el.dataset.cd) - now); });
  document.querySelectorAll("[data-elapsed]").forEach(el => { el.textContent = fmtElapsed(Number(el.dataset.elapsed)); });
}

// ---------- 导出 ----------
function exportJSON() {
  const data = { exportedAt: new Date().toISOString(), canvas: snapshotCanvas(), compat: CompatStore.data, handover: HandoverStore.data };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "brocade-workbench.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 初始纹样 ----------
function seedCells(c, r) {
  const a = Array(c * r).fill(0);
  const cx = Math.floor(c / 2), cy = Math.floor(r / 2);
  for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) {
    const i = y * c + x;
    if ((x + y) % 6 === 0) a[i] = 2;
    if (Math.abs(x - cx) + Math.abs(y - cy) === 4) a[i] = 3;
    if (Math.abs(x - cx) + Math.abs(y - cy) === 2) a[i] = 2;
    if (x === 0 || y === 0 || x === c - 1 || y === r - 1) a[i] = 1;
  }
  return a;
}

// ---------- 事件与启动 ----------
function bindEvents() {
  document.querySelectorAll("[data-block]").forEach(btn => btn.onclick = () => { block = btn.dataset.block; afterCanvasMutation(); });
  $("#newBtn").onclick = () => { cols = Number($("#cols").value); rows = Number($("#rows").value); cells = Array(cols * rows).fill(0); undoStack = []; redoStack = []; afterCanvasMutation(); };
  $("#undoBtn").onclick = () => { if (!undoStack.length) return; redoStack.push(cells.slice()); cells = undoStack.pop(); afterCanvasMutation(); };
  $("#redoBtn").onclick = () => { if (!redoStack.length) return; undoStack.push(cells.slice()); cells = redoStack.pop(); afterCanvasMutation(); };
  $("#saveBtn").onclick = savePattern;
  $("#exportBtn").onclick = exportJSON;
  $("#colorEdit").oninput = e => { palette[active] = e.target.value; afterCanvasMutation(); };
  $("#nbBtn").onclick = newBatch;
}
function init() {
  CompatStore.load();
  HandoverStore.load();
  const saved = CanvasStore.load();
  if (saved) {
    cols = saved.cols; rows = saved.rows; cells = saved.cells;
    palette = saved.palette || DEFAULT_PALETTE.slice();
    block = saved.block || "dot";
  } else {
    cells = seedCells(cols, rows);
  }
  $("#cols").value = cols;
  $("#rows").value = rows;
  $("#nbColor").innerHTML = DEFAULT_PALETTE.map((c, i) => '<option value="' + i + '">色位' + i + "</option>").join("");
  bindEvents();
  renderAll();
  setInterval(tick, 1000);
}
window.onpointerup = () => dragging = false;
init();
