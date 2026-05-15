import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";
import OpenAI from "openai";
import { Redis } from "@upstash/redis";

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;
const memoryTtlSeconds = Number(process.env.MEMORY_TTL_SECONDS || 7 * 24 * 60 * 60);

const app = express();
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "missing-openai-api-key",
});

const model = process.env.OPENAI_MODEL || "gpt-4o";
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
const defaultPauseMinutes = Number(process.env.DEFAULT_PAUSE_MINUTES || 720);
const eventWebhookUrl = process.env.EVENT_WEBHOOK_URL || "";

// Fire-and-forget event to n8n (or any webhook). Powers alerts, reports, handoff notifications.
function notifyEvent(type, payload = {}) {
  if (!eventWebhookUrl) return;
  fetch(eventWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...payload, at: new Date().toISOString() }),
  }).catch((error) => console.error("notifyEvent failed:", error));
}

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
const recentSessions = new Map();
let globalPause = null;
const globalPauseExceptions = new Set();

async function hydrateGlobalPauseFromRedis() {
  if (!redis) return;
  try {
    const data = await redis.get("global_pause");
    if (data && typeof data === "object") {
      if (!data.expiresAt || data.expiresAt > Date.now()) {
        globalPause = { expiresAt: data.expiresAt || 0, reason: data.reason || "global_admin_pause" };
      } else {
        await redis.del("global_pause");
      }
    }
    const exemptions = await redis.smembers("global_pause_exceptions");
    if (Array.isArray(exemptions)) {
      exemptions.forEach((k) => globalPauseExceptions.add(k));
    }
  } catch (error) {
    console.error("Redis hydrate global pause failed:", error);
  }
}

async function persistGlobalPauseToRedis() {
  if (!redis) return;
  try {
    if (globalPause) {
      await redis.set("global_pause", globalPause);
    } else {
      await redis.del("global_pause");
    }
  } catch (error) {
    console.error("Redis persist global pause failed:", error);
  }
}

async function persistExemptionsToRedis() {
  if (!redis) return;
  try {
    await redis.del("global_pause_exceptions");
    if (globalPauseExceptions.size) {
      await redis.sadd("global_pause_exceptions", ...globalPauseExceptions);
    }
  } catch (error) {
    console.error("Redis persist exemptions failed:", error);
  }
}

const deviceRates = new Map([
  ["PS4", { daily: 300, weekly: 1500, monthly: 4000, deposit: 2000, category: "300" }],
  ["PS Portal", { daily: 300, weekly: 1500, monthly: 4000, deposit: 2000, category: "300" }],
  ["PS VR2", { daily: 300, weekly: 1500, monthly: 4000, deposit: 2000, category: "300" }],
  ["Nintendo Switch 1", { daily: 300, weekly: 1500, monthly: 4000, deposit: 2000, category: "300" }],
  ["Xbox Series S", { daily: 300, weekly: 1500, monthly: 4000, deposit: 2000, category: "300" }],
  ["Meta Quest 3s", { daily: 300, weekly: 1500, monthly: 4000, deposit: 2000, category: "300" }],
  ["Logitech G29", { daily: 300, weekly: 1500, monthly: 4000, deposit: 2000, category: "300" }],
  ["Xbox Series X", { daily: 350, weekly: 1800, monthly: 5000, deposit: 2000, category: "350" }],
  ["PS5", { daily: 400, weekly: 2500, monthly: 6500, deposit: 2000, category: "400" }],
  ["Nintendo Switch 2", { daily: 400, weekly: 2500, monthly: 6500, deposit: 2000, category: "400" }],
  ["ROG XBOX Ally X", { daily: 400, weekly: 2500, monthly: 6500, deposit: 2000, category: "400" }],
  ["Meta Quest 3", { daily: 400, weekly: 2500, monthly: 6500, deposit: 2000, category: "400" }],
  ["Steam Deck OLED", { daily: 400, weekly: 2500, monthly: 6500, deposit: 2000, category: "400" }],
  ["Viture Beast", { daily: 400, weekly: 2500, monthly: 6500, deposit: 2000, category: "400" }],
  ["PS5 Pro", { daily: 500, weekly: 3000, monthly: 8000, deposit: 4000, category: "500" }],
  ["Lenovo Legion GO2", { daily: 500, weekly: 3000, monthly: 8000, deposit: 4000, category: "500" }],
]);

const deviceAliases = [
  ["Lenovo Legion GO2", ["lenovo legion go2", "legion go2", "go2"]],
  ["ROG XBOX Ally X", ["rog xbox ally x", "rog ally x", "ally x", "rog"]],
  ["Nintendo Switch 2", ["nintendo switch 2", "switch 2", "ns2", "n2"]],
  ["Nintendo Switch 1", ["nintendo switch 1", "switch 1", "switch"]],
  ["Steam Deck OLED", ["steam deck oled", "steam deck", "steam"]],
  ["Xbox Series X", ["xbox series x", "series x", "xbox x", "xbox sx", "xsx"]],
  ["Xbox Series S", ["xbox series s", "series s", "xbox s", "xbox ss", "xss"]],
  ["Meta Quest 3s", ["meta quest 3s", "quest 3s", "mq3s"]],
  ["Meta Quest 3", ["meta quest 3", "quest 3", "mq3"]],
  ["Viture Beast", ["viture beast", "beast"]],
  ["Viture Luma Ultra", ["viture luma ultra", "luma ultra"]],
  ["Viture Luma Pro", ["viture luma pro", "luma pro"]],
  ["XREAL One", ["xreal one", "xreal"]],
  ["Logitech G29", ["logitech g29", "g29"]],
  ["PS5 Pro", ["ps5 pro", "ps 5 pro", "playstation 5 pro", "เพลย์ 5 pro", "เพลย์5 pro", "เพลย์สเตชั่น 5 pro"]],
  ["PS Portal", ["ps portal", "psportal", "portal", "พอร์ทัล"]],
  ["PS VR2", ["ps vr2", "psvr2", "vr2", "วีอาร์2"]],
  ["PS5", ["ps5", "ps 5", "playstation 5", "เพลย์ 5", "เพลย์5", "เพลย์สเตชั่น 5", "เพล5"]],
  ["PS4", ["ps4", "ps 4", "playstation 4", "เพลย์ 4", "เพลย์4", "เพลย์สเตชั่น 4"]],
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
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      lastGameQuery: "",
      lastReturnDate: "",
      lastStartDate: "",
      lastRentalDays: null,
      lastMessages: [],
      noContractPending: false,
      pendingNextDate: "",
      pendingDevice: "",
      summarySent: false,
      preferMonthly: false,
    });
  }

  return conversationMemory.get(sessionKey);
}

async function hydrateMemoryFromRedis(sessionKey) {
  if (!redis || !sessionKey) return;
  if (conversationMemory.has(sessionKey)) return;
  try {
    const data = await redis.get(`mem:${sessionKey}`);
    if (data && typeof data === "object") {
      conversationMemory.set(sessionKey, {
        greetedDate: data.greetedDate || "",
        lastDevice: data.lastDevice || "",
        lastGameQuery: data.lastGameQuery || "",
        lastReturnDate: data.lastReturnDate || "",
        lastStartDate: data.lastStartDate || "",
        lastRentalDays: data.lastRentalDays ?? null,
        lastMessages: Array.isArray(data.lastMessages) ? data.lastMessages : [],
        noContractPending: Boolean(data.noContractPending),
        pendingNextDate: data.pendingNextDate || "",
        pendingDevice: data.pendingDevice || "",
        summarySent: Boolean(data.summarySent),
        preferMonthly: Boolean(data.preferMonthly),
      });
    }
  } catch (error) {
    console.error("Redis hydrate failed:", error);
  }
}

async function persistMemoryToRedis(sessionKey) {
  if (!redis || !sessionKey) return;
  const mem = conversationMemory.get(sessionKey);
  if (!mem) return;
  try {
    await redis.set(`mem:${sessionKey}`, mem, { ex: memoryTtlSeconds });
  } catch (error) {
    console.error("Redis persist failed:", error);
  }
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

function ambiguousTokenMatchesDevice(token, deviceName) {
  if (!token || !deviceName) return false;
  if (token === "xbox") return deviceName.startsWith("Xbox");
  if (token === "playstation") return deviceName.startsWith("PS");
  if (token === "switch") return deviceName.startsWith("Nintendo Switch");
  if (token === "quest") return deviceName.startsWith("Meta Quest");
  return false;
}

function detectAmbiguousDevice(text) {
  const value = String(text || "").toLowerCase();
  if (extractDeviceName(text)) return "";
  if (/\bxbox\b/.test(value) || /เอ็กซ์บ็อกซ์|เอ็กบ็อก/.test(value)) return "xbox";
  if (/\bps\b|\bplaystation\b|เพลย์/.test(value) && !/ps[345]|ps\s*portal|ps\s*vr|psvr/.test(value)) return "playstation";
  if (/\bswitch\b|\bnintendo\b|นินเทนโด|นินเทน|สวิตช์/.test(value) && !/switch\s*[12]|ns[12]\b/.test(value)) return "switch";
  if (/\bquest\b|\bmeta\b/.test(value) && !/quest\s*3s?|mq3/.test(value)) return "quest";
  return "";
}

function buildAmbiguousDeviceAnswer(token, english, shouldGreetToday) {
  const greet = english ? "Hello 🎮✨" : "สวัสดีครับ 🎮✨";
  const lines = [];
  if (shouldGreetToday) lines.push(greet);
  if (token === "xbox") {
    lines.push(english ? "🎮 Xbox Series X or Series S?" : "🎮 สนใจ Xbox Series X หรือ Series S ครับ?");
    lines.push("");
    lines.push(english ? "⚡️ Series X" : "⚡️ Series X");
    lines.push(english ? "💰 350 THB/day" : "💰 รายวัน 350 บาท");
    lines.push(english ? "🗓️ 1,800 THB/week" : "🗓️ รายสัปดาห์ 1,800 บาท");
    lines.push(english ? "🔒 Deposit 2,000 THB" : "🔒 ค่าประกัน 2,000 บาท");
    lines.push("");
    lines.push(english ? "🟢 Series S" : "🟢 Series S");
    lines.push(english ? "💰 300 THB/day" : "💰 รายวัน 300 บาท");
    lines.push(english ? "🗓️ 1,500 THB/week" : "🗓️ รายสัปดาห์ 1,500 บาท");
    lines.push(english ? "🔒 Deposit 2,000 THB" : "🔒 ค่าประกัน 2,000 บาท");
    lines.push("");
    lines.push(english ? "🙏 Tell me the model and how many days, I'll quote the total." : "🙏 แจ้งรุ่นและจำนวนวันได้เลยครับ จะคำนวณยอดให้ทันที");
  } else if (token === "playstation") {
    lines.push(english ? "🎮 Which PlayStation?" : "🎮 สนใจ PS รุ่นไหนครับ?");
    lines.push("");
    lines.push("🔹 PS4");
    lines.push("🔹 PS5");
    lines.push("🔹 PS5 Pro");
    lines.push("🔹 PS Portal");
    lines.push("🔹 PS VR2");
    lines.push("");
    lines.push(english ? "🙏 Tell me the model and how many days." : "🙏 แจ้งรุ่นและจำนวนวันได้เลยครับ");
  } else if (token === "switch") {
    lines.push(english ? "🎮 Nintendo Switch 1 or Switch 2?" : "🎮 Nintendo Switch 1 หรือ Switch 2 ครับ?");
    lines.push("");
    lines.push(english ? "🙏 Tell me the model and how many days." : "🙏 แจ้งรุ่นและจำนวนวันได้เลยครับ");
  } else if (token === "quest") {
    lines.push(english ? "🥽 Meta Quest 3 or Quest 3s?" : "🥽 Meta Quest 3 หรือ Quest 3s ครับ?");
    lines.push("");
    lines.push(english ? "🙏 Tell me the model and how many days." : "🙏 แจ้งรุ่นและจำนวนวันได้เลยครับ");
  }
  return lines.filter(Boolean).join("\n");
}

function updateRecentMessages(memory, customerText, answer = "", sessionKey = "") {
  memory.lastMessages.push({ customerText, answer });
  memory.lastMessages = memory.lastMessages.slice(-4);
  if (sessionKey) {
    persistMemoryToRedis(sessionKey).catch(() => {});
  }
}

function isEnglishText(text) {
  const value = String(text || "");
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const thai = (value.match(/[\u0E00-\u0E7F]/g) || []).length;
  if (thai > 0) {
    return false;
  }
  return latin > thai && thai === 0;
}

function chooseVariant(variants) {
  return variants[Math.floor(Math.random() * variants.length)];
}

function formatMoney(amount, english = false) {
  return `${Number(amount).toLocaleString("en-US")} ${english ? "THB" : "บาท"}`;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function formatDate(date, english = false) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return english ? `${map.day}/${map.month}/${map.year}` : `${map.day}/${map.month}/${map.year}`;
}

function getBangkokDateObject() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${map.year}-${map.month}-${map.day}T00:00:00+07:00`);
}

function extractRentalDays(text) {
  const value = String(text || "").toLowerCase();
  const weekMatch = value.match(/(\d+)\s*(?:อาทิตย์|สัปดาห์|week|weeks|wk)/i);
  if (weekMatch) return Number(weekMatch[1]) * 7;
  const monthMatch = value.match(/(\d+)\s*(?:เดือน|month|months|mo)\b/i);
  if (monthMatch) return Number(monthMatch[1]) * 30;
  const patterns = [
    /(\d+)\s*วัน/i,
    /(\d+)\s*(?:day|days|d)\b/i,
    /(?:เช่า|rent)\s*(\d+)\b/i,
    /(\d+)\s*คืน/i,
    /(\d+)\s*(?:night|nights)\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return Number(match[1]);
  }

  if (/อาทิตย์|สัปดาห์|week|weekly/.test(value)) return 7;
  if (/เดือน|รายเดือน|month|monthly/.test(value)) return 30;
  return null;
}

function isMonthlyRental(text, days) {
  return /เดือน|รายเดือน|month|monthly/.test(String(text || "").toLowerCase()) || days >= 28;
}

function extractRentalMonths(text) {
  const value = String(text || "").toLowerCase();
  const match = value.match(/(\d+)\s*(?:เดือน|months|month|mo)/i);
  if (match) return Number(match[1]);
  if (/หลายเดือน|หลาย ๆ เดือน|หลายๆเดือน|multi month|long term|long-term|monthly/.test(value)) return null;
  return null;
}

function extractStartDate(text) {
  const value = String(text || "").toLowerCase();
  const today = getBangkokDateObject();

  if (/พรุ่งนี้|tomorrow/.test(value)) {
    return addDays(today, 1);
  }

  if (/วันนี้|today/.test(value)) {
    return today;
  }

  const explicit = value.match(/(?:เริ่ม|start|starting)\s*(?:วันที่)?\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/i);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]);
    let year = explicit[3] ? Number(explicit[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    return new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+07:00`);
  }

  return null;
}

function includesPriceQuestion(text, memory = {}) {
  if (includesAccountRentalQuestion(text)) return false;
  if (includesIncludedGamesQuestion(text)) return false;
  if (includesAvailabilityQuestion(text)) return false;
  // General rental questions without a specific device must not reuse remembered device.
  if (includesGeneralRentalQuestion(text) && !extractDeviceName(text)) return false;
  const value = normalizeSearchText(text);
  const hasDevice = Boolean(extractDeviceName(text) || memory.lastDevice);
  const monthly = /เดือน|รายเดือน|month|monthly/.test(value);
  const hasRentalDays = Boolean(extractRentalDays(text));
  const hasStartDate = Boolean(extractStartDate(text));
  const rentalContext = /เช่า|rent|rental|วัน|พรุ่งนี้|วันนี้|tomorrow|today|เริ่ม|start/.test(value);

  return (
    /ราคา|กี่บาท|เท่าไหร่|ค่าเช่า|เรท|สรุป|ยอด|รวม|price|how much|rate|cost|rental fee|summary|total/.test(value) ||
    (hasDevice && (/เช่า|rent|rental/.test(value) || monthly || (rentalContext && (hasRentalDays || hasStartDate))))
  );
}

function includesLongTermRentalQuestion(text) {
  const value = normalizeSearchText(text);
  return /หลายเดือน|หลาย ๆ เดือน|หลายๆเดือน|รายเดือน|เดือน|monthly|month|months|long term|long-term|multi month/.test(
    value,
  );
}

function includesPromotionQuestion(text) {
  const value = normalizeSearchText(text);
  return /โปร|โปรโมชั่น|ส่วนลด|ลดราคา|promotion|promo|discount|deal/.test(value);
}

function getBangkokHour() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value || 0);
}

function isWithinBusinessHours() {
  const hour = getBangkokHour();
  return hour >= 10 && hour < 18;
}

function includesRentNowQuestion(text) {
  const value = normalizeSearchText(text);
  return /(เช่า.{0,4}ตอนนี้|ตอนนี้.{0,4}ว่าง|เช่าเลย|เอาตอนนี้|เอาเลย|รับเครื่องตอนนี้|รับวันนี้เลย|ส่งวันนี้เลย|rent now|right now|today now|deliver today|same day|same-day|asap)/.test(
    value,
  );
}

function buildRentNowAnswer(customerText, shouldGreetToday) {
  if (!includesRentNowQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  const open = isWithinBusinessHours();
  const lines = [];
  if (shouldGreetToday) lines.push(english ? "Hello 🎮✨" : "สวัสดีครับ 🎮✨");
  if (open) {
    lines.push(english ? "✅ Yes, we can deliver today!" : "✅ ได้ครับ ส่งวันนี้ทันครับ");
    lines.push(english ? "🙏 Interested? Tell me the device and how many days." : "🙏 สนใจแจ้งรุ่นเครื่องและจำนวนวันได้เลยครับ 😊");
  } else {
    lines.push(english ? "🔒 Sorry, shop is closed for the day." : "🔒 ขออภัยครับ ร้านปิดแล้ว");
    lines.push(english ? "🚚 Next delivery available tomorrow 10:00 - 18:00." : "🚚 จัดส่งได้อีกทีพรุ่งนี้ ตั้งแต่ 10:00 - 18:00 เป็นต้นไปครับ");
    lines.push(english ? "🙏 Interested in booking for tomorrow? Just tell me 😊" : "🙏 สนใจจองเป็นพรุ่งนี้ แจ้งได้เลยครับ 😊");
  }
  return lines.filter(Boolean).join("\n");
}

function includesBookingIntent(text) {
  const value = normalizeSearchText(text);
  return /\bจอง\b|จองครับ|จองค่ะ|จองเลย|จองวันที่|จองวัน|ก็จอง|จองด้วย|^book\b|book it|i want to book|please book/.test(value);
}

function parseExplicitDate(text, fallbackYear) {
  const m = String(text || "").match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : fallbackYear;
  if (year < 100) year += 2000;
  return new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+07:00`);
}

async function buildPendingNextDateAnswer(customerText, memory, shouldGreetToday) {
  if (!memory.pendingNextDate) return "";
  const english = isEnglishText(customerText);
  const value = normalizeSearchText(customerText);

  const explicitDate = parseExplicitDate(customerText, new Date().getFullYear());
  const dateOnlyNumberMatch = value.match(/\b(?:วันที่|day|date)\s*(\d{1,2})\b/);
  const affirm = isAffirmative(customerText) || includesBookingIntent(customerText);
  if (!affirm && !explicitDate && !dateOnlyNumberMatch) return "";

  let chosenDate = null;
  if (explicitDate) chosenDate = explicitDate;
  else if (dateOnlyNumberMatch) {
    const pendingDate = new Date(memory.pendingNextDate.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, "$3-$2-$1") + "T00:00:00+07:00");
    if (!isNaN(pendingDate.getTime())) {
      pendingDate.setDate(Number(dateOnlyNumberMatch[1]));
      chosenDate = pendingDate;
    }
  } else {
    const pendingDate = new Date(memory.pendingNextDate.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, "$3-$2-$1") + "T00:00:00+07:00");
    if (!isNaN(pendingDate.getTime())) chosenDate = pendingDate;
  }

  if (!chosenDate) return "";

  memory.lastStartDate = chosenDate.toISOString();
  memory.pendingNextDate = "";
  const device = memory.pendingDevice || memory.lastDevice;
  memory.pendingDevice = "";
  if (device) memory.lastDevice = device;

  const days = extractRentalDays(customerText) || memory.lastRentalDays;
  if (days) memory.lastRentalDays = days;

  if (english) {
    const lines = [];
    if (shouldGreetToday) lines.push("Hello 🎮✨");
    lines.push(`✅ Got it! Booking ${device || "the device"} for ${formatDate(chosenDate, true)}`);
    if (!days) lines.push("📅 How many days would you like to rent?");
    lines.push("📍 Please share Google Maps link so admin can confirm delivery fee.");
    if (days) lines.push("🙏 I'll prepare the full summary once I have the location.");
    return lines.filter(Boolean).join("\n");
  }
  const lines = [];
  if (shouldGreetToday) lines.push("สวัสดีครับ 🎮✨");
  lines.push(`✅ รับเรื่องครับ จอง ${device || "เครื่อง"} วันที่ ${formatDate(chosenDate)}`);
  if (!days) lines.push("📅 เช่าจำนวนกี่วันครับ?");
  lines.push("📍 รบกวนส่งลิ้งค์ Google Maps จุดจัดส่ง เพื่อให้แอดมินเช็คค่าส่งด้วยครับ");
  if (days) lines.push("🙏 ได้ลิ้งค์แล้ว เดี๋ยวสรุปรายละเอียดให้อีกครั้งครับ");
  return lines.filter(Boolean).join("\n");
}

function includesNoContractIntent(text) {
  const value = normalizeSearchText(text);
  return /ไม่[ก-๙ ]{0,14}สัญญา|ไม่แนบบัตร|ไม่ส่งบัตร|no contract|without contract|skip contract|no id|without id/.test(
    value,
  );
}

function isAffirmative(text) {
  const value = normalizeSearchText(text);
  return /^(โอเค|โอเก|โอเค ?(ไม่ทำ)?สัญญา|ok|okay|k|kk|ใช่|ใช่ครับ|ใช่ค่ะ|ตกลง|เอา|เอาครับ|เอาค่ะ|เอาเลย|รับทราบ|จัดเลย|ได้|ได้ครับ|ได้ค่ะ|yes|y|yep|yup|sure|confirm|confirmed|ตามนั้น|go ahead|proceed)\b/.test(value);
}

async function buildNoContractConfirmAnswer(customerText, memory, shouldGreetToday) {
  if (!includesNoContractIntent(customerText)) return "";
  const english = isEnglishText(customerText);
  const deviceName = memory.lastDevice;
  if (!deviceName || !deviceRates.has(deviceName)) return "";
  const rate = deviceRates.get(deviceName);
  const newDeposit = rate.deposit === 4000 ? 8000 : 5000;
  memory.noContractPending = true;
  if (english) {
    return [
      shouldGreetToday ? "Hello 🎮✨" : "",
      `📝 Rent ${deviceName} without a rental agreement?`,
      `🔒 Deposit will be adjusted to ${formatMoney(newDeposit, true)} (instead of ${formatMoney(rate.deposit, true)})`,
      "🙏 Reply OK or Yes to confirm, I'll re-quote the total.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
    `📝 ยืนยันเช่า ${deviceName} แบบไม่ทำสัญญาการเช่าใช่ไหมครับ?`,
    `🔒 ค่าประกันจะปรับเป็น ${formatMoney(newDeposit)} (จากเดิม ${formatMoney(rate.deposit)})`,
    "🙏 ตอบ โอเค หรือ ใช่ เพื่อยืนยัน เดี๋ยวสรุปยอดใหม่ให้ครับ",
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildNoContractReissueAnswer(customerText, memory, shouldGreetToday) {
  if (!memory.noContractPending) return "";
  if (!isAffirmative(customerText)) return "";
  const deviceName = memory.lastDevice;
  const days = memory.lastRentalDays;
  if (!deviceName || !deviceRates.has(deviceName) || !days) return "";
  const english = isEnglishText(customerText);
  const calc = calculateRental(deviceName, days, true, false);
  if (!calc || calc.rentalFee == null) return "";
  const startDate = memory.lastStartDate ? new Date(memory.lastStartDate) : null;
  const returnDate = startDate ? addDays(startDate, days) : null;
  memory.noContractPending = false;

  const GAMES_LINK = "https://ajgamerental2021.github.io/ajconsole/game_index.html";
  const gamesLines = english
    ? ["✨ You can pick up to 10 games per rental", "📚 Browse all games:", `👉 ${GAMES_LINK}`]
    : ["✨ ลูกค้าเลือกได้สูงสุด 10 เกม ต่อการเช่า 1 ครั้ง", "📚 ดูรายการเกมทั้งหมดและเลือกเกมได้ที่:", `👉 ${GAMES_LINK}`];
  const warningLines = english
    ? ["⚠️ Please send Google Maps location for admin to confirm delivery fee", "⚠️ Please read all rental terms carefully before transferring"]
    : ["⚠️ แจ้งโลเคชั่นจัดส่งเป็นลิ้งค์ Google Maps เพื่อให้แอดมินเช็คค่าส่งด้วยนะครับ", "⚠️ รบกวนอ่านรายละเอียดการเช่าอย่างละเอียดก่อนโอนจอง"];

  if (english) {
    const groups = [];
    if (shouldGreetToday) groups.push("Hello 🎮✨");
    groups.push([
      `📌 ${deviceName} for ${days} days (No contract)`,
      `💰 Rental fee: ${formatMoney(calc.rentalFee, true)}`,
      `🔒 Deposit: ${formatMoney(calc.deposit, true)} (refundable on return day)`,
      `✅ Total: ${formatMoney(calc.total, true)}`,
    ].join("\n"));
    groups.push(["📝 Booking payment: 200 THB", `🚚 Pay on delivery: ${formatMoney(calc.payOnDelivery, true)}`].join("\n"));
    if (returnDate) groups.push(`📅 Rental period: ${formatDate(startDate, true)} - ${formatDate(returnDate, true)}`);
    if (returnDate) groups.push(gamesLines.join("\n"));
    groups.push(buildEnglishPaymentLines(calc, true));
    groups.push(warningLines.join("\n"));
    return groups.join("\n\n");
  }

  const groups = [];
  if (shouldGreetToday) groups.push("สวัสดีครับ 🎮✨");
  groups.push([
    `📌 ${deviceName} เช่า ${days} วัน (ไม่ทำสัญญา)`,
    `💰 ค่าเช่า: ${formatMoney(calc.rentalFee)}`,
    `🔒 ค่าประกัน: ${formatMoney(calc.deposit)} ได้คืนวันคืนเครื่อง`,
    `✅ รวมสุทธิ: ${formatMoney(calc.total)}`,
  ].join("\n"));
  groups.push(["📝 โอนจองคิว: 200 บาท", `🚚 จ่ายตอนรับเครื่อง: ${formatMoney(calc.payOnDelivery)}`].join("\n"));
  if (returnDate) groups.push(`📅 รอบเช่า: ${formatDate(startDate)} - ${formatDate(returnDate)}`);
  if (returnDate) groups.push(gamesLines.join("\n"));
  groups.push(buildThaiPaymentLines(calc, true));
  groups.push(warningLines.join("\n"));
  return groups.join("\n\n");
}

function includesAvailabilityQuestion(text) {
  const value = normalizeSearchText(text);
  if (includesGeneralRentalQuestion(text)) return false;
  if (/เครื่องว่าง|มีเครื่องว่าง|เครื่องพร้อม|ของว่าง|เครื่องเหลือ|in stock|available now|free now|do you have (a |the )?(ps|xbox|switch|quest|console|rog|legion|steam|meta|portal)/.test(value)) {
    return true;
  }
  if (/ว่าง(ไหม|มั้ย|มัย|มะ)\b/.test(value)) return true;
  if (/^ว่างไหม$|^ว่างมั้ย$|^ว่างหรอ$|^ว่างป่ะ$/.test(value)) return true;
  if (/\b(available|free|vacant)\??$/.test(value)) return true;
  if (/is\s+(ps|xbox|switch|quest|meta|rog|legion|steam|portal).*\b(available|free|in\s*stock)/.test(value)) return true;
  return false;
}

async function buildAvailabilityAnswer(customerText, memory, shouldGreetToday) {
  if (!includesAvailabilityQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  const deviceName = extractDeviceName(customerText) || memory.lastDevice;
  let summary = "";
  try {
    summary = await loadInventorySummary();
  } catch (error) {
    console.error("Availability inventory load failed:", error);
  }
  const lines = [];
  if (shouldGreetToday) lines.push(english ? "Hello 🎮✨" : "สวัสดีครับ 🎮✨");
  if (!deviceName) {
    lines.push(english ? "📦 Which model do you want to check?" : "📦 อยากเช็คเครื่องรุ่นไหนครับ?");
    lines.push(english ? "Tell me the model, e.g. PS5, PS5 Pro, Switch 2." : "แจ้งชื่อเครื่อง เช่น PS5, PS5 Pro, Switch 2 ได้เลยครับ");
    return lines.filter(Boolean).join("\n");
  }
  const lineForDevice = summary.split("\n").find((l) => l.toLowerCase().includes(deviceName.toLowerCase()));
  if (!lineForDevice) {
    lines.push(english ? `📦 Let me check ${deviceName} queue for you.` : `📦 เดี๋ยวเช็คคิว ${deviceName} ให้ครับ`);
    lines.push(english ? "🙏 Admin will confirm shortly." : "🙏 สักครู่แอดมินยืนยันให้นะครับ");
    return lines.filter(Boolean).join("\n");
  }
  const isAvailable = /available/i.test(lineForDevice) && !/not available/i.test(lineForDevice);
  if (isAvailable) {
    lines.push(english ? `✅ ${deviceName} is available right now 🎮` : `✅ ${deviceName} ว่างอยู่ครับ พร้อมส่ง 🎮`);
    lines.push(english ? "📅 Tell me start date and how many days, I'll quote total." : "📅 แจ้งวันเริ่มเช่าและจำนวนวันได้เลยครับ จะคำนวณยอดให้ทันที");
  } else {
    const dateMatch = lineForDevice.match(/วันที่คาดว่าจะว่าง:\s*([^)]+)/);
    const nextDate = dateMatch ? dateMatch[1].trim() : "";
    lines.push(english ? `⚠️ ${deviceName} is fully booked right now` : `⚠️ ${deviceName} คิวเต็มอยู่ครับ`);
    if (nextDate) lines.push(english ? `📅 Next available: ${nextDate}` : `📅 คาดว่าว่างวันที่: ${nextDate}`);
    lines.push(english ? "🙏 Admin will confirm exact queue, please wait a moment." : "🙏 เดี๋ยวแอดมินยืนยันคิวอีกครั้งครับ");
  }
  return lines.filter(Boolean).join("\n");
}

function includesOutOfAreaQuestion(text) {
  const value = normalizeSearchText(text);
  const provinces = /เชียงใหม่|เชียงราย|ภูเก็ต|กระบี่|พัทยา|ชลบุรี|ระยอง|โคราช|นครราชสีมา|ขอนแก่น|อุดรธานี|หาดใหญ่|สงขลา|สุราษ|พิษณุโลก|นครสวรรค์|ลำปาง|เลย|ตรัง|ยะลา|ปัตตานี|นราธิวาส|อุบล|สกล|มหาสารคาม|ร้อยเอ็ด|กาฬสินธุ์|มุกดาหาร|หนองคาย|บุรีรัมย์|สุรินทร์|ศรีสะเกษ|เพชรบุรี|ประจวบ|ชุมพร|ระนอง|พังงา|เลย|น่าน|แพร่|พะเยา|แม่ฮ่องสอน|ตาก|กำแพงเพชร|สุโขทัย|อุตรดิตถ์/;
  return /ส่งต่างจังหวัด|ต่างจังหวัด|ส่งจังหวัด/.test(value) || provinces.test(value);
}

function buildOutOfAreaAnswer(customerText, shouldGreetToday) {
  if (!includesOutOfAreaQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "🙏 Sorry, we only deliver in Bangkok & metro area (BMR)",
        "📍 If you're in BMR, please share a Google Maps link to confirm delivery fee.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "🙏 ขออภัยครับ ทางร้านส่งเฉพาะ กรุงเทพ-ปริมณฑล",
        "📍 ถ้าอยู่ในเขตปริมณฑล แจ้งพิกัด Google Maps มาเช็คค่าส่งได้ครับ",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesPaymentSlipQuestion(text) {
  const value = normalizeSearchText(text);
  return /โอนแล้ว|โอนเงินแล้ว|ส่งสลิป|สลิปโอน|ชำระแล้ว|จ่ายแล้ว|payment sent|paid already|sent slip|transferred/.test(
    value,
  );
}

function buildPaymentSlipAnswer(customerText, shouldGreetToday) {
  if (!includesPaymentSlipQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 🙏" : "",
        "✅ Got it! Thank you for the payment 🙏",
        "👨‍💼 Admin will verify the slip and confirm the booking shortly.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🙏" : "",
        "✅ รับเรื่องครับ ขอบคุณที่โอนนะครับ 🙏",
        "👨‍💼 เดี๋ยวแอดมินช่วยเช็คสลิปและยืนยันคิวให้ครับ",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesIncludedGamesQuestion(text) {
  const value = normalizeSearchText(text);
  if (/ไอดี|account|psn/.test(value)) return false;
  const tightPatterns = [
    /รวมเกม/,
    /แถมเกม/,
    /พร้อมเกม/,
    /เกมในเครื่อง/,
    /เกมมาด้วย/,
    /เกมมาให้/,
    /มีเกมมา(ให้|ด้วย|พร้อม)/,
    /มีเกมใน(เครื่อง|นี้)/,
    /เครื่องนี้มีเกม/,
    /^มีเกมไหม$/,
    /^มีเกมมั้ย$/,
    /games\s*included/,
    /with\s*games?\b/,
    /come\s*with\s*games?/,
    /bundled\s*games?/,
  ];
  return tightPatterns.some((re) => re.test(value));
}

function buildIncludedGamesAnswer(customerText, memory, shouldGreetToday) {
  if (!includesIncludedGamesQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  const device = memory.lastDevice || (english ? "the console" : "เครื่อง");
  const isPS5Family = /PS5|PS4|PS Portal|PS VR2/i.test(memory.lastDevice || "");
  const gameLink = isPS5Family
    ? "https://ajgamerental2021.github.io/ajconsole/game_index.html"
    : "https://ajgamerental2021.github.io/ajconsole/game_index.html";
  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        `🎮 Yes! ${device} rental comes with games included`,
        "",
        "✨ Pick up to 10 games per rental",
        "📚 Browse all games:",
        `👉 ${gameLink}`,
        "",
        "🙏 Just send me the game names you want, I'll prepare them.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        `🎮 ใช่ครับ! เช่า${device} รวมเกมให้ด้วย`,
        "",
        "✨ เลือกได้สูงสุด 10 เกม ต่อการเช่า 1 ครั้ง",
        "📚 ดูรายการเกมทั้งหมด:",
        `👉 ${gameLink}`,
        "",
        "🙏 แจ้งชื่อเกมที่อยากได้มาเลย เดี๋ยวจัดเตรียมให้ครับ",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesAccountRentalQuestion(text) {
  const value = normalizeSearchText(text);
  return /ไอดี|ไอดีเกม|game id|account|psn|รหัสเกม/.test(value);
}

function buildAccountRentalAnswer(customerText, shouldGreetToday) {
  if (!includesAccountRentalQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "🆔 PS5 game account rental is available!",
        "",
        "📚 Browse the full list, prices, and terms here:",
        "👉 https://ajgamerental2021.github.io/ajgameid/",
        "",
        "🙏 Need admin to double-check? Just let me know.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "🆔 มีบริการเช่าไอดีเกม PS5 ครับ!",
        "",
        "📚 ดูรายการ ราคา และเงื่อนไขทั้งหมดได้ที่ลิงก์นี้เลย:",
        "👉 https://ajgamerental2021.github.io/ajgameid/",
        "",
        "🙏 ถ้าต้องการให้แอดมินช่วยเช็คเพิ่ม แจ้งได้เลยครับ",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesTermsQuestion(text) {
  const value = normalizeSearchText(text);
  if (/ไม่[ก-๙ ]{0,14}สัญญา|ไม่แนบบัตร|ไม่ส่งบัตร|no contract|without contract|no id|without id|skip contract/.test(value)) {
    return false;
  }
  return /ข้อกำหนด|เงื่อนไข|กติกา|รายละเอียด|ต้องใช้อะไร|ใช้เอกสาร|มัดจำ|ประกัน|สัญญา|terms|condition|requirement|deposit|agreement/.test(
    value,
  );
}

function includesDepositRefundQuestion(text) {
  const value = normalizeSearchText(text);
  return /ค่าประกัน[ก-๙ ]{0,6}(คืน|ได้คืน|คืนเมื่อไหร่|คืนตอนไหน|คืนยังไง)|คืนค่าประกัน|ได้ค่าประกันคืน|ประกันคืนเมื่อไหร่|ประกันได้คืน|deposit[ a-z]{0,10}(refund|back|return)|when.{0,12}deposit/.test(
    value,
  );
}

function buildDepositRefundAnswer(customerText, shouldGreetToday) {
  if (!includesDepositRefundQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  if (english) {
    return [
      shouldGreetToday ? "Hello 🎮✨" : "",
      "🔒 Deposit refund",
      "✅ The deposit is refunded on the return day",
      "✅ Once we receive the device and finish checking it, we transfer the deposit back",
      "✅ Refunded to the bank account on the rental agreement (or the one you provide)",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
    "🔒 การคืนค่าประกัน",
    "✅ ค่าประกันได้คืนในวันที่คืนเครื่อง",
    "✅ เมื่อทางร้านได้รับเครื่องและเช็คเครื่องเรียบร้อย จะโอนคืนค่าประกันให้",
    "✅ โอนคืนเข้าบัญชีที่ทำสัญญาการเช่าไว้ หรือบัญชีที่ลูกค้าแจ้งมา",
  ]
    .filter(Boolean)
    .join("\n");
}

function includesGameSelectionMessage(text) {
  const value = normalizeSearchText(text);
  return /รายการเกมที่ต้องการ|เกมที่ต้องการ|เกมที่อยากได้|อยากได้เกม|เอาเกมพวกนี้|เลือกเกมพวกนี้|เกมที่เลือก|games i want|i want these games|these are the games/.test(
    value,
  );
}

function buildGameSelectionAnswer(customerText, memory, shouldGreetToday) {
  if (!includesGameSelectionMessage(customerText)) return "";
  const english = isEnglishText(customerText);
  if (memory.summarySent) {
    return english
      ? [shouldGreetToday ? "Hello 🎮✨" : "", "✅ Noted! We'll prepare the games you selected before delivery 🎮"]
          .filter(Boolean)
          .join("\n")
      : [shouldGreetToday ? "สวัสดีครับ 🎮✨" : "", "✅ รับทราบครับ ทางร้านจะเตรียมเกมที่เลือกไว้ให้ก่อนจัดส่งเครื่องครับผม 🎮"]
          .filter(Boolean)
          .join("\n");
  }
  const missing = [];
  if (!memory.lastDevice) missing.push(english ? "device" : "เครื่อง");
  if (!memory.lastStartDate) missing.push(english ? "start date" : "วันเริ่ม");
  if (!memory.lastRentalDays) missing.push(english ? "days" : "จำนวนวัน");
  missing.push(english ? "delivery location" : "สถานที่จัดส่ง");
  if (english) {
    return [
      shouldGreetToday ? "Hello 🎮✨" : "",
      "✅ Noted on the games you want!",
      "",
      "🙏 To prepare your rental, could you tell me:",
      ["📋 Which device", "📅 Start date", "🗓️ Number of days", "📍 Delivery location (Google Maps link)"].join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
    "✅ รับทราบเกมที่ต้องการแล้วครับ!",
    "",
    "🙏 ขอทราบรายละเอียดการเช่าเพิ่มครับ:",
    ["📋 เครื่องที่ต้องการเช่า", "📅 วันที่เริ่มเช่า", "🗓️ จำนวนวัน", "📍 สถานที่จัดส่ง (ลิ้งค์ Google Maps)"].join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function includesGeneralRentalQuestion(text) {
  const value = normalizeSearchText(text);
  return /เช่ายังไง|เช่าไง|เช่าอย่างไร|เช่าทำยังไง|วิธี[ก-๙ ]{0,6}(เช่า|จอง)|ขั้นตอน[ก-๙ ]{0,6}(เช่า|จอง)|how to rent|how do i rent|how does (the )?rental work|มีเครื่องอะไร|เครื่องอะไรบ้าง|มีอะไรให้เช่า|มีรุ่นอะไร|มีเครื่องไหนบ้าง|มีเครื่องอะไรให้เช่า|เครื่องอะไรให้เช่า|what (consoles?|devices?) (do you have|are available)|เช่าแล้วได้อะไร|ได้อะไรบ้าง|what do i get|รายละเอียดการเช่า|อยากเช่าเครื่องเกม|อยากเช่าเครื่อง|สนใจเช่าเครื่อง|อยากได้เครื่องเกม|เช่าเครื่องเกม|want to rent (a |an )?(game|console)|looking to rent/.test(
    value,
  );
}

const deviceCategories = [
  { th: "🎮 Console", en: "🎮 Console", devices: ["PS4", "PS5", "PS5 Pro", "PS Portal", "Xbox Series S", "Xbox Series X", "Nintendo Switch 1", "Nintendo Switch 2"] },
  { th: "🥽 VR & AR", en: "🥽 VR & AR", devices: ["PS VR2", "Meta Quest 3", "Meta Quest 3s", "Viture Beast"] },
  { th: "💻 PC Handheld", en: "💻 PC Handheld", devices: ["ROG XBOX Ally X", "Steam Deck OLED", "Lenovo Legion GO2"] },
  { th: "🕹️ อื่นๆ", en: "🕹️ Others", devices: ["Logitech G29"] },
];

function buildDeviceCategoryList(english = false) {
  return deviceCategories
    .map((cat) => {
      const available = cat.devices.filter((d) => deviceRates.has(d));
      if (!available.length) return "";
      const header = english ? cat.en : cat.th;
      return [header, ...available.map((d) => `🔹 ${d}`)].join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildGeneralRentalInfoAnswer(customerText, memory, shouldGreetToday) {
  if (!includesGeneralRentalQuestion(customerText)) return "";
  if (extractDeviceName(customerText)) return "";
  const english = isEnglishText(customerText);
  if (english) {
    return [
      shouldGreetToday ? "Hello 🎮✨" : false,
      "🎮 We have these devices available for rent:",
      buildDeviceCategoryList(true),
      ["📋 To quote your rental, please tell me:", "1️⃣ Which device you want", "2️⃣ Start date", "3️⃣ Number of days", "4️⃣ Delivery location (Google Maps link)"].join("\n"),
      ["📝 A rental agreement is required (or extra deposit if skipped).", "🙏 Send the details and I'll calculate the total right away!"].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    shouldGreetToday ? "สวัสดีครับ 🎮✨" : false,
    "🎮 ทางร้านมีเครื่องให้เช่าตามนี้ครับ:",
    buildDeviceCategoryList(false),
    ["📋 ขอข้อมูลเพื่อคำนวณค่าเช่าครับ:", "1️⃣ เครื่องที่ต้องการเช่า", "2️⃣ วันที่เริ่มเช่า", "3️⃣ จำนวนวัน", "4️⃣ สถานที่จัดส่ง (ลิ้งค์ Google Maps)"].join("\n"),
    ["📝 การเช่ามีทำสัญญาการเช่าด้วยครับ (หรือเพิ่มค่าประกันถ้าไม่ทำสัญญา)", "🙏 แจ้งรายละเอียดมาได้เลย เดี๋ยวคำนวณยอดให้ทันทีครับ"].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function includesContractDocQuestion(text) {
  const value = normalizeSearchText(text);
  if (/ไม่[ก-๙ ]{0,14}สัญญา/.test(value)) return false;
  const patterns = [
    /ทำสัญญา[ก-๙ ]{0,12}(ยังไง|อย่างไร|ไง|ขั้นตอน)/,
    /สัญญา[ก-๙ ]{0,12}(ทำยังไง|ทำอย่างไร|ยังไง)/,
    /เซ็นสัญญา[ก-๙ ]{0,12}(ยังไง|อย่างไร)/,
    /(ใช้|ต้องใช้|แนบ)[ก-๙ ]{0,8}เอกสาร/,
    /เอกสาร[ก-๙ ]{0,8}(อะไร|ที่ใช้|ที่ต้อง)/,
    /ใช้อะไรบ้าง/,
    /ต้องเตรียมอะไร/,
    /how.{0,20}(do i|to).{0,12}contract/,
    /what.{0,12}document/,
    /documents?.{0,12}(need|require)/,
    /what.{0,12}(do i need|to prepare)/,
    /rental agreement.{0,12}(how|process|step)/,
  ];
  return patterns.some((re) => re.test(value));
}

function buildContractDocAnswer(customerText, memory, shouldGreetToday) {
  if (!includesContractDocQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  const deviceName = extractDeviceName(customerText) || memory.lastDevice;
  const rate = deviceName ? deviceRates.get(deviceName) : null;
  const noContractDeposit = rate ? (rate.deposit === 4000 ? 8000 : 5000) : null;
  const depositLineTh = rate
    ? `🔒 ${deviceName} ไม่ทำสัญญา ค่าประกันปรับเป็น ${formatMoney(noContractDeposit)} (จากเดิม ${formatMoney(rate.deposit)})`
    : "🔒 ถ้าไม่ทำสัญญา ค่าประกันปรับเป็น 5,000 / 8,000 บาท แล้วแต่รุ่นเครื่อง";
  const depositLineEn = rate
    ? `🔒 Without agreement, ${deviceName} deposit becomes ${formatMoney(noContractDeposit, true)} (from ${formatMoney(rate.deposit, true)})`
    : "🔒 Without agreement, deposit becomes 5,000 / 8,000 THB depending on device";

  if (english) {
    return [
      shouldGreetToday ? "Hello 🎮✨" : "",
      "📝 Rental agreement process",
      "1️⃣ Fill in the Google Form",
      "2️⃣ Upload a photo of your Passport",
      "3️⃣ Upload a selfie holding your Passport",
      "",
      "🔗 Rental agreement form:",
      "https://forms.gle/92PBGXEHMQhtPov48",
      "",
      "📌 Prefer not to do the agreement?",
      depositLineEn,
      "",
      "🙏 Any questions, just let me know.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
    "📝 ขั้นตอนทำสัญญาการเช่า",
    "1️⃣ กรอกข้อมูลในลิ้งค์ Google Form",
    "2️⃣ อัพโหลดรูปสำเนาบัตรประชาชน",
    "3️⃣ อัพโหลดรูปเซลฟี่คู่กับบัตรประชาชน",
    "",
    "🔗 ลิ้งค์ทำสัญญาการเช่า:",
    "https://forms.gle/Y6xfFaMyuJ9REhtz9",
    "",
    "📌 ถ้าไม่สะดวกหรือไม่ต้องการทำสัญญา",
    depositLineTh,
    "",
    "🙏 มีข้อสงสัยเพิ่มเติม แจ้งได้เลยครับ",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildTermsAnswer(customerText, shouldGreetToday) {
  if (!includesTermsQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "Rental conditions 📝",
        "✅ Minimum 3 days",
        "✅ Deposit refunded on return day",
        "✅ Rental agreement + ID card copy required",
        "✅ Delivery to Bangkok & metropolitan area only",
        "❌ No separate accessory rental",
        "🚫 Customer cancellation → 200 THB booking fee non-refundable",
        "🚫 Early return → unused rental difference non-refundable",
        "",
        "If you skip the rental agreement, deposit increases (5,000 / 8,000 THB depending on device).",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "เงื่อนไขการเช่า 📝",
        "✅ เช่าขั้นต่ำ 3 วัน",
        "✅ ค่าประกันคืนเต็มจำนวนวันคืนเครื่อง",
        "✅ ต้องทำสัญญาเช่า + แนบสำเนาบัตรประชาชน",
        "✅ ส่งเฉพาะกรุงเทพ-ปริมณฑล",
        "❌ ไม่มีเช่าอุปกรณ์แยก",
        "🚫 ยกเลิกโดยลูกค้า → ไม่คืนเงินจอง 200 บาท",
        "🚫 คืนก่อนกำหนด → ไม่คืนเงินส่วนต่าง",
        "",
        "ถ้าไม่ทำสัญญา ค่าประกันปรับเป็น 5,000 / 8,000 บาท แล้วแต่รุ่นเครื่องครับ",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesPurchaseQuestion(text) {
  const value = normalizeSearchText(text);
  return /ซื้อ|ขาย|รับซื้อ|มีขาย|จำหน่าย|สั่งซื้อ|purchase|buy|sell|sale|for sale/.test(value);
}

function buildPromotionAnswer(customerText, shouldGreetToday) {
  if (!includesPromotionQuestion(customerText)) return "";

  const english = isEnglishText(customerText);

  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "Current promotions 🔥🎁",
        "",
        "🚚 Delivery promotion",
        "Rent 3-6 days: return delivery subsidy up to 100 THB",
        "Rent 7+ days: outbound and return delivery subsidy up to 100 THB each way",
        "",
        "⭐ Returning customer discount",
        "Returning customers get 10% off the rental fee for the next rental",
        "",
        "Deposit and delivery fee differences are not discounted.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "ตอนนี้มีโปรโมชั่นตามนี้ครับ 🔥🎁",
        "",
        "🚚 โปรค่าจัดส่ง",
        "เช่า 3-6 วัน: ร้านช่วยค่าส่งขากลับสูงสุด 100 บาท",
        "เช่า 7 วันขึ้นไป: ร้านช่วยค่าส่งขาไปและขากลับ สูงสุดเที่ยวละ 100 บาท",
        "",
        "⭐ ส่วนลดลูกค้าเก่า",
        "ลูกค้าเก่าที่เคยเช่าแล้ว มีส่วนลดค่าเช่า 10% ในครั้งถัดไปครับ",
        "",
        "หมายเหตุ: ส่วนลดคิดจากค่าเช่า ไม่รวมค่าประกันและส่วนต่างค่าส่งครับ ✅",
      ]
        .filter(Boolean)
        .join("\n");
}

function buildPurchasePauseReply(customerText, shouldGreetToday) {
  const english = isEnglishText(customerText);

  return english
    ? [
        shouldGreetToday ? "Hello 👋" : "",
        "🛒 For purchase/sales inquiries, admin will take care of you shortly.",
        "",
        "I’ll pause the automated reply now so our team can continue directly. ✅",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 👋" : "",
        "🛒 เรื่องซื้อ/ขายสินค้า แอดมินจะเข้ามาดูแลให้นะครับ",
        "",
        "ระบบจะพักการตอบอัตโนมัติไว้ก่อน เพื่อให้แอดมินคุยต่อโดยตรงครับ ✅",
      ]
        .filter(Boolean)
        .join("\n");
}

function calculateRental(deviceName, days, noContract = false, returningCustomer = false) {
  const rate = deviceRates.get(deviceName);
  if (!rate) return null;

  const rentalFee =
    days >= 28 ? rate.monthly : days === 7 ? rate.weekly : days >= 3 && days <= 6 ? rate.daily * days : null;
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

function includesSummaryRequest(text) {
  const value = normalizeSearchText(text);
  return /สรุป|ยอด|รวม|จอง|โอน|บัญชี|เลขบัญชี|ชำระ|payment|pay|summary|total|bank|transfer|book|booking/.test(
    value,
  ) || /summarize|summarise/.test(value);
}

function includesNoContractRequest(text) {
  return /ไม่ทำสัญญา|ไม่แนบบัตร|ไม่สะดวกทำสัญญา|ไม่ส่งบัตร|no contract|without contract|no id|without id/i.test(
    String(text || ""),
  );
}

function buildThaiPaymentLines(calc, noContract) {
  if (noContract) {
    return [
      ["🏦 ข้อมูลโอนจอง", "✅ เลขบัญชี: 8690576029", "✅ ธนาคาร: กรุงไทย", "✅ ชื่อบัญชี: สมชาย เหมศิริ"].join("\n"),
      [
        "❌ ลูกค้าไม่ทำสัญญาการเช่า",
        "🚫 ยกเลิกโดยลูกค้า → ไม่คืนเงินจอง 200 บาท",
        "🚫 คืนก่อนกำหนด → ไม่คืนเงินส่วนต่าง",
      ].join("\n"),
    ].join("\n\n");
  }

  return [
    ["🏦 ข้อมูลโอนจอง", "✅ เลขบัญชี: 8690576029", "✅ ธนาคาร: กรุงไทย", "✅ ชื่อบัญชี: สมชาย เหมศิริ"].join("\n"),
    ["📝 ลิงก์ทำสัญญาการเช่า", "https://forms.gle/Y6xfFaMyuJ9REhtz9"].join("\n"),
    [
      `❌ ไม่ทำสัญญา → ค่าประกัน ${formatMoney(calc.rate.deposit === 4000 ? 8000 : 5000)}`,
      "🚫 ยกเลิกโดยลูกค้า → ไม่คืนเงินจอง 200 บาท",
      "🚫 คืนก่อนกำหนด → ไม่คืนเงินส่วนต่าง",
    ].join("\n"),
  ].join("\n\n");
}

function buildEnglishPaymentLines(calc, noContract) {
  if (noContract) {
    return [
      ["🏦 Bank details", "✅ Bank Acc No.: 8690576029", "✅ Bank Name: Krung Thai", "✅ Bank Acc Name: Somchai Hemsiri"].join("\n"),
      [
        "❌ Customer chose no rental agreement",
        "🚫 Customer cancellation → 200 THB booking payment is non-refundable",
        "🚫 Early return → unused rental difference is non-refundable",
      ].join("\n"),
    ].join("\n\n");
  }

  return [
    "💳 Payment options for foreign customers",
    ["1️⃣ Cash (THB)", `Pay full on delivery: ${formatMoney(calc.total, true)}`].join("\n"),
    ["2️⃣ Wise", `Pay full before delivery: ${formatMoney(calc.total, true)}`].join("\n"),
    ["3️⃣ Thai Bank Transfer", "Booking: 200 THB", `On delivery: ${formatMoney(calc.payOnDelivery, true)}`].join("\n"),
    ["🏦 Bank details", "✅ Bank Acc No.: 8690576029", "✅ Bank Name: Krung Thai", "✅ Bank Acc Name: Somchai Hemsiri"].join("\n"),
    ["📝 Rental agreement link", "https://forms.gle/92PBGXEHMQhtPov48"].join("\n"),
    [
      `❌ No rental agreement → deposit ${formatMoney(calc.rate.deposit === 4000 ? 8000 : 5000, true)}`,
      "🚫 Customer cancellation → 200 THB booking payment is non-refundable",
      "🚫 Early return → unused rental difference is non-refundable",
    ].join("\n"),
  ].join("\n\n");
}

async function buildPriceAnswer(customerText, memory, shouldGreetToday) {
  if (!includesPriceQuestion(customerText, memory)) return "";

  const english = isEnglishText(customerText);
  const deviceName = extractDeviceName(customerText) || memory.lastDevice;

  if (!deviceName || !deviceRates.has(deviceName)) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : false,
          "🎮 We have these devices available for rent:",
          buildDeviceCategoryList(true),
          ["📋 Please tell me: device, start date, number of days, delivery location.", "📝 A rental agreement is required (or extra deposit if skipped)."].join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : false,
          "🎮 ทางร้านมีเครื่องให้เช่าตามนี้ครับ:",
          buildDeviceCategoryList(false),
          ["📋 รบกวนแจ้ง: เครื่องที่ต้องการ, วันที่เริ่มเช่า, จำนวนวัน, สถานที่จัดส่งครับ", "📝 การเช่ามีทำสัญญาการเช่าด้วย (หรือเพิ่มค่าประกันถ้าไม่ทำสัญญา)"].join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n");
  }

  memory.lastDevice = deviceName;

  const explicitDays = extractRentalDays(customerText);
  const explicitStart = extractStartDate(customerText);
  // Only reuse remembered days when this message continues a booking (has a start date).
  // A bare price ask ("เช่า PS5 เท่าไหร่", "รายวันเท่าไหร่") must show the rate table.
  const days = explicitDays || (explicitStart ? memory.lastRentalDays : null) || null;
  const noContract = includesNoContractRequest(customerText);
  const returningCustomer = /ลูกค้าเก่า|เคยเช่า|returning|old customer/i.test(customerText);
  const calc = days ? calculateRental(deviceName, days, noContract, returningCustomer) : null;
  const rate = deviceRates.get(deviceName);
  const summaryRequest = includesSummaryRequest(customerText);

  if (!days) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          `${deviceName} rental rate`,
          "",
          `💰 Daily: ${formatMoney(rate.daily, true)} / day`,
          `📅 Minimum rental: 3 days`,
          `🗓️ Weekly: ${formatMoney(rate.weekly, true)} / 7 days`,
          isMonthlyRental(customerText, 0) ? `📆 Monthly: ${formatMoney(rate.monthly, true)} / month` : "",
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
          isMonthlyRental(customerText, 0) ? `📆 รายเดือน: ${formatMoney(rate.monthly)} / 1 เดือน` : "",
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

  const startDate = extractStartDate(customerText);
  const returnDate = startDate ? addDays(startDate, days) : null;
  const monthly = isMonthlyRental(customerText, days);
  const includePayment = summaryRequest || Boolean(startDate);

  if (returnDate) {
    memory.lastReturnDate = returnDate.toISOString();
    memory.lastRentalDays = days;
  }
  if (startDate) {
    memory.lastStartDate = startDate.toISOString();
  }
  if (includePayment) {
    memory.summarySent = true;
  }

  const keep = (arr) => arr.filter((x) => x !== undefined && x !== null && x !== false).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  let inventoryStatus = null;
  if (startDate) {
    try {
      const inv = await loadInventorySummary();
      const lineForDevice = inv.split("\n").find((l) => l.toLowerCase().includes(deviceName.toLowerCase()));
      if (lineForDevice) {
        const available = /available/i.test(lineForDevice) && !/not available/i.test(lineForDevice);
        const dateMatch = lineForDevice.match(/วันที่คาดว่าจะว่าง:\s*([^)]+)/);
        inventoryStatus = { available, nextDate: dateMatch ? dateMatch[1].trim() : "" };
      }
    } catch (error) {
      console.error("Inventory check inside buildPriceAnswer failed:", error);
    }
  }

  const GAMES_LINK = "https://ajgamerental2021.github.io/ajconsole/game_index.html";
  const gamesInfoLines = english
    ? ["✨ You can pick up to 10 games per rental", "📚 Browse all games:", `👉 ${GAMES_LINK}`]
    : ["✨ ลูกค้าเลือกได้สูงสุด 10 เกม ต่อการเช่า 1 ครั้ง", "📚 ดูรายการเกมทั้งหมดและเลือกเกมได้ที่:", `👉 ${GAMES_LINK}`];
  const warningLines = english
    ? ["⚠️ Please send Google Maps location for admin to confirm delivery fee", "⚠️ Please read all rental terms carefully before transferring"]
    : ["⚠️ แจ้งโลเคชั่นจัดส่งเป็นลิ้งค์ Google Maps เพื่อให้แอดมินเช็คค่าส่งด้วยนะครับ", "⚠️ รบกวนอ่านรายละเอียดการเช่าอย่างละเอียดก่อนโอนจอง"];

  if (inventoryStatus && !inventoryStatus.available) {
    if (inventoryStatus.nextDate) {
      memory.pendingNextDate = inventoryStatus.nextDate;
      memory.pendingDevice = deviceName;
    }
    if (english) {
      const lines = [];
      if (shouldGreetToday) lines.push("Hello 🎮✨");
      lines.push(`⚠️ ${deviceName} is fully booked on ${formatDate(startDate, true)}`);
      lines.push(inventoryStatus.nextDate ? `📅 Next available: ${inventoryStatus.nextDate}` : "📅 Admin will confirm queue shortly.");
      lines.push("🙏 Would you like to book on the next available date instead?");
      return lines.filter(Boolean).join("\n");
    }
    const lines = [];
    if (shouldGreetToday) lines.push("สวัสดีครับ 🎮✨");
    lines.push(`⚠️ ${deviceName} คิวเต็มในวันที่ ${formatDate(startDate)} ครับ`);
    lines.push(inventoryStatus.nextDate ? `📅 คาดว่าว่างวันที่: ${inventoryStatus.nextDate}` : "📅 เดี๋ยวแอดมินยืนยันคิวอีกครั้งครับ");
    lines.push("🙏 สนใจจองเป็นวันนั้นแทนไหมครับ?");
    return lines.filter(Boolean).join("\n");
  }

  if (english) {
    const groups = [];
    if (shouldGreetToday) groups.push("Hello 🎮✨");
    const summary = [
      `📌 ${monthly ? `${deviceName} monthly rental` : `${deviceName} for ${days} days`}`,
      `💰 Rental fee: ${formatMoney(calc.rentalFee, true)}`,
      calc.discount ? `⭐ Returning discount 10%: -${formatMoney(calc.discount, true)}` : false,
      `🔒 Deposit: ${formatMoney(calc.deposit, true)} (refundable on return day)`,
      `✅ Total: ${formatMoney(calc.total, true)}`,
    ];
    groups.push(keep(summary));
    const pay = [
      "📝 Booking payment: 200 THB",
      `🚚 Pay on delivery: ${formatMoney(calc.payOnDelivery, true)}`,
    ];
    groups.push(keep(pay));
    if (returnDate) groups.push(`📅 Rental period: ${formatDate(startDate, true)} - ${formatDate(returnDate, true)}`);
    if (returnDate) groups.push(keep(gamesInfoLines));
    if (monthly) groups.push("ℹ️ Short-term rentals are usually daily/weekly, monthly available at this rate.");
    if (includePayment) groups.push(buildEnglishPaymentLines(calc, noContract));
    if (includePayment) groups.push(keep(warningLines));
    if (!startDate) groups.push("📍 Please send start date and Google Maps link for delivery fee.");
    return groups.filter(Boolean).join("\n\n");
  }

  const groups = [];
  if (shouldGreetToday) groups.push("สวัสดีครับ 🎮✨");
  const summary = [
    `📌 ${monthly ? `${deviceName} เช่าแบบรายเดือน` : `${deviceName} เช่า ${days} วัน`}`,
    `💰 ค่าเช่า: ${formatMoney(calc.rentalFee)}`,
    calc.discount ? `⭐ ส่วนลดลูกค้าเก่า 10%: -${formatMoney(calc.discount)}` : false,
    `🔒 ค่าประกัน: ${formatMoney(calc.deposit)} ได้คืนวันคืนเครื่อง`,
    `✅ รวมสุทธิ: ${formatMoney(calc.total)}`,
  ];
  groups.push(keep(summary));
  const pay = [
    "📝 โอนจองคิว: 200 บาท",
    `🚚 จ่ายตอนรับเครื่อง: ${formatMoney(calc.payOnDelivery)}`,
  ];
  groups.push(keep(pay));
  if (returnDate) groups.push(`📅 รอบเช่า: ${formatDate(startDate)} - ${formatDate(returnDate)}`);
  if (returnDate) groups.push(keep(gamesInfoLines));
  if (monthly) groups.push("ℹ️ ปกติเช่าระยะสั้นรายวัน/รายสัปดาห์ แต่มีเรทรายเดือนตามนี้ครับ");
  if (includePayment) groups.push(buildThaiPaymentLines(calc, noContract));
  if (includePayment) groups.push(keep(warningLines));
  if (!startDate) groups.push("📍 ถ้าสนใจจอง แจ้งวันเริ่มเช่าและส่งลิงก์ Google Maps ได้เลยครับ");
  return groups.filter(Boolean).join("\n\n");
}

function buildLongTermRentalAnswer(customerText, memory, shouldGreetToday, force = false) {
  if (!force && !includesLongTermRentalQuestion(customerText)) return "";

  memory.preferMonthly = true;
  const english = isEnglishText(customerText);
  const deviceName = extractDeviceName(customerText) || memory.lastDevice;
  const months = extractRentalMonths(customerText);

  if (!deviceName || !deviceRates.has(deviceName)) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          "Monthly rental is available for some devices 😊🎮",
          "",
          "Which device are you interested in?",
          "",
          "Please send the device model and rental start date, then admin can check the queue and confirm the monthly booking.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          "มีเรทรายเดือนสำหรับบางเครื่องครับ 😊🎮",
          "",
          "สนใจเป็นเครื่องรุ่นไหนครับ?",
          "",
          "แจ้งชื่อเครื่องและวันที่เริ่มเช่าได้เลยครับ เดี๋ยวช่วยเช็คคิวและสรุปรายเดือนให้ครับ ✅",
        ]
          .filter(Boolean)
          .join("\n");
  }

  memory.lastDevice = deviceName;

  const rate = deviceRates.get(deviceName);
  const rentalFee = rate.monthly * (months || 1);
  const total = rentalFee + rate.deposit;
  const monthLabel = months || 1;

  const keepLT = (arr) => arr.filter((x) => x !== undefined && x !== null && x !== false && x !== "").join("\n");

  if (english) {
    const groups = [];
    if (shouldGreetToday) groups.push("Hello 🎮✨");
    groups.push(`${deviceName} monthly rental is available 😊🎮`);
    groups.push(keepLT([
      `📆 Monthly rate: ${formatMoney(rate.monthly, true)} / month`,
      months ? `🗓️ Duration: ${months} months` : false,
      months ? `💰 Rental fee: ${formatMoney(rentalFee, true)}` : false,
      `🔒 Deposit: ${formatMoney(rate.deposit, true)} (refundable on return day)`,
      months ? `✅ Total before delivery: ${formatMoney(total, true)}` : false,
    ]));
    groups.push(
      months
        ? "📍 Please send the start date and Google Maps link so admin can check the queue and delivery fee."
        : "🙏 Let me know how many months and the start date, I'll calculate the total.",
    );
    return groups.join("\n\n");
  }

  const groups = [];
  if (shouldGreetToday) groups.push("สวัสดีครับ 🎮✨");
  groups.push(`${deviceName} มีเรทรายเดือนครับ 😊🎮`);
  groups.push(keepLT([
    `📆 รายเดือน: ${formatMoney(rate.monthly)} / 1 เดือน`,
    months ? `🗓️ ระยะเวลา: ${monthLabel} เดือน` : false,
    months ? `💰 ค่าเช่า: ${formatMoney(rentalFee)}` : false,
    `🔒 ค่าประกัน: ${formatMoney(rate.deposit)} ได้คืนวันคืนเครื่อง`,
    months ? `✅ รวมสุทธิ: ${formatMoney(total)}` : false,
  ]));
  groups.push(
    months
      ? "📍 แจ้งวันที่เริ่มเช่าและลิงก์ Google Maps ได้เลยครับ เดี๋ยวเช็คคิวและค่าส่งให้ครับ"
      : "🙏 แจ้งจำนวนเดือนและวันเริ่มเช่าได้เลยครับ เดี๋ยวคำนวณยอดรวมให้ครับ",
  );
  return groups.join("\n\n");
}

function includesBusinessRentalQuestion(text) {
  const value = normalizeSearchText(text);
  return /นามบริษัท|ในบริษัท|บริษัท|ใบกำกับ|ใบเสร็จ|tax invoice|receipt|company rental|under company|company name|corporate/.test(
    value,
  );
}

function buildBusinessRentalAnswer(customerText, memory, shouldGreetToday) {
  if (!includesBusinessRentalQuestion(customerText)) return "";

  const english = isEnglishText(customerText);
  const deviceName = extractDeviceName(customerText) || memory.lastDevice;
  if (deviceName) {
    memory.lastDevice = deviceName;
  }

  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "Company rental is available 😊🧾",
        "",
        "✅ Can issue tax invoice / receipt",
        "✅ No rental agreement required",
        "✅ No ID card copy required",
        "",
        "Company rental rate is higher than individual rental.",
        "",
        "Please send these details so admin can quote correctly:",
        deviceName ? `🎮 Device: ${deviceName}` : "🎮 Device you want to rent",
        "📅 Start date and rental duration",
        "🏢 Company name",
        "📍 Google Maps link for delivery fee check",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "เช่าในนามบริษัท ทางร้านมีให้บริการครับ 😊🧾",
        "",
        "✅ สามารถออกใบกำกับภาษี / ใบเสร็จได้",
        "✅ ไม่ต้องทำสัญญาการเช่า",
        "✅ ไม่ต้องแนบสำเนาบัตรประชาชนผู้เช่า",
        "",
        "ราคาเช่าในนามบริษัทจะสูงกว่าเรทบุคคลครับ",
        "",
        "รบกวนแจ้งข้อมูลนี้เพื่อให้แอดมินเสนอราคาได้ถูกต้องครับ",
        deviceName ? `🎮 เครื่อง: ${deviceName}` : "🎮 เครื่องที่ต้องการเช่า",
        "📅 วันที่เริ่มเช่า และจำนวนวัน",
        "🏢 ชื่อบริษัท",
        "📍 ลิงก์ Google Maps เพื่อเช็คค่าส่ง",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesExtensionRequest(text) {
  const value = normalizeSearchText(text);
  return /เช่าต่อ|ต่ออีก|ต่อ\s*\d+|extend|extension|rent longer|continue rental/.test(value);
}

function includesReturnRequest(text) {
  const value = normalizeSearchText(text);
  return /คืนเครื่อง|ส่งคืน|นัดคืน|ต้องการคืน|return device|return the device|pickup return/.test(value);
}

function buildReturnAnswer(customerText, shouldGreetToday) {
  if (!includesReturnRequest(customerText)) return "";

  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "Sure, for returning the device, please confirm these details 📦✅",
        "",
        "📍 Is the return pickup location the same as the delivery location?",
        "",
        "🕒 What time would you like us to arrange the return pickup?",
        "",
        "If you want the deposit refunded immediately, the return location needs a TV and/or power outlet so we can check the device first.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "ได้ครับ สำหรับการคืนเครื่อง รบกวนแจ้งเพิ่มนิดนึงครับ 📦✅",
        "",
        "📍 จุดคืนเป็นสถานที่เดียวกับที่จัดส่งไปไหมครับ?",
        "",
        "🕒 สะดวกให้ไปรับคืนช่วงเวลาไหนครับ?",
        "",
        "ถ้าต้องการรับค่าประกันคืนทันที จุดคืนต้องมีทีวีและ/หรือปลั๊กไฟ เพื่อให้ตรวจเช็คเครื่องก่อนคืนเงินครับ 🔒✨",
      ]
        .filter(Boolean)
        .join("\n");
}

function buildExtensionAnswer(customerText, memory, shouldGreetToday) {
  if (!includesExtensionRequest(customerText)) return "";

  const english = isEnglishText(customerText);
  const deviceName = extractDeviceName(customerText) || memory.lastDevice;
  const days = extractRentalDays(customerText);

  if (!deviceName || !deviceRates.has(deviceName)) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          "Which device would you like to extend?",
          "",
          "Please tell me the device model and how many more days you want to extend.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          "ต้องการเช่าต่อเครื่องรุ่นไหนครับ?",
          "",
          "แจ้งชื่อเครื่องและจำนวนวันที่ต้องการเช่าต่อได้เลยครับ 🎮✨",
        ]
          .filter(Boolean)
          .join("\n");
  }

  memory.lastDevice = deviceName;

  if (!days) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          `${deviceName} extension is available 🎮✨`,
          "",
          "How many more days would you like to extend?",
          "",
          "Returning customer extension gets 10% off the rental fee. ✅",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          `${deviceName} เช่าต่อได้ครับ 🎮✨`,
          "",
          "ต้องการเช่าต่อเพิ่มกี่วันครับ?",
          "",
          "ค่าเช่าต่อจะคิดส่วนลดลูกค้าเก่า 10% จากค่าเช่าครับ ✅",
        ]
          .filter(Boolean)
          .join("\n");
  }

  const calc = calculateRental(deviceName, days, false, true);
  if (!calc || calc.rentalFee == null) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          `${deviceName} extension starts from the shop's rental rates.`,
          "",
          "For this duration, admin will help confirm the best rate for you.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          `${deviceName} เช่าต่อได้ครับ`,
          "",
          "จำนวนวันนี้ให้แอดมินช่วยเช็คเรทราคาที่เหมาะที่สุดให้นะครับ ✅",
        ]
          .filter(Boolean)
          .join("\n");
  }

  const startDate = memory.lastReturnDate ? new Date(memory.lastReturnDate) : getBangkokDateObject();
  const returnDate = addDays(startDate, days);
  memory.lastReturnDate = returnDate.toISOString();
  memory.lastRentalDays = days;

  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        `${deviceName} extension for ${days} days 🎮✨`,
        "",
        `💰 Rental fee: ${formatMoney(calc.rentalFee, true)}`,
        `⭐ Returning customer discount 10%: -${formatMoney(calc.discount, true)}`,
        "",
        `✅ Extension payment: ${formatMoney(calc.discountedRentalFee, true)}`,
        `📅 New return date: ${formatDate(returnDate, true)}`,
        "",
        "🏦 Bank details",
        "✅ Bank Acc No.: 8690576029",
        "✅ Bank Name: Krung Thai",
        "✅ Bank Acc Name: Somchai Hemsiri",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        `${deviceName} เช่าต่อ ${days} วันครับ 🎮✨`,
        "",
        `💰 ค่าเช่า: ${formatMoney(calc.rentalFee)}`,
        `⭐ ส่วนลดลูกค้าเก่า 10%: -${formatMoney(calc.discount)}`,
        "",
        `✅ ยอดเช่าต่อที่ต้องชำระ: ${formatMoney(calc.discountedRentalFee)}`,
        `📅 วันคืนใหม่: ${formatDate(returnDate)}`,
        "",
        "🏦 ข้อมูลโอน",
        "✅ เลขบัญชี: 8690576029",
        "✅ ธนาคาร: กรุงไทย",
        "✅ ชื่อบัญชี: สมชาย เหมศิริ",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesAdminRequest(text) {
  const value = normalizeSearchText(text);
  return /แอดมิน|admin|คนจริง|พนักงาน|เจ้าหน้าที่|ติดต่อคน|คุยกับคน|human|staff|agent|representative|operator/.test(
    value,
  );
}

function buildAdminPauseReply(customerText, shouldGreetToday) {
  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 👋" : "",
        "🗨️ Admin will take care of you shortly. 😊",
        "",
        "I’ll pause the automated reply now so our team can continue the conversation directly.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 👋" : "",
        "🗨️ แอดมินจะเข้ามาดูแลให้นะครับ 😊",
        "",
        "ระบบจะพักการตอบอัตโนมัติไว้ก่อน เพื่อให้แอดมินคุยต่อโดยตรงครับ ✅",
      ]
        .filter(Boolean)
        .join("\n");
}

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ๆฯ]/g, "")
    .replace(/ม๊ัย|ม๊ัยย|มั๊ย|ม้าย|ใหม|ไม๊/g, "มั้ย")
    .replace(/เท่าไร|เท่าไรร|เท่าไหร|เท่าไหร่|เท่าไหร่ๆ/g, "เท่าไหร่")
    .replace(/กี่บาทแล้ว|กี่บาท|ราคาเท่าไหร่|ราคาเท่าไร/g, "กี่บาท")
    .replace(/ครัช|ครัฟ|คับ|คร่ะ|ค่ะะ|คะะ|ครับๆ/g, "")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(text) {
  return normalizeSearchText(text).replace(/[^a-z0-9ก-๙]/gi, "");
}

function includesGameplayHowToQuestion(text) {
  const value = normalizeSearchText(text);
  if (/เช่า|rent|ราคา|กี่บาท|เท่าไหร่/.test(value)) return false;
  const patterns = [
    /เล่น[ก-๙ 0-9]{0,12}(ยังไง|อย่างไร|ไง)/,
    /วิธีเล่น/,
    /เล่น\s*\d+\s*คน/,
    /เล่น(สอง|สาม|สี่|หลาย)คน/,
    /โหมด(เล่น|มัลติ|co)/,
    /\b(coop|co-op|multiplayer|gameplay|walkthrough)\b/,
    /how to play|how do (you|i) play/,
    /ผ่านด่าน|สู้บอส|ตีบอส|ล้มบอส/,
    /สูตรโกง|cheat code/,
  ];
  return patterns.some((re) => re.test(value));
}

function buildGameplayHowToAnswer(customerText, shouldGreetToday) {
  if (!includesGameplayHowToQuestion(customerText)) return "";
  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "🙏 One moment, admin will come help you shortly 😊",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "🙏 สักครู่จะมีแอดมินเข้ามาดูแลนะครับ 😊",
      ]
        .filter(Boolean)
        .join("\n");
}

function includesGameQuestion(text) {
  const normalized = normalizeSearchText(text);
  if (
    includesBusinessRentalQuestion(text) ||
    includesPurchaseQuestion(text) ||
    includesLongTermRentalQuestion(text) ||
    includesTermsQuestion(text) ||
    includesPromotionQuestion(text) ||
    includesAccountRentalQuestion(text) ||
    includesGameplayHowToQuestion(text) ||
    includesIncludedGamesQuestion(text) ||
    includesAvailabilityQuestion(text) ||
    includesContractDocQuestion(text) ||
    includesGeneralRentalQuestion(text) ||
    includesDepositRefundQuestion(text) ||
    includesGameSelectionMessage(text)
  ) {
    return false;
  }

  const candidate = buildGameSearchQuery(text);
  const hasEnglishToken = /[a-z0-9]{3,}/i.test(candidate);
  const hasGameKeyword = /เกม|game/.test(normalized);
  const hasAvailabilityPhrase = /มี|ไหม|มั้ย|have|available/.test(normalized);

  if (!hasEnglishToken) return false;
  return hasAvailabilityPhrase || hasGameKeyword;
}

function buildGameSearchQuery(text) {
  const platformStopwords = new Set([
    "ps5",
    "ps4",
    "ps",
    "playstation",
    "switch",
    "nintendo",
    "xbox",
    "series",
    "meta",
    "quest",
    "steam",
    "deck",
    "rog",
    "ally",
    "lenovo",
    "legion",
    "viture",
    "xreal",
    "portal",
    "vr2",
    "pro",
    "oled",
    "เครื่อง",
    "บน",
    "ใน",
    "เช่า",
    "ราคา",
    "กี่บาท",
    "เท่าไหร่",
    "นาม",
    "บริษัท",
    "ใบกำกับ",
    "ใบเสร็จ",
    "มี",
    "มีเกม",
    "เกม",
    "เกมนี้",
    "เกมส์",
    "game",
    "ไหม",
    "ไหมครับ",
    "ไหมค่ะ",
    "ไหมคะ",
    "มั้ย",
    "มั้ยครับ",
    "มั้ยค่ะ",
    "มั้ยคะ",
    "ครับ",
    "ค่ะ",
    "คะ",
    "จ้า",
    "จ๊ะ",
    "หน่อย",
    "เล่น",
    "ได้",
    "ขอ",
    "ถาม",
    "available",
    "have",
    "do",
    "you",
    "has",
    "is",
    "there",
    "on",
    "of",
    "the",
    "for",
    "rent",
    "rental",
  ]);

  const normalizedAliases = deviceAliases.flatMap(([, aliases]) =>
    aliases.map((alias) => normalizeSearchText(alias)).filter(Boolean),
  );

  let normalized = normalizeSearchText(text);
  for (const alias of normalizedAliases.sort((a, b) => b.length - a.length)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }

  return normalized
    .split(" ")
    .filter((part) => part && !platformStopwords.has(part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
  const query = buildGameSearchQuery(customerText);

  if (query.length < 3) {
    return "ข้อมูลเกม: ลูกค้าถามเรื่องเกม แต่ยังไม่ได้ระบุชื่อเกมชัดเจน ให้ส่งลิงก์เลือกเกมและถามชื่อเกมที่สนใจ";
  }

  const queryParts = query.split(" ").filter((part) => part.length >= 3);
  const compactQuery = compactSearchText(query);
  const rawMatches = [];

  for (const game of gameData.games || []) {
    const gameName = normalizeSearchText(game.name);
    const compactGameName = compactSearchText(game.name);
    const directMatch = gameName.includes(query) || query.includes(gameName);
    const compactMatch =
      compactQuery.length >= 3 &&
      (compactGameName.includes(compactQuery) || compactQuery.includes(compactGameName));
    const tokenMatch =
      queryParts.length > 0 && queryParts.every((part) => gameName.includes(part));

    if (directMatch || compactMatch || tokenMatch) {
      rawMatches.push({
        name: game.name,
        platform: getPlatformName(gameData, game.platformId),
        unavailable: Boolean(game.unavailable),
        availableDate: game.available_date || "",
      });
    }
  }

  if (rawMatches.length === 0) {
    return [
      "ข้อมูลเกม: ไม่พบชื่อเกมที่ตรงกับคำถามใน Gist",
      "ให้ตอบว่าเบื้องต้นยังไม่เจอในรายการรวม และให้ลูกค้าเช็ค/เลือกเกมเองได้ที่ https://ajgamerental2021.github.io/ajconsole/game_index.html",
    ].join("\n");
  }

  const exactMatches = rawMatches.filter((match) => {
    const compactName = compactSearchText(match.name);
    return compactName === compactQuery || compactName.includes(compactQuery);
  });
  const matches = (exactMatches.length ? exactMatches : rawMatches).slice(0, 12);
  const grouped = new Map();

  for (const match of matches) {
    const key = compactSearchText(match.name);
    if (!grouped.has(key)) {
      grouped.set(key, {
        name: match.name,
        platforms: [],
      });
    }

    const group = grouped.get(key);
    const status = match.unavailable
      ? `ไม่พร้อมให้เลือกตอนนี้${match.availableDate ? `, คาดว่าจะว่าง ${match.availableDate}` : ""}`
      : "มีให้เลือก";
    group.platforms.push(`${match.platform} (${status})`);
  }

  const lines = [...grouped.values()].map((group) => {
    return `- ${group.name}: ${group.platforms.join(" / ")}`;
  });

  return [
    "ข้อมูลเกมจาก Gist:",
    "ถ้าพบเกมเดียวกันหลายเครื่อง ให้บอกเครื่องที่มีให้ลูกค้าเลือก",
    ...lines,
    "ลิงก์เลือกเกมทั้งหมด: https://ajgamerental2021.github.io/ajconsole/game_index.html",
  ].join("\n");
}

function buildGameAnswerFromSummary(customerText, gameSummary, shouldGreetToday) {
  if (!gameSummary) return "";

  const english = isEnglishText(customerText);
  const notFound = gameSummary.includes("ไม่พบชื่อเกม");
  const unclear = gameSummary.includes("ยังไม่ได้ระบุชื่อเกมชัดเจน");
  const lines = gameSummary
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, ""));

  if (unclear) {
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          "Which game would you like to check?",
          "",
          "You can also browse all games here:",
          "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          "ต้องการเช็คเกมชื่ออะไรครับ?",
          "",
          "หรือเลือกดูเกมทั้งหมดได้ที่ลิงก์นี้เลยครับ",
          "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
        ]
          .filter(Boolean)
          .join("\n");
  }

  if (notFound || lines.length === 0) {
    const queried = buildGameSearchQuery(customerText);
    return english
      ? [
          shouldGreetToday ? "Hello 🎮✨" : "",
          `I couldn't find ${queried || "that game"} in the combined game list yet.`,
          "",
          "You can browse all available games here:",
          "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
          "",
          "If you want, admin can help double-check it for you.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
          `เบื้องต้นยังไม่เจอเกม ${queried || "นี้"} ในรายการรวมครับ`,
          "",
          "สามารถเลือกดูเกมทั้งหมดได้ที่ลิงก์นี้เลยครับ",
          "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
          "",
          "ถ้าต้องการให้แอดมินช่วยเช็คซ้ำ แจ้งได้เลยครับ 🎮✨",
        ]
          .filter(Boolean)
          .join("\n");
  }

  const gameLines = lines.slice(0, 5).map((line) => `✅ ${line}`);
  const thaiIntro = chooseVariant([
    "ทางร้านมีให้บริการครับ 😊🎮✨",
    "ทางร้านมีให้เลือกครับ 😊🎮✨",
    "มีให้บริการในรายการของร้านครับ 🎮✨",
  ]);
  const englishIntro = chooseVariant([
    "This game is available from our shop 😊🎮✨",
    "We have this game available 😊🎮✨",
    "This title is available in our game list 🎮✨",
  ]);

  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        englishIntro,
        "",
        ...gameLines,
        "",
        "You can browse and choose games here:",
        "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        thaiIntro,
        "",
        ...gameLines,
        "",
        "สามารถเลือกเกมทั้งหมดได้ที่ลิงก์นี้เลยครับ",
        "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
      ]
        .filter(Boolean)
        .join("\n");
}

function buildGameLookupUnavailableAnswer(customerText, shouldGreetToday) {
  if (!includesGameQuestion(customerText)) return "";

  const english = isEnglishText(customerText);
  return english
    ? [
        shouldGreetToday ? "Hello 🎮✨" : "",
        "I can’t check the game list automatically right now.",
        "",
        "You can browse and choose games here:",
        "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
        "",
        "Admin can also help double-check the title for you.",
      ]
        .filter(Boolean)
        .join("\n")
    : [
        shouldGreetToday ? "สวัสดีครับ 🎮✨" : "",
        "ตอนนี้เช็ครายการเกมอัตโนมัติไม่สำเร็จครับ",
        "",
        "สามารถเลือกดูเกมทั้งหมดได้ที่ลิงก์นี้เลยครับ",
        "👉 https://ajgamerental2021.github.io/ajconsole/game_index.html",
        "",
        "ถ้าต้องการให้แอดมินช่วยเช็คชื่อเกมซ้ำ แจ้งได้เลยครับ 🎮✨",
      ]
        .filter(Boolean)
        .join("\n");
}

function extractGameQueryFromSummary(gameSummary) {
  const line = String(gameSummary || "")
    .split("\n")
    .find((item) => item.startsWith("- "));
  if (!line) return "";
  return line.replace(/^- /, "").split(":")[0].trim();
}

function shouldUseLastGameQuery(customerText, memory) {
  if (!memory.lastGameQuery) return false;

  const value = normalizeSearchText(customerText);
  const hasDevice = Boolean(extractDeviceName(customerText));
  const asksGameFollowup = /เกม|game|เล่น|มี|ไหม|มั้ย|available|have|ล่ะ|ละ/.test(value);
  const asksPlatformFollowup =
    asksGameFollowup && /บน|ps5|ps4|switch|xbox|meta|quest|playstation|nintendo|platform/.test(value);

  return (hasDevice && asksGameFollowup) || asksPlatformFollowup;
}

function getActivePause(sessionKey) {
  if (globalPause) {
    if (globalPause.expiresAt && globalPause.expiresAt <= Date.now()) {
      globalPause = null;
      globalPauseExceptions.clear();
      persistGlobalPauseToRedis().catch(() => {});
      persistExemptionsToRedis().catch(() => {});
    } else if (!globalPauseExceptions.has(sessionKey)) {
      return { ...globalPause, scope: "global" };
    }
  }

  const pause = pausedSessions.get(sessionKey);
  if (!pause) return null;

  if (pause.expiresAt && pause.expiresAt <= Date.now()) {
    pausedSessions.delete(sessionKey);
    return null;
  }

  return pause;
}

function rememberSession({ sessionKey, dialogflowSession, customerText, intentName, memory }) {
  recentSessions.set(sessionKey, {
    sessionKey,
    dialogflowSession,
    lastText: customerText,
    lastDevice: memory?.lastDevice || "",
    lastIntentName: intentName || "",
    updatedAt: new Date().toISOString(),
  });

  if (recentSessions.size > 80) {
    const oldest = [...recentSessions.entries()]
      .sort(([, a], [, b]) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .slice(0, recentSessions.size - 80);
    for (const [key] of oldest) {
      recentSessions.delete(key);
    }
  }
}

async function pauseSession({ sessionKey, customerId = "", minutes = defaultPauseMinutes, reason = "admin_takeover" }) {
  const expiresAt = minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0;

  pausedSessions.set(sessionKey, {
    expiresAt,
    reason,
  });

  await persistPauseToWebhook({
    sessionKey,
    customerId: customerId || sessionKey,
    minutes,
    reason,
  });

  return {
    sessionKey,
    customerId: customerId || sessionKey,
    reason,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };
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

async function persistPauseToWebhook({ sessionKey, customerId, minutes, reason, status = "paused" }) {
  notifyEvent(status === "resumed" ? "resume" : "pause", { sessionKey, customerId, minutes, reason });

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
        status,
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

const fewShotExamples = `
ตัวอย่างที่ 1 — ถามรวมเกม
ลูกค้า: "รวมเกมไหมครับ"
context: lastDevice=PS5
ตอบ:
🎮 ใช่ครับ! เช่า PS5 รวมเกมให้ด้วย
✨ เลือกได้สูงสุด 10 เกม ต่อการเช่า 1 ครั้ง
📚 ดูรายการเกมทั้งหมด:
👉 https://ajgamerental2021.github.io/ajconsole/game_index.html

ตัวอย่างที่ 2 — ถามวิธีเล่นเกม
ลูกค้า: "ดราก้อนบอลเล่น 2 คนยังไง"
ตอบ:
🙏 สักครู่จะมีแอดมินเข้ามาดูแลนะครับ 😊

ตัวอย่างที่ 3 — เช่า xbox เปล่า ๆ (ambiguous)
ลูกค้า: "เช่า xbox เท่าไหร่"
ตอบ:
🎮 สนใจ Xbox Series X หรือ Series S ครับ?

⚡️ Series X
💰 รายวัน 350 บาท
🗓️ รายสัปดาห์ 1,800 บาท
🔒 ค่าประกัน 2,000 บาท

🟢 Series S
💰 รายวัน 300 บาท
🗓️ รายสัปดาห์ 1,500 บาท
🔒 ค่าประกัน 2,000 บาท

ตัวอย่างที่ 4 — สรุปการเช่า
ลูกค้า: "ps5 เช่า 4 วัน เริ่ม 20/5/2026"
ตอบ:
🎮 PS5 เช่า 4 วัน
💰 ค่าเช่า 1,600 บาท
🔒 ค่าประกัน 2,000 บาท
✅ รวมสุทธิ 3,600 บาท
📅 รอบเช่า 20/05/2026 - 24/05/2026

🏦 ข้อมูลโอน
✅ เลขบัญชี 8690576029
✅ ธนาคาร กรุงไทย
✅ ชื่อบัญชี สมชาย เหมศิริ

ตัวอย่างที่ 5 — ส่งต่างจังหวัด
ลูกค้า: "ส่งเชียงใหม่ไหมครับ"
ตอบ:
🙏 ขออภัยครับ ทางร้านส่งเฉพาะกรุงเทพและปริมณฑลครับ
📍 ถ้าอยู่ในเขตปริมณฑล แจ้งพิกัด Google Maps มาเช็คค่าส่งได้ครับ
`.trim();

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
      max_output_tokens: 900,
      instructions: [
        "คุณเป็นแอดมินร้าน Aj เช่าเครื่องเกม ฉลาด รวดเร็ว สุภาพ เป็นกันเอง อ่านง่าย",
        "ตอบเป็นภาษาเดียวกับลูกค้า ถ้าลูกค้าพิมพ์ไทยให้ตอบไทย ถ้าลูกค้าพิมพ์อังกฤษให้ตอบอังกฤษ",
        "จัดคำตอบเป็นบรรทัดสั้น และเว้นบรรทัดเดียว (ไม่ใช่สองบรรทัด) ระหว่างหัวข้อ",
        "ใส่ emoji ที่ชัดเจนทุกหัวข้อและทุกบุลเลต ใช้หลากหลาย เช่น 🎮✨ 📅🕒 💰✅ 🚚⚡️ 📝📌 ⚠️ 🏦💳 🔒 ⭐ 🎁 🔥 📍 🙏 ❌ 🚫 👋",
        "ขึ้นต้นหัวข้อด้วย emoji 1-2 ตัว ตามด้วยข้อความสั้น แล้วเป็นบุลเลตที่ขึ้นต้นด้วย emoji อีกตัว",
        "ห้ามเขียนเป็นย่อหน้ายาว ถ้ามีราคา/เงื่อนไข/ขั้นตอน ให้แยกเป็นหลายบรรทัดพร้อมเว้นบรรทัดเดียว",
        "ถ้าลูกค้าถามหลายเรื่องในข้อความเดียว ให้ตอบแยกเป็นหัวข้อด้วย emoji หัวเรื่องต่างกัน ครบทุกคำถาม",
        "ถ้าลูกค้าถามหลายเรื่องในข้อความเดียว เช่น ราคาและเกม ให้ตอบให้ครบทุกคำถามโดยแยกเป็นหัวข้อ",
        "รูปแบบที่ชอบ: หัวข้อ 1 บรรทัด, รายละเอียด 2-5 บรรทัด, เว้นบรรทัด, ขั้นต่อไป 1-3 บรรทัด",
        "ถ้า shouldGreetToday=true ให้เริ่มด้วยคำทักทายสั้น ๆ เช่น 'สวัสดีครับ' หรือ 'Hello' เฉพาะครั้งแรกของวันนั้น",
        "ถ้า shouldGreetToday=false ห้ามขึ้นต้นด้วยคำว่า สวัสดี/Hello อีก",
        "ตอบจากข้อมูลร้านที่ให้มาเท่านั้น ห้ามแต่งราคา สต็อก โปรโมชัน หรือเงื่อนไขเอง",
        "ถ้าข้อมูลไม่พอ ให้ถามกลับ 1 คำถามที่จำเป็นที่สุด",
        "ถ้าลูกค้าถามต่อโดยไม่ระบุชื่อเครื่อง ให้ใช้ lastDevice จาก context ก่อนหน้าเป็นเครื่องที่กำลังคุยอยู่",
        "ถ้าลูกค้าถามว่าเครื่องรุ่นใดว่างหรือไม่ ให้ใช้ข้อมูลสต็อกจาก Google Sheet ที่แนบมา",
        "ถ้าเครื่องมี Status = Available อย่างน้อย 1 เครื่อง ให้ตอบว่าว่าง แต่ถ้าลูกค้าต้องการจองตามวันที่เฉพาะ ให้แจ้งว่าจะให้แอดมินเช็คคิวและยืนยันอีกครั้ง",
        "ถ้าลูกค้าถามว่ามีเกมนี้ไหม ให้ใช้ข้อมูลเกมจาก Gist ที่แนบมา ถ้าไม่พบให้ส่งลิงก์เลือกเกมทั้งหมด",
        "ถ้าลูกค้าถาม 'รวมเกมไหม' 'มีเกมมาให้ไหม' 'แถมเกมไหม' 'พร้อมเกมไหม' 'เครื่องนี้มีเกมอะไรบ้าง' ห้ามตีความว่าเป็นชื่อเกม → ตอบว่ารวมเกมให้ ลูกค้าเลือกได้สูงสุด 10 เกม จากลิงก์ game_index.html",
        "ถ้าข้อความลูกค้าสั้น ไม่มีชื่อเกมจริง ๆ และดูเหมือนถามว่า 'มีเกมหรือเปล่า' → ตีความเป็นถามเกมที่แถม ไม่ใช่ค้นหาเกม",
        "อ่าน context ก่อนตอบ: ถ้าก่อนหน้าลูกค้าถามราคาเครื่อง X และถามต่อด้วยคำสั้น ๆ เช่น 'มีเกมไหม' 'รวมไหม' ให้ตีความเป็นถามว่าเช่าเครื่อง X รวมเกมหรือไม่",
        "ถ้าลูกค้าถามเช่าในนามบริษัทหรือใบกำกับภาษี ห้ามตีความเป็นคำถามเกม ให้ตอบเงื่อนไขบริษัทและขอชื่อบริษัท",
        "ถ้าลูกค้าถามเลือกเกม ให้ส่งลิงก์ https://ajgamerental2021.github.io/ajconsole/game_index.html",
        "ถ้าลูกค้าบอกว่าต้องการเช่าต่อ ให้ใช้ lastDevice จาก context ถ้ามีจำนวนวันให้คำนวณค่าเช่าต่อพร้อมส่วนลดลูกค้าเก่า 10% ถ้าไม่มีจำนวนวันให้ถามจำนวนวัน",
        "ถ้าลูกค้าบอกว่าต้องการคืนเครื่อง ให้ถามว่าจุดคืนเป็นสถานที่เดียวกับตอนส่งไหม และสะดวกเวลาไหน",
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
            `ตัวอย่างการตอบที่ถูกต้อง (few-shot examples):\n${fewShotExamples}`,
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
    defaultPauseMinutes,
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

app.get("/admin/recent-sessions", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessions = [...recentSessions.values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );

  if (String(req.get("accept") || "").includes("text/html")) {
    const rows = sessions
      .map((item) => {
        const url = `/admin/take-action?token=${encodeURIComponent(adminToken)}&sessionKey=${encodeURIComponent(
          item.sessionKey,
        )}`;
        return [
          "<li>",
          `<a href="${url}">Pause</a>`,
          " ",
          `<strong>${item.updatedAt}</strong>`,
          " ",
          `<code>${item.sessionKey}</code>`,
          " ",
          `<span>${String(item.lastText || "").replace(/[<>&]/g, "")}</span>`,
          "</li>",
        ].join("");
      })
      .join("");

    return res.type("html").send(`
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.5;">
          <h1>Recent Sessions</h1>
          <p>กด Pause เมื่อต้องการให้แอดมิน Take action เอง</p>
          <ul>${rows || "<li>No sessions yet</li>"}</ul>
        </body>
      </html>
    `);
  }

  res.json({ ok: true, sessions });
});

app.get("/admin/take-action", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.query.sessionKey || "").trim();
  const minutes = Number(req.query.minutes || defaultPauseMinutes);
  const reason = String(req.query.reason || "admin_take_action");

  if (!sessionKey) {
    const sessions = [...recentSessions.values()].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    const rows = sessions
      .map((item) => {
        const url = `/admin/take-action?token=${encodeURIComponent(adminToken)}&sessionKey=${encodeURIComponent(
          item.sessionKey,
        )}&minutes=${encodeURIComponent(minutes)}&reason=${encodeURIComponent(reason)}`;
        const exemptUrl = `/admin/exempt?token=${encodeURIComponent(adminToken)}&sessionKey=${encodeURIComponent(item.sessionKey)}`;
        const isExempt = globalPauseExceptions.has(item.sessionKey);
        const exemptBtn = globalPause
          ? (isExempt
              ? `<a href="/admin/unexempt?token=${encodeURIComponent(adminToken)}&sessionKey=${encodeURIComponent(item.sessionKey)}" style="display:inline-block;margin-left:6px;padding:6px 10px;background:#999;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;">🔒 ถอน Exempt</a>`
              : `<a href="${exemptUrl}" style="display:inline-block;margin-left:6px;padding:6px 10px;background:#06c;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;">▶️ ให้ AI ตอบเฉพาะคนนี้</a>`)
          : "";
        return `<li style="margin:10px 0;padding:10px;border:1px solid #ccc;border-radius:8px;">
          <div style="font-size:12px;color:#666;">${item.updatedAt}</div>
          <div><code style="word-break:break-all;font-size:12px;">${item.sessionKey}</code></div>
          <div style="margin:6px 0;">${String(item.lastText || "").replace(/[<>&]/g, "")}</div>
          <a href="${url}" style="display:inline-block;padding:6px 10px;background:#c33;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:700;">⏸ Pause</a>
          ${exemptBtn}
        </li>`;
      })
      .join("");

    const expiry = globalPause?.expiresAt ? new Date(globalPause.expiresAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "ไม่จำกัด (ถาวร)";
    const globalBanner = globalPause
      ? `<div style="padding:12px;background:#fee;border:2px solid #c33;border-radius:8px;margin-bottom:16px;">
          <strong>🌐 Global Pause กำลังเปิด</strong><br/>
          AI หยุดตอบทุกคน · ${globalPause.reason}<br/>
          ⏰ ถึง: ${expiry}<br/>
          <a href="/admin/resume-all?token=${encodeURIComponent(adminToken)}" style="display:inline-block;margin-top:8px;padding:8px 14px;background:#0a7;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">▶️ Resume All</a>
        </div>`
      : `<div style="padding:12px;background:#efe;border:1px solid #0a7;border-radius:8px;margin-bottom:16px;">
          ✅ AI ตอบปกติ
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;">
            <a href="/admin/pause-all?token=${encodeURIComponent(adminToken)}&minutes=720" style="padding:8px 14px;background:#c33;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">⏸ Pause All 12 ชม.</a>
            <a href="/admin/pause-all?token=${encodeURIComponent(adminToken)}&minutes=0&reason=global_permanent_pause" style="padding:8px 14px;background:#900;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">🔒 Pause All ถาวร (ไม่มี timer)</a>
          </div>
        </div>`;
    return res.type("html").send(`
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;max-width:600px;">
          <h1>Admin Take Action</h1>
          ${globalBanner}
          <p><a href="/admin/resume?token=${encodeURIComponent(adminToken)}">▶️ ดู/ปลด pause รายคน</a></p>
          <p>เลือกลูกค้าที่ต้องการให้ AI หยุดตอบทันที</p>
          <ul style="list-style:none;padding:0;">${rows || "<li>No recent sessions yet</li>"}</ul>
        </body>
      </html>
    `);
  }

  const pause = await pauseSession({ sessionKey, customerId: sessionKey, minutes, reason });
  res.type("html").send(`
    <html>
      <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;">
        <h1>✅ Paused</h1>
        <p>AI หยุดตอบ <code>${pause.sessionKey}</code></p>
        <p>Reason: ${pause.reason}</p>
        <p>Until: ${pause.expiresAt || "manual resume required"}</p>
        <p><a href="/admin/take-action?token=${encodeURIComponent(adminToken)}">← กลับหน้า list</a></p>
        <p><a href="/admin/resume?token=${encodeURIComponent(adminToken)}&sessionKey=${encodeURIComponent(pause.sessionKey)}" style="display:inline-block;padding:10px 16px;background:#0a7;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">▶️ Resume ตอนนี้</a></p>
      </body>
    </html>
  `);
});

app.get("/admin/pause-all", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const minutes = Number(req.query.minutes || defaultPauseMinutes);
  const reason = String(req.query.reason || "global_admin_pause");
  globalPause = {
    expiresAt: minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0,
    reason,
  };
  await persistGlobalPauseToRedis();
  await persistPauseToWebhook({
    sessionKey: "*GLOBAL*",
    customerId: "*GLOBAL*",
    minutes,
    reason,
    status: "paused",
  });
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const until = globalPause.expiresAt ? new Date(globalPause.expiresAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "ไม่จำกัด (manual)";
  res.type("html").send(`<html><head>${meta}</head>
    <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;max-width:600px;">
      <h1>🌐 Global Pause ON</h1>
      <p>AI หยุดตอบ <strong>ทุกคน</strong> รวมถึงลูกค้าใหม่ที่จะทักเข้ามา</p>
      <p>📅 จนถึง: ${until}</p>
      <p>📝 Reason: ${reason}</p>
      <p><a href="/admin/resume-all?token=${encodeURIComponent(adminToken)}" style="display:inline-block;padding:12px 20px;background:#0a7;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">▶️ Resume All / เปิด AI กลับ</a></p>
      <p><a href="/admin/take-action?token=${encodeURIComponent(adminToken)}">← Take Action</a> · <a href="/admin/resume?token=${encodeURIComponent(adminToken)}">Resume List</a></p>
    </body></html>`);
});

app.get("/admin/exempt", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sessionKey = String(req.query.sessionKey || "").trim();
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  if (!sessionKey) {
    return res.status(400).type("html").send(`<html><head>${meta}</head><body style="font-family:-apple-system,sans-serif;padding:16px;"><h1>Missing sessionKey</h1></body></html>`);
  }
  globalPauseExceptions.add(sessionKey);
  pausedSessions.delete(sessionKey);
  persistExemptionsToRedis().catch(() => {});
  res.type("html").send(`<html><head>${meta}</head>
    <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;">
      <h1>✅ AI ตอบเฉพาะคนนี้</h1>
      <p><code>${sessionKey}</code></p>
      <p>ลูกค้านี้จะได้รับการตอบจาก AI แม้ว่า Global Pause จะเปิดอยู่</p>
      <p><a href="/admin/take-action?token=${encodeURIComponent(adminToken)}">← Take Action</a> · <a href="/admin/resume?token=${encodeURIComponent(adminToken)}">Resume List</a></p>
    </body></html>`);
});

app.get("/admin/unexempt", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sessionKey = String(req.query.sessionKey || "").trim();
  globalPauseExceptions.delete(sessionKey);
  persistExemptionsToRedis().catch(() => {});
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  res.type("html").send(`<html><head>${meta}</head>
    <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;">
      <h1>✅ ถอน exemption</h1>
      <p><code>${sessionKey}</code> กลับมาอยู่ใน Global Pause</p>
      <p><a href="/admin/resume?token=${encodeURIComponent(adminToken)}">← Resume List</a></p>
    </body></html>`);
});

app.get("/admin/resume-all", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const was = Boolean(globalPause);
  globalPause = null;
  globalPauseExceptions.clear();
  await persistGlobalPauseToRedis();
  await persistExemptionsToRedis();
  await persistPauseToWebhook({
    sessionKey: "*GLOBAL*",
    customerId: "*GLOBAL*",
    minutes: 0,
    reason: "global_admin_resumed",
    status: "resumed",
  });
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  res.type("html").send(`<html><head>${meta}</head>
    <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;max-width:600px;">
      <h1>${was ? "✅ Global Pause OFF" : "ℹ️ ไม่ได้ pause ทั้งหมดอยู่"}</h1>
      <p>AI กลับมาตอบลูกค้าตามปกติ (ยกเว้นรายคนที่ pause อยู่)</p>
      <p><a href="/admin/take-action?token=${encodeURIComponent(adminToken)}">← Take Action</a> · <a href="/admin/resume?token=${encodeURIComponent(adminToken)}">Resume List</a></p>
    </body></html>`);
});

app.post("/admin/pause", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.body?.sessionKey || req.query.sessionKey || "").trim();
  const customerId = String(req.body?.customerId || req.query.customerId || "").trim();
  const minutes = Number(req.body?.minutes || req.query.minutes || defaultPauseMinutes);
  const reason = String(req.body?.reason || req.query.reason || "admin_takeover");

  if (!sessionKey) {
    return res.status(400).json({ ok: false, error: "sessionKey is required" });
  }

  pauseSession({ sessionKey, customerId, minutes, reason })
    .then((pause) => res.json({ ok: true, ...pause }))
    .catch((error) => {
      console.error("Pause failed:", error);
      res.status(500).json({ ok: false, error: "Pause failed" });
    });
});

app.post("/admin/take-action", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.body?.sessionKey || req.query.sessionKey || "").trim();
  const customerId = String(req.body?.customerId || req.query.customerId || "").trim();
  const minutes = Number(req.body?.minutes || req.query.minutes || defaultPauseMinutes);
  const reason = String(req.body?.reason || req.query.reason || "admin_take_action");

  if (!sessionKey) {
    return res.status(400).json({ ok: false, error: "sessionKey is required" });
  }

  pauseSession({ sessionKey, customerId, minutes, reason })
    .then((pause) => res.json({ ok: true, ...pause }))
    .catch((error) => {
      console.error("Take action pause failed:", error);
      res.status(500).json({ ok: false, error: "Take action pause failed" });
    });
});

app.post("/admin/admin-reply", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.body?.sessionKey || req.query.sessionKey || "").trim();
  const customerId = String(req.body?.customerId || req.query.customerId || "").trim();
  const minutes = Number(req.body?.minutes || req.query.minutes || defaultPauseMinutes);
  const reason = String(req.body?.reason || req.query.reason || "admin_reply_detected");

  if (!sessionKey) {
    return res.status(400).json({ ok: false, error: "sessionKey is required" });
  }

  pauseSession({ sessionKey, customerId, minutes, reason })
    .then((pause) => res.json({ ok: true, ...pause }))
    .catch((error) => {
      console.error("Admin-reply pause failed:", error);
      res.status(500).json({ ok: false, error: "Admin-reply pause failed" });
    });
});

app.post("/admin/resume", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.body?.sessionKey || req.query.sessionKey || "").trim();

  if (!sessionKey) {
    return res.status(400).json({ ok: false, error: "sessionKey is required" });
  }

  pausedSessions.delete(sessionKey);
  await persistPauseToWebhook({
    sessionKey,
    customerId: sessionKey,
    minutes: 0,
    reason: "admin_resumed",
    status: "resumed",
  });
  pauseSheetCache = { expiresAt: 0, rows: [] };
  res.json({ ok: true, sessionKey, resumed: true });
});

app.get("/admin/resume", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sessionKey = String(req.query.sessionKey || "").trim();
  const now = Date.now();
  const meta = { viewport: '<meta name="viewport" content="width=device-width, initial-scale=1">' };

  if (!sessionKey) {
    const merged = new Map();
    for (const [key, pause] of pausedSessions.entries()) {
      merged.set(key, {
        sessionKey: key,
        reason: pause.reason || "",
        expiresAt: pause.expiresAt ? new Date(pause.expiresAt).toISOString() : null,
        remainingMinutes: pause.expiresAt ? Math.max(0, Math.round((pause.expiresAt - now) / 60000)) : null,
        source: "memory",
      });
    }
    try {
      const rows = await loadPauseSheetRows();
      for (const row of rows) {
        const key = String(row.SessionKey || row.sessionKey || row.session || "").trim();
        if (!key || merged.has(key)) continue;
        const status = String(row.Status || row.status || "").trim().toLowerCase();
        if (status && !["paused", "pause", "active", "true", "yes"].includes(status)) continue;
        const until = parseDateTime(row.PausedUntil || row.pausedUntil || row.ExpiresAt || row.expiresAt);
        if (until && until <= now) continue;
        merged.set(key, {
          sessionKey: key,
          reason: String(row.Reason || row.reason || "pause_sheet"),
          expiresAt: until ? new Date(until).toISOString() : null,
          remainingMinutes: until ? Math.max(0, Math.round((until - now) / 60000)) : null,
          source: "sheet",
        });
      }
    } catch (error) {
      console.error("Resume page: pause sheet load failed:", error);
    }
    const pauses = [...merged.values()].sort((a, b) => (a.expiresAt || "").localeCompare(b.expiresAt || ""));

    const rows = pauses
      .map((p) => {
        const url = `/admin/resume?token=${encodeURIComponent(adminToken)}&sessionKey=${encodeURIComponent(p.sessionKey)}`;
        return `<li style="margin:12px 0;padding:12px;border:1px solid #ccc;border-radius:8px;">
          <div><code style="word-break:break-all;">${p.sessionKey}</code></div>
          <div style="color:#666;font-size:13px;">${p.reason} · เหลือ ${p.remainingMinutes ?? "?"} นาที · ${p.source}</div>
          <a href="${url}" style="display:inline-block;margin-top:8px;padding:10px 16px;background:#0a7;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">▶️ Resume / ปลด Pause</a>
        </li>`;
      })
      .join("");

    const expiryR = globalPause?.expiresAt ? new Date(globalPause.expiresAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "ไม่จำกัด (ถาวร)";
    const globalBanner = globalPause
      ? `<div style="padding:12px;background:#fee;border:2px solid #c33;border-radius:8px;margin-bottom:16px;">
          <strong>🌐 Global Pause กำลังเปิด</strong> · ${globalPause.reason}<br/>
          ⏰ ถึง: ${expiryR}<br/>
          <a href="/admin/resume-all?token=${encodeURIComponent(adminToken)}" style="display:inline-block;margin-top:8px;padding:8px 14px;background:#0a7;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">▶️ Resume All</a>
        </div>`
      : `<div style="padding:12px;background:#efe;border:1px solid #0a7;border-radius:8px;margin-bottom:16px;">
          ✅ AI ตอบปกติ
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;">
            <a href="/admin/pause-all?token=${encodeURIComponent(adminToken)}&minutes=720" style="padding:6px 12px;background:#c33;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">⏸ Pause All 12 ชม.</a>
            <a href="/admin/pause-all?token=${encodeURIComponent(adminToken)}&minutes=0&reason=global_permanent_pause" style="padding:6px 12px;background:#900;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">🔒 Pause All ถาวร</a>
          </div>
        </div>`;
    return res.type("html").send(`<html><head>${meta.viewport}</head>
      <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;max-width:600px;">
        <h1>Admin Resume</h1>
        ${globalBanner}
        <p><a href="/admin/take-action?token=${encodeURIComponent(adminToken)}">← กลับไปหน้า Take Action</a></p>
        <ul style="list-style:none;padding:0;">${rows || "<li>ไม่มีลูกค้าที่ pause อยู่</li>"}</ul>
      </body></html>`);
  }

  const existed = pausedSessions.has(sessionKey);
  pausedSessions.delete(sessionKey);
  await persistPauseToWebhook({
    sessionKey,
    customerId: sessionKey,
    minutes: 0,
    reason: "admin_resumed",
    status: "resumed",
  });
  pauseSheetCache = { expiresAt: 0, rows: [] };
  res.type("html").send(`<html><head>${meta.viewport}</head>
    <body style="font-family:-apple-system,sans-serif;line-height:1.5;padding:16px;">
      <h1>${existed ? "✅ Resumed" : "ℹ️ ไม่พบ pause"}</h1>
      <p><code>${sessionKey}</code></p>
      <p>${existed ? "AI กลับมาตอบลูกค้าคนนี้แล้ว" : "ลูกค้านี้ไม่ได้ถูก pause อยู่"}</p>
      <p><a href="/admin/resume?token=${encodeURIComponent(adminToken)}">← ดูรายการ pause ทั้งหมด</a></p>
    </body></html>`);
});

app.post("/dialogflow-webhook", async (req, res) => {
  const queryResult = req.body?.queryResult || {};
  const customerText = queryResult.queryText || "";
  const intentName = queryResult.intent?.displayName || "";
  const sessionKey = getSessionKey(req);
  const dialogflowSession = getDialogflowSession(req);
  await hydrateMemoryFromRedis(sessionKey);
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

  rememberSession({
    sessionKey,
    dialogflowSession,
    customerText,
    intentName,
    memory,
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
    updateRecentMessages(memory, customerText, answer, sessionKey);
    return res.json(dialogflowText(answer));
  }

  if (includesPurchaseQuestion(customerText)) {
    const answer = buildPurchasePauseReply(customerText, shouldGreetToday);
    const minutes = 120;
    const expiresAt = Date.now() + minutes * 60 * 1000;

    pausedSessions.set(sessionKey, {
      expiresAt,
      reason: "purchase_or_sales_inquiry",
    });

    await persistPauseToWebhook({
      sessionKey,
      customerId: sessionKey,
      minutes,
      reason: "purchase_or_sales_inquiry",
    });

    memory.greetedDate = today.dateKey;
    updateRecentMessages(memory, customerText, answer, sessionKey);
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

  if (!customerText.trim()) {
    return res.json(dialogflowText("ขอรายละเอียดเพิ่มเติมนิดนึงนะคะ"));
  }

  try {
    const answerBlocks = [];
    const shouldGreetForNextBlock = () => shouldGreetToday && answerBlocks.length === 0;

    const promotionAnswer = buildPromotionAnswer(customerText, shouldGreetForNextBlock());
    if (promotionAnswer) {
      answerBlocks.push(promotionAnswer);
    }

    const gameplayHowToAnswer = buildGameplayHowToAnswer(customerText, shouldGreetForNextBlock());
    if (gameplayHowToAnswer) {
      answerBlocks.push(gameplayHowToAnswer);
      const minutes = 120;
      pausedSessions.set(sessionKey, {
        expiresAt: Date.now() + minutes * 60 * 1000,
        reason: "gameplay_howto_handoff",
      });
      await persistPauseToWebhook({
        sessionKey,
        customerId: sessionKey,
        minutes,
        reason: "gameplay_howto_handoff",
      });
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const pendingNextDateAnswer = await buildPendingNextDateAnswer(customerText, memory, shouldGreetForNextBlock());
    if (pendingNextDateAnswer) {
      answerBlocks.push(pendingNextDateAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const noContractReissue = await buildNoContractReissueAnswer(customerText, memory, shouldGreetForNextBlock());
    if (noContractReissue) {
      answerBlocks.push(noContractReissue);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const noContractConfirm = await buildNoContractConfirmAnswer(customerText, memory, shouldGreetForNextBlock());
    if (noContractConfirm) {
      answerBlocks.push(noContractConfirm);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const rentNowAnswer = buildRentNowAnswer(customerText, shouldGreetForNextBlock());
    if (rentNowAnswer) {
      answerBlocks.push(rentNowAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const availabilityAnswer = await buildAvailabilityAnswer(customerText, memory, shouldGreetForNextBlock());
    if (availabilityAnswer) {
      answerBlocks.push(availabilityAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const outOfAreaAnswer = buildOutOfAreaAnswer(customerText, shouldGreetForNextBlock());
    if (outOfAreaAnswer) {
      answerBlocks.push(outOfAreaAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const paymentSlipAnswer = buildPaymentSlipAnswer(customerText, shouldGreetForNextBlock());
    if (paymentSlipAnswer) {
      answerBlocks.push(paymentSlipAnswer);
      const minutes = 120;
      pausedSessions.set(sessionKey, {
        expiresAt: Date.now() + minutes * 60 * 1000,
        reason: "payment_slip_handoff",
      });
      await persistPauseToWebhook({
        sessionKey,
        customerId: sessionKey,
        minutes,
        reason: "payment_slip_handoff",
      });
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const includedGamesAnswer = buildIncludedGamesAnswer(customerText, memory, shouldGreetForNextBlock());
    if (includedGamesAnswer) {
      answerBlocks.push(includedGamesAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const accountAnswer = buildAccountRentalAnswer(customerText, shouldGreetForNextBlock());
    if (accountAnswer) {
      answerBlocks.push(accountAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const ambiguousToken = detectAmbiguousDevice(customerText);
    const ambiguousConflictsWithMemory =
      ambiguousToken && memory.lastDevice && !ambiguousTokenMatchesDevice(ambiguousToken, memory.lastDevice);
    if (ambiguousConflictsWithMemory) {
      memory.lastDevice = "";
      memory.lastRentalDays = null;
      memory.lastStartDate = "";
      memory.lastReturnDate = "";
    }
    if (
      ambiguousToken &&
      (ambiguousConflictsWithMemory || !memory.lastDevice) &&
      (includesPriceQuestion(customerText, memory) ||
        includesLongTermRentalQuestion(customerText) ||
        /เช่า|rent/i.test(customerText))
    ) {
      answerBlocks.push(
        buildAmbiguousDeviceAnswer(ambiguousToken, isEnglishText(customerText), shouldGreetForNextBlock()),
      );
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const businessAnswer = buildBusinessRentalAnswer(customerText, memory, shouldGreetForNextBlock());
    if (businessAnswer) {
      answerBlocks.push(businessAnswer);
    }

    const depositRefundAnswer = buildDepositRefundAnswer(customerText, shouldGreetForNextBlock());
    if (depositRefundAnswer) {
      answerBlocks.push(depositRefundAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const gameSelectionAnswer = buildGameSelectionAnswer(customerText, memory, shouldGreetForNextBlock());
    if (gameSelectionAnswer) {
      answerBlocks.push(gameSelectionAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const contractDocAnswer = buildContractDocAnswer(customerText, memory, shouldGreetForNextBlock());
    if (contractDocAnswer) {
      answerBlocks.push(contractDocAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const generalRentalAnswer = buildGeneralRentalInfoAnswer(customerText, memory, shouldGreetForNextBlock());
    if (generalRentalAnswer) {
      answerBlocks.push(generalRentalAnswer);
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    const termsAnswer = buildTermsAnswer(customerText, shouldGreetForNextBlock());
    if (termsAnswer) {
      answerBlocks.push(termsAnswer);
    }

    if (!businessAnswer) {
      // Reset monthly preference if customer explicitly asks for short-term (daily/weekly)
      if (/รายวัน|รายสัปดาห์|daily|weekly|per day|per week/.test(normalizeSearchText(customerText))) {
        memory.preferMonthly = false;
      }
      // Route summary requests back to monthly when the conversation is in a monthly context
      const monthlyContextSummary =
        memory.preferMonthly &&
        !includesLongTermRentalQuestion(customerText) &&
        includesSummaryRequest(customerText) &&
        !extractRentalDays(customerText);
      const longTermAnswer = buildLongTermRentalAnswer(
        customerText,
        memory,
        shouldGreetForNextBlock(),
        monthlyContextSummary,
      );
      if (longTermAnswer) {
        answerBlocks.push(longTermAnswer);
      }

      const returnAnswer = buildReturnAnswer(customerText, shouldGreetForNextBlock());
      if (returnAnswer) {
        answerBlocks.push(returnAnswer);
      }

      const extensionAnswer = buildExtensionAnswer(customerText, memory, shouldGreetForNextBlock());
      if (extensionAnswer) {
        answerBlocks.push(extensionAnswer);
      }

      if (!longTermAnswer && !returnAnswer && !extensionAnswer) {
        const summaryBefore = memory.summarySent;
        const priceAnswer = await buildPriceAnswer(customerText, memory, shouldGreetForNextBlock());
        if (priceAnswer) {
          answerBlocks.push(priceAnswer);
          if (!summaryBefore && memory.summarySent) {
            notifyEvent("booking_summary", {
              sessionKey,
              device: memory.lastDevice,
              days: memory.lastRentalDays,
              startDate: memory.lastStartDate,
            });
          }
        }
      }

      if (!longTermAnswer && !returnAnswer && !extensionAnswer) {
        const useLastGameQuery = shouldUseLastGameQuery(customerText, memory);
        const gameLookupText = useLastGameQuery ? memory.lastGameQuery : customerText;
        try {
          const gameSummary = await lookupGameSummary(gameLookupText, {
            force: useLastGameQuery,
          });
          const notFound = gameSummary.includes("ไม่พบชื่อเกม");
          if (notFound) {
            const english = isEnglishText(customerText);
            const handoff = english
              ? "🙏 One moment, admin will check this for you shortly 😊"
              : "🙏 สักครู่จะมีแอดมินเข้ามาช่วยเช็คให้นะครับ 😊";
            answerBlocks.push(handoff);
            const minutes = 120;
            pausedSessions.set(sessionKey, {
              expiresAt: Date.now() + minutes * 60 * 1000,
              reason: "game_not_found_handoff",
            });
            await persistPauseToWebhook({
              sessionKey,
              customerId: sessionKey,
              minutes,
              reason: "game_not_found_handoff",
            });
          } else {
            const gameAnswer = buildGameAnswerFromSummary(customerText, gameSummary, shouldGreetForNextBlock());
            if (gameAnswer) {
              const extractedGame = extractGameQueryFromSummary(gameSummary);
              if (extractedGame) {
                memory.lastGameQuery = extractedGame;
              }
              answerBlocks.push(gameAnswer);
            }
          }
        } catch (error) {
          console.error("Game lookup failed:", error);
          const gameErrorAnswer = buildGameLookupUnavailableAnswer(customerText, shouldGreetForNextBlock());
          if (gameErrorAnswer) {
            answerBlocks.push(gameErrorAnswer);
          }
        }
      }
    }

    if (answerBlocks.length > 0) {
      const answer = answerBlocks.join("\n\n");
      memory.greetedDate = today.dateKey;
      updateRecentMessages(memory, customerText, answer, sessionKey);
      return res.json(dialogflowText(answer));
    }

    if (!isFallbackIntent(intentName) && queryResult.fulfillmentText) {
      return res.json(dialogflowText(queryResult.fulfillmentText));
    }

    const sessionContext = [
      `todayDateBangkok=${today.display}`,
      `todayWeekday=${today.weekday}`,
      `shouldGreetToday=${shouldGreetToday}`,
      `lastDevice=${memory.lastDevice || "none"}`,
      `lastGameQuery=${memory.lastGameQuery || "none"}`,
      `recentMessages=${JSON.stringify(memory.lastMessages)}`,
    ].join("\n");

    notifyEvent("intent_miss", { sessionKey, customerText });
    const answer = await askAI(customerText, memory, sessionContext);
    memory.greetedDate = today.dateKey;
    updateRecentMessages(memory, customerText, answer, sessionKey);
    return res.json(dialogflowText(answer));
  } catch (error) {
    console.error("AI fallback failed:", error);
    return res.json(dialogflowText("ขออภัยค่ะ ขอส่งต่อให้แอดมินช่วยตรวจสอบให้นะคะ"));
  }
});

await loadKnowledgeBase();
await hydrateGlobalPauseFromRedis();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Dialogflow AI fallback webhook is running on port ${port}`);
});
