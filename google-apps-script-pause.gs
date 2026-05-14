const ADMIN_TOKEN = "CHANGE_THIS_TO_THE_SAME_ADMIN_TOKEN_AS_RENDER";
const SHEET_NAME = "AI Pause";
const RENDER_BASE_URL = "https://your-render-service.onrender.com";
const DEFAULT_PAUSE_MINUTES = 720;

function pauseFromAdminReply(sessionKey, customerId) {
  if (!sessionKey) return;
  const payload = {
    sessionKey: sessionKey,
    customerId: customerId || sessionKey,
    minutes: DEFAULT_PAUSE_MINUTES,
    reason: "admin_reply_detected",
  };
  UrlFetchApp.fetch(RENDER_BASE_URL + "/admin/admin-reply", {
    method: "post",
    contentType: "application/json",
    headers: { "x-admin-token": ADMIN_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || "{}");

  if (body.token !== ADMIN_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  ensureHeader(sheet);

  sheet.appendRow([
    body.createdAt || new Date().toISOString(),
    body.sessionKey || "",
    body.customerId || "",
    body.status || "paused",
    body.pausedUntil || "",
    body.reason || "",
  ]);

  return json({ ok: true });
}

function ensureHeader(sheet) {
  const header = ["CreatedAt", "SessionKey", "CustomerId", "Status", "PausedUntil", "Reason"];
  const range = sheet.getRange(1, 1, 1, header.length);
  const values = range.getValues()[0];

  if (values.join("") === "") {
    range.setValues([header]);
    sheet.setFrozenRows(1);
  }
}

function json(payload, statusCode) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
