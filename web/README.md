# Evora Web

Versão web da Evora: conversa por voz ou texto no navegador, com respostas do Gemini.
Publicada no Vercel a partir desta pasta (`web/` como Root Directory).

## Como funciona

- `index.html`, `style.css` e `app.js` montam a interface. O microfone e a voz usam as APIs
  nativas do navegador e funcionam melhor no **Chrome** ou no **Edge**.
- `api/chat.js` é uma função serverless que chama o Gemini. A chave **nunca** vai para o navegador.
- `api/tts.js` gera a voz "Jarvis" (masculina) com o Gemini TTS; o navegador aplica o efeito metálico. Se a voz do Gemini falhar, usa a voz do navegador.
- `lib/prompt.js` guarda a personalidade da Evora, adaptada de `core/prompt.txt`.

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Nome | Obrigatória | Para quê |
|---|---|---|
| `GEMINI_API_KEY` | sim* | Chave do Google AI Studio (https://aistudio.google.com/apikey). Usada na pesquisa na internet e na voz Jarvis |
| `GROQ_API_KEY` | recomendada | Chave grátis do Groq (https://console.groq.com/keys). Muito mais rápido e com cota grátis bem maior; vira o cérebro principal da conversa |
| `GROQ_MODEL` | não | Modelo do Groq. Padrão: `openai/gpt-oss-120b` |
| `GEMINI_MODEL` | não | Modelo do Gemini. Padrão: `gemini-flash-latest` |
| `EVORA_TTS_VOICE` | não | Voz do Gemini para o estilo Jarvis. Padrão: `Charon`. Outras masculinas: `Orus`, `Iapetus`, `Algenib` |
| `EVORA_TTS_MODEL` | não | Modelo de voz. Padrão: `gemini-3.1-flash-tts-preview` |
| `EVORA_ACCESS_CODE` | não | Se definida, o site pede esse código antes de responder (evita que outras pessoas gastem sua cota) |

\* Precisa de pelo menos uma das duas chaves (Gemini ou Groq).

Depois de criar ou mudar uma variável, faça um **Redeploy** para ela valer.

## Diferença para a Evora de desktop

A versão web conversa e pesquisa na internet, mas não controla o computador (abrir apps,
arquivos, mensagens, tela, câmera). Isso continua sendo da Evora de desktop (`main.py`).
