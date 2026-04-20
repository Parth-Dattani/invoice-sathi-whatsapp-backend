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

async function refreshAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_OAUTH_WEB_CLIENT_ID or GOOGLE_OAUTH_WEB_CLIENT_SECRET");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error_description || j.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  const at = (j.access_token || "").toString().trim();
  if (!at) throw new Error("No access_token from refresh");
  return at;
}

/**
 * POST /api/google/drive-access-token
 * Authorization: Bearer <Firebase ID token>
 *
 * Returns a short-lived Google access token using users/{uid}.googleDriveRefreshToken
 * (saved by POST /api/google/store-drive-refresh after Android Google sign-in).
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const decoded = await verifyFirebaseIdToken(req);
    if (!decoded?.uid) {
      return json(res, 401, {
        ok: false,
        error: "Missing/invalid Authorization Bearer token",
      });
    }

    const a = getFirebaseAdmin();
    const snap = await a.firestore().doc(`users/${decoded.uid}`).get();
    const data = snap.data() || {};
    const refresh = (data.googleDriveRefreshToken || "").toString().trim();
    if (!refresh) {
      return json(res, 400, {
        ok: false,
        error:
          "No googleDriveRefreshToken for this user. Sign in with Google on Android once (serverAuthCode flow) so the app can call /api/google/store-drive-refresh.",
      });
    }

    const accessToken = await refreshAccessToken(refresh);
    return json(res, 200, { ok: true, accessToken });
  } catch (e) {
    console.error("[drive-access-token] unhandled", e);
    return json(res, 500, { ok: false, error: e?.message || String(e) });
  }
}
