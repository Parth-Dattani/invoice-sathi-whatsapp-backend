import admin from "firebase-admin";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
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

/**
 * POST /api/google/store-drive-refresh
 * Body: { "serverAuthCode": "..." }
 *
 * Env:
 * - FIREBASE_SERVICE_ACCOUNT_JSON
 * - GOOGLE_OAUTH_WEB_CLIENT_ID (same as Flutter AppConstants.googleWebClientId)
 * - GOOGLE_OAUTH_WEB_CLIENT_SECRET (Web OAuth client secret from Google Cloud Console)
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const decoded = await verifyFirebaseIdToken(req);
    if (!decoded?.uid) {
      return json(res, 401, { ok: false, error: "Missing/invalid Authorization Bearer token" });
    }

    const clientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      return json(res, 500, {
        ok: false,
        error:
          "Server missing GOOGLE_OAUTH_WEB_CLIENT_ID or GOOGLE_OAUTH_WEB_CLIENT_SECRET",
      });
    }

    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: "Invalid JSON" });
    }

    const serverAuthCode = (payload.serverAuthCode || "").toString().trim();
    if (!serverAuthCode) {
      return json(res, 400, { ok: false, error: "Missing serverAuthCode" });
    }

    /** Android serverAuthCode exchange: try empty redirect_uri, then postmessage. */
    async function exchangeAuthCode(code) {
      const redirectUris = ["", "postmessage"];
      let lastErr = null;
      for (const redirectUri of redirectUris) {
        const body = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        });
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const tokenJson = await tokenRes.json().catch(() => ({}));
        if (tokenRes.ok && (tokenJson.refresh_token || "").toString().trim()) {
          return tokenJson;
        }
        lastErr =
          tokenJson.error_description ||
          tokenJson.error ||
          `HTTP ${tokenRes.status}`;
      }
      throw new Error(lastErr || "Token exchange failed");
    }

    let tokenJson;
    try {
      tokenJson = await exchangeAuthCode(serverAuthCode);
    } catch (e) {
      return json(res, 400, {
        ok: false,
        error: e?.message || String(e),
      });
    }

    const refreshToken = (tokenJson.refresh_token || "").toString().trim();
    if (!refreshToken) {
      return json(res, 400, {
        ok: false,
        error:
          "No refresh_token returned. On Android ensure GoogleSignIn(forceCodeForRefreshToken: true) and sign in again.",
      });
    }

    const a = getFirebaseAdmin();
    await a.firestore().doc(`users/${decoded.uid}`).set(
      {
        googleDriveRefreshToken: refreshToken,
        googleDriveRefreshTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return json(res, 200, { ok: true });
  } catch (e) {
    console.error("[store-drive-refresh] unhandled", e);
    return json(res, 500, { ok: false, error: e?.message || String(e) });
  }
}
