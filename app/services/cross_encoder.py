"""Cross-encoder stage of match scorer v5 (no LLM).

A fine-tuned transformer reads the compact profile digest and posting digest
(``UserEncoding.ce_text`` / ``JobEncoding.ce_text``) together and predicts
the six dimension scores plus a "real posting" logit. It runs in the analysis
worker; concurrent pairs are merged into one GPU call by a micro-batcher, the
same way ``encoding_service`` batches embeddings.

Unavailable (no CUDA under ``auto``, no weights, load error) means the caller
scores with the tree models alone. A failed call is never retried.
"""

from __future__ import annotations

import asyncio
import json
import math
import queue
import threading
import time
from concurrent.futures import Future
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_state_lock = threading.Lock()
_runtime: dict | None = None
_disabled_reason: str | None = None


def _weights_dir() -> Path:
    return Path(get_settings().match_cross_encoder_dir)


@lru_cache(maxsize=1)
def _configured() -> bool:
    mode = get_settings().match_cross_encoder
    if mode == "off" or not (_weights_dir() / "meta.json").exists():
        return False
    if mode == "auto":
        from app.services.encoding_service import _cuda_available

        return _cuda_available()
    return True


def enabled() -> bool:
    """Configured on, weights present, and not failed to load. Imports torch on first call."""
    return _disabled_reason is None and _configured()


def warm_up() -> bool:
    """Load the model and run one pair so the first real request pays no start-up cost."""
    if not enabled():
        return False
    rt = _load()
    if rt is None:
        return False
    started = time.monotonic()
    _run(rt, [("Candidate preferences: none", "Job title: warm-up")])
    logger.info("cross_encoder_warm", first_call_ms=int((time.monotonic() - started) * 1000))
    return True


def _load() -> dict | None:
    global _runtime, _disabled_reason
    if _runtime is not None or _disabled_reason is not None:
        return _runtime
    with _state_lock:
        if _runtime is not None or _disabled_reason is not None:
            return _runtime
        started = time.monotonic()
        try:
            import torch
            from torch import nn
            from transformers import AutoModel, AutoTokenizer

            path = _weights_dir()
            meta = json.loads((path / "meta.json").read_text())
            device = "cuda" if torch.cuda.is_available() else "cpu"
            tokenizer = AutoTokenizer.from_pretrained(path)
            # float32 weights under bfloat16 autocast, exactly as trained; casting
            # the weights themselves to bfloat16 costs about 0.3 MAE.
            encoder = AutoModel.from_pretrained(path, dtype=torch.float32).to(device).eval()
            head_np = np.load(path / "head.npz")
            head = nn.Linear(head_np["weight"].shape[1], head_np["weight"].shape[0])
            head.weight.data = torch.tensor(head_np["weight"])
            head.bias.data = torch.tensor(head_np["bias"])
            head = head.to(device=device).eval()
            _runtime = {
                "torch": torch,
                "tokenizer": tokenizer,
                "encoder": encoder,
                "head": head,
                "device": device,
                "max_length": int(meta["max_length"]),
                "dimensions": list(meta["dimensions"]),
                "version": meta.get("version", "unknown"),
            }
            logger.info(
                "cross_encoder_loaded",
                device=device,
                version=_runtime["version"],
                max_length=_runtime["max_length"],
                load_ms=int((time.monotonic() - started) * 1000),
            )
        except Exception as e:
            _disabled_reason = str(e)
            logger.warning("cross_encoder_unavailable", error=str(e))
        return _runtime


def _run(rt: dict, pairs: list[tuple[str, str]]) -> np.ndarray:
    torch = rt["torch"]
    batch = rt["tokenizer"](
        [p for p, _ in pairs],
        [j for _, j in pairs],
        truncation="longest_first",
        max_length=rt["max_length"],
        padding=True,
        return_tensors="pt",
    ).to(rt["device"])
    with torch.inference_mode(), torch.autocast(
        device_type=rt["device"], dtype=torch.bfloat16, enabled=rt["device"] == "cuda"
    ):
        hidden = rt["encoder"](input_ids=batch["input_ids"], attention_mask=batch["attention_mask"]).last_hidden_state
        att = batch["attention_mask"]
        pooled = (hidden * att.unsqueeze(-1)).sum(1) / att.sum(1, keepdim=True).clamp(min=1)
        out = rt["head"](pooled)
    return out.float().cpu().numpy()


class _PairBatcher:
    """Single model thread merging concurrent pair requests into one forward pass."""

    def __init__(self) -> None:
        self._queue: queue.SimpleQueue[tuple[list[tuple[str, str]], Future]] = queue.SimpleQueue()
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    def submit(self, pairs: list[tuple[str, str]]) -> Future:
        fut: Future = Future()
        if self._thread is None or not self._thread.is_alive():
            with self._start_lock:
                if self._thread is None or not self._thread.is_alive():
                    self._thread = threading.Thread(target=self._loop, name="cross-encoder", daemon=True)
                    self._thread.start()
        self._queue.put((pairs, fut))
        return fut

    def _loop(self) -> None:
        settings = get_settings()
        window = settings.match_cross_encoder_batch_window_ms / 1000.0
        cap = settings.match_cross_encoder_max_batch
        while True:
            batch = [self._queue.get()]
            size = len(batch[0][0])
            deadline = time.monotonic() + window
            while size < cap:
                timeout = deadline - time.monotonic()
                try:
                    item = self._queue.get(timeout=timeout) if timeout > 0 else self._queue.get_nowait()
                except queue.Empty:
                    break
                batch.append(item)
                size += len(item[0])
            rt = _load()
            if rt is None:
                for _, fut in batch:
                    fut.set_result(None)
                continue
            flat = [p for pairs, _ in batch for p in pairs]
            try:
                out = _run(rt, flat)
            except BaseException as exc:  # deliver to every waiter, keep the thread alive
                for _, fut in batch:
                    if not fut.done():
                        fut.set_exception(exc)
                continue
            offset = 0
            for pairs, fut in batch:
                fut.set_result(out[offset : offset + len(pairs)])
                offset += len(pairs)


_batcher = _PairBatcher()


def _to_scores(row: np.ndarray, dimensions: list[str]) -> dict:
    return {
        "dims": {d: float(np.clip(row[k], 0.0, 1.0) * 100.0) for k, d in enumerate(dimensions)},
        "posting_prob": 1.0 / (1.0 + math.exp(-float(row[len(dimensions)]))),
    }


async def score_pair(profile_text: str | None, job_text: str | None) -> dict | None:
    """{"dims", "posting_prob", "ms"} for one pair, or None when the stage is unavailable or fails."""
    if not enabled() or not (profile_text or "").strip() or not (job_text or "").strip():
        return None
    started = time.monotonic()
    try:
        out = await asyncio.wrap_future(_batcher.submit([(profile_text, job_text)]))
    except Exception as e:
        logger.warning("cross_encoder_score_failed", error=str(e))
        return None
    if out is None or _runtime is None:
        return None
    result = _to_scores(out[0], _runtime["dimensions"])
    result["ms"] = round((time.monotonic() - started) * 1000, 1)
    result["version"] = _runtime["version"]
    return result


def score_pairs_sync(pairs: list[tuple[str, str]]) -> list[dict] | None:
    """Batch scoring for offline evaluation and rescoring scripts."""
    rt = _load()
    if rt is None:
        return None
    out = _run(rt, pairs)
    return [_to_scores(row, rt["dimensions"]) for row in out]
