// Evora Web — voz gerada pelo Gemini (TTS). Devolve um arquivo WAV.
//
// Variáveis de ambiente (opcionais):
//   EVORA_TTS_VOICE   voz do Gemini; padrão "Charon" (masculina, grave e serena)
//   EVORA_TTS_MODEL   modelo de voz; padrão "gemini-3.1-flash-tts-preview"

const MAX_CHARS = 1500;

const STYLE =
  "Leia em português do Brasil, com voz masculina grave, calma e elegante, como um assistente de " +
  "inteligência artificial sofisticado e um pouco formal, que já viu de tudo. Ritmo firme e preciso, " +
  "dicção clara, sem exagero de emoção. Leia exatamente este texto:\n\n";

function wavFromPcm(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function fail(res, status, error) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Método não permitido.");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fail(res, 503, "Sem chave do Gemini.");
  const access = process.env.EVORA_ACCESS_CODE;
  if (access && req.headers["x-evora-code"] !== access) return fail(res, 401, "Código de acesso inválido.");

  let text = "";
  try {
    text = String((await readBody(req)).text || "").trim().slice(0, MAX_CHARS);
  } catch {
    return fail(res, 400, "Requisição inválida.");
  }
  if (!text) return fail(res, 400, "Sem texto.");

  const voice = process.env.EVORA_TTS_VOICE || "Charon";
  const models = [process.env.EVORA_TTS_MODEL || "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"]
    .filter((m, i, a) => a.indexOf(m) === i);

  let lastStatus = 502;
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: STYLE + text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
          }),
        }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastStatus = r.status;
        console.error(`[evora-tts] ${model} -> ${r.status}: ${data?.error?.message || ""}`);
        if (r.status === 401 || r.status === 403) break;
        continue;
      }
      const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
      if (!part) { lastStatus = 502; continue; }
      const mime = part.inlineData.mimeType || "";
      const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
      const pcm = Buffer.from(part.inlineData.data, "base64");
      const wav = wavFromPcm(pcm, rate);
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Evora-Voice", `${model}/${voice}`);
      return res.end(wav);
    } catch (e) {
      lastStatus = 502;
    }
  }
  return fail(res, lastStatus === 429 ? 429 : 502, "A voz do Gemini não está disponível agora.");
}
