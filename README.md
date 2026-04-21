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

**Meta Cloud API — utility template (no 24h session):** on the same company document, under `whatsappCloud`:

- `invoiceTemplateName` (string), e.g. `smartbiz_invoice` — when set, `/api/whatsapp/send-invoice` sends a **template** message instead of a document. Omit or use `""` to keep **document** mode.
- `invoiceTemplateLanguage` (string, optional) — must match the template’s locale in **WhatsApp Manager** (often `en_US` not `en`). If omitted, default is `en`; the server retries several English locales when Meta returns **#132001**.
- `invoiceTemplateLanguageCandidates` (array of strings, optional) — extra locale codes to try first (e.g. `["en","en_GB"]`) if Manager shows a non-default code.
- `invoiceTemplateNamespace` (string, optional) — only if Meta / your BSP requires `template.namespace` on send; usually **omit** for Cloud API + Phone Number ID.
- Requests use `language.policy: "deterministic"` (helps some **#132001** cases).
- `invoiceTemplateBodyParams` (array of strings, optional) — must match your template’s `{{1}}`, `{{2}}`, … order. If omitted, the server sends `[companyName, customerName, invoiceNo, amount]` (4 texts).
- `invoiceTemplateIncludePdfLink` (bool, optional) — if `true`, appends the public PDF URL as a 5th **body** parameter (only when **not** sending a document header). Use when the template has no PDF header but a URL placeholder in the body.
- `invoiceTemplateDocumentHeader` (bool, optional) — if `true`, only send the **document header** (PDF link) + body. If `false`, never send a document header. If omitted, the server **tries document header first**, then retries **body-only** (covers both “Loading PDF…” templates and plain text templates).

---

## Google Drive auto PDF delete (nightly)

1. **`POST /api/google/store-drive-refresh`** — After **Google sign-in on Android**, Flutter sends `serverAuthCode`; this route exchanges it for a **refresh token** and saves `users/{uid}.googleDriveRefreshToken` (Admin SDK).
2. **`POST /api/google/drive-access-token`** — Header `Authorization: Bearer <Firebase ID token>`. Returns `{ ok: true, accessToken }` using the stored refresh token (same env vars as cron). Used by the app when the **client-side Google silent sign-in** token is missing or expired, so **Drive PDF upload** keeps working.
3. **`GET /api/cron/cleanup-drive-pdfs`** — Vercel Cron (see `vercel.json`, default **18:30 UTC ≈ 00:00 IST**) trashes all **PDF** files in each user’s `pdfFolderId` (and each `users/{uid}/companies/*` `pdfFolderId` if set).

### User requirements

- User must **Sign in with Google** once (Android) so `serverAuthCode` is registered.
- Firestore must have `pdfFolderId` (your app already sets this).

### Security

Do **not** allow clients to **read** `googleDriveRefreshToken` in Firestore rules.

### Cron on Vercel

Cron jobs may require a **paid** Vercel plan depending on your account. If cron does not run, check the Vercel dashboard.