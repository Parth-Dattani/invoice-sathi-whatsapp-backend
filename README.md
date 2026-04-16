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
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — required for `send-invoice` + Drive routes (service account JSON string)
   - `WHATSAPP_DIRECT_SHARE_KEY` (optional but recommended)
   - **Google Drive nightly cleanup (optional but required for auto PDF delete):**
     - `GOOGLE_OAUTH_WEB_CLIENT_ID` — same value as Flutter `AppConstants.googleWebClientId`
     - `GOOGLE_OAUTH_WEB_CLIENT_SECRET` — Web OAuth client **secret** (Google Cloud Console → Credentials)
     - `CRON_SECRET` — long random string (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`)
4. Deploy.

## Connect Flutter app

In Firestore:

`users/{uid}/companies/{companyId}`

Set:

- `whatsappDirectShareUrl` = `https://<your-vercel-domain>/api/whatsapp/send-invoice`
- `whatsappDirectShareKey` = same as `WHATSAPP_DIRECT_SHARE_KEY` (if you set it)

---

## Google Drive auto PDF delete (nightly)

1. **`POST /api/google/store-drive-refresh`** — After **Google sign-in on Android**, Flutter sends `serverAuthCode`; this route exchanges it for a **refresh token** and saves `users/{uid}.googleDriveRefreshToken` (Admin SDK).
2. **`GET /api/cron/cleanup-drive-pdfs`** — Vercel Cron (see `vercel.json`, default **18:30 UTC ≈ 00:00 IST**) trashes all **PDF** files in each user’s `pdfFolderId` (and each `users/{uid}/companies/*` `pdfFolderId` if set).

### User requirements

- User must **Sign in with Google** once (Android) so `serverAuthCode` is registered.
- Firestore must have `pdfFolderId` (your app already sets this).

### Security

Do **not** allow clients to **read** `googleDriveRefreshToken` in Firestore rules.

### Cron on Vercel

Cron jobs may require a **paid** Vercel plan depending on your account. If cron does not run, check the Vercel dashboard.