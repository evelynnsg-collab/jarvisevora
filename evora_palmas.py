"""
EVORA — abrir com palmas
========================

Fica rodando em segundo plano (quase sem gastar CPU) ouvindo o microfone.
Duas palmas seguidas abrem a Evora em tela cheia, e ela cumprimenta:
"Bom dia / Boa tarde / Boa noite, Senhora Evelyn".

Uso:
    python evora_palmas.py              # ouvindo (deixe aberto, ou use ATIVAR_PALMAS.bat)
    python evora_palmas.py --teste      # mostra o nível do som e as palmas detectadas
    python evora_palmas.py --abrir      # abre a Evora agora, sem palmas (para testar)

Opções:
    --url URL             endereço da Evora (padrão: https://jarvisevora-web.vercel.app)
    --sensibilidade N     1 (precisa de palmas fortes) a 10 (pega palmas fracas). Padrão 5.

A Evora abre num perfil próprio do Chrome/Edge (pasta EvoraChrome), configurado para
poder falar e usar o microfone assim que abre — sem precisar tocar em nada.
No primeiro uso, entre com a sua senha nessa janela; o login fica salvo por 30 dias.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from collections import deque
from pathlib import Path

import numpy as np

try:
    import sounddevice as sd
except Exception:  # pragma: no cover - mensagem amigável se faltar a biblioteca
    print("Falta a biblioteca 'sounddevice'. Instale com:  pip install sounddevice numpy")
    sys.exit(1)

URL_PADRAO = "https://jarvisevora-web.vercel.app"
TAXA = 16000          # amostras por segundo
BLOCO = 256           # 16 ms por bloco
PAUSA_DEPOIS = 8.0    # segundos sem reagir depois de abrir


# ── Detector de palmas ────────────────────────────────────────────────────────
class DetectorDePalmas:
    """Reconhece palmas pelo formato do som: subida instantânea, muita energia em
    agudos e queda rápida (em ~0,1 s, mesmo com o eco da sala). Voz, música e TV têm
    subida/queda lentas e são ignoradas. Duas palmas com 0,12 s a 0,9 s de intervalo = comando."""

    def __init__(self, sensibilidade: int = 5):
        s = min(10, max(1, sensibilidade))
        self.limiar_absoluto = 0.30 - s * 0.022       # pico mínimo (escala 0..1)
        self.fator_sobre_ruido = 14 - s * 0.8          # quantas vezes acima do ruído de fundo
        self.ruido = 0.003                             # nível de fundo (vai se ajustando)
        self.anterior = 0.0
        self.candidata: dict | None = None
        self.palmas: deque[float] = deque(maxlen=4)
        self.ultimo_disparo = -1e9
        self.aguardando: float | None = None   # momento da 2ª palma, esperando ver se vem uma 3ª

    def _agudos(self, x: np.ndarray) -> float:
        espectro = np.abs(np.fft.rfft(x * np.hanning(len(x))))
        freqs = np.fft.rfftfreq(len(x), 1 / TAXA)
        total = espectro.sum() + 1e-9
        return float(espectro[freqs > 1500].sum() / total)

    def processar(self, x: np.ndarray, agora: float) -> tuple[bool, dict]:
        rms = float(np.sqrt(np.mean(x * x)) + 1e-9)
        pico = float(np.max(np.abs(x)))
        info = {"rms": rms, "pico": pico, "ruido": self.ruido, "palma": False}
        disparou = False

        # Confirma a candidata: o pico vem nos primeiros ~30 ms e, de 80 a 130 ms
        # depois, uma palma já caiu para menos de 40% (a voz ainda está no meio da sílaba)
        if self.candidata is not None:
            self.candidata["depois"].append(rms)
            if len(self.candidata["depois"]) >= 8:
                d = self.candidata["depois"]
                pico_evento = max(self.candidata["rms"], d[0], d[1])
                cauda = float(np.mean(d[4:8]))
                queda = cauda / pico_evento
                if queda < 0.40:
                    self.palmas.append(self.candidata["t"])
                    info["palma"] = True
                    if self.aguardando is not None:
                        self.aguardando = None        # veio uma 3ª: é aplauso, não comando
                        self.palmas.clear()
                    elif self._checar_duas():
                        self.aguardando = self.candidata["t"]
                self.candidata = None

        # passou 0,9 s da 2ª palma sem uma 3ª: agora sim é o comando
        if self.aguardando is not None and agora - self.aguardando > 0.9 and self.candidata is None:
            self.aguardando = None
            self.ultimo_disparo = agora
            self.palmas.clear()
            disparou = True

        subida = rms / (self.anterior + 1e-9)
        if (
            self.candidata is None
            and pico > max(self.limiar_absoluto, self.ruido * self.fator_sobre_ruido)
            and subida > 4.0
            and self._agudos(x) > 0.30
        ):
            self.candidata = {"t": agora, "rms": rms, "depois": []}

        # ruído de fundo só aprende com som "calmo"
        if pico < max(self.limiar_absoluto * 0.5, self.ruido * 4):
            self.ruido = 0.995 * self.ruido + 0.005 * rms
        self.anterior = rms
        return disparou, info

    def _checar_duas(self) -> bool:
        if len(self.palmas) < 2 or self.palmas[-1] - self.ultimo_disparo < PAUSA_DEPOIS:
            return False
        a, b = self.palmas[-2], self.palmas[-1]
        # três palmas rápidas seguidas costumam ser aplauso: ignora
        tres = len(self.palmas) >= 3 and (a - self.palmas[-3]) < 0.9
        return 0.12 <= b - a <= 0.9 and not tres


# ── Abrir a Evora ─────────────────────────────────────────────────────────────
def achar_navegador() -> str | None:
    candidatos = []
    if sys.platform == "win32":
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                candidatos += [
                    Path(base) / "Google/Chrome/Application/chrome.exe",
                    Path(base) / "Microsoft/Edge/Application/msedge.exe",
                ]
    elif sys.platform == "darwin":
        candidatos += [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ]
    for nome in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge", "chrome", "msedge"):
        achado = shutil.which(nome)
        if achado:
            candidatos.append(Path(achado))
    for c in candidatos:
        if c and Path(c).exists():
            return str(c)
    return None


def abrir_evora(url: str) -> None:
    alvo = f"{url.rstrip('/')}/?wake=palmas&t={int(time.time())}"
    navegador = achar_navegador()
    if not navegador:
        print("Chrome/Edge não encontrado — abrindo no navegador padrão (pode pedir um toque para falar).")
        webbrowser.open(alvo)
        return
    perfil = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".config") / "EvoraChrome"
    perfil.mkdir(parents=True, exist_ok=True)
    args = [
        navegador,
        f"--user-data-dir={perfil}",
        f"--app={alvo}",
        "--start-fullscreen",
        "--autoplay-policy=no-user-gesture-required",   # pode falar assim que abre
        "--use-fake-ui-for-media-stream",               # libera o microfone só neste perfil
        "--no-first-run",
        "--no-default-browser-check",
    ]
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    subprocess.Popen(args, creationflags=flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ── Programa ─────────────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser(description="Abre a Evora com duas palmas.")
    ap.add_argument("--url", default=os.environ.get("EVORA_URL", URL_PADRAO))
    ap.add_argument("--sensibilidade", type=int, default=int(os.environ.get("EVORA_SENSIBILIDADE", "5")))
    ap.add_argument("--teste", action="store_true", help="mostra o nível do som e as palmas detectadas")
    ap.add_argument("--abrir", action="store_true", help="abre a Evora agora e sai")
    a = ap.parse_args()

    if a.abrir:
        abrir_evora(a.url)
        return

    det = DetectorDePalmas(a.sensibilidade)
    print("EVORA • ouvindo palmas… (duas palmas abrem a Evora; Ctrl+C para sair)")

    def ao_receber(indata, frames, tempo, status):  # roda na thread de áudio
        x = indata[:, 0].astype(np.float32)
        disparou, info = det.processar(x, time.monotonic())
        if a.teste:
            barra = "█" * min(40, int(info["pico"] * 60))
            marca = "  👏 PALMA" if info["palma"] else ""
            print(f"\r{barra:<40} pico={info['pico']:.2f} fundo={info['ruido']:.3f}{marca}   ", end="", flush=True)
            if info["palma"]:
                print()
        if disparou:
            print("\n👏👏 Duas palmas — abrindo a Evora")
            try:
                abrir_evora(a.url)
            except Exception as e:  # nunca derruba o ouvinte
                print("Não consegui abrir:", e)

    while True:
        try:
            with sd.InputStream(channels=1, samplerate=TAXA, blocksize=BLOCO, dtype="float32", callback=ao_receber):
                while True:
                    time.sleep(1)
        except KeyboardInterrupt:
            print("\nAté logo.")
            return
        except Exception as e:
            # microfone desconectado / em uso: tenta de novo daqui a pouco
            print("Microfone indisponível:", e, "— tentando de novo em 10 s")
            time.sleep(10)


if __name__ == "__main__":
    main()
