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
   - `OPENAI_MODEL` = `gpt-5.2`
   - `AI_TIMEOUT_MS` = `4200`
   - `INVENTORY_SHEET_ID` = `13QZWpd_E-L_0G_Xd0zSL5_OcgV4sdwk9febXZSkZepc`
   - `INVENTORY_GID` = `1879984026`
   - `INVENTORY_CACHE_MS` = `60000`
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
