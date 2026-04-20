import twilio from "twilio";
import admin from "firebase-admin";

/** E.164 or whatsapp:+... → digits only (Meta Cloud API `to` field). */
function toWhatsAppDigits(phone) {
  const s = String(phone ?? "").trim();
  const noPrefix = s.replace(/^whatsapp:/i, "").trim();
  const digits = noPrefix.replace(/\D/g, "");
  return digits;
}

function entriesLoose(obj) {
  return obj && typeof obj === "object" && !Array.isArray(obj)
    ? Object.entries(obj)
    : [];
}

function getLoose(map, expectedKey) {
  const ek = String(expectedKey).toLowerCase();
  for (const [k, v] of entriesLoose(map)) {
    if (String(k).trim().toLowerCase() === ek) return v;
  }
  return undefined;
}

/**
 * Send document + caption via Meta WhatsApp Cloud API (Graph).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */
/**
 * Utility template (e.g. smartbiz_invoice) — business-initiated without 24h session.
 * Body parameter count must match the approved template in WhatsApp Manager.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#template-messages
 */
async function sendWhatsAppCloudTemplate({
  phoneNumberId,
  accessToken,
  graphApiVersion,
  toDigits,
  templateName,
  languageCode,
  bodyParameterTexts,
}) {
  const v =
    (graphApiVersion || "").toString().trim() ||
    process.env.WHATSAPP_META_GRAPH_VERSION?.trim() ||
    "v21.0";
  const url = `https://graph.facebook.com/${v}/${encodeURIComponent(
    String(phoneNumberId).trim()
  )}/messages`;

  const components = [];
  if (bodyParameterTexts && bodyParameterTexts.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParameterTexts.map((t) => ({
        type: "text",
        text: String(t ?? "").slice(0, 1024),
      })),
    });
  }

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(accessToken).trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "template",
      template: {
        name: String(templateName || "").trim(),
        language: { code: String(languageCode || "en").trim() || "en" },
        ...(components.length ? { components } : {}),
      },
    }),
  });

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const msg =
      data?.error?.message ||
      data?.error?.error_user_msg ||
      text ||
      `Meta HTTP ${r.status}`;
    const err = new Error(msg);
    err.metaHttpStatus = r.status;
    err.metaBody = data;
    throw err;
  }
  return data;
}

async function sendWhatsAppCloudDocument({
  phoneNumberId,
  accessToken,
  graphApiVersion,
  toDigits,
  documentUrl,
  caption,
  filename,
}) {
  const v =
    (graphApiVersion || "").toString().trim() ||
    process.env.WHATSAPP_META_GRAPH_VERSION?.trim() ||
    "v21.0";
  const url = `https://graph.facebook.com/${v}/${encodeURIComponent(
    String(phoneNumberId).trim()
  )}/messages`;
  const cap =
    typeof caption === "string" && caption.length > 1024
      ? `${caption.slice(0, 1021)}...`
      : caption;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(accessToken).trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "document",
      document: {
        link: documentUrl,
        caption: cap,
        filename: String(filename || "invoice.pdf").replace(/[^\w.\-]/g, "_").slice(0, 240),
      },
    }),
  });

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const msg =
      data?.error?.message ||
      data?.error?.error_user_msg ||
      text ||
      `Meta HTTP ${r.status}`;
    const err = new Error(msg);
    err.metaHttpStatus = r.status;
    err.metaBody = data;
    throw err;
  }
  return data;
}

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

    // Public HTTPS URL with PDF headers (Twilio + Meta Cloud API fetch this link).
    const fileNameSafe = `Invoice_${String(invoiceNo).replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )}.pdf`;
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
      if (baseUrl) {
        mediaUrl = `${baseUrl}/api/whatsapp/pdf?driveUrl=${encodeURIComponent(
          driveUrl
        )}&name=${encodeURIComponent(fileNameSafe)}`;
      }
    } catch (e) {
      console.error("[send-invoice] mediaUrl build failed, using driveUrl", e);
      mediaUrl = driveUrl;
    }

    const wc = company.whatsappCloud || {};
    const phoneNumberIdRaw =
      wc.phoneNumberId ?? getLoose(wc, "phoneNumberId");
    const accessTokenMetaRaw =
      wc.accessToken ?? getLoose(wc, "accessToken");
    const graphApiVersionRaw =
      wc.graphApiVersion ?? getLoose(wc, "graphApiVersion");

    const phoneNumberId = (phoneNumberIdRaw || "").toString().trim();
    const accessTokenMeta = (accessTokenMetaRaw || "").toString().trim();
    const graphApiVersion = (graphApiVersionRaw || "").toString().trim();

    if (phoneNumberId && accessTokenMeta) {
      const toDigits = toWhatsAppDigits(toPhoneE164);
      if (!toDigits || toDigits.length < 8) {
        return json(res, 400, {
          ok: false,
          error:
            "Invalid toPhoneE164 for WhatsApp Cloud API (use full international number, e.g. +91xxxxxxxxxx).",
        });
      }

      // Approved utility template (e.g. smartbiz_invoice) — set whatsappCloud.invoiceTemplateName on the company doc.
      // Omit or set to "" to keep sending a document only (24h session may be required).
      const invoiceTemplateNameRaw =
        wc.invoiceTemplateName ?? getLoose(wc, "invoiceTemplateName");
      const invoiceTemplateName = (invoiceTemplateNameRaw ?? "")
        .toString()
        .trim();
      const invoiceTemplateLanguageRaw =
        wc.invoiceTemplateLanguage ??
        wc.invoiceTemplateLanguageCode ??
        getLoose(wc, "invoiceTemplateLanguage");
      const invoiceTemplateLanguage = (
        invoiceTemplateLanguageRaw ?? "en"
      )
        .toString()
        .trim() || "en";

      let bodyParameterTexts = null;
      const overrideParams = wc.invoiceTemplateBodyParams;
      if (Array.isArray(overrideParams) && overrideParams.length > 0) {
        bodyParameterTexts = overrideParams.map((x) => String(x ?? ""));
      } else {
        const co =
          (companyName && String(companyName).trim()) || " ";
        const cn =
          (customerName && String(customerName).trim()) || "Customer";
        const inv = String(invoiceNo).trim();
        let amt = "₹0";
        if (typeof amount === "number" && Number.isFinite(amount)) {
          amt = `₹${amount}`;
        } else if (
          amount !== undefined &&
          amount !== null &&
          String(amount).trim()
        ) {
          amt = `₹${String(amount).trim()}`;
        }
        bodyParameterTexts = [co, cn, inv, amt];
        const includeLink =
          wc.invoiceTemplateIncludePdfLink === true ||
          getLoose(wc, "invoiceTemplateIncludePdfLink") === true;
        if (includeLink) {
          bodyParameterTexts.push(String(mediaUrl));
        }
      }

      if (invoiceTemplateName) {
        const metaPayload = await sendWhatsAppCloudTemplate({
          phoneNumberId,
          accessToken: accessTokenMeta,
          graphApiVersion: graphApiVersion || undefined,
          toDigits,
          templateName: invoiceTemplateName,
          languageCode: invoiceTemplateLanguage,
          bodyParameterTexts,
        });
        const wid = metaPayload?.messages?.[0]?.id;
        return json(res, 200, {
          ok: true,
          provider: "meta",
          sendMode: "template",
          templateName: invoiceTemplateName,
          messageId: wid,
          ...(isDebug() ? { debugMeta: metaPayload } : {}),
        });
      }

      const metaPayload = await sendWhatsAppCloudDocument({
        phoneNumberId,
        accessToken: accessTokenMeta,
        graphApiVersion: graphApiVersion || undefined,
        toDigits,
        documentUrl: mediaUrl,
        caption: body,
        filename: fileNameSafe,
      });
      const wid = metaPayload?.messages?.[0]?.id;
      return json(res, 200, {
        ok: true,
        provider: "meta",
        sendMode: "document",
        messageId: wid,
        ...(isDebug() ? { debugMeta: metaPayload } : {}),
      });
    }

    const t = company.twilio || {};
    const accountSidRaw = t.accountSid ?? getLoose(t, "accountSid");
    const authTokenRaw = t.authToken ?? getLoose(t, "authToken");
    const fromRaw = t.whatsappFrom ?? getLoose(t, "whatsappFrom");

    const accountSid = (accountSidRaw || "").toString().trim();
    const authToken = (authTokenRaw || "").toString().trim();
    const from = (fromRaw || "").toString().trim();

    if (!accountSid || !authToken || !from) {
      return json(res, 400, {
        ok: false,
        error:
          "WhatsApp sender not configured. For Meta Cloud API set whatsappCloud.phoneNumberId and whatsappCloud.accessToken on the company document, or for Twilio set twilio.accountSid, twilio.authToken, twilio.whatsappFrom.",
        ...(isDebug()
          ? {
              debug: {
                uid: decoded.uid,
                companyId: String(companyId).trim(),
                hasWhatsappCloudMap: !!company.whatsappCloud,
                hasPhoneNumberId: !!phoneNumberId,
                hasMetaAccessToken: !!accessTokenMeta,
                hasTwilioMap: !!company.twilio,
                hasAccountSid: !!accountSid,
                hasAuthToken: !!authToken,
                hasWhatsappFrom: !!from,
                twilioKeys: company.twilio
                  ? Object.keys(company.twilio).slice(0, 20)
                  : [],
                whatsappCloudKeys: company.whatsappCloud
                  ? Object.keys(company.whatsappCloud).slice(0, 20)
                  : [],
              },
            }
          : {}),
      });
    }

    const to = toPhoneE164.startsWith("whatsapp:")
      ? toPhoneE164
      : `whatsapp:${toPhoneE164}`;

    const client = twilio(accountSid, authToken);
    const msg = await client.messages.create({
      from,
      to,
      body,
      mediaUrl: [mediaUrl],
    });
    return json(res, 200, { ok: true, provider: "twilio", sid: msg.sid });
  } catch (e) {
    console.error("[send-invoice] unhandled", e);
    return json(res, 500, { ok: false, error: e?.message || String(e) });
  }
}

