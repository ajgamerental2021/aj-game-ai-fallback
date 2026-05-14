import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "missing-openai-api-key",
});

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const aiTimeoutMs = Number(process.env.AI_TIMEOUT_MS || 3500);
const inventorySheetId =
  process.env.INVENTORY_SHEET_ID || "13QZWpd_E-L_0G_Xd0zSL5_OcgV4sdwk9febXZSkZepc";
const inventoryGid = process.env.INVENTORY_GID || "1879984026";
const inventoryCacheMs = Number(process.env.INVENTORY_CACHE_MS || 60000);
const inventoryFetchTimeoutMs = Number(process.env.INVENTORY_FETCH_TIMEOUT_MS || 3000);
const gameDataUrl =
  process.env.GAME_DATA_URL ||
  "https://gist.github.com/ajgamerental2021/4c37e6a92859ce10f353d2ccb1ecbabd/raw/b5ae091ddb5cd977f68ca6c447c7f8a2afde46df/ajgame-data.json";
const gameDataCacheMs = Number(process.env.GAME_DATA_CACHE_MS || 300000);
const gameDataFetchTimeoutMs = Number(process.env.GAME_DATA_FETCH_TIMEOUT_MS || 3000);
const adminToken = process.env.ADMIN_TOKEN || "";
const pausedReplyText = process.env.PAUSED_REPLY_TEXT || "";
const pauseSheetId = process.env.PAUSE_SHEET_ID || inventorySheetId;
const pauseSheetGid = process.env.PAUSE_SHEET_GID || "";
const pauseSheetCacheMs = Number(process.env.PAUSE_SHEET_CACHE_MS || 30000);
const pauseSheetFetchTimeoutMs = Number(process.env.PAUSE_SHEET_FETCH_TIMEOUT_MS || 3000);
const pauseWebhookUrl = process.env.PAUSE_WEBHOOK_URL || "";

let knowledgeBase = "";
let inventoryCache = {
  expiresAt: 0,
  summary: "",
};
let gameDataCache = {
  expiresAt: 0,
  data: null,
};
let pauseSheetCache = {
  expiresAt: 0,
  rows: [],
};
const conversationMemory = new Map();
const pausedSessions = new Map();

const deviceRates = new Map([
  ["PS4", { daily: 300, weekly: 1500, deposit: 2000, category: "300" }],
  ["PS Portal", { daily: 300, weekly: 1500, deposit: 2000, category: "300" }],
  ["PS VR2", { daily: 300, weekly: 1500, deposit: 2000, category: "300" }],
  ["Nintendo Switch 1", { daily: 300, weekly: 1500, deposit: 2000, category: "300" }],
  ["Xbox Series S", { daily: 300, weekly: 1500, deposit: 2000, category: "300" }],
  ["Meta Quest 3s", { daily: 300, weekly: 1500, deposit: 2000, category: "300" }],
  ["Logitech G29", { daily: 300, weekly: 1500, deposit: 2000, category: "300" }],
  ["Xbox Series X", { daily: 350, weekly: 1800, deposit: 2000, category: "350" }],
  ["PS5", { daily: 400, weekly: 2500, deposit: 2000, category: "400" }],
  ["Nintendo Switch 2", { daily: 400, weekly: 2500, deposit: 2000, category: "400" }],
  ["ROG XBOX Ally X", { daily: 400, weekly: 2500, deposit: 2000, category: "400" }],
  ["Meta Quest 3", { daily: 400, weekly: 2500, deposit: 2000, category: "400" }],
  ["Steam Deck OLED", { daily: 400, weekly: 2500, deposit: 2000, category: "400" }],
  ["Viture Beast", { daily: 400, weekly: 2500, deposit: 2000, category: "400" }],
  ["PS5 Pro", { daily: 500, weekly: 3000, deposit: 4000, category: "500" }],
  ["Lenovo Legion GO2", { daily: 500, weekly: 3000, deposit: 4000, category: "500" }],
]);

const deviceAliases = [
  ["Lenovo Legion GO2", ["lenovo legion go2", "legion go2", "go2"]],
  ["ROG XBOX Ally X", ["rog xbox ally x", "rog ally x", "ally x", "rog"]],
  ["Nintendo Switch 2", ["nintendo switch 2", "switch 2", "ns2", "n2"]],
  ["Nintendo Switch 1", ["nintendo switch 1", "switch 1", "switch"]],
  ["Steam Deck OLED", ["steam deck oled", "steam deck", "steam"]],
  ["Xbox Series X", ["xbox series x", "series x"]],
  ["Xbox Series S", ["xbox series s", "series s"]],
  ["Meta Quest 3s", ["meta quest 3s", "quest 3s", "mq3s"]],
  ["Meta Quest 3", ["meta quest 3", "quest 3", "mq3"]],
  ["Viture Beast", ["viture beast", "beast"]],
  ["Viture Luma Ultra", ["viture luma ultra", "luma ultra"]],
  ["Viture Luma Pro", ["viture luma pro", "luma pro"]],
  ["XREAL One", ["xreal one", "xreal"]],
  ["Logitech G29", ["logitech g29", "g29"]],
  ["PS5 Pro", ["ps5 pro", "playstation 5 pro", "เพลย์ 5 pro", "เพลย์5 pro"]],
  ["PS Portal", ["ps portal", "portal"]],
  ["PS VR2", ["ps vr2", "psvr2", "vr2"]],
  ["PS5", ["ps5", "playstation 5", "เพลย์ 5", "เพลย์5"]],
  ["PS4", ["ps4", "playstation 4", "เพลย์ 4", "เพลย์4"]],
];

async function loadKnowledgeBase() {
  knowledgeBase = await fs.readFile(new URL("./knowledge-base.md", import.meta.url), "utf8");
}

function dialogflowText(text) {
  return {
    fulfillmentMessages: [
      {
        text: {
          text: [beautifyReply(text)],
        },
      },
    ],
  };
}

function dialogflowEmpty() {
  return {
    fulfillmentMessages: [],
  };
}

function isFallbackIntent(intentName) {
  return intentName === "Default Fallback Intent" || intentName.toLowerCase().includes("fallback");
}

function clipForChat(text) {
  const clean = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (!clean) return "ขอส่งต่อให้แอดมินช่วยตรวจสอบให้นะคะ";
  return clean.length > 900 ? `${clean.slice(0, 897)}...` : clean;
}

function beautifyReply(text) {
  const value = String(text || "").trim();
  if (!value) return value;

  const lines = value.split(/\r?\n/).map((line) => line.trimEnd());
  const spaced = [];

  for (const line of lines) {
    const isVisualLine = /^[🎮📅🗓️💰🔒✅📝🚚⭐⚠️📍🗨️👋✨]/u.test(line);
    const previous = spaced[spaced.length - 1];

    if (isVisualLine && previous && previous !== "") {
      spaced.push("");
    }

    spaced.push(line);
  }

  return spaced.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function getBangkokDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  })
    .formatToParts(new Date())
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    display: `${parts.day}/${parts.month}/${parts.year}`,
    weekday: parts.weekday,
  };
}

function getSessionKey(req) {
  return (
    req.body?.originalDetectIntentRequest?.payload?.data?.source?.userId ||
    req.body?.originalDetectIntentRequest?.payload?.source?.userId ||
    req.body?.session ||
    "anonymous"
  );
}

function getDialogflowSession(req) {
  return req.body?.session || "";
}

function getMemory(sessionKey) {
  if (!conversationMemory.has(sessionKey)) {
    conversationMemory.set(sessionKey, {
      greetedDate: "",
      lastDevice: "",
      lastMessages: [],
    });
  }

  return conversationMemory.get(sessionKey);
}

function extractDeviceName(text) {
  const normalized = String(text || "").toLowerCase();

  for (const [deviceName, aliases] of deviceAliases) {
    if (aliases.some((alias) => normalized.includes(alias.toLowerCase()))) {
      return deviceName;
    }
  }

  return "";
}

function updateRecentMessages(memory, customerText, answer = "") {
  memory.lastMessages.push({ customerText, answer });
  memory.lastMessages = memory.lastMessages.slice(-4);
}

function isEnglishText(text) {
  const value = String(text || "");
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const thai = (value.match(/[\u0E00-\u0E7F]/g) || []).length;
  return latin > thai;
}

function formatMoney(amount, english = false) {
  return `${Number(amount).toLocaleString("en-US")} ${english ? "THB" : "บาท"}`;
}

function extractRentalDays(text) {
  const value = String(text || "").toLowerCase();
  const patterns = [
    /(\d+)\s*(?:วัน|day|days|d)\b/i,
    /(?:เช่า|rent)\s*(\d+)\b/i,
    /(\d+)\s*(?:คืน|night|nights)\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return Number(match[1]);
  }

  if (/สัปดาห์|week|weekly/.test(value)) return 7;
  return null;
}

function includesPriceQuestion(text) {
  const value = normalizeSearchText(text);
  const hasDevice = Boolean(extractDeviceName(text));
  return (
    /ราคา|กี่บาท|เท่าไหร่|ค่าเช่า|เรท|price|how much|rate|cost|rental fee/.test(value) ||
    (hasDevice && /เช่า|rent|rental/.test(value))
  );
}

function calculateRental(deviceName, days, noContract = false, returningCustomer = false) {
  const rate = deviceRates.get(deviceName);
  if (!rate) return null;

  const rentalFee = days === 7 ? rate.weekly : days >= 3 && days <= 6 ? rate.daily * days : null;
  if (rentalFee === null) return { rate };

  const discount = returningCustomer ? Math.round(rentalFee * 0.1) : 0;
  const discountedRentalFee = rentalFee - discount;
  const deposit = noContract ? (rate.deposit === 4000 ? 8000 : 5000) : rate.deposit;

  return {
    rate,
    rentalFee,
    discount,
    discountedRentalFee,
    deposit,
    total: discountedRentalFee + deposit,
    bookingFee: 200,
    payOnDelivery: discountedRentalFee + deposit - 200,
  };
}

function buildPriceAnswer(customerText, memory, shouldGreetToday) {
  if (!includesPriceQuestion(customerText)) return "";

  const english = isEnglishText(customerText);
  const deviceName = extractDeviceName(customerText) || memory.lastDevice;

  if (!deviceName || !deviceRates.has(deviceName)) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          "Which device would you like to rent?",
          "",
          "Please tell me the model, for example PS5, PS5 Pro, Nintendo Switch 2, or Meta Quest 3.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          "สนใจเช่าเครื่องรุ่นไหนครับ?",
          "",
          "แจ้งชื่อเครื่องได้เลย เช่น PS5, PS5 Pro, Nintendo Switch 2 หรือ Meta Quest 3 ครับ",
        ]
          .filter(Boolean)
          .join("\n");
  }

  memory.lastDevice = deviceName;

  const days = extractRentalDays(customerText);
  const noContract = /ไม่ทำสัญญา|ไม่แนบบัตร|no contract|without contract/i.test(customerText);
  const returningCustomer = /ลูกค้าเก่า|เคยเช่า|returning|old customer/i.test(customerText);
  const calc = days ? calculateRental(deviceName, days, noContract, returningCustomer) : null;
  const rate = deviceRates.get(deviceName);

  if (!days) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          `${deviceName} rental rate`,
          "",
          `💰 Daily: ${formatMoney(rate.daily, true)} / day`,
          `📅 Minimum rental: 3 days`,
          `🗓️ Weekly: ${formatMoney(rate.weekly, true)} / 7 days`,
          `🔒 Deposit: ${formatMoney(rate.deposit, true)} (refundable on return day)`,
          "",
          "Please tell me how many days you would like to rent, and I can calculate the total for you.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          `ราคาเช่า ${deviceName} ครับ`,
          "",
          `💰 รายวัน: ${formatMoney(rate.daily)} / วัน`,
          `📅 ขั้นต่ำ: 3 วัน`,
          `🗓️ รายสัปดาห์: ${formatMoney(rate.weekly)} / 7 วัน`,
          `🔒 ค่าประกัน: ${formatMoney(rate.deposit)} ได้คืนวันคืนเครื่อง`,
          "",
          "แจ้งจำนวนวันที่ต้องการเช่าได้เลยครับ เดี๋ยวคำนวณยอดรวมให้ครับ ✅",
        ]
          .filter(Boolean)
          .join("\n");
  }

  if (!calc || calc.rentalFee == null) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          `${deviceName} rental starts from 3 days.`,
          "",
          `💰 Daily: ${formatMoney(rate.daily, true)} / day`,
          `🗓️ Weekly: ${formatMoney(rate.weekly, true)} / 7 days`,
          "",
          "For rentals longer than 7 days, admin will help confirm the best rate.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          `${deviceName} เช่าขั้นต่ำ 3 วันครับ`,
          "",
          `💰 รายวัน: ${formatMoney(rate.daily)} / วัน`,
          `🗓️ รายสัปดาห์: ${formatMoney(rate.weekly)} / 7 วัน`,
          "",
          "ถ้าเช่าเกิน 7 วัน เดี๋ยวแอดมินช่วยเช็คเรทราคาให้เหมาะที่สุดครับ ✅",
        ]
          .filter(Boolean)
          .join("\n");
  }

  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        `${deviceName} for ${days} days`,
        "",
        `💰 Rental fee: ${formatMoney(calc.rentalFee, true)}`,
        calc.discount ? `⭐ Returning customer discount 10%: -${formatMoney(calc.discount, true)}` : "",
        `🔒 Deposit: ${formatMoney(calc.deposit, true)} (refundable on return day)`,
        "",
        `✅ Total before delivery: ${formatMoney(calc.total, true)}`,
        "",
        "📝 Booking payment: 200 THB",
        `🚚 Pay on delivery: ${formatMoney(calc.payOnDelivery, true)}`,
        "",
        "Please send the start date and Google Maps link so we can check delivery fee.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        `${deviceName} เช่า ${days} วันครับ`,
        "",
        `💰 ค่าเช่า: ${formatMoney(calc.rentalFee)}`,
        calc.discount ? `⭐ ส่วนลดลูกค้าเก่า 10%: -${formatMoney(calc.discount)}` : "",
        `🔒 ค่าประกัน: ${formatMoney(calc.deposit)} ได้คืนวันคืนเครื่อง`,
        "",
        `✅ รวมสุทธิ: ${formatMoney(calc.total)}`,
        "",
        "📝 โอนจองคิว: 200 บาท",
        `🚚 จ่ายตอนรับเครื่อง: ${formatMoney(calc.payOnDelivery)}`,
        "",
        "ถ้าสนใจจอง แจ้งวันเริ่มเช่าและส่งลิงก์ Google Maps ได้เลยครับ 📍",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesAdminRequest(text) {
  const value = normalizeSearchText(text);
  return /แอดมิน|admin|คนจริง|พนักงาน|เจ้าหน้าที่|ติดต่อคน|คุยกับคน|human|staff|agent|representative/.test(
    value,
  );
}

function buildAdminPauseReply(customerText, shouldGreetToday) {
  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 👋" : "",
        "🗨️ Admin will take care of you shortly.",
        "",
        "I’ll pause the automated reply now so our team can continue the conversation directly.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 👋" : "",
        "🗨️ แอดมินจะเข้ามาดูแลให้นะครับ",
        "",
        "ระบบจะพักการตอบอัตโนมัติไว้ก่อน เพื่อให้แอดมินคุยต่อโดยตรงครับ ✅",
      ]
        .filter(Boolean)
        .join("\n");
}

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesGameQuestion(text) {
  const normalized = normalizeSearchText(text);
  return /เกม|game|เล่น|มี/.test(normalized);
}

async function fetchJsonWithTimeout(url, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadGameData() {
  const now = Date.now();
  if (gameDataCache.data && gameDataCache.expiresAt > now) {
    return gameDataCache.data;
  }

  const data = await fetchJsonWithTimeout(gameDataUrl, gameDataFetchTimeoutMs);
  gameDataCache = {
    expiresAt: now + gameDataCacheMs,
    data,
  };

  return data;
}

function getPlatformName(gameData, platformId) {
  return gameData.platforms?.find((platform) => platform.id === platformId)?.name || platformId;
}

async function lookupGameSummary(customerText, { force = false } = {}) {
  if (!force && !includesGameQuestion(customerText)) {
    return "";
  }

  const gameData = await loadGameData();
  const stopwords = new Set([
    "มี",
    "เกม",
    "game",
    "ไหม",
    "มั้ย",
    "เล่น",
    "ได้",
    "ใน",
    "เครื่อง",
    "บน",
    "ขอ",
    "ถาม",
    "เช่า",
    "available",
    "have",
    "do",
    "you",
    "has",
    "is",
    "there",
    "on",
  ]);
  const query = normalizeSearchText(customerText)
    .split(" ")
    .filter((part) => !stopwords.has(part))
    .join(" ")
    .trim();

  if (query.length < 3) {
    return "ข้อมูลเกม: ลูกค้าถามเรื่องเกม แต่ยังไม่ได้ระบุชื่อเกมชัดเจน ให้ส่งลิงก์เลือกเกมและถามชื่อเกมที่สนใจ";
  }

  const queryParts = query.split(" ").filter((part) => part.length >= 3);
  const matches = [];

  for (const game of gameData.games || []) {
    const gameName = normalizeSearchText(game.name);
    const directMatch = gameName.includes(query) || query.includes(gameName);
    const tokenMatch =
      queryParts.length > 0 && queryParts.every((part) => gameName.includes(part));

    if (directMatch || tokenMatch) {
      matches.push({
        name: game.name,
        platform: getPlatformName(gameData, game.platformId),
        unavailable: Boolean(game.unavailable),
        availableDate: game.available_date || "",
      });
    }

    if (matches.length >= 8) break;
  }

  if (matches.length === 0) {
    return [
      "ข้อมูลเกม: ไม่พบชื่อเกมที่ตรงกับคำถามใน Gist",
      "ให้ตอบว่าเบื้องต้นยังไม่เจอในรายการรวม และให้ลูกค้าเช็ค/เลือกเกมเองได้ที่ https://ajgamerental2021.github.io/ajconsole/game_index.html",
    ].join("\n");
  }

  const lines = matches.map((match) => {
    const status = match.unavailable
      ? `ไม่พร้อมให้เลือกตอนนี้${match.availableDate ? `, คาดว่าจะว่าง ${match.availableDate}` : ""}`
      : "มีให้เลือก";
    return `- ${match.name}: ${match.platform} (${status})`;
  });

  return [
    "ข้อมูลเกมจาก Gist:",
    "ถ้าพบเกมเดียวกันหลายเครื่อง ให้บอกเครื่องที่มีให้ลูกค้าเลือก",
    ...lines,
    "ลิงก์เลือกเกมทั้งหมด: https://ajgamerental2021.github.io/ajconsole/game_index.html",
  ].join("\n");
}

function getActivePause(sessionKey) {
  const pause = pausedSessions.get(sessionKey);
  if (!pause) return null;

  if (pause.expiresAt && pause.expiresAt <= Date.now()) {
    pausedSessions.delete(sessionKey);
    return null;
  }

  return pause;
}

function parseDateTime(value) {
  if (!value) return 0;
  const text = String(value).trim();
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

async function loadPauseSheetRows() {
  if (!pauseSheetGid) return [];

  const now = Date.now();
  if (pauseSheetCache.expiresAt > now) {
    return pauseSheetCache.rows;
  }

  const url = `https://docs.google.com/spreadsheets/d/${pauseSheetId}/export?format=csv&gid=${pauseSheetGid}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), pauseSheetFetchTimeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Pause sheet fetch failed: ${response.status}`);
    }

    const csv = await response.text();
    const rows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    pauseSheetCache = {
      expiresAt: now + pauseSheetCacheMs,
      rows,
    };

    return rows;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getPauseFromSheet(sessionKey, customerId = "") {
  const rows = await loadPauseSheetRows();
  const now = Date.now();

  for (const row of rows) {
    const status = String(row.Status || row.status || "").trim().toLowerCase();
    if (status && !["paused", "pause", "active", "true", "yes"].includes(status)) {
      continue;
    }

    const rowSession = String(row.SessionKey || row.sessionKey || row.session || "").trim();
    const rowCustomer = String(row.CustomerId || row.customerId || row.userId || "").trim();
    const matchesSession = rowSession && rowSession === sessionKey;
    const matchesCustomer = rowCustomer && rowCustomer === customerId;

    if (!matchesSession && !matchesCustomer) continue;

    const until = parseDateTime(row.PausedUntil || row.pausedUntil || row.ExpiresAt || row.expiresAt);
    if (until && until <= now) continue;

    return {
      expiresAt: until,
      reason: row.Reason || row.reason || "pause_sheet",
      source: "google_sheet",
    };
  }

  return null;
}

async function getEffectivePause(sessionKey, customerId = "") {
  const localPause = getActivePause(sessionKey);
  if (localPause) return localPause;

  try {
    return await getPauseFromSheet(sessionKey, customerId);
  } catch (error) {
    console.error("Pause sheet lookup failed:", error);
    return null;
  }
}

async function persistPauseToWebhook({ sessionKey, customerId, minutes, reason }) {
  if (!pauseWebhookUrl) return;

  try {
    const expiresAt = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : "";
    await fetch(pauseWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: adminToken,
        sessionKey,
        customerId,
        minutes,
        reason,
        status: "paused",
        pausedUntil: expiresAt,
        createdAt: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.error("Persist pause webhook failed:", error);
  }
}

function requireAdmin(req, res) {
  if (!adminToken) {
    res.status(403).json({ ok: false, error: "ADMIN_TOKEN is not configured" });
    return false;
  }

  const token = req.get("x-admin-token") || req.query.token;
  if (token !== adminToken) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }

  return true;
}

async function loadInventorySummary() {
  const now = Date.now();
  if (inventoryCache.summary && inventoryCache.expiresAt > now) {
    return inventoryCache.summary;
  }

  const url = `https://docs.google.com/spreadsheets/d/${inventorySheetId}/export?format=csv&gid=${inventoryGid}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), inventoryFetchTimeoutMs);
  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`Inventory sheet fetch failed: ${response.status}`);
  }

  const csv = await response.text();
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const grouped = new Map();

  for (const record of records) {
    const deviceName = record["Device Name"]?.trim();
    const status = record.Status?.trim();

    if (!deviceName || !status) continue;

    if (!grouped.has(deviceName)) {
      grouped.set(deviceName, {
        total: 0,
        available: 0,
        unavailableStatuses: new Set(),
        nextAvailableDates: new Set(),
      });
    }

    const group = grouped.get(deviceName);
    group.total += 1;

    if (status.toLowerCase() === "available") {
      group.available += 1;
    } else {
      group.unavailableStatuses.add(status);
      if (record["Available Date"]?.trim()) {
        group.nextAvailableDates.add(record["Available Date"].trim());
      }
    }
  }

  const lines = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([deviceName, group]) => {
      if (group.available > 0) {
        return `- ${deviceName}: Available (${group.available}/${group.total} เครื่องว่าง)`;
      }

      const dates = [...group.nextAvailableDates].join(", ");
      const suffix = dates ? `, วันที่คาดว่าจะว่าง: ${dates}` : "";
      return `- ${deviceName}: Not available (0/${group.total} เครื่องว่าง${suffix})`;
    });

  inventoryCache = {
    expiresAt: now + inventoryCacheMs,
    summary: [
      "ข้อมูลสต็อกจาก Google Sheet worksheet Inventory:",
      "กติกา: ถ้า Device Name เดียวกันมีหลายแถว และมี Status = Available อย่างน้อย 1 แถว ให้ถือว่าเครื่องรุ่นนั้นว่าง",
      ...lines,
    ].join("\n"),
  };

  return inventoryCache.summary;
}

async function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("AI request timed out")), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function askAI(customerText, memory, sessionContext) {
  if (!process.env.OPENAI_API_KEY) {
    return "ขออภัยค่ะ ขอส่งต่อให้แอดมินช่วยตรวจสอบให้นะคะ";
  }

  let inventorySummary = "";
  let gameSummary = "";

  try {
    inventorySummary = await loadInventorySummary();
  } catch (error) {
    console.error("Inventory lookup failed:", error);
    inventorySummary =
      "ข้อมูลสต็อก: ตอนนี้เช็ค Google Sheet ไม่สำเร็จ ถ้าลูกค้าถามเครื่องว่าง ให้บอกว่าจะให้แอดมินเช็คคิวล่าสุดให้นะคะ";
  }

  try {
    gameSummary = await lookupGameSummary(customerText);
  } catch (error) {
    console.error("Game lookup failed:", error);
    gameSummary =
      "ข้อมูลเกม: ตอนนี้เช็ค Gist ไม่สำเร็จ ถ้าลูกค้าถามเกม ให้ส่งลิงก์เลือกเกมทั้งหมด https://ajgamerental2021.github.io/ajconsole/game_index.html";
  }

  const response = await withTimeout(
    openai.responses.create({
      model,
      max_output_tokens: 700,
      instructions: [
        "คุณเป็นแอดมินร้าน Aj เช่าเครื่องเกม ตอบสุภาพ เป็นธรรมชาติ และอ่านง่าย",
        "ตอบเป็นภาษาเดียวกับลูกค้า ถ้าลูกค้าพิมพ์ไทยให้ตอบไทย ถ้าลูกค้าพิมพ์อังกฤษให้ตอบอังกฤษ",
        "จัดคำตอบเป็นบรรทัดสั้น ๆ และเว้นบรรทัดระหว่างหัวข้อเสมอ",
        "ใช้ emoji ให้ดูเป็นมิตรและชัดเจนในทุกหัวข้อ เช่น 🎮✨ 📅🕒 💰✅ 🚚⚡️ 📝📌 ⚠️",
        "ห้ามเขียนเป็นย่อหน้ายาว ถ้ามีราคา/เงื่อนไข/ขั้นตอน ให้แยกเป็นหลายบรรทัดพร้อมเว้นบรรทัด",
        "รูปแบบที่ชอบ: หัวข้อ 1 บรรทัด, รายละเอียด 2-5 บรรทัด, เว้นบรรทัด, ขั้นต่อไป 1-3 บรรทัด",
        "ถ้า shouldGreetToday=true ให้เริ่มด้วยคำทักทายสั้น ๆ เช่น 'สวัสดีครับ' หรือ 'Hello' เฉพาะครั้งแรกของวันนั้น",
        "ถ้า shouldGreetToday=false ห้ามขึ้นต้นด้วยคำว่า สวัสดี/Hello อีก",
        "ตอบจากข้อมูลร้านที่ให้มาเท่านั้น ห้ามแต่งราคา สต็อก โปรโมชัน หรือเงื่อนไขเอง",
        "ถ้าข้อมูลไม่พอ ให้ถามกลับ 1 คำถามที่จำเป็นที่สุด",
        "ถ้าลูกค้าถามต่อโดยไม่ระบุชื่อเครื่อง ให้ใช้ lastDevice จาก context ก่อนหน้าเป็นเครื่องที่กำลังคุยอยู่",
        "ถ้าลูกค้าถามว่าเครื่องรุ่นใดว่างหรือไม่ ให้ใช้ข้อมูลสต็อกจาก Google Sheet ที่แนบมา",
        "ถ้าเครื่องมี Status = Available อย่างน้อย 1 เครื่อง ให้ตอบว่าว่าง แต่ถ้าลูกค้าต้องการจองตามวันที่เฉพาะ ให้แจ้งว่าจะให้แอดมินเช็คคิวและยืนยันอีกครั้ง",
        "ถ้าลูกค้าถามว่ามีเกมนี้ไหม ให้ใช้ข้อมูลเกมจาก Gist ที่แนบมา ถ้าไม่พบให้ส่งลิงก์เลือกเกมทั้งหมด",
        "ถ้าลูกค้าถามเลือกเกม ให้ส่งลิงก์ https://ajgamerental2021.github.io/ajconsole/game_index.html",
        "การคำนวณวันคืน: ถ้าเริ่มเช่าวันที่ X จำนวน N วัน ให้วันคืน = วันที่ X + N วัน เช่น เริ่ม 1 เช่า 3 วัน คืน 4, เริ่ม 1 เช่า 7 วัน คืน 8",
        "ถ้าลูกค้าพูดว่าเริ่มวันนี้ ให้ใช้วันที่ปัจจุบันใน Asia/Bangkok จาก context",
        "ถ้าเป็นเรื่องคืนเงิน เคลม ยกเลิกออเดอร์ ต่อรองพิเศษ หรือข้อร้องเรียน ให้บอกว่าจะส่งต่อแอดมิน",
        "ห้ามพูดถึงว่าเป็น AI หรือระบบอัตโนมัติ เว้นแต่ลูกค้าถามตรง ๆ",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            `ข้อมูลร้าน:\n${knowledgeBase}`,
            inventorySummary,
            gameSummary,
            `บริบทสนทนา:\n${sessionContext}`,
            `ข้อความลูกค้า:\n${customerText}`,
          ].join("\n\n"),
        },
      ],
    }),
    aiTimeoutMs,
  );

  return clipForChat(response.output_text);
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Dialogflow ES AI fallback webhook",
    model,
  });
});

app.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    model,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasAdminToken: Boolean(adminToken),
    aiTimeoutMs,
    inventorySheetId,
    inventoryGid,
    inventoryCacheMs,
    inventoryFetchTimeoutMs,
    gameDataUrl,
    gameDataCacheMs,
    gameDataFetchTimeoutMs,
    pauseSheetId,
    pauseSheetGid,
    pauseSheetCacheMs,
    pauseWebhookConfigured: Boolean(pauseWebhookUrl),
  });
});

app.get("/inventory", async (_req, res) => {
  try {
    const summary = await loadInventorySummary();
    res.type("text/plain").send(summary);
  } catch (error) {
    console.error("Inventory endpoint failed:", error);
    res.status(500).json({ ok: false, error: "Inventory lookup failed" });
  }
});

app.get("/games/search", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const summary = await lookupGameSummary(q, { force: true });
    res.type("text/plain").send(summary || "กรุณาใส่ชื่อเกมที่ต้องการค้นหา เช่น /games/search?q=elden ring");
  } catch (error) {
    console.error("Game search endpoint failed:", error);
    res.status(500).json({ ok: false, error: "Game lookup failed" });
  }
});

app.get("/admin/pauses", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const now = Date.now();
  const pauses = [...pausedSessions.entries()].map(([sessionKey, pause]) => ({
    sessionKey,
    reason: pause.reason || "",
    expiresAt: pause.expiresAt ? new Date(pause.expiresAt).toISOString() : null,
    remainingSeconds: pause.expiresAt ? Math.max(0, Math.round((pause.expiresAt - now) / 1000)) : null,
  }));

  res.json({ ok: true, pauses });
});

app.get("/admin/pause-sheet", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const rows = await loadPauseSheetRows();
    res.json({ ok: true, rows });
  } catch (error) {
    console.error("Pause sheet endpoint failed:", error);
    res.status(500).json({ ok: false, error: "Pause sheet lookup failed" });
  }
});

app.post("/admin/pause", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.body?.sessionKey || req.query.sessionKey || "").trim();
  const minutes = Number(req.body?.minutes || req.query.minutes || 60);
  const reason = String(req.body?.reason || req.query.reason || "admin_takeover");

  if (!sessionKey) {
    return res.status(400).json({ ok: false, error: "sessionKey is required" });
  }

  const expiresAt = minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0;
  pausedSessions.set(sessionKey, { expiresAt, reason });
  persistPauseToWebhook({
    sessionKey,
    customerId: sessionKey,
    minutes,
    reason,
  });
  res.json({
    ok: true,
    sessionKey,
    reason,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  });
});

app.post("/admin/resume", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.body?.sessionKey || req.query.sessionKey || "").trim();

  if (!sessionKey) {
    return res.status(400).json({ ok: false, error: "sessionKey is required" });
  }

  pausedSessions.delete(sessionKey);
  res.json({ ok: true, sessionKey, resumed: true });
});

app.post("/dialogflow-webhook", async (req, res) => {
  const queryResult = req.body?.queryResult || {};
  const customerText = queryResult.queryText || "";
  const intentName = queryResult.intent?.displayName || "";
  const sessionKey = getSessionKey(req);
  const dialogflowSession = getDialogflowSession(req);
  const memory = getMemory(sessionKey);
  const today = getBangkokDateParts();
  const detectedDevice = extractDeviceName(customerText);

  if (detectedDevice) {
    memory.lastDevice = detectedDevice;
  }

  const shouldGreetToday = memory.greetedDate !== today.dateKey;

  console.log("Dialogflow webhook:", {
    intentName,
    text: customerText,
    isFallback: isFallbackIntent(intentName),
    sessionKey,
    dialogflowSession,
    lastDevice: memory.lastDevice,
    shouldGreetToday,
  });

  if (includesAdminRequest(customerText)) {
    const answer = buildAdminPauseReply(customerText, shouldGreetToday);
    const minutes = 120;
    const expiresAt = Date.now() + minutes * 60 * 1000;

    pausedSessions.set(sessionKey, {
      expiresAt,
      reason: "customer_requested_admin",
    });

    await persistPauseToWebhook({
      sessionKey,
      customerId: sessionKey,
      minutes,
      reason: "customer_requested_admin",
    });

    memory.greetedDate = today.dateKey;
    updateRecentMessages(memory, customerText, answer);
    return res.json(dialogflowText(answer));
  }

  const activePause = await getEffectivePause(sessionKey, dialogflowSession);
  if (activePause) {
    console.log("AI paused for session:", {
      sessionKey,
      reason: activePause.reason,
      expiresAt: activePause.expiresAt ? new Date(activePause.expiresAt).toISOString() : null,
    });

    return res.json(pausedReplyText ? dialogflowText(pausedReplyText) : dialogflowEmpty());
  }

  if (!isFallbackIntent(intentName) && queryResult.fulfillmentText) {
    return res.json(dialogflowText(queryResult.fulfillmentText));
  }

  if (!customerText.trim()) {
    return res.json(dialogflowText("ขอรายละเอียดเพิ่มเติมนิดนึงนะคะ"));
  }

  try {
    const deterministicAnswer = buildPriceAnswer(customerText, memory, shouldGreetToday);
    if (deterministicAnswer) {
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, deterministicAnswer);
      return res.json(dialogflowText(deterministicAnswer));
    }

    const sessionContext = [
      `todayDateBangkok=${today.display}`,
      `todayWeekday=${today.weekday}`,
      `shouldGreetToday=${shouldGreetToday}`,
      `lastDevice=${memory.lastDevice || "none"}`,
      `recentMessages=${JSON.stringify(memory.lastMessages)}`,
    ].join("\n");

    const answer = await askAI(customerText, memory, sessionContext);
    memory.greetedDate = today.dateKey;
    updateRecentMessages(memory, customerText, answer);
    return res.json(dialogflowText(answer));
  } catch (error) {
    console.error("AI fallback failed:", error);
    return res.json(dialogflowText("ขออภัยค่ะ ขอส่งต่อให้แอดมินช่วยตรวจสอบให้นะคะ"));
  }
});

await loadKnowledgeBase();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Dialogflow AI fallback webhook is running on port ${port}`);
});
