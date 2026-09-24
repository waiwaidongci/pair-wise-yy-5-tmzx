"use strict";
/*
 * 三类数据分别承载（各自独立的 localStorage 键）：
 *   CanvasStore    画布数据  → brocade.canvas.v1
 *   CompatStore    配伍判定  → brocade.compat.v1（复核单、染缸、批次）
 *   HandoverStore  交接记录  → brocade.handover.v1（机台占用、交接流水）
 */

const TOLERANCE = 10;               // 批次色距容差 ΔE，超差即与样卡不符
const DRY_MS = 10 * 60 * 1000;      // 染缸晾干时长：未晾干不能接下一份
const DEFAULT_PALETTE = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"];

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}
function writeJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

const CanvasStore = {
  key: "brocade.canvas.v1",
  load() { return readJSON(this.key, null); },
  save(snap) { writeJSON(this.key, Object.assign({}, snap, { savedAt: Date.now() })); }
};

const CompatStore = {
  key: "brocade.compat.v1",
  data: null,
  load() {
    this.data = readJSON(this.key, null);
    if (!this.data) { this.data = seedCompat(); this.persist(); }
    return this.data;
  },
  persist() { writeJSON(this.key, this.data); }
};

const HandoverStore = {
  key: "brocade.handover.v1",
  data: null,
  load() {
    this.data = readJSON(this.key, null);
    if (!this.data) { this.data = seedHandover(); this.persist(); }
    return this.data;
  },
  persist() { writeJSON(this.key, this.data); }
};

function seedCompat() {
  const now = Date.now();
  return {
    tolerance: TOLERANCE,
    vats: [
      { id: "V1", name: "甲字染缸", state: "idle", dryingUntil: null, sheetId: null },
      { id: "V2", name: "乙字染缸", state: "idle", dryingUntil: null, sheetId: null },
      { id: "V3", name: "丙字染缸", state: "drying", dryingUntil: now + 6 * 60 * 1000, sheetId: null },
      { id: "V4", name: "丁字染缸", state: "idle", dryingUntil: null, sheetId: null },
      { id: "V5", name: "戊字染缸", state: "idle", dryingUntil: null, sheetId: null }
    ],
    batches: [
      { id: "B1", vatId: "V1", colorIndex: 1, sampleHex: "#a6322d", measuredHex: "#a83830", measuredAt: now - 3600000, createdAt: now - 3700000 },
      { id: "B2", vatId: "V2", colorIndex: 2, sampleHex: "#1f5f78", measuredHex: null, measuredAt: null, createdAt: now - 3500000 },
      { id: "B3", vatId: "V4", colorIndex: 3, sampleHex: "#d6a437", measuredHex: "#be9646", measuredAt: now - 3400000, createdAt: now - 3500000 }
    ],
    sheets: []
  };
}

function seedHandover() {
  return {
    machines: [
      { id: "M1", name: "一号机台", sheetId: null, since: null },
      { id: "M2", name: "二号机台", sheetId: null, since: null },
      { id: "M3", name: "三号机台", sheetId: null, since: null }
    ],
    records: []
  };
}
