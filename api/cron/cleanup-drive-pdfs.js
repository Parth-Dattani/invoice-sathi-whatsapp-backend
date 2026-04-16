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

function verifyCron(req) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = (req.headers.authorization || "").toString().trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return token && token === secret;
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

async function listPdfFileIds(accessToken, folderId) {
  const q = `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`;
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "200");
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j.error?.message || j.error || `Drive list HTTP ${r.status}`);
  }
  const files = Array.isArray(j.files) ? j.files : [];
  return files.map((f) => f.id).filter(Boolean);
}

async function trashFile(accessToken, fileId) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/trash`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Trash failed ${r.status}: ${t}`);
  }
}

function collectFolderIds(userData, companiesSnap) {
  const ids = new Set();
  const uPdf = (userData?.pdfFolderId || "").toString().trim();
  if (uPdf) ids.add(uPdf);
  if (companiesSnap?.docs) {
    for (const d of companiesSnap.docs) {
      const c = d.data() || {};
      const p = (c.pdfFolderId || "").toString().trim();
      if (p) ids.add(p);
    }
  }
  return [...ids];
}

/**
 * GET /api/cron/cleanup-drive-pdfs
 * Vercel Cron: Authorization: Bearer <CRON_SECRET> (set CRON_SECRET in Vercel env).
 *
 * Trashes PDFs in each user's pdfFolderId (user doc + companies/*) when googleDriveRefreshToken exists.
 * Schedule: 30 18 * * * (18:30 UTC ≈ 00:00 IST).
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }
    if (!verifyCron(req)) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    const maxPages = Math.min(
      Math.max(parseInt(process.env.DRIVE_CLEANUP_MAX_USER_PAGES || "20", 10) || 20, 1),
      100
    );
    const pageSize = Math.min(
      Math.max(parseInt(process.env.DRIVE_CLEANUP_USER_PAGE_SIZE || "50", 10) || 50, 1),
      200
    );

    const a = getFirebaseAdmin();
    const db = a.firestore();

    let lastDoc = null;
    let pages = 0;
    let usersScanned = 0;
    let usersProcessed = 0;
    let pdfsTrashed = 0;
    const errors = [];

    while (pages < maxPages) {
      let q = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;
      pages += 1;
      lastDoc = snap.docs[snap.docs.length - 1];

      for (const doc of snap.docs) {
        usersScanned += 1;
        const uid = doc.id;
        const data = doc.data() || {};
        const refresh = (data.googleDriveRefreshToken || "").toString().trim();
        if (!refresh) continue;

        let accessToken;
        try {
          accessToken = await refreshAccessToken(refresh);
        } catch (e) {
          errors.push({ uid, step: "refresh", error: e?.message || String(e) });
          continue;
        }

        let companiesSnap;
        try {
          companiesSnap = await db.collection("users").doc(uid).collection("companies").get();
        } catch {
          companiesSnap = { docs: [] };
        }

        const folderIds = collectFolderIds(data, companiesSnap);
        if (!folderIds.length) continue;

        usersProcessed += 1;
        for (const folderId of folderIds) {
          try {
            const ids = await listPdfFileIds(accessToken, folderId);
            for (const fileId of ids) {
              try {
                await trashFile(accessToken, fileId);
                pdfsTrashed += 1;
              } catch (e) {
                errors.push({
                  uid,
                  step: "trash",
                  folderId,
                  fileId,
                  error: e?.message || String(e),
                });
              }
            }
          } catch (e) {
            errors.push({
              uid,
              step: "list",
              folderId,
              error: e?.message || String(e),
            });
          }
        }
      }

      if (snap.size < pageSize) break;
    }

    return json(res, 200, {
      ok: true,
      usersScanned,
      usersProcessed,
      pdfsTrashed,
      errors: errors.slice(0, 50),
      errorCount: errors.length,
    });
  } catch (e) {
    console.error("[cleanup-drive-pdfs] unhandled", e);
    return json(res, 500, { ok: false, error: e?.message || String(e) });
  }
}
