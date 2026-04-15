export default async function handler(req, res) {
  const url = (req.query?.driveUrl || "").toString().trim();
  const name = (req.query?.name || "invoice.pdf").toString().trim() || "invoice.pdf";

  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Missing/invalid driveUrl" }));
    return;
  }

  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: `Upstream fetch failed: ${r.status}` }));
      return;
    }

    // Force PDF headers so WhatsApp shows PDF preview/thumbnail reliably.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${name.replaceAll('"', "")}"`);
    res.setHeader("Cache-Control", "public, max-age=3600");

    // Stream response
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  }
}

