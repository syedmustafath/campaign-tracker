// api/extract.js
// Vercel Serverless Function. Runs on Vercel's servers (same domain as your app),
// so the browser never talks to api.anthropic.com directly — no CORS, nothing new
// for your office network to block. Your Claude API key stays here, server-side.
//
// Accepts an uploaded file as base64 and asks Claude to extract campaign fields.
// - PDFs and images are sent to Claude natively (it reads them directly).
// - Emails (.eml), text, html, csv, markdown are decoded to text server-side.
// - Word/.docx: readable text is extracted from the file's XML.
// - Anything else: we try to read it as UTF-8 text as a best effort.

const MODEL = "claude-sonnet-4-6"; // good + cheap for extraction; change if you like

const SYSTEM_PROMPT = `You extract structured campaign data from marketing emails and documents for a campaign tracker.

Return ONLY a JSON object (no prose, no markdown fences) with these keys. Use "" for anything not present — never invent values.

{
  "name": "campaign name",
  "wallet": "wallet/merchant number if present, else ''",
  "category": "one of: mfc, jfc, rewards, discounts, clm, channel  (map: 'merchant funded cashback'->mfc, 'joint funded cashback'->jfc, 'reward'->rewards, 'discount'->discounts). If unclear use ''",
  "priority": "one of: urgent, high, normal, low. If not stated use ''",
  "manager": "Key Account Manager full name if present, else ''",
  "start": "start date as YYYY-MM-DD, else ''",
  "end": "end date as YYYY-MM-DD, else ''",
  "kpi": { "PC": "number or ''", "PA": "number or ''", "CC": "number or ''" },
  "lifecycle": "one of: Proposal Under Review, Modality Confirmed, Assets Confirmed, KV Confirmed, Assets Uploaded. If unclear use ''",
  "notes": "one or two short sentences summarizing anything useful not captured above, else ''"
}

Rules:
- Dates: convert any format (e.g. '15 Feb 2026', '02/15/26') to YYYY-MM-DD. If only a month/year, use the 1st.
- KPI numbers: strip commas and currency symbols; return the bare number as a string.
- Output must be valid JSON and nothing else.`;

const USER_INSTR = "Extract the campaign fields from this email/document. Return only the JSON object.";

function decodeBase64(b64){ return Buffer.from(b64, "base64"); }

function docxText(buf){
  const s = buf.toString("latin1");
  const matches = [...s.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]);
  if (matches.length) return matches.join(" ");
  return s.replace(/<[^>]+>/g, " ").replace(/[^\x20-\x7E\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function emlText(buf){
  const raw = buf.toString("utf8");
  const subjMatch = raw.match(/^Subject:\s*(.*)$/im);
  const subject = subjMatch ? subjMatch[1].trim() : "";
  const p = raw.indexOf("\r\n\r\n");
  const idx = p >= 0 ? p + 4 : (raw.indexOf("\n\n") >= 0 ? raw.indexOf("\n\n") + 2 : 0);
  let body = idx > 1 ? raw.slice(idx) : raw;
  body = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  body = body.replace(/=\r?\n/g, "").replace(/=[0-9A-F]{2}/g, " ");
  body = body.replace(/\s+/g, " ").trim();
  return (subject ? "Subject: " + subject + "\n\n" : "") + body;
}

function htmlText(buf){
  return buf.toString("utf8")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function buildUserContent(filename, mime, buf){
  const name = (filename || "").toLowerCase();
  const type = (mime || "").toLowerCase();

  if (type.includes("pdf") || name.endsWith(".pdf")){
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
      { type: "text", text: USER_INSTR },
    ];
  }

  const imgTypes = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", gif:"image/gif" };
  const ext = name.split(".").pop();
  if (type.startsWith("image/") || imgTypes[ext]){
    const media = type.startsWith("image/") ? type : imgTypes[ext];
    return [
      { type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } },
      { type: "text", text: USER_INSTR },
    ];
  }

  let text = "";
  if (name.endsWith(".eml") || type.includes("rfc822")) text = emlText(buf);
  else if (name.endsWith(".docx") || type.includes("officedocument.wordprocessing")) text = docxText(buf);
  else if (name.endsWith(".html") || name.endsWith(".htm") || type.includes("html")) text = htmlText(buf);
  else text = buf.toString("utf8");

  text = (text || "").slice(0, 100000).trim();
  if (!text) throw new Error("Could not read any text from this file. Try a PDF, or paste the content into a .txt file.");
  return [{ type: "text", text: USER_INSTR + "\n\n" + text }];
}

module.exports = async function handler(req, res){
  if (req.method !== "POST"){ res.status(405).json({ error: "Use POST" }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey){
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Vercel -> Settings -> Environment Variables, then redeploy." });
    return;
  }

  try{
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { filename, mime, data, text } = body;

    let userContent;
    if (data){
      const buf = decodeBase64(data);
      userContent = buildUserContent(filename, mime, buf);
    } else if (text && text.trim()){
      userContent = [{ type: "text", text: USER_INSTR + "\n\n" + text.slice(0, 100000) }];
    } else {
      res.status(400).json({ error: "No file provided." });
      return;
    }

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!anthropicResp.ok){
      const errText = await anthropicResp.text();
      res.status(502).json({ error: "Claude API error", detail: errText });
      return;
    }

    const out = await anthropicResp.json();
    const raw = (out.content || []).map(b => (b.type === "text" ? b.text : "")).join("").trim();
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch(e){ res.status(200).json({ ok: false, error: "Could not parse Claude's response as JSON.", raw }); return; }

    res.status(200).json({ ok: true, campaign: parsed });
  } catch(err){
    res.status(500).json({ error: "Unexpected server error", detail: String(err && err.message || err) });
  }
};

// Allow larger request bodies (base64 files). Default Vercel limit is small.
module.exports.config = { api: { bodyParser: { sizeLimit: "30mb" } } };
