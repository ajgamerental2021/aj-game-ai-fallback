# LINE OA + Dialogflow ES + AI Fallback บน Render

โปรเจกต์นี้คือ webhook สำหรับ `Default Fallback Intent` ของ Dialogflow ES

เมื่อลูกค้าพิมพ์ใน LINE OA แล้ว Dialogflow จับ intent เดิมไม่ได้ ระบบจะส่งข้อความเข้า OpenAI แล้วตอบกลับผ่าน Dialogflow ไปยัง LINE OA

## 1. แก้ข้อมูลร้าน

เปิด `knowledge-base.md` แล้วใส่ข้อมูลจริง เช่น:

- เวลาทำการ
- วิธีสั่งซื้อ
- ราคา/แพ็กเกจ ถ้าต้องการให้ AI ตอบ
- ค่าจัดส่ง
- วิธีชำระเงิน
- เงื่อนไขเปลี่ยน/คืนสินค้า
- เรื่องที่ต้องส่งต่อแอดมิน

อย่าใส่ข้อมูลที่ไม่อยากให้ AI ตอบลูกค้า

## 2. เอาขึ้น GitHub

Render deploy ง่ายที่สุดจาก GitHub

```bash
git init
git add .
git commit -m "Add Dialogflow AI fallback webhook"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

## 3. Deploy บน Render

1. เข้า Render
2. กด `New +`
3. เลือก `Web Service`
4. Connect GitHub repo นี้
5. ตั้งค่า:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
6. เพิ่ม Environment Variables:
   - `OPENAI_API_KEY` = API key ของคุณ
   - `OPENAI_MODEL` = `gpt-4o` (default ใหม่ ฉลาดขึ้น ถ้าอยากประหยัดใช้ `gpt-4o-mini`)
   - `AI_TIMEOUT_MS` = `3500`
   - `INVENTORY_SHEET_ID` = `13QZWpd_E-L_0G_Xd0zSL5_OcgV4sdwk9febXZSkZepc`
   - `INVENTORY_GID` = `1879984026`
   - `INVENTORY_CACHE_MS` = `60000`
   - `INVENTORY_FETCH_TIMEOUT_MS` = `3000`
   - `GAME_DATA_URL` = `https://gist.github.com/ajgamerental2021/4c37e6a92859ce10f353d2ccb1ecbabd/raw/b5ae091ddb5cd977f68ca6c447c7f8a2afde46df/ajgame-data.json`
   - `GAME_DATA_CACHE_MS` = `300000`
   - `GAME_DATA_FETCH_TIMEOUT_MS` = `3000`
   - `ADMIN_TOKEN` = ตั้งเป็นรหัสยาว ๆ เอง ใช้สำหรับ pause AI รายลูกค้า
   - `PAUSED_REPLY_TEXT` = เว้นว่างไว้ถ้าต้องการให้ AI เงียบตอน pause
   - `PAUSE_SHEET_ID` = Google Sheet ID ที่ใช้เก็บ pause
   - `PAUSE_SHEET_GID` = gid ของ worksheet `AI Pause` ถ้าต้องการให้ server อ่าน pause จากชีต
   - `PAUSE_SHEET_CACHE_MS` = `30000`
   - `PAUSE_SHEET_FETCH_TIMEOUT_MS` = `3000`
   - `PAUSE_WEBHOOK_URL` = URL ของ Google Apps Script Web App สำหรับบันทึก pause ลงชีต
7. กด Deploy

หลัง deploy เสร็จ Render จะให้ URL ประมาณนี้:

```text
https://your-service-name.onrender.com
```

Webhook URL ที่ต้องใช้คือ:

```text
https://your-service-name.onrender.com/dialogflow-webhook
```

เช็คว่าสต็อกดึงจาก Google Sheet ได้ไหม เปิด:

```text
https://your-service-name.onrender.com/inventory
```

ระบบจะอ่าน worksheet `Inventory` จาก Google Sheet โดยใช้คอลัมน์ `Device Name` และ `Status` ถ้า Device Name เดียวกันมีหลายแถว และมีแถวใดแถวหนึ่งเป็น `Available` จะถือว่าเครื่องรุ่นนั้นว่าง

เช็ค config แบบไม่เปิดเผย API key ได้ที่:

```text
https://your-service-name.onrender.com/debug
```

ควรเห็น `hasOpenAIKey: true` และ `model: "gpt-4o"`

เช็คเกมจาก Gist ได้ที่:

```text
https://your-service-name.onrender.com/games/search?q=elden ring
```

ถ้าเจอเกม ระบบจะบอกว่าเกมนั้นอยู่บนเครื่อง/แพลตฟอร์มไหน

## 4. ตั้งค่า Dialogflow ES

1. เข้า Dialogflow ES Console
2. เลือก Agent ที่ต่อกับ LINE OA อยู่
3. ไปที่ `Fulfillment`
4. เปิด `Webhook`
5. ใส่ URL:

```text
https://your-service-name.onrender.com/dialogflow-webhook
```

6. กด `Save`
7. ไปที่ `Intents`
8. เปิด `Default Fallback Intent`
9. เลื่อนลงไปที่ `Fulfillment`
10. เปิด `Enable webhook call for this intent`
11. กด `Save`

## 5. ทดสอบ

ทัก LINE OA ด้วยประโยคที่ Dialogflow ไม่เคยสอน เช่น:

```text
ส่งไปเชียงใหม่กี่วัน
```

ถ้าข้อมูลอยู่ใน `knowledge-base.md` ระบบควรตอบได้เอง

## 6. ถ้าไม่ตอบ

เช็กตามลำดับ:

1. Render service เปิดอยู่ไหม
2. เปิด URL `/` แล้วเห็น `ok: true` ไหม
3. ใส่ `OPENAI_API_KEY` ใน Render แล้วหรือยัง
4. Dialogflow Fulfillment URL ถูกไหม
5. เปิด webhook ใน `Default Fallback Intent` แล้วหรือยัง
6. ดู Logs ใน Render ว่ามี error อะไร
7. ถ้าถามสต็อกแล้วตอบไม่ได้ ให้เปิด `/inventory` เพื่อเช็คว่า Google Sheet ยัง publish/export ได้อยู่ไหม

## 7. หมายเหตุเรื่อง Render Free

ถ้าใช้ Render free plan ตัว service อาจ sleep เมื่อไม่มีคนใช้ ช่วงแรกของการทักหลัง sleep อาจตอบช้าและ Dialogflow อาจ timeout ได้ ถ้าใช้งานจริงควรใช้ paid instance หรือ hosting ที่ไม่ sleep

## 8. Cron Job สำหรับปลุก Render

โปรเจกต์นี้มีสคริปต์ `npm run ping` สำหรับให้ Render Cron Job เรียก URL ของ web service เป็นระยะ

ถ้าใช้ `render.yaml` แบบ Blueprint จะมี service ชื่อ:

```text
line-dialogflow-ai-fallback-ping
```

ให้ตั้ง Environment Variable ของ cron job:

```text
PING_URL=https://your-service-name.onrender.com/
```

schedule ตั้งไว้เป็น:

```text
*/10 * * * *
```

หมายถึง ping ทุก 10 นาที

หมายเหตุ: Render Cron Job มีค่าใช้จ่ายขั้นต่ำต่อ cron job service ตามเงื่อนไขของ Render และการ ping ตลอดเวลาจะทำให้ Free web service ใช้ free instance hours ต่อเนื่อง

## 9. Admin Take Action / Human Handoff

ถ้าแอดมินต้องการเข้ามาคุยเองและไม่ให้ AI ตอบ มี 3 วิธีที่แนะนำ:

### วิธีที่ 1: ทำ intent ส่งต่อแอดมินใน Dialogflow

สร้าง intent เช่น:

```text
Human Handoff
```

ใส่ training phrases เช่น:

```text
ขอคุยกับแอดมิน
แอดมินอยู่ไหม
ติดต่อพนักงาน
คุยกับคนจริง
```

ตั้ง response เป็น:

```text
แอดมินจะเข้ามาดูแลให้นะครับ
```

ไม่ต้องเปิด webhook ใน intent นี้

### วิธีที่ 2: ตอนแอดมินกำลังคุย ให้ปิด webhook เฉพาะ intent ที่ไม่อยากให้ AI ตอบ

เหมาะกับช่วงทดลองระบบ แต่ไม่สะดวกถ้าต้องทำบ่อย

### วิธีที่ 3: ระบบ pause รายลูกค้า

เวอร์ชันนี้มีระบบ pause รายลูกค้า 2 ชั้น:

1. pause ใน memory ใช้ได้ทันที
2. pause ผ่าน Google Sheet ใช้เก็บและเช็คสถานะจากชีต

ข้อควรรู้:

- ถ้า Render restart/deploy ใหม่ รายการ pause จะหาย
- ถ้าตั้ง Google Sheet pause แล้ว รายการ pause จะถูกเก็บในชีตด้วย
- ตอน pause ถ้า `PAUSED_REPLY_TEXT` ว่าง ระบบจะไม่ส่งข้อความตอบกลับ เพื่อให้แอดมินตอบเอง

ก่อนใช้ ให้ตั้ง env:

```text
ADMIN_TOKEN=ตั้งรหัสลับยาวๆเอง
PAUSED_REPLY_TEXT=
DEFAULT_PAUSE_MINUTES=720
```

### ตั้ง Google Sheet Pause

สร้าง worksheet ชื่อ:

```text
AI Pause
```

หัวตารางแถวแรก:

```text
CreatedAt | SessionKey | CustomerId | Status | PausedUntil | Reason
```

ค่า `Status` ที่ถือว่า pause:

```text
paused
active
true
yes
```

ถ้าจะให้ server อ่าน pause จากชีต ให้ publish/export worksheet นี้ได้เหมือน Inventory แล้วใส่ env:

```text
PAUSE_SHEET_ID=Google Sheet ID
PAUSE_SHEET_GID=gid ของ worksheet AI Pause
```

### ตั้ง Google Apps Script เพื่อบันทึก pause ลงชีต

ใน repo มีไฟล์:

```text
google-apps-script-pause.gs
```

ให้เปิด Google Sheet → Extensions → Apps Script แล้ววางโค้ดนี้

แก้บรรทัด:

```js
const ADMIN_TOKEN = "CHANGE_THIS_TO_THE_SAME_ADMIN_TOKEN_AS_RENDER";
```

ให้เป็นรหัสเดียวกับ `ADMIN_TOKEN` ใน Render

จากนั้น Deploy → New deployment → Web app:

```text
Execute as: Me
Who has access: Anyone
```

เอา Web App URL มาใส่ใน Render:

```text
PAUSE_WEBHOOK_URL=https://script.google.com/macros/s/xxxxx/exec
```

เมื่อ AI auto-pause เพราะลูกค้าพิมพ์หาแอดมิน ระบบจะยิง URL นี้เพื่อเพิ่มแถวใน Google Sheet ให้อัตโนมัติ

หา `sessionKey` ได้จาก Render Logs หลังลูกค้าทักมา จะมีบรรทัด:

```text
Dialogflow webhook: { sessionKey: "...", ... }
```

### วิธีใช้ง่ายสุดสำหรับ Admin Take Action

เปิดลิงก์นี้ใน browser แล้ว bookmark ไว้:

```text
https://your-service-name.onrender.com/admin/take-action?token=YOUR_ADMIN_TOKEN
```

เมื่อลูกค้าทักเข้ามา server จะจำ session ล่าสุดไว้ให้ในหน้านี้

ถ้าแอดมินต้องการคุยเอง:

1. เปิดลิงก์ `Admin Take Action`
2. กด `Take action / Pause` ที่ลูกค้าคนนั้น
3. AI จะหยุดตอบลูกค้าคนนั้นทันทีตามเวลาที่ตั้งใน `DEFAULT_PAUSE_MINUTES`
4. ถ้าตั้ง `PAUSE_WEBHOOK_URL` แล้ว ระบบจะบันทึก pause ลง Google Sheet ด้วย

ข้อจำกัดสำคัญ:

- LINE OA / Dialogflow webhook ไม่ส่งข้อความที่แอดมินพิมพ์ออกไปหา server
- ดังนั้น server จะไม่รู้เองว่าแอดมินกดตอบในแอป LINE OA แล้ว
- วิธีที่ใช้งานได้จริงคือต้องกด `Take action / Pause` ก่อนหรือทันทีที่แอดมินเริ่มคุย

ดู session ล่าสุดแบบ JSON:

```text
https://your-service-name.onrender.com/admin/recent-sessions?token=YOUR_ADMIN_TOKEN
```

สั่ง pause 60 นาที:

```bash
curl -X POST "https://your-service-name.onrender.com/admin/pause" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -d '{"sessionKey":"SESSION_KEY_FROM_LOGS","minutes":60,"reason":"admin_takeover"}'
```

ดูรายการที่ pause อยู่:

```bash
curl "https://your-service-name.onrender.com/admin/pauses" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

ปลด pause:

```bash
curl -X POST "https://your-service-name.onrender.com/admin/resume" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -d '{"sessionKey":"SESSION_KEY_FROM_LOGS"}'
```

ถ้าต้องการให้ตอน pause มีข้อความแจ้งลูกค้า ให้ตั้ง:

```text
PAUSED_REPLY_TEXT=แอดมินกำลังเข้ามาดูแลให้นะครับ
```

### Auto Pause ทันทีตอนแอดมินตอบใน LINE OA (ใหม่)

เพิ่ม endpoint:

```text
POST https://your-service-name.onrender.com/admin/admin-reply
```

ใช้สำหรับให้ระบบภายนอก (Make.com / Apps Script / LINE Webhook Relay) เรียกเข้ามาทุกครั้งที่ตรวจจับว่าแอดมินพิมพ์ตอบลูกค้าใน LINE OA → AI จะ pause ลูกค้ารายนั้นทันที (default `DEFAULT_PAUSE_MINUTES` = 720 นาที = 12 ชม.)

ตัวอย่าง payload:

```json
{
  "sessionKey": "LINE_USER_ID_ของลูกค้า",
  "customerId": "LINE_USER_ID_ของลูกค้า",
  "minutes": 720,
  "reason": "admin_reply_detected"
}
```

Header ที่ต้องส่ง: `x-admin-token: YOUR_ADMIN_TOKEN`

ในไฟล์ `google-apps-script-pause.gs` มี helper `pauseFromAdminReply(sessionKey, customerId)` ให้เรียกใช้จาก Apps Script trigger ของ LINE OA Manager หรือ Make.com flow

ตั้งค่าใน Apps Script:

```js
const RENDER_BASE_URL = "https://your-render-service.onrender.com";
```

วิธีต่อกับ LINE OA จริง (เลือก 1 ใน 3):

1. **LINE Messaging API webhook** — ถ้าใช้ LINE Messaging API ตรง ๆ ให้ relay เหตุการณ์ที่ source.type = `user` แต่ message.sentBy เป็น admin/operator → ยิงเข้า `/admin/admin-reply`
2. **Make.com / Zapier** — สร้าง scenario: trigger `LINE - Watch Operator Messages` → action `HTTP POST` ไปที่ `/admin/admin-reply`
3. **Apps Script Time Trigger** — ดึง Chat History API ของ LINE OA Manager (ถ้าเข้าถึงได้) ทุก 1 นาที แล้วเรียก `pauseFromAdminReply()` เมื่อเจอ outgoing message ที่ไม่ใช่จาก bot

ข้อจำกัด: LINE OA Manager Web UI ไม่มี webhook อย่างเป็นทางการสำหรับ outgoing admin message ต้องใช้ Messaging API หรือ third-party relay

### Auto Pause จากคำว่าแอดมิน/คนจริง

ถ้าลูกค้าพิมพ์ข้อความที่มีคำประมาณนี้:

```text
แอดมิน
ขอคุยกับคนจริง
ติดต่อพนักงาน
admin
human
staff
agent
```

ระบบจะตอบ:

```text
แอดมินจะเข้ามาดูแลให้นะครับ
```

แล้ว pause AI ของลูกค้าคนนั้นทันทีประมาณ 120 นาที

## 10. สรุปอัพเดทล่าสุด

### Stack ปัจจุบัน

- **Render Web Service** = endpoint webhook (`/dialogflow-webhook`, `/admin/*`)
- **GitHub** = source code repo, Render auto-deploy ตอน push main
- **Google Sheet** = inventory + pause status
- **Gist** = ข้อมูลเกม (`ajgame-data.json`)
- **Google Apps Script** = บันทึก pause ลงชีต + relay admin-reply event
- **Dialogflow ES** = NLU จับ intent + ส่ง fallback มา webhook
- **LINE OA** = ช่องทางคุยกับลูกค้า

### ฟีเจอร์ที่เพิ่ม/แก้

- **AI model default `gpt-4o`** ฉลาดขึ้น (เปลี่ยน env `OPENAI_MODEL` ได้)
- **จับ keyword ได้ดีขึ้น** — normalize รูปแปร `มั๊ย/ม้าย/ใหม`, `เท่าไร/เท่าไหร่`, ตัด `ครัช/คับ/ๆ`
- **Alias เครื่องใหม่** — `xbox x`, `xbox sx`, `xbox s`, `xbox ss`, `ps 5`, `เพลย์สเตชั่น 5`, `psportal`, `วีอาร์2` ฯลฯ
- **Ambiguous device handler** — พิมพ์ `xbox` เปล่า ๆ จะถามว่า Series X หรือ S พร้อมเรทเทียบ
- **เช่าไอดีเกม PS5** — จับคำ `ไอดี/account/psn` แยกออกจากเช่าเครื่อง ส่งลิงก์ `ajgameid`
- **เช่ารายเดือน** — จับ `หลายเดือน/รายเดือน/เดือน` ไม่ปนกับ game lookup
- **เงื่อนไข/ข้อกำหนด** — มี `buildTermsAnswer` block ตอบเงื่อนไขเช่าโดยตรง
- **สรุปอัตโนมัติ** — เมื่อลูกค้าให้ทั้งจำนวนวัน + วันเริ่ม → ตอบยอดรวม + วันเริ่ม/วันคืน + เลขบัญชี + ลิงก์สัญญา ทันที (Thai/English ตามภาษาลูกค้า)
- **Memory ข้ามข้อความ** — `lastDevice`, `lastRentalDays`, `lastStartDate` ใช้ต่อกรณีลูกค้าทยอยส่งข้อมูล
- **Layout/Emoji** — ตัด blank line ซ้อน, ใส่ emoji หลากหลายทุกหัวข้อ
- **Endpoint ใหม่** `/admin/admin-reply` สำหรับ auto-pause ตอนแอดมินตอบ

## 11. ทำอะไรต่อให้ใช้งานได้จริง (Checklist)

1. **Push code ใหม่ขึ้น GitHub**
   ```bash
   git add server.js google-apps-script-pause.gs README_TH.md knowledge-base.md
   git commit -m "Smart keyword matching, account rental, auto-pause endpoint"
   git push origin main
   ```
2. **Render auto-deploy** — รอ build เสร็จ ~2 นาที
3. **ตั้ง env ใหม่บน Render** (ถ้าอยากใช้ `gpt-4o`)
   - แก้ `OPENAI_MODEL` = `gpt-4o`
   - กด `Manual Deploy` → `Clear cache & deploy` ถ้าจำเป็น
4. **ตรวจ health**
   - เปิด `https://your-service-name.onrender.com/` → `ok: true`
   - เปิด `https://your-service-name.onrender.com/debug` → `model: "gpt-4o"`
5. **อัพเดท Google Apps Script**
   - เปิด Sheet `AI Pause` → Extensions → Apps Script
   - แทนที่โค้ดด้วย `google-apps-script-pause.gs` ใหม่
   - แก้ `RENDER_BASE_URL` ให้ตรงกับ Render URL จริง
   - แก้ `ADMIN_TOKEN` ให้ตรงกับ env Render
   - กด `Deploy` → `Manage deployments` → แก้ version ปัจจุบัน → `Deploy`
6. **เชื่อม Auto-pause กับ LINE OA** (เลือก 1)
   - **ง่ายสุด**: ใช้ Make.com — Trigger `LINE OA - New Message from Operator` → HTTP POST → `/admin/admin-reply` พร้อม header `x-admin-token`
   - หรือใช้ Messaging API webhook ที่ relay event admin → server
7. **ทดสอบลูกค้าจำลอง**
   - ทัก `เช่าไอดี PS5` → ต้องได้ลิงก์ `ajgameid`
   - ทัก `เช่า xbox เท่าไหร่` → ต้องถาม Series X/S พร้อมเรท
   - ทัก `xbox x เช่า 4 วัน เริ่มพรุ่งนี้` → ต้องสรุปยอด + วันคืน + เลขบัญชี
   - ทัก `มีเช่าหลายเดือนมั้ย` → ต้องตอบเรทรายเดือน
   - ให้แอดมินตอบใน LINE OA → AI ต้อง pause ลูกค้าคนนั้นทันที (เช็ค Sheet `AI Pause`)
8. **Monitor**
   - ดู Render Logs หา error
   - ดู Sheet `AI Pause` ว่าเก็บ event ถูก
9. **(Optional) Tune knowledge-base.md** ถ้าเจอคำถามที่ AI ยังตอบไม่ดี — เพิ่ม FAQ ในไฟล์แล้ว push อีกรอบ
