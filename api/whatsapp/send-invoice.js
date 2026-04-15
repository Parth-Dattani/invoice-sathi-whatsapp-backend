import twilio from "twilio";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const apiKey = process.env.WHATSAPP_DIRECT_SHARE_KEY?.trim();
    if (apiKey) {
      const got = (req.headers["x-api-key"] || "").toString().trim();
      // Allow requests without a key (simpler setup). If a key is provided, it must match.
      if (got && got !== apiKey) {
        return json(res, 401, { ok: false, error: "Unauthorized" });
      }
    }

    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON" });
    }

    const {
      toPhoneE164,
      invoiceNo,
      amount,
      driveUrl,
      customerName,
      companyName,
    } = payload || {};

    if (!toPhoneE164 || !invoiceNo || !driveUrl) {
      return json(res, 400, {
        ok: false,
        error: "Missing required fields: toPhoneE164, invoiceNo, driveUrl",
      });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    const from = process.env.TWILIO_WHATSAPP_FROM?.trim(); // e.g. "whatsapp:+14155238886"

    if (!accountSid || !authToken || !from) {
      return json(res, 500, {
        ok: false,
        error:
          "Server not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM.",
      });
    }

    const to = toPhoneE164.startsWith("whatsapp:")
      ? toPhoneE164
      : `whatsapp:${toPhoneE164}`;

    const amountText =
      amount === undefined || amount === null || amount === ""
        ? ""
        : `Amount: ₹${amount}\n`;

    const headerName = customerName ? `Hi ${customerName},\n` : "";
    const headerCompany = companyName ? `${companyName}\n` : "";

    const body =
      `${headerCompany}${headerName}` +
      `Invoice ${invoiceNo}\n` +
      amountText +
      `PDF attached.`;

    // Use a proxy URL so Twilio/WhatsApp receives correct PDF headers + filename,
    // which improves WhatsApp in-chat preview rendering.
    let mediaUrl = driveUrl;
    try {
      const proto = (req.headers["x-forwarded-proto"] || "https")
        .toString()
        .split(",")[0]
        .trim() || "https";
      const host = (req.headers["x-forwarded-host"] || req.headers.host || "")
        .toString()
        .trim();
      const baseUrl = host ? `${proto}://${host}` : "";
      const fileNameSafe = `Invoice_${String(invoiceNo).replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      )}.pdf`;
      if (baseUrl) {
        mediaUrl = `${baseUrl}/api/whatsapp/pdf?driveUrl=${encodeURIComponent(
          driveUrl
        )}&name=${encodeURIComponent(fileNameSafe)}`;
      }
    } catch (e) {
      console.error("[send-invoice] mediaUrl build failed, using driveUrl", e);
      mediaUrl = driveUrl;
    }

    const client = twilio(accountSid, authToken);
    const msg = await client.messages.create({
      from,
      to,
      body,
      mediaUrl: [mediaUrl],
    });
    return json(res, 200, { ok: true, sid: msg.sid });
  } catch (e) {
    console.error("[send-invoice] unhandled", e);
    return json(res, 500, { ok: false, error: e?.message || String(e) });
  }
}

