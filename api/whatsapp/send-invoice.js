import twilio from "twilio";
import admin from "firebase-admin";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isDebug() {
  return (process.env.DEBUG_WHATSAPP_DIRECT_SHARE || "").toString().trim() === "1";
}

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    throw new Error(
      "Server not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON (service account JSON string)."
    );
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid FIREBASE_SERVICE_ACCOUNT_JSON (must be valid JSON). ${e?.message || e}`
    );
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return admin;
}

async function verifyFirebaseIdToken(req) {
  const auth = (req.headers.authorization || "").toString().trim();
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!idToken) return null;
  const a = getFirebaseAdmin();
  return await a.auth().verifyIdToken(idToken);
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
      companyId,
      toPhoneE164,
      invoiceNo,
      amount,
      driveUrl,
      customerName,
      companyName,
    } = payload || {};

    if (!companyId || !toPhoneE164 || !invoiceNo || !driveUrl) {
      return json(res, 400, {
        ok: false,
        error:
          "Missing required fields: companyId, toPhoneE164, invoiceNo, driveUrl",
      });
    }

    const decoded = await verifyFirebaseIdToken(req);
    if (!decoded?.uid) {
      return json(res, 401, {
        ok: false,
        error: "Missing/invalid Authorization Bearer token",
      });
    }

    const a = getFirebaseAdmin();
    const companyRef = a
      .firestore()
      .doc(`users/${decoded.uid}/companies/${String(companyId).trim()}`);
    const companySnap = await companyRef.get();
    if (!companySnap.exists) {
      return json(res, 404, {
        ok: false,
        error: "Company not found",
        ...(isDebug()
          ? { debug: { uid: decoded.uid, companyId: String(companyId).trim() } }
          : {}),
      });
    }
    const company = companySnap.data() || {};

    if (company.isWhatsappDirectShare === false) {
      return json(res, 403, {
        ok: false,
        error: "WhatsApp direct share is disabled for this company",
        ...(isDebug()
          ? {
              debug: {
                uid: decoded.uid,
                companyId: String(companyId).trim(),
                isWhatsappDirectShare: company.isWhatsappDirectShare,
              },
            }
          : {}),
      });
    }

    const t = company.twilio || {};

    // Be tolerant to accidental key casing/whitespace differences in Firestore map keys.
    // e.g. "whatsappFrom", "whatsappFrom ", "WhatsAppFrom"
    const tEntries =
      t && typeof t === "object" && !Array.isArray(t)
        ? Object.entries(t)
        : [];
    const tGetLoose = (expectedKey) => {
      const ek = String(expectedKey).toLowerCase();
      for (const [k, v] of tEntries) {
        if (String(k).trim().toLowerCase() === ek) return v;
      }
      return undefined;
    };

    const accountSidRaw = t.accountSid ?? tGetLoose("accountSid");
    const authTokenRaw = t.authToken ?? tGetLoose("authToken");
    const fromRaw = t.whatsappFrom ?? tGetLoose("whatsappFrom");

    const accountSid = (accountSidRaw || "").toString().trim();
    const authToken = (authTokenRaw || "").toString().trim();
    const from = (fromRaw || "").toString().trim(); // e.g. "whatsapp:+14155238886"

    if (!accountSid || !authToken || !from) {
      return json(res, 400, {
        ok: false,
        error:
          "Twilio is not configured for this company. Set twilio.accountSid, twilio.authToken, twilio.whatsappFrom in Firestore.",
        ...(isDebug()
          ? {
              debug: {
                uid: decoded.uid,
                companyId: String(companyId).trim(),
                hasTwilioMap: !!company.twilio,
                hasAccountSid: !!accountSid,
                hasAuthToken: !!authToken,
                hasWhatsappFrom: !!from,
                whatsappFromType:
                  fromRaw === null
                    ? "null"
                    : Array.isArray(fromRaw)
                      ? "array"
                      : typeof fromRaw,
                whatsappFromLen: typeof fromRaw === "string" ? fromRaw.length : null,
                whatsappFromTrimLen: from.length,
                whatsappFromPreview:
                  typeof fromRaw === "string"
                    ? fromRaw.slice(0, 24)
                    : fromRaw === undefined
                      ? "undefined"
                      : null,
                twilioKeys: company.twilio
                  ? Object.keys(company.twilio).slice(0, 20)
                  : [],
              },
            }
          : {}),
      });
    }

    const to = toPhoneE164.startsWith("whatsapp:")
      ? toPhoneE164
      : `whatsapp:${toPhoneE164}`;

    const lines = [];
    if (companyName && String(companyName).trim()) {
      lines.push(String(companyName).trim());
    }
    if (customerName && String(customerName).trim()) {
      lines.push(`Hi ${String(customerName).trim()},`);
    }
    lines.push(`Invoice ${String(invoiceNo).trim()}`);
    if (typeof amount === "number" && Number.isFinite(amount)) {
      // Keep it simple: don't format currency locale-side on backend.
      lines.push(`Amount: ₹${amount}`);
    } else if (amount !== undefined && amount !== null && String(amount).trim()) {
      lines.push(`Amount: ₹${String(amount).trim()}`);
    }
    lines.push("PDF attached.");
    const body = lines.join("\n");

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

