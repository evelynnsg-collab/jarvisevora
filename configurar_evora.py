"""Aplica a identidade e a voz da Evora, preservando as demais configurações."""
import json
import shutil
from pathlib import Path


def main():
    base = Path(__file__).resolve().parent
    target = base / "config" / "api_keys.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(target.read_text(encoding="utf-8-sig")) if target.exists() else {}
    if not isinstance(data, dict):
        raise ValueError("O arquivo de configuração precisa conter um objeto JSON.")
    if target.exists():
        backup = target.with_name("api_keys.antes_evora.json")
        if not backup.exists():
            shutil.copy2(target, backup)
    data.update(assistant_name="Evora", voice_name="Aoede", hud_style="face",
                tts_engine="edgetts", tts_voice="pt-BR-FranciscaNeural",
                input_device="")
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=4), encoding="utf-8")
    temp.replace(target)
    print("Evora configurada: voz feminina e português do Brasil.")
    print("Agora abra o programa normalmente. As chaves existentes foram preservadas.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Não foi possível configurar a Evora: {exc}")
        raise SystemExit(1)
