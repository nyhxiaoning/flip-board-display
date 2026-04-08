// @ts-nocheck // 临时关闭 TS 类型检查
import "./styles.scss";
import { createOkxWsClient } from "./ws";

const CHARSET = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:/-*#";
const FONT_STACK = '"JetBrains Mono Local", monospace';
const NARROW_TIME_RATIO = 0.42;
const FONT_OPTIONS = [
  { label: "JetBrains Mono（本地）", value: '"JetBrains Mono Local", monospace' },
  { label: "Roboto Mono（本地）", value: '"Roboto Mono Local", monospace' },
];
const WS_SOURCE_OPTIONS = [{ label: "OKX", value: "okx" }];

function makeId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const state = {
  title: "出发航班", // 看板标题文本。
  fontFamily: FONT_STACK, // 翻牌字符使用的主字体栈。
  charWidth: 42, // 单个字符格宽度。
  charHeight: 62, // 单个字符格高度。
  fontScale: 0.85, // 字符在格子中的占比（0.6~1.0）。
  midlineGap: 2, // 中间黑线间隔（像素）。
  tileGap: 2, // 字符格之间的水平间距。
  tileRadius: 0, // 上下翻页卡片的圆角半径。
  rowGap: 16, // 行与行之间的垂直间距。
  columnGap: 22, // 信息列之间的水平间距。
  boardPadding: 28, // 看板内容区域内边距。
  labelHeight: 26, // 列标题区域高度。
  titleHeight: 34, // 看板标题区域高度。
  flipDuration: 500, // 基础翻页时长（毫秒）。
  wsEnabled: false, // 是否启用 WebSocket 实时数据。
  wsSource: "okx", // WebSocket 数据源。
  wsSymbols: "BTC-USDT,ETH-USDT,SOL-USDT,BNB-USDT,ADA-USDT,XRP-USDT,DOGE-USDT,TRX-USDT,LTC-USDT,LINK-USDT", // 订阅交易对列表。
  wsStatus: "未连接", // 连接状态展示。
  columns: [
    { id: makeId(), label: "时间", key: "time", type: "text", length: 5, align: "right" },
    { id: makeId(), label: "目的地", key: "destination", type: "text", length: 14, align: "left" },
    { id: makeId(), label: "航班", key: "flight", type: "text", length: 6, align: "left" },
    { id: makeId(), label: "登机口", key: "gate", type: "text", length: 2, align: "right" },
    { id: makeId(), label: "状态", key: "active", type: "status" },
  ],
  rows: [
    { id: makeId(), time: "18:35", destination: "Jakarta", flight: "SQ0166", gate: "07", active: true },
    { id: makeId(), time: "18:45", destination: "Penang", flight: "SQ0198", gate: "07", active: true },
    { id: makeId(), time: "18:50", destination: "Dhaka", flight: "SQ0436", gate: "11", active: false },
    { id: makeId(), time: "18:55", destination: "Kuala Lumpur", flight: "MH6176", gate: "14", active: true },
    { id: makeId(), time: "19:00", destination: "Hong Kong", flight: "SQ0868", gate: "18", active: false },
  ],
};

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="app-shell">
    <aside class="setup-panel">
      <div class="setup-panel__header">
        <div>
          <p class="eyebrow">机场翻牌看板</p>
          <h1>配置面板</h1>
        </div>
        <button type="button" class="ghost-button" data-action="randomize">随机数据</button>
      </div>
      <div class="setup-panel__scroll" id="controls"></div>
    </aside>
    <main class="preview-panel">
      <div class="preview-panel__toolbar">
        <div>
          <p class="eyebrow">实时预览</p>
          <h2>画布看板</h2>
        </div>
        <div class="button-row">
          <button type="button" class="ghost-button" id="dataPageButton">数据页面</button>
          <button type="button" class="primary-button" id="fullscreenButton">全屏</button>
        </div>
      </div>
      <section class="stage" id="stage">
        <div class="stage__viewport" id="viewport">
          <canvas id="boardCanvas" aria-label="Airport flip board preview"></canvas>
        </div>
      </section>
    </main>
  </div>
  <section class="data-page hidden" id="dataPage">
    <div class="data-page__panel">
      <div class="data-page__header">
        <h2>批量数据编辑</h2>
        <button type="button" class="icon-button" id="closeDataPageButton">✕</button>
      </div>
      <p class="data-page__hint">按列顺序使用 | 分隔。状态列支持 true/false、1/0、是/否。</p>
      <textarea id="bulkDataTextarea" class="data-page__textarea"></textarea>
      <div class="data-page__actions">
        <button type="button" class="ghost-button" id="reloadDataPageButton">重载当前数据</button>
        <button type="button" class="primary-button" id="applyDataPageButton">应用数据</button>
      </div>
    </div>
  </section>
`;

const controlsEl = document.querySelector("#controls");
const stageEl = document.querySelector("#stage");
const viewportEl = document.querySelector("#viewport");
const canvas = document.querySelector("#boardCanvas");
const fullscreenButton = document.querySelector("#fullscreenButton");
const dataPageButton = document.querySelector("#dataPageButton");
const dataPage = document.querySelector("#dataPage");
const closeDataPageButton = document.querySelector("#closeDataPageButton");
const reloadDataPageButton = document.querySelector("#reloadDataPageButton");
const applyDataPageButton = document.querySelector("#applyDataPageButton");
const bulkDataTextarea = document.querySelector("#bulkDataTextarea");
const ctx = canvas.getContext("2d");

const tileState = new Map();
const resizeObserver = new ResizeObserver(() => renderer.render(performance.now()));
const wsDecimalCache = new Map();
const wsUpdateCounter = new Map();
const wsActivityScore = new Map();
const wsLastPriceMap = new Map();
const WS_MAX_ROWS = 10;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeChar(char) {
  const upper = (char ?? " ").toUpperCase();
  return CHARSET.includes(upper) ? upper : " ";
}

function fitText(value, length, align) {
  const normalized = String(value ?? "").toUpperCase().slice(0, length);
  if (align === "right") {
    return normalized.padStart(length, " ");
  }
  if (align === "center") {
    return normalized.padStart(Math.floor((length + normalized.length) / 2), " ").padEnd(length, " ");
  }
  return normalized.padEnd(length, " ");
}

function getSlotWidths(column) {
  if (column.type !== "text") {
    return [];
  }

  return Array.from({ length: column.length }, (_, index) => {
    if (column.key === "time" && column.length === 5 && index === 2) {
      return Math.max(12, Math.round(state.charWidth * NARROW_TIME_RATIO));
    }

    return state.charWidth;
  });
}

function isTimeColonSlot(column, charIndex) {
  return column.type === "text" && column.key === "time" && column.length === 5 && charIndex === 2;
}

function buildRollSequence(fromChar, toChar) {
  const from = sanitizeChar(fromChar);
  const to = sanitizeChar(toChar);
  const LETTERS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const DIGITS = " 0123456789";
  const SYMBOLS = " .:/-*#";

  // ":" 直接切换，不进行逐步滚动。
  if (from === ":" || to === ":") {
    return from === to ? [] : [to];
  }

  const groups = [LETTERS, DIGITS, SYMBOLS];
  const group = groups.find((charset) => charset.includes(from) && charset.includes(to));

  // 跨分组字符直接切换（例如字母 -> 数字）。
  if (!group) {
    return from === to ? [] : [to];
  }

  const startIndex = group.indexOf(from);
  const endIndex = group.indexOf(to);

  if (startIndex < 0 || endIndex < 0 || startIndex === endIndex) {
    return [];
  }

  const sequence = [];
  let index = startIndex;

  while (index !== endIndex) {
    index = (index + 1) % group.length;
    sequence.push(group[index]);
  }

  return sequence;
}

function getRollStepDuration(stepCount) {
  if (stepCount <= 1) {
    return Math.max(90, Math.round(state.flipDuration * 0.78));
  }

  // 连续字符切换时加速单步时长，避免多张连续翻动拖沓。
  return clamp(Math.round(state.flipDuration / Math.min(stepCount * 0.95 + 1.2, 8)), 55, Math.max(120, Math.round(state.flipDuration * 0.9)));
}

function getReplayStartChar(targetChar) {
  const target = sanitizeChar(targetChar);
  if ("ABCDEFGHIJKLMNOPQRSTUVWXYZ".includes(target)) {
    return "A";
  }
  if ("0123456789".includes(target)) {
    return "0";
  }
  return " ";
}

function queueTileRoll(tile, fromChar, toChar, startAt = performance.now()) {
  const sequence = buildRollSequence(fromChar, toChar);

  tile.currentChar = sanitizeChar(fromChar);
  tile.targetChar = sanitizeChar(toChar);
  tile.nextChar = sequence[0] ?? tile.targetChar;
  tile.pendingChars = sequence.slice(1);
  tile.duration = getRollStepDuration(sequence.length);
  tile.startedAt = sequence.length > 0 ? startAt : 0;
}

function makeTextColumn() {
  return {
    id: makeId(),
    label: "列",
    key: `field${state.columns.length + 1}`,
    type: "text",
    length: 6,
    align: "left",
  };
}

function makeStatusColumn() {
  return {
    id: makeId(),
    label: "状态",
    key: `status${state.columns.length + 1}`,
    type: "status",
  };
}

function makeEmptyRow() {
  const row = { id: makeId() };
  state.columns.forEach((column) => {
    row[column.key] = column.type === "status" ? true : "";
  });
  return row;
}

function syncRowsToColumns() {
  state.rows = state.rows.map((row) => {
    const next = { id: row.id };
    state.columns.forEach((column) => {
      if (column.type === "status") {
        next[column.key] = Boolean(row[column.key]);
      } else {
        next[column.key] = row[column.key] ?? "";
      }
    });
    return next;
  });
}

function updateState(mutator) {
  mutator(state);
  syncRowsToColumns();
  renderControls();
  renderer.syncTargets();
  renderer.render(performance.now());
}

function moveItem(list, from, to) {
  if (to < 0 || to >= list.length) {
    return;
  }
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

function randomToken(length) {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return text.trim() || " ";
}

function randomizeRows() {
  const destinations = ["Jakarta", "Penang", "Dhaka", "Kuala Lumpur", "Hong Kong", "Phuket", "Bali", "Kuching"];

  updateState((draft) => {
    draft.rows.forEach((row, rowIndex) => {
      draft.columns.forEach((column) => {
        if (column.type === "status") {
          row[column.key] = Math.random() > 0.4;
          return;
        }

        if (column.key === "time") {
          row[column.key] = `${18 + rowIndex}:${String(Math.floor(Math.random() * 6) * 5).padStart(2, "0")}`;
        } else if (column.key === "destination") {
          row[column.key] = destinations[Math.floor(Math.random() * destinations.length)];
        } else if (column.key === "flight") {
          row[column.key] = `${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(
            65 + Math.floor(Math.random() * 26),
          )}${Math.floor(1000 + Math.random() * 9000)}`;
        } else if (column.key === "gate") {
          row[column.key] = String(Math.floor(1 + Math.random() * 28)).padStart(2, "0");
        } else {
          row[column.key] = randomToken(column.length ?? 6);
        }
      });
    });
  });
}

function getWsColumnPreset() {
  return [
    { id: makeId(), label: "时间", key: "time", type: "text", length: 5, align: "right" },
    { id: makeId(), label: "交易对", key: "pair", type: "text", length: 10, align: "left" },
    { id: makeId(), label: "最新价", key: "last", type: "text", length: 9, align: "right" },
    { id: makeId(), label: "状态", key: "active", type: "status" },
  ];
}

function hasWsColumnPreset() {
  const targetKeys = ["time", "pair", "last", "active"];
  return state.columns.length === targetKeys.length && targetKeys.every((key, index) => state.columns[index]?.key === key);
}

function applyWsColumnPreset() {
  if (hasWsColumnPreset()) {
    return;
  }

  state.columns = getWsColumnPreset();
  syncRowsToColumns();
  renderControls();
  renderer.syncTargets();
  renderer.render(performance.now());
}

function setWsStatus(text) {
  state.wsStatus = text;
  const statusEl = document.querySelector("#wsStatusText");
  if (statusEl) {
    if ("value" in statusEl) {
      statusEl.value = text;
    } else {
      statusEl.textContent = text;
    }
  }
}

function refreshBoardOnly() {
  syncRowsToColumns();
  renderer.syncTargets();
  renderer.render(performance.now());
}

function getOrCreateWsRow(symbol) {
  const pairText = String(symbol ?? "");
  let row = state.rows.find((item) => String(item.pair ?? "") === pairText);
  if (!row) {
    if (state.rows.length >= WS_MAX_ROWS) {
      return null;
    }
    row = makeEmptyRow();
    row.pair = pairText;
    state.rows.push(row);
  }
  return row;
}

function sortWsRowsByActivity() {
  state.rows.sort((a, b) => {
    const pairA = String(a.pair ?? "");
    const pairB = String(b.pair ?? "");
    const scoreA = wsActivityScore.get(pairA) ?? 0;
    const scoreB = wsActivityScore.get(pairB) ?? 0;
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    const countA = wsUpdateCounter.get(pairA) ?? 0;
    const countB = wsUpdateCounter.get(pairB) ?? 0;
    if (countA !== countB) {
      return countB - countA;
    }
    return pairA.localeCompare(pairB);
  });
}

function applyTickerUpdate(ticker) {
  const symbol = ticker.symbol;
  if (!symbol) {
    return;
  }

  const activity = Number(ticker.volCcy24h || ticker.vol24h || 0);
  const row = getOrCreateWsRow(symbol);
  if (!row) {
    return;
  }
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const pairText = symbol;
  let lastValue = ticker.last ?? "";
  const previousRowActive = row.active;
  let isActive = typeof previousRowActive === "boolean" ? previousRowActive : Number(ticker.last || 0) >= Number(ticker.open24h || 0);
  const currentLastPrice = Number(ticker.last);

  const defaultDecimals = 4;
  const resolveDecimals = (textValue) => {
    const cacheKey = `${symbol}:decimals`;
    if (wsDecimalCache.has(cacheKey)) {
      return wsDecimalCache.get(cacheKey);
    }
    const parts = String(textValue ?? "").split(".");
    const decimals = parts[1] ? clamp(parts[1].length, 2, 8) : defaultDecimals;
    wsDecimalCache.set(cacheKey, decimals);
    return decimals;
  };
  const formatStableNumber = (textValue, decimals) => {
    const numeric = Number(textValue);
    if (!Number.isFinite(numeric)) {
      return String(textValue ?? "");
    }
    return numeric.toFixed(decimals);
  };
  const priceDecimals = resolveDecimals(lastValue);
  lastValue = formatStableNumber(lastValue, priceDecimals);
  const previousLastPrice = wsLastPriceMap.get(pairText);
  if (Number.isFinite(currentLastPrice) && Number.isFinite(previousLastPrice)) {
    if (currentLastPrice > previousLastPrice) {
      isActive = true; // 上涨：绿色
    } else if (currentLastPrice < previousLastPrice) {
      isActive = false; // 下跌：红色
    } else {
      // 价格持平时保持上一跳状态，避免红绿闪回。
      isActive = typeof previousRowActive === "boolean" ? previousRowActive : isActive;
    }
  }
  if (Number.isFinite(currentLastPrice)) {
    wsLastPriceMap.set(pairText, currentLastPrice);
  }

  row.time = `${hh}:${mm}`;
  row.pair = pairText;
  row.last = String(lastValue);
  row.active = Boolean(isActive);
  wsActivityScore.set(pairText, Number.isFinite(activity) ? activity : 0);
  wsUpdateCounter.set(pairText, (wsUpdateCounter.get(pairText) ?? 0) + 1);
  sortWsRowsByActivity();

  refreshBoardOnly();
}

const wsClient = createOkxWsClient({
  onStatus: setWsStatus,
  onTicker: applyTickerUpdate,
});

function connectMarketSocket() {
  if (!state.wsEnabled) {
    return;
  }
  applyWsColumnPreset();
  state.wsSource = "okx";
  wsUpdateCounter.clear();
  wsActivityScore.clear();
  wsLastPriceMap.clear();
  state.rows = [];
  refreshBoardOnly();
  wsClient.connect(state.wsSymbols);
}

function stopMarketSocket() {
  wsClient.disconnect();
}

function serializeRowsForEditor() {
  const keys = state.columns.map((column) => column.key);
  const header = keys.join("|");
  const lines = state.rows.map((row) =>
    state.columns
      .map((column) => {
        if (column.type === "status") {
          return row[column.key] ? "true" : "false";
        }
        return String(row[column.key] ?? "");
      })
      .join("|"),
  );

  return [header, ...lines].join("\n");
}

function parseStatusValue(rawValue) {
  const normalized = String(rawValue ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y", "是", "启用", "green"].includes(normalized);
}

function openDataPage() {
  bulkDataTextarea.value = serializeRowsForEditor();
  dataPage.classList.remove("hidden");
  bulkDataTextarea.focus();
}

function closeDataPage() {
  dataPage.classList.add("hidden");
}

function applyBulkData() {
  const keys = state.columns.map((column) => column.key);
  const lines = bulkDataTextarea.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return;
  }

  const maybeHeader = lines[0].split("|").map((part) => part.trim());
  const hasHeader = maybeHeader.length === keys.length && maybeHeader.every((key, index) => key === keys[index]);
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const parsedRows = dataLines.map((line) => {
    const parts = line.split("|");
    const nextRow = { id: makeId() };

    state.columns.forEach((column, index) => {
      const value = parts[index] ?? "";
      nextRow[column.key] = column.type === "status" ? parseStatusValue(value) : value;
    });

    return nextRow;
  });

  if (parsedRows.length === 0) {
    return;
  }

  updateState((draft) => {
    draft.rows = parsedRows;
  });

  closeDataPage();
}

function renderControls() {
  controlsEl.innerHTML = `
    <section class="setup-group">
      <h3>看板</h3>
      <div class="form-grid">
        <label class="field">
          <span>标题</span>
          <input data-path="title" type="text" value="${escapeHtml(state.title)}" />
        </label>
        <label class="field">
          <span>字体</span>
          <select data-path="fontFamily">
            ${FONT_OPTIONS.map(
              (option) =>
                `<option value="${escapeHtml(option.value)}" ${state.fontFamily === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>`,
            ).join("")}
          </select>
        </label>
      </div>
    </section>

    <section class="setup-group">
      <h3>实时数据</h3>
      <div class="form-grid">
        <label class="field field--toggle">
          <span>启用WS</span>
          <input data-number="wsEnabled" type="checkbox" ${state.wsEnabled ? "checked" : ""} />
        </label>
        <label class="field">
          <span>数据源</span>
          <input type="text" readonly value="${WS_SOURCE_OPTIONS[0].label}" />
        </label>
        <label class="field" style="grid-column: 1 / -1;">
          <span>交易对（逗号分隔）</span>
          <input data-path="wsSymbols" type="text" value="${escapeHtml(state.wsSymbols)}" />
        </label>
        <label class="field" style="grid-column: 1 / -1;">
          <span>状态</span>
          <input id="wsStatusText" type="text" readonly value="${escapeHtml(state.wsStatus)}" />
        </label>
      </div>
    </section>

    <section class="setup-group">
      <h3>字符尺寸</h3>
      <div class="form-grid form-grid--compact">
        <label class="field">
          <span>圆角</span>
          <input data-number="tileRadius" type="number" min="0" max="12" step="1" value="${state.tileRadius}" />
        </label>
        <label class="field">
          <span>字间距</span>
          <input data-number="tileGap" type="number" min="0" max="12" step="1" value="${state.tileGap}" />
        </label>
        <label class="field">
          <span>宽度</span>
          <input data-number="charWidth" type="number" min="24" max="96" step="1" value="${state.charWidth}" />
        </label>
        <label class="field">
          <span>高度</span>
          <input data-number="charHeight" type="number" min="32" max="128" step="1" value="${state.charHeight}" />
        </label>
        <label class="field">
          <span>字占比</span>
          <input data-number="fontScale" type="number" min="0.6" max="1" step="0.01" value="${state.fontScale}" />
        </label>
        <label class="field">
          <span>中线间隔</span>
          <input data-number="midlineGap" type="number" min="1" max="8" step="0.5" value="${state.midlineGap}" />
        </label>
        <label class="field">
          <span>列间距</span>
          <input data-number="columnGap" type="number" min="8" max="48" step="1" value="${state.columnGap}" />
        </label>
        <label class="field">
          <span>行间距</span>
          <input data-number="rowGap" type="number" min="4" max="36" step="1" value="${state.rowGap}" />
        </label>
        <label class="field">
          <span>翻页毫秒</span>
          <input data-number="flipDuration" type="number" min="120" max="1600" step="10" value="${state.flipDuration}" />
        </label>
      </div>
    </section>

    <section class="setup-group">
      <div class="section-heading">
        <h3>列配置</h3>
        <div class="button-row">
          <button type="button" class="ghost-button" data-action="add-text-column">新增文本列</button>
          <button type="button" class="ghost-button" data-action="add-status-column">新增状态灯列</button>
        </div>
      </div>
      <div class="stack">
        ${state.columns
          .map(
            (column, index) => `
              <article class="column-card">
                <div class="column-card__header">
                  <strong>${escapeHtml(column.label || `Column ${index + 1}`)}</strong>
                  <div class="button-row">
                    <button type="button" class="icon-button" data-action="move-column-up" data-index="${index}">↑</button>
                    <button type="button" class="icon-button" data-action="move-column-down" data-index="${index}">↓</button>
                    <button type="button" class="icon-button danger" data-action="remove-column" data-index="${index}" ${
                      state.columns.length === 1 ? "disabled" : ""
                    }>✕</button>
                  </div>
                </div>
                <div class="form-grid">
                  <label class="field">
                    <span>名称</span>
                    <input data-column-field="label" data-index="${index}" type="text" value="${escapeHtml(column.label)}" />
                  </label>
                  <label class="field">
                    <span>Key</span>
                    <input data-column-field="key" data-index="${index}" type="text" value="${escapeHtml(column.key)}" />
                  </label>
                  <label class="field">
                    <span>类型</span>
                    <select data-column-field="type" data-index="${index}">
                      <option value="text" ${column.type === "text" ? "selected" : ""}>文本</option>
                      <option value="status" ${column.type === "status" ? "selected" : ""}>状态灯</option>
                    </select>
                  </label>
                  ${
                    column.type === "text"
                      ? `
                        <label class="field">
                          <span>字符数</span>
                          <input data-column-field="length" data-index="${index}" type="number" min="1" max="24" value="${column.length}" />
                        </label>
                        <label class="field">
                          <span>对齐</span>
                          <select data-column-field="align" data-index="${index}">
                            <option value="left" ${column.align === "left" ? "selected" : ""}>左对齐</option>
                            <option value="center" ${column.align === "center" ? "selected" : ""}>居中</option>
                            <option value="right" ${column.align === "right" ? "selected" : ""}>右对齐</option>
                          </select>
                        </label>
                      `
                      : `
                        <label class="field">
                          <span>说明</span>
                          <input type="text" disabled value="绿色=启用，红色=停用" />
                        </label>
                      `
                  }
                </div>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>

  `;

  controlsEl.querySelectorAll("[data-path]").forEach((input) => {
    const eventName = input.tagName === "SELECT" ? "change" : "input";
    input.addEventListener(eventName, (event) => {
      const { path } = event.currentTarget.dataset;
      state[path] = event.currentTarget.value;
      renderer.render(performance.now());
    });
  });

  controlsEl.querySelectorAll("[data-number]").forEach((input) => {
    const eventName = input.type === "checkbox" ? "change" : "input";
    input.addEventListener(eventName, (event) => {
      const { number } = event.currentTarget.dataset;
      state[number] = event.currentTarget.type === "checkbox" ? event.currentTarget.checked : Number(event.currentTarget.value);
      renderer.syncTargets();
      renderer.render(performance.now());
      if (number === "wsEnabled") {
        if (state.wsEnabled) {
          connectMarketSocket();
        } else {
          stopMarketSocket();
        }
      }
    });
  });

  controlsEl.querySelectorAll("[data-column-field]").forEach((input) => {
    const eventName = input.tagName === "SELECT" ? "change" : "input";
    input.addEventListener(eventName, (event) => {
      const columnIndex = Number(event.currentTarget.dataset.index);
      const field = event.currentTarget.dataset.columnField;

      updateState((draft) => {
        const column = draft.columns[columnIndex];
        const previousKey = column.key;
        const nextValue = field === "length" ? clamp(Number(event.currentTarget.value), 1, 24) : event.currentTarget.value;

        column[field] = nextValue;

        if (field === "type" && nextValue === "status") {
          delete column.length;
          delete column.align;
        } else if (field === "type" && nextValue === "text") {
          column.length = 6;
          column.align = "left";
        }

        if (field === "key" && previousKey !== column.key) {
          draft.rows.forEach((row) => {
            row[column.key] = row[previousKey];
            delete row[previousKey];
          });
        }
      });
    });
  });

  controlsEl.querySelectorAll('[data-path="wsSymbols"]').forEach((input) => {
    const eventName = input.tagName === "SELECT" ? "change" : "blur";
    input.addEventListener(eventName, () => {
      if (state.wsEnabled) {
        connectMarketSocket();
      }
    });
  });

  controlsEl.querySelectorAll("[data-row-field]").forEach((input) => {
    const eventName = input.type === "checkbox" ? "change" : "input";
    input.addEventListener(eventName, (event) => {
      const rowIndex = Number(event.currentTarget.dataset.rowIndex);
      const field = event.currentTarget.dataset.rowField;
      const value = event.currentTarget.type === "checkbox" ? event.currentTarget.checked : event.currentTarget.value;

      updateState((draft) => {
        draft.rows[rowIndex][field] = value;
      });
    });
  });

  controlsEl.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", handleControlAction);
  });
}

function handleControlAction(event) {
  const { action, index } = event.currentTarget.dataset;
  const itemIndex = Number(index);

  if (action === "randomize") {
    randomizeRows();
    return;
  }

  updateState((draft) => {
    if (action === "add-text-column") {
      draft.columns.push(makeTextColumn());
      draft.rows.forEach((row) => {
        row[draft.columns[draft.columns.length - 1].key] = "";
      });
    }

    if (action === "add-status-column") {
      draft.columns.push(makeStatusColumn());
      draft.rows.forEach((row) => {
        row[draft.columns[draft.columns.length - 1].key] = true;
      });
    }

    if (action === "remove-column" && draft.columns.length > 1) {
      const [removed] = draft.columns.splice(itemIndex, 1);
      draft.rows.forEach((row) => {
        delete row[removed.key];
      });
    }

    if (action === "move-column-up") {
      moveItem(draft.columns, itemIndex, itemIndex - 1);
    }

    if (action === "move-column-down") {
      moveItem(draft.columns, itemIndex, itemIndex + 1);
    }

    if (action === "add-row") {
      draft.rows.push(makeEmptyRow());
    }

    if (action === "remove-row" && draft.rows.length > 1) {
      draft.rows.splice(itemIndex, 1);
    }

    if (action === "move-row-up") {
      moveItem(draft.rows, itemIndex, itemIndex - 1);
    }

    if (action === "move-row-down") {
      moveItem(draft.rows, itemIndex, itemIndex + 1);
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getCanvasTitle() {
  return "DEPARTURES";
}

function getCanvasColumnLabel(column) {
  const builtinLabels = {
    time: "TIME",
    destination: "DESTINATION",
    flight: "FLIGHT",
    gate: "GATE",
    pair: "PAIR",
    last: "LAST",
    bid: "BID",
    ask: "ASK",
    chg: "24H%",
    active: "STATUS",
  };

  return builtinLabels[column.key] ?? String(column.key ?? "").toUpperCase();
}

class FlipBoardRenderer {
  constructor(renderContext, targetCanvas, viewport) {
    this.ctx = renderContext;
    this.canvas = targetCanvas;
    this.viewport = viewport;
    this.devicePixelRatio = window.devicePixelRatio || 1;
    this.canvasPixelWidth = 0;
    this.canvasPixelHeight = 0;
    this.canvasCssWidth = 0;
    this.canvasCssHeight = 0;
    this.cachedViewportWidth = 0;
    this.cachedViewportHeight = 0;
    this.cachedLayout = null;
    this.syncTargets();
  }

  invalidateLayout() {
    this.cachedLayout = null;
  }

  resizeCanvas(cssWidth, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.devicePixelRatio) {
      this.devicePixelRatio = dpr;
      this.cachedLayout = null;
    }
    const pixelWidth = Math.floor(cssWidth * this.devicePixelRatio);
    const pixelHeight = Math.floor(cssHeight * this.devicePixelRatio);
    const sizeChanged =
      pixelWidth !== this.canvasPixelWidth ||
      pixelHeight !== this.canvasPixelHeight ||
      cssWidth !== this.canvasCssWidth ||
      cssHeight !== this.canvasCssHeight;
    if (!sizeChanged) {
      return;
    }

    this.canvasPixelWidth = pixelWidth;
    this.canvasPixelHeight = pixelHeight;
    this.canvasCssWidth = cssWidth;
    this.canvasCssHeight = cssHeight;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  getCachedLayout(viewportWidth, viewportHeight) {
    if (
      !this.cachedLayout ||
      this.cachedViewportWidth !== viewportWidth ||
      this.cachedViewportHeight !== viewportHeight
    ) {
      this.cachedViewportWidth = viewportWidth;
      this.cachedViewportHeight = viewportHeight;
      this.cachedLayout = this.getLayout();
    }
    return this.cachedLayout;
  }

  getLayout() {
    let currentX = state.boardPadding;

    const columns = state.columns.map((column) => {
      if (column.type === "status") {
        const width = state.charHeight * 0.64;
        const layout = {
          ...column,
          x: currentX,
          width,
        };

        currentX += width + state.columnGap;
        return layout;
      }

      const slotWidths = getSlotWidths(column);
      let slotX = 0;
      const slots = slotWidths.map((width, index) => {
        const slot = { x: slotX, width };
        slotX += width + (index < slotWidths.length - 1 ? state.tileGap : 0);
        return slot;
      });

      const layout = {
        ...column,
        x: currentX,
        slots,
        width: slotX,
      };

      currentX += slotX + state.columnGap;
      return layout;
    });

    const contentRight = columns.length ? columns.at(-1).x + columns.at(-1).width : state.boardPadding;
    const boardWidth = contentRight + state.boardPadding;
    const rowHeight = state.charHeight;
    const rowsHeight = rowHeight * state.rows.length + state.rowGap * Math.max(state.rows.length - 1, 0);
    const boardHeight = state.boardPadding * 2 + state.titleHeight + state.labelHeight + rowsHeight;

    return { columns, boardWidth, boardHeight, rowHeight, contentRight };
  }

  syncTargets() {
    this.invalidateLayout();
    const activeKeys = new Set();

    state.rows.forEach((row) => {
      state.columns.forEach((column) => {
        if (column.type !== "text") {
          return;
        }

        const fitted = fitText(row[column.key], column.length, column.align);

        for (let charIndex = 0; charIndex < column.length; charIndex += 1) {
          const key = `${row.id}:${column.id}:${charIndex}`;
          const targetChar = sanitizeChar(fitted[charIndex]);
          const isStaticTimeColon = isTimeColonSlot(column, charIndex);

          if (isStaticTimeColon) {
            tileState.delete(key);
            continue;
          }

          activeKeys.add(key);
          const tile = tileState.get(key);

          if (!tile) {
            tileState.set(key, {
              key,
              currentChar: targetChar,
              targetChar,
              nextChar: targetChar,
              pendingChars: [],
              startedAt: 0,
              duration: state.flipDuration,
            });
            continue;
          }

          if (tile.targetChar !== targetChar) {
            const baseChar = sanitizeChar(tile.startedAt > 0 ? tile.nextChar : tile.currentChar);
            queueTileRoll(tile, baseChar, targetChar);
          } else if (tile.startedAt === 0) {
            tile.currentChar = targetChar;
            tile.nextChar = targetChar;
            tile.pendingChars = [];
            tile.duration = state.flipDuration;
          }
        }
      });
    });

    [...tileState.keys()].forEach((key) => {
      if (!activeKeys.has(key)) {
        tileState.delete(key);
      }
    });
  }

  replayAllTiles() {
    const startedAt = performance.now();

    tileState.forEach((tile) => {
      queueTileRoll(tile, getReplayStartChar(tile.targetChar), tile.targetChar, startedAt);
    });
  }

  render(now) {
    const isFullscreen = document.fullscreenElement === this.canvas;
    const viewportWidth = isFullscreen ? window.innerWidth : this.viewport.clientWidth;
    const viewportHeight = isFullscreen ? window.innerHeight : this.viewport.clientHeight;
    const canvasWidth = Math.max(320, Math.floor(viewportWidth));
    const canvasHeight = Math.max(240, Math.floor(viewportHeight));
    const { columns, rowHeight, contentRight } = this.getCachedLayout(canvasWidth, canvasHeight);

    this.resizeCanvas(canvasWidth, canvasHeight);

    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    this.ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    this.drawBoardBackground(canvasWidth, canvasHeight);
    this.drawHeader(columns);
    this.drawRows(columns, rowHeight, now, canvasWidth, canvasHeight, contentRight);
  }

  drawBoardBackground(width, height) {
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#4b4b4b");
    gradient.addColorStop(0.35, "#2c2c2c");
    gradient.addColorStop(1, "#090909");

    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);

    this.ctx.strokeStyle = "rgba(255,255,255,0.1)";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  }

  drawHeader(columns) {
    this.ctx.fillStyle = "#d8d8d8";
    this.ctx.font = `600 12px Inter, system-ui, sans-serif`;
    this.ctx.textBaseline = "middle";
    this.ctx.textAlign = "left";

    const titleY = state.boardPadding + state.titleHeight / 2 - 2;
    this.ctx.font = `700 18px Inter, system-ui, sans-serif`;
    this.ctx.fillText(getCanvasTitle(), state.boardPadding, titleY);

    let x = state.boardPadding;
    const labelY = state.boardPadding + state.titleHeight + state.labelHeight / 2;
    this.ctx.font = `700 14px Inter, system-ui, sans-serif`;

    columns.forEach((column) => {
      this.ctx.fillStyle = "rgba(216, 216, 216, 0.88)";
      this.ctx.fillText(getCanvasColumnLabel(column), x, labelY);
      x += column.width + state.columnGap;
    });
  }

  drawRows(columns, rowHeight, now, canvasWidth, canvasHeight, contentRight) {
    const top = state.boardPadding + state.titleHeight + state.labelHeight;
    const bottomLimit = canvasHeight - state.boardPadding;
    const rightLimit = canvasWidth - state.boardPadding;
    const rowStride = rowHeight + state.rowGap;
    const rowsPerPage = Math.max(1, Math.floor((bottomLimit - top + state.rowGap) / rowStride));

    for (let rowIndex = 0; rowIndex < rowsPerPage; rowIndex += 1) {
      const y = top + rowIndex * rowStride;
      if (y + rowHeight > bottomLimit) {
        break;
      }

      const row = state.rows[rowIndex];

      columns.forEach((column) => {
        if (column.type === "status") {
          this.drawStatusBulb(column.x, y, rowHeight, row ? Boolean(row[column.key]) : false, !row);
        } else {
          const fitted = fitText(row?.[column.key] ?? "", column.length, column.align);
          for (let charIndex = 0; charIndex < column.length; charIndex += 1) {
            const isStaticTimeColon = isTimeColonSlot(column, charIndex);
            const charValue = isStaticTimeColon ? ":" : sanitizeChar(fitted[charIndex]);
            const tile = row && !isStaticTimeColon ? tileState.get(`${row.id}:${column.id}:${charIndex}`) : null;
            const slot = column.slots[charIndex];
            const tileX = column.x + slot.x;
            const tileY = y;
            if (isStaticTimeColon) {
              this.drawTimeSeparatorDots(tileX, tileY, slot.width, state.charHeight);
            } else {
              this.drawTile(tileX, tileY, slot.width, state.charHeight, tile, charValue, now);
            }
          }
        }
      });

      let fillerX = contentRight + state.columnGap;
      while (fillerX + state.charWidth <= rightLimit) {
        this.drawTile(fillerX, y, state.charWidth, state.charHeight, null, " ", now);
        fillerX += state.charWidth + state.tileGap;
      }
    }
  }

  drawStatusBulb(x, y, rowHeight, isActive, isPlaceholder = false) {
    const radius = Math.min(rowHeight * 0.17, 11);
    const centerX = x + state.charHeight * 0.32;
    const centerY = y + rowHeight / 2;
    const glowColor = isPlaceholder ? "rgba(255,255,255,0.02)" : isActive ? "rgba(107, 255, 128, 0.2)" : "rgba(255, 84, 84, 0.18)";

    // Outer dark bezel for an embedded look.
    this.ctx.fillStyle = "rgba(0,0,0,0.72)";
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius + 4.2, 0, Math.PI * 2);
    this.ctx.fill();

    // Inner cavity shadow to push the bulb inward.
    const cavityGradient = this.ctx.createRadialGradient(centerX, centerY, Math.max(1, radius * 0.2), centerX, centerY, radius + 3.2);
    cavityGradient.addColorStop(0, "rgba(0,0,0,0.08)");
    cavityGradient.addColorStop(1, "rgba(0,0,0,0.55)");
    this.ctx.fillStyle = cavityGradient;
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius + 3.2, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.fillStyle = "rgba(255,255,255,0.05)";
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius + 5, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.fillStyle = glowColor;
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius + 2, 0, Math.PI * 2);
    this.ctx.fill();

    const bulbGradient = this.ctx.createRadialGradient(centerX - radius * 0.35, centerY - radius * 0.35, 2, centerX, centerY, radius);
    bulbGradient.addColorStop(0, isPlaceholder ? "#8a8a8a" : isActive ? "#f2ffdc" : "#ffd4d4");
    bulbGradient.addColorStop(0.4, isPlaceholder ? "#5e5e5e" : isActive ? "#7aff6d" : "#ff7f7f");
    bulbGradient.addColorStop(1, isPlaceholder ? "#2a2a2a" : isActive ? "#2ba63d" : "#9f2121");

    this.ctx.fillStyle = bulbGradient;
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.strokeStyle = "rgba(255,255,255,0.2)";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  drawTile(x, y, width, height, tile, fallbackChar, now) {
    const splitY = y + height / 2;
    const char = sanitizeChar(fallbackChar);
    const insetX = Math.max(1.5, Math.min(3, width * 0.06));
    const insetY = Math.max(1.5, Math.min(3, height * 0.04));
    const cardGap = clamp(Number(state.midlineGap), 1, 8);
    const radius = clamp(Number(state.tileRadius), 0, 12);
    const topRect = {
      x: x + insetX,
      y: y + insetY,
      width: Math.max(6, width - insetX * 2),
      height: Math.max(6, height / 2 - insetY - cardGap / 2),
    };
    const bottomRect = {
      x: x + insetX,
      y: splitY + cardGap / 2,
      width: Math.max(6, width - insetX * 2),
      height: Math.max(6, height / 2 - insetY - cardGap / 2),
    };

    let fromChar = char;
    let toChar = char;
    let progress = 1;

    if (tile) {
      while (tile.startedAt > 0 && now - tile.startedAt >= tile.duration) {
        tile.currentChar = sanitizeChar(tile.nextChar ?? char);

        if (tile.pendingChars.length > 0) {
          tile.nextChar = tile.pendingChars.shift();
          tile.duration = getRollStepDuration(tile.pendingChars.length + 1);
          tile.startedAt = now;
        } else {
          tile.nextChar = tile.currentChar;
          tile.startedAt = 0;
          tile.duration = state.flipDuration;
        }
      }

      fromChar = sanitizeChar(tile.currentChar ?? char);
      toChar = sanitizeChar(tile.startedAt > 0 ? tile.nextChar : tile.currentChar ?? char);
      progress = tile.startedAt > 0 ? clamp((now - tile.startedAt) / tile.duration, 0, 1) : 1;
    }

    this.ctx.fillStyle = "rgba(0,0,0,0.42)";
    this.ctx.fillRect(x, y, width, height);

    const backgroundTop = this.ctx.createLinearGradient(topRect.x, topRect.y, topRect.x, topRect.y + topRect.height);
    backgroundTop.addColorStop(0, "#343434");
    backgroundTop.addColorStop(0.55, "#282828");
    backgroundTop.addColorStop(1, "#1d1d1d");
    const backgroundBottom = this.ctx.createLinearGradient(bottomRect.x, bottomRect.y, bottomRect.x, bottomRect.y + bottomRect.height);
    backgroundBottom.addColorStop(0, "#242424");
    backgroundBottom.addColorStop(0.45, "#181818");
    backgroundBottom.addColorStop(1, "#0e0e0e");

    this.ctx.fillStyle = backgroundTop;
    this.drawRoundedRect(topRect.x, topRect.y, topRect.width, topRect.height, radius);
    this.ctx.fill();

    this.ctx.fillStyle = backgroundBottom;
    this.drawRoundedRect(bottomRect.x, bottomRect.y, bottomRect.width, bottomRect.height, radius);
    this.ctx.fill();

    this.ctx.strokeStyle = "rgba(255,255,255,0.1)";
    this.ctx.lineWidth = 1;
    this.drawRoundedRect(topRect.x + 0.5, topRect.y + 0.5, topRect.width - 1, topRect.height - 1, radius);
    this.ctx.stroke();
    this.drawRoundedRect(bottomRect.x + 0.5, bottomRect.y + 0.5, bottomRect.width - 1, bottomRect.height - 1, radius);
    this.ctx.stroke();

    this.ctx.strokeStyle = "rgba(255,255,255,0.07)";
    this.ctx.beginPath();
    this.ctx.moveTo(topRect.x + 1, topRect.y + 1.5);
    this.ctx.lineTo(topRect.x + topRect.width - 1, topRect.y + 1.5);
    this.ctx.moveTo(bottomRect.x + 1, bottomRect.y + 1.5);
    this.ctx.lineTo(bottomRect.x + bottomRect.width - 1, bottomRect.y + 1.5);
    this.ctx.stroke();

    this.ctx.fillStyle = "#020202";
    this.ctx.fillRect(x + insetX, splitY - cardGap / 2, width - insetX * 2, cardGap);

    const easedProgress = progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    const firstHalf = clamp(easedProgress * 2, 0, 1);
    const secondHalf = clamp((easedProgress - 0.5) * 2, 0, 1);

    if (easedProgress < 0.5) {
      this.drawHalfChar(x, y, width, height, toChar, "top", 1, topRect, radius);
      this.drawHalfChar(x, y, width, height, fromChar, "bottom", 1, bottomRect, radius);
      this.drawTopFlap(x, y, width, height, fromChar, 1 - firstHalf, topRect, radius, backgroundTop);
    } else if (easedProgress < 1) {
      this.drawHalfChar(x, y, width, height, toChar, "top", 1, topRect, radius);
      this.drawHalfChar(x, y, width, height, fromChar, "bottom", 1, bottomRect, radius);
      this.drawBottomFlap(x, y, width, height, toChar, secondHalf, bottomRect, radius, backgroundBottom);
    } else {
      this.drawStaticChar(x, y, width, height, toChar, topRect, bottomRect, radius);
    }

    // Side connector details (vertical hinge-like pins), rendered on top.
    const pinWidth = Math.max(1.5, Math.min(2.6, topRect.width * 0.05));
    const pinHeight = Math.max(8, Math.min(14, height * 0.2));
    const pinY = splitY - pinHeight / 2;
    const leftPinX = topRect.x - pinWidth * 0.6;
    const rightPinX = topRect.x + topRect.width - pinWidth * 0.4;

    this.ctx.fillStyle = "rgba(0,0,0,0.9)";
    this.ctx.fillRect(leftPinX, pinY, pinWidth, pinHeight);
    this.ctx.fillRect(rightPinX, pinY, pinWidth, pinHeight);

    this.ctx.fillStyle = "rgba(255,255,255,0.2)";
    this.ctx.fillRect(leftPinX, pinY + 1, 1, pinHeight - 2);
    this.ctx.fillRect(rightPinX, pinY + 1, 1, pinHeight - 2);
  }

  drawStaticChar(x, y, width, height, char, topRect, bottomRect, radius) {
    this.drawHalfChar(x, y, width, height, char, "top", 1, topRect, radius);
    this.drawHalfChar(x, y, width, height, char, "bottom", 1, bottomRect, radius);
  }

  drawTopFlap(x, y, width, height, char, scaleY, topRect, radius, backgroundFill) {
    this.ctx.save();
    this.drawRoundedRect(topRect.x, topRect.y, topRect.width, topRect.height, radius);
    this.ctx.clip();
    const fold = 1 - clamp(scaleY, 0, 1);
    const hingeY = y + height / 2;
    this.ctx.translate(x + width / 2, hingeY);
    this.ctx.scale(1 - fold * 0.12, Math.max(scaleY, 0.02));
    this.ctx.translate(-(x + width / 2), -hingeY);
    this.ctx.fillStyle = backgroundFill;
    this.drawRoundedRect(topRect.x, topRect.y, topRect.width, topRect.height, radius);
    this.ctx.fill();
    this.drawHalfChar(x, y, width, height, char, "top", 1, topRect, radius);
    this.ctx.restore();
  }

  drawBottomFlap(x, y, width, height, char, scaleY, bottomRect, radius, backgroundFill) {
    this.ctx.save();
    this.drawRoundedRect(bottomRect.x, bottomRect.y, bottomRect.width, bottomRect.height, radius);
    this.ctx.clip();
    const fold = 1 - clamp(scaleY, 0, 1);
    const hingeY = y + height / 2;
    this.ctx.translate(x + width / 2, hingeY);
    this.ctx.scale(1 - fold * 0.12, Math.max(scaleY, 0.02));
    this.ctx.translate(-(x + width / 2), -hingeY);
    this.ctx.fillStyle = backgroundFill;
    this.drawRoundedRect(bottomRect.x, bottomRect.y, bottomRect.width, bottomRect.height, radius);
    this.ctx.fill();
    this.drawHalfChar(x, y, width, height, char, "bottom", 1, bottomRect, radius);
    this.ctx.restore();
  }

  drawHalfChar(x, y, width, height, char, half, alpha, rect, radius) {
    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, radius);
    this.ctx.clip();

    this.ctx.fillStyle = "#ffffff";
    const fontSize = Math.floor(height * clamp(Number(state.fontScale), 0.6, 1));
    this.ctx.font = `700 ${fontSize}px ${state.fontFamily}`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(char, x + width / 2, y + height * 0.52);
    this.ctx.restore();
  }

  drawPlainChar(x, y, width, height, char) {
    this.ctx.save();
    this.ctx.fillStyle = "#ffffff";
    const fontSize = Math.floor(height * clamp(Number(state.fontScale), 0.6, 1));
    this.ctx.font = `700 ${fontSize}px ${state.fontFamily}`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(char, x + width / 2, y + height * 0.52);
    this.ctx.restore();
  }

  drawTimeSeparatorDots(x, y, width, height) {
    const centerX = x + width / 2;
    const upperY = y + height * 0.38;
    const lowerY = y + height * 0.66;
    const dotRadius = Math.max(1.5, Math.min(width * 0.2, height * 0.07));

    this.ctx.save();
    this.ctx.fillStyle = "#ffffff";
    this.ctx.beginPath();
    this.ctx.arc(centerX, upperY, dotRadius, 0, Math.PI * 2);
    this.ctx.arc(centerX, lowerY, dotRadius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  drawRoundedRect(x, y, width, height, radius) {
    const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));

    this.ctx.beginPath();
    this.ctx.moveTo(x + safeRadius, y);
    this.ctx.lineTo(x + width - safeRadius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    this.ctx.lineTo(x + width, y + height - safeRadius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    this.ctx.lineTo(x + safeRadius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    this.ctx.lineTo(x, y + safeRadius);
    this.ctx.quadraticCurveTo(x, y, x + safeRadius, y);
    this.ctx.closePath();
  }

}

const renderer = new FlipBoardRenderer(ctx, canvas, viewportEl);
document.querySelector('[data-action="randomize"]').addEventListener("click", handleControlAction);

fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement === canvas) {
    await document.exitFullscreen();
    return;
  }

  await canvas.requestFullscreen();
});

dataPageButton.addEventListener("click", openDataPage);
closeDataPageButton.addEventListener("click", closeDataPage);
reloadDataPageButton.addEventListener("click", () => {
  bulkDataTextarea.value = serializeRowsForEditor();
});
applyDataPageButton.addEventListener("click", applyBulkData);

document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === canvas) {
    renderer.replayAllTiles();
    renderer.render(performance.now());
  }
});

resizeObserver.observe(viewportEl);
window.addEventListener("resize", () => renderer.render(performance.now()));

function tick(now) {
  renderer.render(now);
  requestAnimationFrame(tick);
}

renderControls();
renderer.syncTargets();
requestAnimationFrame(tick);
