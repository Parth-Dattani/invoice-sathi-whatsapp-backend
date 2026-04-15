# Vercel WhatsApp Backend (Twilio)

This is a minimal Vercel Serverless API used by the Flutter app to **auto-send WhatsApp invoice links**.

## Endpoint

- `POST /api/whatsapp/send-invoice`

Request JSON:

```json
{
  "toPhoneE164": "+916355439872",
  "invoiceNo": "INV0041",
  "amount": 1890.0,
  "driveUrl": "https://drive.google.com/uc?export=download&id=...",
  "customerName": "Hardik",
  "companyName": "Jalaram Traders"
}
```

Headers (optional):

- `x-api-key: <WHATSAPP_DIRECT_SHARE_KEY>`

## Vercel deploy

1. Create a new project in Vercel.
2. **Root Directory**: `vercel-whatsapp-backend`
3. Add Environment Variables:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_WHATSAPP_FROM` (example: `whatsapp:+14155238886`)
   - `WHATSAPP_DIRECT_SHARE_KEY` (optional but recommended)
4. Deploy.

## Connect Flutter app

In Firestore:

`users/{uid}/companies/{companyId}`

Set:

- `whatsappDirectShareUrl` = `https://<your-vercel-domain>/api/whatsapp/send-invoice`
- `whatsappDirectShareKey` = same as `WHATSAPP_DIRECT_SHARE_KEY` (if you set it)

