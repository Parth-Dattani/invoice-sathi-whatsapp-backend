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
 * Utility template (e.g. smartbiz_invoice) via Meta Cloud API.
 * Body parameter count must match the approved template. Use whatsappCloud.invoiceTemplateLanguage
 * exactly as in WhatsApp Manager (often en_US vs en) — (#132001) means locale mismatch.
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
  headerDocument,
  templateNamespace,
}) {
  const v =
    (graphApiVersion || "").toString().trim() ||
    process.env.WHATSAPP_META_GRAPH_VERSION?.trim() ||
    "v21.0";
  const url = `https://graph.facebook.com/${v}/${encodeURIComponent(
    String(phoneNumberId).trim()
  )}/messages`;

  const components = [];
  const hdrLink = (headerDocument?.link || "").toString().trim();
  if (hdrLink) {
    const fn = String(headerDocument?.filename || "invoice.pdf")
      .replace(/[^\w.\-]/g, "_")
      .slice(0, 240);
    components.push({
      type: "header",
      parameters: [
        {
          type: "document",
          document: {
            link: hdrLink,
            filename: fn,
          },
        },
      ],
    });
  }
  if (bodyParameterTexts && bodyParameterTexts.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParameterTexts.map((t) => ({
        type: "text",
        text: String(t ?? "").slice(0, 1024),
      })),
    });
  }

  const langCode = String(languageCode || "en").trim() || "en";
  const templatePayload = {
    name: String(templateName || "").trim(),
    language: {
      code: langCode,
    },
  };
  const ns = (templateNamespace || "").toString().trim();
  if (ns) {
    templatePayload.namespace = ns;
  }
  if (components.length) {
    templatePayload.components = components;
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
      template: templatePayload,
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
    // Helpful debug in Vercel logs: show full error_data when present.
    try {
      if (data?.error) {
        console.error(
          "[send-invoice][meta-error]",
          JSON.stringify(
            {
              status: r.status,
              message: data?.error?.message,
              code: data?.error?.code,
              error_data: data?.error?.error_data,
            },
            null,
            2
          )
        );
      }
    } catch (_) {}
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

function isMetaTemplateTranslationError(err) {
  const code = err?.metaBody?.error?.code;
  if (code === 132001 || String(code) === "132001") return true;
  const m = String(err?.message || err).toLowerCase();
  return (
    m.includes("132001") ||
    m.includes("does not exist in the translation") ||
    m.includes("template name does not exist in the translation")
  );
}

function isMetaTemplateParamCountError(err) {
  const code = err?.metaBody?.error?.code;
  if (code === 132000 || String(code) === "132000") return true;
  const m = String(err?.message || err).toLowerCase();
  return (
    m.includes("132000") ||
    m.includes("number of parameters does not match") ||
    m.includes("expected number of params")
  );
}

/** Tries primary language, then common English variants for Meta (#132001). */
function buildTemplateLanguageCandidates(primaryRaw, extraFromFirestore) {
  const primary = (primaryRaw || "en").trim() || "en";
  const candidates = [];
  const push = (c) => {
    const t = (c || "").trim();
    if (t && !candidates.includes(t)) candidates.push(t);
  };
  push(primary);
  if (Array.isArray(extraFromFirestore)) {
    for (const x of extraFromFirestore) {
      push(String(x ?? ""));
    }
  }
  const pl = primary.toLowerCase();
  if (pl === "en") push("en_US");
  if (pl === "en_us") push("en");
  push("en_US");
  push("en");
  push("en_GB");
  push("en_IN");
  return candidates;
}

async function sendWhatsAppCloudTemplateWithLanguageFallback({
  phoneNumberId,
  accessToken,
  graphApiVersion,
  toDigits,
  templateName,
  languageCode,
  bodyParameterTexts,
  headerDocument,
  templateNamespace,
  extraLanguageCodes,
}) {
  const candidates = buildTemplateLanguageCandidates(
    languageCode,
    extraLanguageCodes
  );

  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const lang = candidates[i];
    try {
      return await sendWhatsAppCloudTemplate({
        phoneNumberId,
        accessToken,
        graphApiVersion,
        toDigits,
        templateName,
        languageCode: lang,
        bodyParameterTexts,
        headerDocument,
        templateNamespace,
      });
    } catch (e) {
      lastErr = e;
      const canRetry =
        isMetaTemplateTranslationError(e) && i < candidates.length - 1;
      if (!canRetry) throw e;
      console.warn(
        `[send-invoice] template lang "${lang}" failed (${e?.message}), retrying…`
      );
    }
  }
  throw lastErr;
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
      // Flutter app can pass these so backend doesn't need hardcoded template/locale.
      templateName: payloadTemplateName,
      languageCode: payloadLanguageCode,
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

      // Approved utility template (e.g. smartbiz_invoice).
      // Priority: request JSON → company root → whatsappCloud.
      // Omit or set to "" to keep sending a document only (24h session may be required).
      const companyRootTemplate = String(
        company.whatsappTemplateName ?? ""
      ).trim();
      const companyRootLang = String(
        company.whatsappTemplateLanguage ?? ""
      ).trim();

      const payloadName =
        (payloadTemplateName && String(payloadTemplateName).trim()) ||
        String(getLoose(payload, "whatsappTemplateName") ?? "").trim() ||
        "";
      const payloadLang =
        (payloadLanguageCode && String(payloadLanguageCode).trim()) ||
        String(getLoose(payload, "whatsappTemplateLanguage") ?? "").trim() ||
        "";

      const invoiceTemplateNameRaw =
        payloadName ||
        companyRootTemplate ||
        (wc.invoiceTemplateName ?? getLoose(wc, "invoiceTemplateName"));
      const invoiceTemplateName = (invoiceTemplateNameRaw ?? "")
        .toString()
        .trim();
      const invoiceTemplateLanguageRaw =
        payloadLang ||
        companyRootLang ||
        (wc.invoiceTemplateLanguage ??
          wc.invoiceTemplateLanguageCode ??
          getLoose(wc, "invoiceTemplateLanguage"));
      const invoiceTemplateLanguage = (invoiceTemplateLanguageRaw ?? "en")
        .toString()
        .trim() || "en";

      if (isDebug()) {
        const tokenHint =
          accessTokenMeta.length >= 10
            ? `${accessTokenMeta.slice(0, 6)}…${accessTokenMeta.slice(-4)}`
            : "(short)";
        console.warn(
          `[send-invoice][debug] meta_config uid=${decoded.uid} companyId=${String(companyId).trim()} ` +
            `phoneNumberId=${phoneNumberId} accessToken=${tokenHint} graph=${graphApiVersion || "(default)"} ` +
            `templateName=${invoiceTemplateName || "(none)"} templateLang=${invoiceTemplateLanguage || "(none)"} ` +
            `payloadName=${payloadName || "(none)"} payloadLang=${payloadLang || "(none)"} ` +
            `companyRootTemplate=${companyRootTemplate || "(none)"} companyRootLang=${companyRootLang || "(none)"}`
        );
      }

      const invoiceTemplateNamespaceRaw =
        wc.invoiceTemplateNamespace ??
        wc.templateNamespace ??
        getLoose(wc, "invoiceTemplateNamespace");
      const invoiceTemplateNamespace = (invoiceTemplateNamespaceRaw ?? "")
        .toString()
        .trim();

      const extraLangRaw = wc.invoiceTemplateLanguageCandidates;
      const extraLanguageCodes = Array.isArray(extraLangRaw)
        ? extraLangRaw.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];

      const includePdfInBodyWhenNoHeader =
        wc.invoiceTemplateIncludePdfLink === true ||
        getLoose(wc, "invoiceTemplateIncludePdfLink") === true;
      const docHeaderExplicitTrue =
        wc.invoiceTemplateDocumentHeader === true ||
        getLoose(wc, "invoiceTemplateDocumentHeader") === true;
      const docHeaderExplicitFalse =
        wc.invoiceTemplateDocumentHeader === false ||
        getLoose(wc, "invoiceTemplateDocumentHeader") === false;
      const bodyParamCountRaw =
        wc.invoiceTemplateBodyParamCount ??
        getLoose(wc, "invoiceTemplateBodyParamCount");
      const bodyParamCount = Number.isFinite(Number(bodyParamCountRaw))
        ? Number(bodyParamCountRaw)
        : 0;

      function buildInvoiceTemplateBodyTexts(forDocumentHeaderAttempt) {
        const overrideParams = wc.invoiceTemplateBodyParams;
        if (Array.isArray(overrideParams) && overrideParams.length > 0) {
          const xs = overrideParams.map((x) => String(x ?? ""));
          if (bodyParamCount > 0) return xs.slice(0, bodyParamCount);
          return xs;
        }
        const co =
          (companyName && String(companyName).trim()) || " ";
        const cn =
          (customerName && String(customerName).trim()) || "Customer";
        const inv = String(invoiceNo).trim();
        const invDigits = inv.replace(/\D/g, "").trim() || inv;
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
        // Special-case: many simple templates use {{1}}=customer name and {{2}}=invoice number (often Number type).
        // When placeholders are exactly 2, map accordingly to avoid Meta #132012.
        const texts =
          bodyParamCount === 2
            ? [cn, invDigits]
            : [co, cn, inv, amt];
        if (
          !forDocumentHeaderAttempt &&
          includePdfInBodyWhenNoHeader
        ) {
          texts.push(String(mediaUrl));
        }
        if (bodyParamCount > 0) {
          // Force parameter count to match template placeholders.
          if (texts.length > bodyParamCount) return texts.slice(0, bodyParamCount);
          while (texts.length < bodyParamCount) texts.push(" ");
        }
        return texts;
      }

      if (invoiceTemplateName) {
        const attempts = [];
        // Default: DO NOT send document header unless explicitly enabled.
        // This avoids (#132000) for templates without a header component.
        if (docHeaderExplicitTrue && mediaUrl) {
          attempts.push({ withDocHeader: true });
        }
        if (!docHeaderExplicitTrue || docHeaderExplicitFalse) {
          attempts.push({ withDocHeader: false });
        }
        if (!attempts.length) {
          attempts.push({ withDocHeader: false });
        }

        let metaPayload;
        for (let ai = 0; ai < attempts.length; ai++) {
          const { withDocHeader } = attempts[ai];
          const headerDocument =
            withDocHeader && mediaUrl
              ? { link: mediaUrl, filename: fileNameSafe }
              : null;

          // First attempt uses configured/default body params.
          const baseTexts = buildInvoiceTemplateBodyTexts(withDocHeader);

          async function trySendWithTexts(bodyParameterTexts) {
            return await sendWhatsAppCloudTemplateWithLanguageFallback({
              phoneNumberId,
              accessToken: accessTokenMeta,
              graphApiVersion: graphApiVersion || undefined,
              toDigits,
              templateName: invoiceTemplateName,
              languageCode: invoiceTemplateLanguage,
              bodyParameterTexts,
              headerDocument,
              templateNamespace: invoiceTemplateNamespace || undefined,
              extraLanguageCodes,
            });
          }

          try {
            metaPayload = await trySendWithTexts(baseTexts);
            break;
          } catch (e) {
            // If template placeholder count is unknown, brute-force body param count.
            if (isMetaTemplateParamCountError(e)) {
              const maxTry = 8;
              for (let n = 1; n <= maxTry; n++) {
                const xs = baseTexts.slice(0, n);
                while (xs.length < n) xs.push(" ");
                try {
                  metaPayload = await trySendWithTexts(xs);
                  break;
                } catch (e2) {
                  if (!isMetaTemplateParamCountError(e2) || n === maxTry) {
                    throw e2;
                  }
                  console.warn(
                    `[send-invoice] paramCount ${n} failed (${e2?.message}); retrying…`
                  );
                }
              }
              if (metaPayload) break;
            }

            if (ai === attempts.length - 1) {
              throw e;
            }
            console.warn(
              `[send-invoice] template try withDocHeader=${withDocHeader} failed: ${e?.message || e}; retrying…`
            );
          }
        }

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
    const errMsg = e?.message || String(e);
    // Expose Meta error details only in DEBUG mode.
    const debug = isDebug()
      ? {
          metaHttpStatus: e?.metaHttpStatus,
          metaBody: e?.metaBody,
          hint:
            "If you see #132001 for all en/en_US/en_GB candidates, token+phoneNumberId likely belong to a different WABA than the template.",
        }
      : undefined;
    return json(res, 500, {
      ok: false,
      error: errMsg,
      ...(debug ? { debug } : {}),
    });
  }
}

