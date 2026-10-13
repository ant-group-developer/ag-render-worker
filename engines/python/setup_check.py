"""Checks the render venv for deploy/setup-render.ps1 (run by the farm installer on install and on every update).

Imports torch, omnivoice and whisperx, reports whether torch sees CUDA, and with ``--models`` downloads the models the
engines load into ``HF_HOME`` (the installer sets it to ``<InstallDir>\\models``, the same folder the worker gives the
engines), so the first studio.tts / studio.transcribe job does not wait for several GB.

Prints one JSON line: ``{"torch": "2.8.0+cu126", "cuda": true, "models": [...]}``. Any failure is a traceback and exit 1.
"""

import argparse
import json

# tts-handler.ts sends this model to tts.py
OMNIVOICE_MODEL = "k2-fsa/OmniVoice"
# Studio's studio.transcribe model and the TTS voice-sample reader (tts_ref_asr_model default)
WHISPER_MODEL = "large-v3"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", action="store_true", help="download OmniVoice and Whisper into HF_HOME")
    args = parser.parse_args()

    import torch
    import omnivoice  # noqa: F401
    import whisperx  # noqa: F401

    out = {"torch": torch.__version__, "cuda": bool(torch.cuda.is_available()), "models": []}
    if args.models:
        # Same cache entries the engines read: OmniVoice.from_pretrained(<repo id>) and whisperx.load_model(<size>)
        # -> faster_whisper.utils.download_model(<size>), both into HF_HOME/hub.
        from huggingface_hub import snapshot_download
        from faster_whisper.utils import download_model

        snapshot_download(OMNIVOICE_MODEL)
        out["models"].append(OMNIVOICE_MODEL)
        download_model(WHISPER_MODEL)
        out["models"].append(f"faster-whisper {WHISPER_MODEL}")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
