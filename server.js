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

let knowledgeBase = "";
let inventoryCache = {
  expiresAt: 0,
  summary: "",
};

async function loadKnowledgeBase() {
  knowledgeBase = await fs.readFile(new URL("./knowledge-base.md", import.meta.url), "utf8");
}

function dialogflowText(text) {
  return {
    fulfillmentMessages: [
      {
        text: {
          text: [text],
        },
      },
    ],
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

async function askAI(customerText) {
  if (!process.env.OPENAI_API_KEY) {
    return "ขออภัยค่ะ ขอส่งต่อให้แอดมินช่วยตรวจสอบให้นะคะ";
  }

  let inventorySummary = "";

  try {
    inventorySummary = await loadInventorySummary();
  } catch (error) {
    console.error("Inventory lookup failed:", error);
    inventorySummary =
      "ข้อมูลสต็อก: ตอนนี้เช็ค Google Sheet ไม่สำเร็จ ถ้าลูกค้าถามเครื่องว่าง ให้บอกว่าจะให้แอดมินเช็คคิวล่าสุดให้นะคะ";
  }

  const response = await withTimeout(
    openai.responses.create({
      model,
      max_output_tokens: 350,
      instructions: [
        "คุณเป็นแอดมินร้านค้า ตอบเป็นภาษาไทย สุภาพ กระชับ และเป็นธรรมชาติ",
        "ตอบจากข้อมูลร้านที่ให้มาเท่านั้น ห้ามแต่งราคา สต็อก โปรโมชัน หรือเงื่อนไขเอง",
        "ถ้าข้อมูลไม่พอ ให้ถามกลับ 1 คำถามที่จำเป็นที่สุด",
        "ถ้าลูกค้าถามว่าเครื่องรุ่นใดว่างหรือไม่ ให้ใช้ข้อมูลสต็อกจาก Google Sheet ที่แนบมา",
        "ถ้าเครื่องมี Status = Available อย่างน้อย 1 เครื่อง ให้ตอบว่าว่าง แต่ถ้าลูกค้าต้องการจองตามวันที่เฉพาะ ให้แจ้งว่าจะให้แอดมินเช็คคิวและยืนยันอีกครั้ง",
        "ถ้าเป็นเรื่องคืนเงิน เคลม ยกเลิกออเดอร์ ต่อรองพิเศษ หรือข้อร้องเรียน ให้บอกว่าจะส่งต่อแอดมิน",
        "ห้ามพูดถึงว่าเป็น AI หรือระบบอัตโนมัติ เว้นแต่ลูกค้าถามตรง ๆ",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: `ข้อมูลร้าน:\n${knowledgeBase}\n\n${inventorySummary}\n\nข้อความลูกค้า:\n${customerText}`,
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
    aiTimeoutMs,
    inventorySheetId,
    inventoryGid,
    inventoryCacheMs,
    inventoryFetchTimeoutMs,
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

app.post("/dialogflow-webhook", async (req, res) => {
  const queryResult = req.body?.queryResult || {};
  const customerText = queryResult.queryText || "";
  const intentName = queryResult.intent?.displayName || "";

  console.log("Dialogflow webhook:", {
    intentName,
    text: customerText,
    isFallback: isFallbackIntent(intentName),
  });

  if (!isFallbackIntent(intentName)) {
    return res.json(dialogflowText(queryResult.fulfillmentText || "รับทราบค่ะ"));
  }

  if (!customerText.trim()) {
    return res.json(dialogflowText("ขอรายละเอียดเพิ่มเติมนิดนึงนะคะ"));
  }

  try {
    const answer = await askAI(customerText);
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
