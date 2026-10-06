"""Train the cross-encoder stage of match scorer v5 from LLM reference labels.

Inputs are the label set written by the v5 labelling run (one directory):

  v5_pairs.json      (profile key, job id, split) for every labelled pair
  v5_profiles.json   the synthetic profiles, keyed by ``key``
  v5_labels.jsonl    reference judgements; rows with ``kind == "ref"`` are used

Job inputs are the stored ``JobEncoding.ce_text`` digests and profile inputs are
rebuilt with ``profile_ce_text``, so training sees exactly what the analysis
worker feeds ``cross_encoder.score_pair``. The head predicts the six dimension
scores (scaled to 0..1) plus a "real posting" logit, mean-pooled over the
attention mask, matching ``cross_encoder._run``.

The epoch is picked on the validation split. The tree / cross-encoder blend is
re-checked on validation with the production cascade (gated pairs and pairs the
trees call a non-posting never reach the cross-encoder), and the locked test
split is reported once at the end.

Usage:
    python -m scripts.train_match_cross_encoder --labels ~/nao-match-labels
    python -m scripts.train_match_cross_encoder --labels ~/nao-match-labels --epochs 4 --out ./model_cache/nao-match-ce-v5
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import time
from pathlib import Path

import numpy as np

BASE_MODEL = "answerdotai/ModernBERT-base"
VERSION = "ce5_512-modernbert-base"
MAX_LENGTH = 512


def _load_labels(labels_dir: Path) -> tuple[list[dict], dict[str, dict]]:
    pairs = json.loads((labels_dir / "v5_pairs.json").read_text())
    profiles = {p["key"]: p for p in json.loads((labels_dir / "v5_profiles.json").read_text())}
    refs: dict[tuple[str, str], dict] = {}
    with (labels_dir / "v5_labels.jsonl").open() as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("kind") == "ref" and isinstance(row.get("out"), dict):
                refs[(row["key"], row["job_id"])] = row["out"]
    rows = []
    for pair in pairs:
        out = refs.get((pair["key"], pair["job_id"]))
        if out is None or pair["key"] not in profiles:
            continue
        rows.append({**pair, "out": out})
    return rows, profiles


async def _build_inputs(rows: list[dict], profiles: dict[str, dict], with_trees: bool) -> None:
    """Attach ``profile_ce``, ``job_ce`` and (optionally) tree outputs to every row in place."""
    from sqlalchemy import select
    from sqlalchemy.orm import undefer

    from app.models.database import JobEncoding, UserEncoding
    from app.services.encoding_service import (
        _years_from_experience,
        build_domain_proxy_text,
        build_prefs_text,
        build_user_encoding,
    )
    from app.services.requirement_lines import profile_ce_text
    from app.services.vector_match_service import score_pair_v5
    from app.storage.database import close_database, get_session, init_database

    await init_database()
    try:
        job_ids = sorted({r["job_id"] for r in rows})
        async with get_session() as session:
            encs = (
                await session.execute(
                    select(JobEncoding).options(undefer("*")).where(JobEncoding.job_id.in_(job_ids))
                )
            ).scalars().all()
            job_encs = {e.job_id: e for e in encs}

        profile_text_by_key = {r["key"]: r["profile_text"] for r in rows}
        user_encs: dict[str, UserEncoding] = {}
        profile_ce: dict[str, str] = {}
        for key, prof in profiles.items():
            if key not in profile_text_by_key:
                continue
            work = [e for e in (prof.get("work_experience") or []) if isinstance(e, dict)]
            edu = [e for e in (prof.get("education") or []) if isinstance(e, dict)]
            prefs = build_prefs_text(explicit_prefs=prof.get("job_match_preferences"), guidance=None)
            profile_ce[key] = profile_ce_text(
                prefs_text=prefs,
                profile_title=prof.get("profile_title"),
                profile_summary=prof.get("profile_summary"),
                years_experience=_years_from_experience(work),
                work_experience=work,
                education=edu,
                technical_skills=prof.get("technical_skills"),
            )
            if with_trees:
                fields = await build_user_encoding(
                    profile_text=profile_text_by_key[key],
                    work_experience=work,
                    education=edu,
                    prefs_text=prefs,
                    domain_text=build_domain_proxy_text(work, edu),
                    profile_title=prof.get("profile_title"),
                    profile_summary=prof.get("profile_summary"),
                    technical_skills=prof.get("technical_skills"),
                )
                user_encs[key] = UserEncoding(user_id=key, **fields)

        missing = 0
        for row in rows:
            enc = job_encs.get(row["job_id"])
            row["job_ce"] = (getattr(enc, "ce_text", None) or "") if enc else ""
            row["profile_ce"] = profile_ce.get(row["key"], "")
            if not row["job_ce"]:
                missing += 1
            if with_trees and enc is not None:
                res = await score_pair_v5(enc, user_encs[row["key"]], explain=True)
                trees = (res.get("explain") or {}).get("trees")
                row["tree"] = {
                    "gated": trees is None,
                    "dims": trees["dimension_scores"] if trees else dict(res["dimension_scores"]),
                    "posting_prob": trees["posting_prob"] if trees else 0.0,
                    "has_prefs": bool(
                        ((res.get("explain") or {}).get("signals") or {}).get("has_preferences")
                    ),
                }
        print(f"  pairs {len(rows)}, jobs {len(job_encs)}/{len(job_ids)}, missing job digests {missing}")
    finally:
        await close_database()


def _targets(out: dict, dimensions: list[str]) -> tuple[list[float], float]:
    dims = out.get("dimension_scores") or {}
    return [float(dims.get(d, 50)) / 100.0 for d in dimensions], 1.0 if out.get("is_job_posting", True) else 0.0


def _overall(dims: dict[str, float], weights: dict[str, float]) -> float:
    return sum(dims[d] * weights[d] for d in weights) / sum(weights.values())


def _evaluate(rows, ce_out, dimensions, weights, w: float | None) -> dict:
    """Overall / dimension MAE against the reference. ``w=None`` scores the cross-encoder alone."""
    errs, dim_errs = [], {d: [] for d in dimensions}
    for row, pred in zip(rows, ce_out):
        out = row["out"]
        if not out.get("is_job_posting", True):
            continue
        ce_dims = {d: float(np.clip(pred[k], 0.0, 1.0) * 100.0) for k, d in enumerate(dimensions)}
        if w is None:
            dims = ce_dims
        else:
            tree = row["tree"]
            dims = {d: float(tree["dims"][d]) for d in dimensions}
            if not tree["gated"] and tree["posting_prob"] >= 0.5:
                dims = {d: w * dims[d] + (1.0 - w) * ce_dims[d] for d in dimensions}
                if not tree["has_prefs"]:
                    dims["user_preferences"] = 50.0
        ref = {d: float((out.get("dimension_scores") or {}).get(d, 50)) for d in dimensions}
        errs.append(abs(_overall(dims, weights) - float(out.get("overall_score", _overall(ref, weights)))))
        for d in dimensions:
            dim_errs[d].append(abs(dims[d] - ref[d]))
    return {
        "overall_mae": round(float(np.mean(errs)), 3) if errs else None,
        "dims_mae": {d: round(float(np.mean(v)), 2) for d, v in dim_errs.items() if v},
        "n": len(errs),
    }


def _spearman(a: list[float], b: list[float]) -> float:
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    return float(np.corrcoef(ra, rb)[0, 1])


def train(args) -> None:
    import torch
    from torch import nn
    from transformers import AutoModel, AutoTokenizer, get_linear_schedule_with_warmup

    from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS

    dimensions = list(MATCH_DIMENSION_WEIGHTS)
    weights = dict(MATCH_DIMENSION_WEIGHTS)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    rows, profiles = _load_labels(Path(args.labels).expanduser())
    print(f"Loaded {len(rows)} reference pairs")
    asyncio.run(_build_inputs(rows, profiles, with_trees=not args.skip_blend))
    rows = [r for r in rows if r["job_ce"] and r["profile_ce"]]
    split = {s: [r for r in rows if r["split"] == s] for s in ("train", "val", "test")}
    print({k: len(v) for k, v in split.items()})

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    encoder = AutoModel.from_pretrained(BASE_MODEL, dtype=torch.float32).to(device)
    head = nn.Linear(encoder.config.hidden_size, len(dimensions) + 1).to(device)
    nn.init.zeros_(head.bias)
    with torch.no_grad():
        head.bias[: len(dimensions)] = 0.5
        head.bias[len(dimensions)] = 2.0

    def forward(batch_rows):
        enc = tokenizer(
            [r["profile_ce"] for r in batch_rows],
            [r["job_ce"] for r in batch_rows],
            truncation="longest_first",
            max_length=MAX_LENGTH,
            padding=True,
            return_tensors="pt",
        ).to(device)
        with torch.autocast(device_type=device, dtype=torch.bfloat16, enabled=device == "cuda"):
            hidden = encoder(input_ids=enc["input_ids"], attention_mask=enc["attention_mask"]).last_hidden_state
            att = enc["attention_mask"]
            pooled = (hidden * att.unsqueeze(-1)).sum(1) / att.sum(1, keepdim=True).clamp(min=1)
            return head(pooled).float()

    def predict(eval_rows):
        encoder.eval()
        head.eval()
        outs = []
        with torch.inference_mode():
            for i in range(0, len(eval_rows), args.eval_batch):
                outs.append(forward(eval_rows[i : i + args.eval_batch]).cpu().numpy())
        encoder.train()
        head.train()
        return np.concatenate(outs) if outs else np.zeros((0, len(dimensions) + 1))

    params = [
        {"params": encoder.parameters(), "lr": args.lr},
        {"params": head.parameters(), "lr": args.head_lr},
    ]
    opt = torch.optim.AdamW(params, weight_decay=0.01)
    steps_per_epoch = math.ceil(len(split["train"]) / (args.batch * args.accum))
    sched = get_linear_schedule_with_warmup(opt, int(0.08 * steps_per_epoch * args.epochs), steps_per_epoch * args.epochs)
    mse = nn.MSELoss()
    bce = nn.BCEWithLogitsLoss()

    best = {"mae": float("inf"), "epoch": -1, "state": None}
    train_rows = list(split["train"])
    for epoch in range(args.epochs):
        random.shuffle(train_rows)
        started = time.monotonic()
        running = 0.0
        for step, i in enumerate(range(0, len(train_rows), args.batch)):
            batch_rows = train_rows[i : i + args.batch]
            tgt = [_targets(r["out"], dimensions) for r in batch_rows]
            y_dims = torch.tensor([t[0] for t in tgt], device=device)
            y_post = torch.tensor([t[1] for t in tgt], device=device)
            out = forward(batch_rows)
            posting_mask = y_post.unsqueeze(1)
            dim_loss = mse(out[:, : len(dimensions)] * posting_mask, y_dims * posting_mask)
            loss = (dim_loss + 0.1 * bce(out[:, len(dimensions)], y_post)) / args.accum
            loss.backward()
            running += float(loss) * args.accum
            if (step + 1) % args.accum == 0 or i + args.batch >= len(train_rows):
                torch.nn.utils.clip_grad_norm_(list(encoder.parameters()) + list(head.parameters()), 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
        val_pred = predict(split["val"])
        val = _evaluate(split["val"], val_pred, dimensions, weights, None)
        print(
            f"epoch {epoch + 1}: loss {running / max(1, step + 1):.4f}  val CE overall MAE {val['overall_mae']}"
            f"  ({time.monotonic() - started:.0f}s)"
        )
        if val["overall_mae"] is not None and val["overall_mae"] < best["mae"]:
            best = {
                "mae": val["overall_mae"],
                "epoch": epoch + 1,
                "state": (
                    {k: v.detach().cpu().clone() for k, v in encoder.state_dict().items()},
                    {k: v.detach().cpu().clone() for k, v in head.state_dict().items()},
                ),
            }

    encoder.load_state_dict(best["state"][0])
    head.load_state_dict(best["state"][1])
    print(f"best epoch {best['epoch']} (val CE MAE {best['mae']})")

    val_pred = predict(split["val"])
    test_pred = predict(split["test"])
    report: dict = {
        "best_epoch": best["epoch"],
        "val_ce": _evaluate(split["val"], val_pred, dimensions, weights, None),
        "test_ce": _evaluate(split["test"], test_pred, dimensions, weights, None),
    }
    if not args.skip_blend:
        grid = {round(w, 2): _evaluate(split["val"], val_pred, dimensions, weights, w)["overall_mae"] for w in np.arange(0.3, 1.01, 0.1)}
        chosen = min(grid, key=lambda w: grid[w])
        report["val_blend_grid"] = grid
        report["val_best_blend_tree_weight"] = chosen
        for w in sorted({0.6, chosen, 1.0}):
            report[f"test_blend_{w}"] = _evaluate(split["test"], test_pred, dimensions, weights, w)
        posting_rows = [
            (r, p) for r, p in zip(split["test"], test_pred) if r["out"].get("is_job_posting", True)
        ]
        ref_overall = [float(r["out"]["overall_score"]) for r, _ in posting_rows]
        blend_overall = []
        for r, p in posting_rows:
            tree = r["tree"]
            dims = {d: float(tree["dims"][d]) for d in dimensions}
            if not tree["gated"] and tree["posting_prob"] >= 0.5:
                ce = {d: float(np.clip(p[k], 0, 1) * 100) for k, d in enumerate(dimensions)}
                dims = {d: 0.6 * dims[d] + 0.4 * ce[d] for d in dimensions}
                if not tree["has_prefs"]:
                    dims["user_preferences"] = 50.0
            blend_overall.append(_overall(dims, weights))
        report["test_blend_0.6_spearman"] = round(_spearman(blend_overall, ref_overall), 4)
    print(json.dumps(report, indent=2))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    encoder.save_pretrained(out_dir)
    tokenizer.save_pretrained(out_dir)
    np.savez(
        out_dir / "head.npz",
        weight=head.weight.detach().cpu().float().numpy(),
        bias=head.bias.detach().cpu().float().numpy(),
    )
    meta = {
        "version": VERSION,
        "base_model": BASE_MODEL,
        "max_length": MAX_LENGTH,
        "dimensions": dimensions,
        "trained_pairs": len(split["train"]),
        "epochs": best["epoch"],
        "report": report,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", default=os.path.expanduser("~/nao-match-labels"))
    parser.add_argument("--out", default="./model_cache/nao-match-ce-v5")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--accum", type=int, default=2)
    parser.add_argument("--eval-batch", type=int, default=32)
    parser.add_argument("--lr", type=float, default=3e-5)
    parser.add_argument("--head-lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--skip-blend", action="store_true", help="skip the tree blend check (no MiniLM encode)")
    train(parser.parse_args())


if __name__ == "__main__":
    main()
