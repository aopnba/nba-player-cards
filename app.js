"use strict";

const dataUrl = "./data/players.json";
const exportWidth = 1080;
const exportHeight = 1350;
const transparentCutout = {
  x: 0,
  y: 0,
  width: 586,
  height: 1350,
};

const elements = {
  searchInput: document.querySelector("#player-search"),
  clearButton: document.querySelector("#clear-search"),
  exportButton: document.querySelector("#export-png"),
  openPngLink: document.querySelector("#open-png"),
  results: document.querySelector("#player-results"),
  searchStatus: document.querySelector("#search-status"),
  heightOverride: document.querySelector("#height-override"),
  playerCard: document.querySelector("#player-card"),
  cardBackground: document.querySelector("#card-background"),
  teamLogo: document.querySelector("#team-logo"),
  teamFallback: document.querySelector("#team-fallback"),
  cardName: document.querySelector("#card-name"),
  cardPosition: document.querySelector("#card-position"),
  cardStats: document.querySelector("#card-stats"),
  cardHeight: document.querySelector("#card-height"),
};

const state = {
  players: [],
  playerCount: 0,
  filteredPlayers: [],
  selectedPlayer: null,
  activeResultIndex: -1,
  imageCache: new Map(),
  logoBoundsCache: new Map(),
  lastExportUrl: null,
};
const textMeasureCanvas = document.createElement("canvas");
const textMeasureContext = textMeasureCanvas.getContext("2d");

const FITTING_RULES = [
  { element: elements.cardName, maxPx: 118, minPx: 48 },
  { element: elements.teamFallback, maxPx: 68, minPx: 28 },
  { element: elements.cardPosition, maxPx: 133.41, minPx: 72, widthRatio: 0.92 },
  { element: elements.cardStats, maxPx: 133.41, minPx: 72, widthRatio: 0.92 },
  { element: elements.cardHeight, maxPx: 133.41, minPx: 72, widthRatio: 0.93 },
];

function normalize(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mergeNameSuffixes(tokens) {
  const suffixes = new Set(["JR", "JR.", "SR", "SR.", "II", "III", "IV", "V"]);
  const merged = [];

  for (const token of tokens) {
    if (merged.length > 0 && suffixes.has(token)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${token}`;
      continue;
    }
    merged.push(token);
  }

  return merged;
}

function buildLinePartitions(words, lineCount, startIndex = 0) {
  if (lineCount === 1) {
    return [[words.slice(startIndex).join(" ")]];
  }

  const partitions = [];
  for (let nextIndex = startIndex + 1; nextIndex <= words.length - (lineCount - 1); nextIndex += 1) {
    const currentLine = words.slice(startIndex, nextIndex).join(" ");
    const remaining = buildLinePartitions(words, lineCount - 1, nextIndex);
    for (const rest of remaining) {
      partitions.push([currentLine, ...rest]);
    }
  }
  return partitions;
}

function lineBalanceScore(lines) {
  const lengths = lines.map((line) => line.replace(/\s+/g, "").length);
  return (Math.max(...lengths) - Math.min(...lengths)) + (lines.length * 6);
}

function buildBalancedLines(text, maxLines = 2) {
  const tokens = mergeNameSuffixes(
    String(text || "")
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean),
  );

  if (!tokens.length) {
    return [];
  }

  if (tokens.length === 1) {
    return tokens;
  }

  let bestLines = [tokens.join(" ")];
  let bestScore = Number.POSITIVE_INFINITY;

  for (let lineCount = 2; lineCount <= Math.min(maxLines, tokens.length); lineCount += 1) {
    const partitions = buildLinePartitions(tokens, lineCount);
    for (const lines of partitions) {
      const score = lineBalanceScore(lines);
      if (score < bestScore) {
        bestScore = score;
        bestLines = lines;
      }
    }
  }

  return bestLines;
}

function renderMultilineText(element, lines) {
  element.replaceChildren();
  for (const line of lines) {
    const span = document.createElement("span");
    span.textContent = line;
    element.appendChild(span);
  }
  element.dataset.lines = lines.join("\n");
}

function getCardScale() {
  const rect = elements.playerCard.getBoundingClientRect();
  return rect.width > 0 ? rect.width / exportWidth : 1;
}

function getTextLinesForElement(element) {
  const explicitLines = String(element.dataset.lines || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (explicitLines.length) {
    return explicitLines;
  }

  return [String(element.textContent || "").trim()].filter(Boolean);
}

function measureTextBlock(element) {
  const style = window.getComputedStyle(element);
  const lines = getTextLinesForElement(element);
  const fontSize = parseFloat(style.fontSize);
  const lineHeight = parseFloat(style.lineHeight) || fontSize;

  textMeasureContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  let maxWidth = 0;
  let maxAscent = 0;
  let maxDescent = 0;

  for (const line of lines) {
    const metrics = textMeasureContext.measureText(line);
    maxWidth = Math.max(maxWidth, metrics.width);
    maxAscent = Math.max(maxAscent, metrics.actualBoundingBoxAscent || fontSize);
    maxDescent = Math.max(maxDescent, metrics.actualBoundingBoxDescent || 0);
  }

  return {
    width: maxWidth,
    height: (lineHeight * Math.max(lines.length - 1, 0)) + maxAscent + maxDescent,
  };
}

function isTextBlockTooLarge(element, widthRatio = 1, heightRatio = 1) {
  const measured = measureTextBlock(element);
  return (
    measured.width > (element.clientWidth * widthRatio) + 1 ||
    measured.height > (element.clientHeight * heightRatio) + 1
  );
}

function fitTextBlock(rule) {
  const {
    element,
    maxPx,
    minPx,
    widthRatio = 1,
    heightRatio = 1,
  } = rule;
  const scale = getCardScale();
  let fontSize = maxPx * scale;
  const minSize = Math.max(minPx * scale, 12);
  const step = Math.max(scale * 0.25, 0.1);

  element.style.fontSize = `${fontSize}px`;
  while (fontSize > minSize && isTextBlockTooLarge(element, widthRatio, heightRatio)) {
    fontSize = Math.max(fontSize - step, minSize);
    element.style.fontSize = `${fontSize}px`;
  }
}

function fitCardText() {
  for (const rule of FITTING_RULES) {
    if (rule.element.classList.contains("is-hidden")) {
      continue;
    }
    fitTextBlock(rule);
  }
}

function setStatus(message) {
  elements.searchStatus.textContent = message;
}

function clearExportState() {
  if (state.lastExportUrl) {
    URL.revokeObjectURL(state.lastExportUrl);
    state.lastExportUrl = null;
  }

  elements.openPngLink.removeAttribute("href");
  elements.openPngLink.removeAttribute("download");
  elements.openPngLink.classList.add("is-hidden");
}

function getDefaultStatus() {
  if (!state.playerCount) {
    return "Loading players...";
  }
  return `${state.playerCount} players`;
}

function updateQueryString(player) {
  const url = new URL(window.location.href);
  url.searchParams.set("player", player.id);
  window.history.replaceState({}, "", url);
}

function normalizeHeightOverride(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const normalizedQuotes = trimmed
    .replace(/[′’]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/\s+/g, "");

  const feetInchesMatch = normalizedQuotes.match(/^(\d+)[-'](\d+(?:\.\d+)?)"?$/);
  if (feetInchesMatch) {
    const feet = feetInchesMatch[1];
    const inches = String(Number(feetInchesMatch[2]));
    return `${feet}'${inches}"`;
  }

  if (/^\d+(?:\.\d+)?$/.test(normalizedQuotes)) {
    const totalInches = Number(normalizedQuotes);
    if (Number.isFinite(totalInches) && totalInches > 12) {
      const feet = Math.floor(totalInches / 12);
      const inches = String(Number((totalInches - (feet * 12)).toFixed(2)));
      return `${feet}'${inches}"`;
    }
  }

  return normalizedQuotes.toUpperCase();
}

function parseHeightToTotalInches(value) {
  const normalized = normalizeHeightOverride(value);
  if (!normalized) {
    return null;
  }

  const feetInchesMatch = normalized.match(/^(\d+)'(\d+(?:\.\d+)?)"$/);
  if (feetInchesMatch) {
    const feet = Number(feetInchesMatch[1]);
    const inches = Number(feetInchesMatch[2]);
    if (Number.isFinite(feet) && Number.isFinite(inches)) {
      return (feet * 12) + inches;
    }
  }

  const numericValue = Number(normalized.replace(/"/g, ""));
  if (Number.isFinite(numericValue) && numericValue > 12) {
    return numericValue;
  }

  return null;
}

function roundHeightDisplay(value) {
  const totalInches = parseHeightToTotalInches(value);
  if (!Number.isFinite(totalInches)) {
    return String(value || "").trim().toUpperCase();
  }

  const roundedInches = Math.ceil(totalInches);
  const feet = Math.floor(roundedInches / 12);
  const inches = roundedInches - (feet * 12);
  return `${feet}'${inches}"`;
}

function getDefaultHeightInput(player) {
  const sourceHeight = player.heightInput || player.heightDisplay;
  const roundedHeight = roundHeightDisplay(sourceHeight);
  return roundedHeight || "";
}

function roundStatsDisplay(value) {
  const parts = String(value || "")
    .split("/")
    .map((part) => part.trim());

  if (!parts.length || parts.every((part) => !part)) {
    return "--/--/--";
  }

  return parts.map((part) => {
    if (!part || part === "--") {
      return "--";
    }

    const numeric = Number(part);
    if (!Number.isFinite(numeric)) {
      return part.toUpperCase();
    }

    return String(Math.ceil(numeric));
  }).join("/");
}

function buildPositionDisplay(player) {
  const position = String(player.position || "").trim().toUpperCase();
  return position || "--";
}

function buildHeightDisplay(player) {
  const override = normalizeHeightOverride(elements.heightOverride.value);
  if (override) {
    return roundHeightDisplay(override) || "--";
  }

  const roundedHeight = roundHeightDisplay(player.heightDisplay);
  return roundedHeight || "--";
}

function buildStatsDisplay(player) {
  return roundStatsDisplay(player.statsDisplay);
}

function buildSuggestionMarkup(player) {
  const rankText = Number.isFinite(player.rank) ? `#${player.rank}` : "--";
  return `
    <span class="search-result__name">${player.fullName}</span>
    <span class="search-result__meta">${player.team} · ${rankText}</span>
  `;
}

function clearResults() {
  elements.results.innerHTML = "";
  state.activeResultIndex = -1;
  elements.searchInput.setAttribute("aria-expanded", "false");
}

function showResults(players) {
  state.filteredPlayers = players;
  state.activeResultIndex = -1;

  if (!players.length) {
    clearResults();
    setStatus(normalize(elements.searchInput.value) ? "No matches" : getDefaultStatus());
    return;
  }

  elements.results.innerHTML = "";
  const fragment = document.createDocumentFragment();

  players.forEach((player, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    button.setAttribute("role", "option");
    button.setAttribute("data-index", String(index));
    button.innerHTML = buildSuggestionMarkup(player);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      selectPlayer(player, true);
    });
    fragment.appendChild(button);
  });

  elements.results.appendChild(fragment);
  elements.searchInput.setAttribute("aria-expanded", "true");
  setStatus(`${players.length} match${players.length === 1 ? "" : "es"}`);
}

function getTopMatches(query) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return [];
  }

  const startsWith = [];
  const includes = [];

  for (const player of state.players) {
    const haystack = `${player.fullName} ${player.team} ${player.position} ${player.playerClass}`;
    const normalizedHaystack = normalize(haystack);
    if (!normalizedHaystack.includes(normalizedQuery)) {
      continue;
    }

    if (normalize(player.fullName).startsWith(normalizedQuery)) {
      startsWith.push(player);
    } else {
      includes.push(player);
    }
  }

  return startsWith.concat(includes).slice(0, 8);
}

function handleSearchInput() {
  showResults(getTopMatches(elements.searchInput.value));
}

function handleKeyboardNavigation(event) {
  if (!state.filteredPlayers.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.activeResultIndex = Math.min(
      state.activeResultIndex + 1,
      state.filteredPlayers.length - 1,
    );
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.activeResultIndex = Math.max(state.activeResultIndex - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const player = state.filteredPlayers[state.activeResultIndex] || state.filteredPlayers[0];
    if (player) {
      selectPlayer(player, true);
    }
    return;
  } else if (event.key === "Escape") {
    clearResults();
    setStatus(getDefaultStatus());
    return;
  } else {
    return;
  }

  const buttons = elements.results.querySelectorAll(".search-result");
  buttons.forEach((button, index) => {
    button.classList.toggle("is-active", index === state.activeResultIndex);
  });
}

function getInitialPlayer(players) {
  const url = new URL(window.location.href);
  const playerId = url.searchParams.get("player");
  if (playerId) {
    const matchingPlayer = players.find((player) => player.id === playerId);
    if (matchingPlayer) {
      return matchingPlayer;
    }
  }
  return players[0] || null;
}

function loadImage(src) {
  if (!state.imageCache.has(src)) {
    state.imageCache.set(
      src,
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Unable to load image: ${src}`));
        image.src = src;
      }),
    );
  }
  return state.imageCache.get(src);
}

async function updateTeamLogo(player) {
  if (!player.logoAsset) {
    elements.teamLogo.classList.add("is-hidden");
    renderMultilineText(elements.teamFallback, buildBalancedLines(player.team, 2));
    elements.teamFallback.classList.remove("is-hidden");
    fitCardText();
    return;
  }

  try {
    await loadImage(player.logoAsset);
    elements.teamLogo.src = player.logoAsset;
    elements.teamLogo.alt = `${player.team} logo`;
    elements.teamLogo.classList.remove("is-hidden");
    elements.teamFallback.classList.add("is-hidden");
  } catch (error) {
    console.error(error);
    elements.teamLogo.classList.add("is-hidden");
    renderMultilineText(elements.teamFallback, buildBalancedLines(player.team, 2));
    elements.teamFallback.classList.remove("is-hidden");
  }

  fitCardText();
}

function renderCard() {
  const player = state.selectedPlayer;
  if (!player) {
    return;
  }

  clearExportState();
  renderMultilineText(elements.cardName, buildBalancedLines(player.fullName, 2));
  elements.cardPosition.textContent = buildPositionDisplay(player);
  elements.cardStats.textContent = buildStatsDisplay(player);
  elements.cardHeight.textContent = buildHeightDisplay(player);

  fitCardText();
  elements.exportButton.disabled = false;
  updateQueryString(player);
}

function selectPlayer(player, updateInput = false) {
  state.selectedPlayer = player;
  if (updateInput) {
    elements.searchInput.value = player.fullName;
  }

  elements.heightOverride.value = getDefaultHeightInput(player);

  renderCard();
  void updateTeamLogo(player);
  clearResults();
  setStatus(getDefaultStatus());
}

function sortPlayers(left, right) {
  const leftRank = Number.isFinite(left.rank) ? left.rank : Number.MAX_SAFE_INTEGER;
  const rightRank = Number.isFinite(right.rank) ? right.rank : Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.fullName.localeCompare(right.fullName);
}

function getScaledRect(element, cardRect, scale) {
  const rect = element.getBoundingClientRect();
  return {
    x: (rect.left - cardRect.left) * scale,
    y: (rect.top - cardRect.top) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

function getComputedFont(style, scale) {
  const baseFontSize = parseFloat(style.fontSize);
  const baseLineHeight = parseFloat(style.lineHeight) || baseFontSize;
  const fontSize = baseFontSize * scale;
  return {
    font: `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`,
    fontSize,
    lineHeight: baseLineHeight * scale,
  };
}

function getCanvasLinesForElement(element) {
  return getTextLinesForElement(element);
}

function drawTextBlockToCanvas(context, element, cardRect, scale, options = {}) {
  const style = window.getComputedStyle(element);
  const rect = getScaledRect(element, cardRect, scale);
  const { font, lineHeight } = getComputedFont(style, scale);
  const lines = getCanvasLinesForElement(element);
  const textAlign = style.textAlign === "right" ? "right" : "center";
  const textX = textAlign === "right" ? rect.x + rect.width : rect.x + (rect.width / 2);

  context.save();
  context.font = font;
  context.textAlign = textAlign;
  context.textBaseline = "top";

  const blockHeight = lineHeight * lines.length;
  let currentY = rect.y + Math.max((rect.height - blockHeight) / 2, 0);

  if (options.shadow) {
    context.fillStyle = options.shadow.color;
    const offsetX = options.shadow.offsetX * scale;
    const offsetY = options.shadow.offsetY * scale;
    for (const line of lines) {
      context.fillText(line, textX + offsetX, currentY + offsetY);
      currentY += lineHeight;
    }
    currentY = rect.y + Math.max((rect.height - blockHeight) / 2, 0);
  }

  context.fillStyle = options.fill || style.color;
  for (const line of lines) {
    context.fillText(line, textX, currentY);
    currentY += lineHeight;
  }

  context.restore();
}

function getOpaqueImageBounds(image) {
  const cacheKey = image.currentSrc || image.src;
  if (state.logoBoundsCache.has(cacheKey)) {
    return state.logoBoundsCache.get(cacheKey);
  }

  const canvas = document.createElement("canvas");
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[((y * width) + x) * 4 + 3];
      if (alpha === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const bounds = maxX === -1
    ? { x: 0, y: 0, width, height }
    : {
        x: minX,
        y: minY,
        width: (maxX - minX) + 1,
        height: (maxY - minY) + 1,
      };

  state.logoBoundsCache.set(cacheKey, bounds);
  return bounds;
}

function drawLogoToCanvas(context, image, destinationRect) {
  const sourceRect = getOpaqueImageBounds(image);
  const scale = Math.min(
    destinationRect.width / sourceRect.width,
    destinationRect.height / sourceRect.height,
  );
  const width = sourceRect.width * scale;
  const height = sourceRect.height * scale;
  const x = destinationRect.x + ((destinationRect.width - width) / 2);
  const y = destinationRect.y + ((destinationRect.height - height) / 2);

  context.drawImage(
    image,
    sourceRect.x,
    sourceRect.y,
    sourceRect.width,
    sourceRect.height,
    x,
    y,
    width,
    height,
  );
}

async function exportCurrentPlayer() {
  if (!state.selectedPlayer) {
    return;
  }

  elements.exportButton.disabled = true;
  setStatus("Building PNG...");

  try {
    await document.fonts.ready;

    const canvas = document.createElement("canvas");
    canvas.width = exportWidth;
    canvas.height = exportHeight;

    const context = canvas.getContext("2d");
    const cardRect = elements.playerCard.getBoundingClientRect();
    const scale = exportWidth / cardRect.width;

    const background = await loadImage(elements.cardBackground.src);
    context.drawImage(background, 0, 0, exportWidth, exportHeight);
    // Keep the left side fully transparent even if a future asset accidentally fills it.
    context.clearRect(
      transparentCutout.x,
      transparentCutout.y,
      transparentCutout.width,
      transparentCutout.height,
    );

    if (!elements.teamLogo.classList.contains("is-hidden")) {
      const logoImage = await loadImage(elements.teamLogo.src);
      drawLogoToCanvas(context, logoImage, getScaledRect(elements.teamLogo, cardRect, scale));
    } else {
      drawTextBlockToCanvas(context, elements.teamFallback, cardRect, scale, { fill: "#ffffff" });
    }

    drawTextBlockToCanvas(context, elements.cardName, cardRect, scale, { fill: "#ffffff" });
    drawTextBlockToCanvas(context, elements.cardPosition, cardRect, scale, { fill: "#ffffff" });
    drawTextBlockToCanvas(context, elements.cardStats, cardRect, scale, { fill: "#ffffff" });
    drawTextBlockToCanvas(context, elements.cardHeight, cardRect, scale, { fill: "#ffffff" });

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });

    if (!blob) {
      throw new Error("PNG export failed");
    }

    if (state.lastExportUrl) {
      URL.revokeObjectURL(state.lastExportUrl);
    }

    const downloadUrl = URL.createObjectURL(blob);
    state.lastExportUrl = downloadUrl;
    const filename = `${slugify(state.selectedPlayer.fullName)}-player-card.png`;
    elements.openPngLink.href = downloadUrl;
    elements.openPngLink.download = filename;
    elements.openPngLink.classList.remove("is-hidden");

    const downloadLink = document.createElement("a");
    downloadLink.href = downloadUrl;
    downloadLink.download = filename;
    document.body.appendChild(downloadLink);
    try {
      downloadLink.click();
    } catch (downloadError) {
      console.warn("Automatic download was not available.", downloadError);
    }
    downloadLink.remove();

    setStatus("PNG ready");
  } catch (error) {
    console.error(error);
    setStatus("PNG export failed");
  } finally {
    elements.exportButton.disabled = false;
  }
}

async function loadPlayers() {
  const response = await fetch(dataUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load player data: ${response.status}`);
  }

  const payload = await response.json();
  state.players = (payload.players || []).slice().sort(sortPlayers);
  state.playerCount = payload.playerCount || state.players.length;

  const initialPlayer = getInitialPlayer(state.players);
  if (initialPlayer) {
    selectPlayer(initialPlayer, true);
  }

  setStatus(getDefaultStatus());
}

function bindEvents() {
  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.searchInput.addEventListener("focus", () => {
    if (normalize(elements.searchInput.value)) {
      handleSearchInput();
    }
  });
  elements.searchInput.addEventListener("keydown", handleKeyboardNavigation);

  elements.clearButton.addEventListener("click", () => {
    elements.searchInput.value = "";
    elements.searchInput.focus();
    clearResults();
    setStatus(getDefaultStatus());
  });

  elements.heightOverride.addEventListener("input", () => {
    renderCard();
    setStatus(getDefaultStatus());
  });
  elements.exportButton.addEventListener("click", exportCurrentPlayer);

  document.addEventListener("click", (event) => {
    if (!elements.results.contains(event.target) && event.target !== elements.searchInput) {
      clearResults();
    }
  });

  window.addEventListener("resize", fitCardText);
}

async function init() {
  bindEvents();

  try {
    await Promise.all([
      document.fonts.ready,
      document.fonts.load('96px "BarlowCondensed"'),
      document.fonts.load('178px "SidewalkSurf"'),
      document.fonts.load('64px "BornStrong"'),
    ]);
    await loadPlayers();
  } catch (error) {
    console.error(error);
    setStatus("Player data could not be loaded");
  }
}

init();
