#!/usr/bin/env python3
"""
4-bit QLoRA fine-tuning pipeline for btc-neon-lite-4b (Qwen/Qwen3-4B)
Designed specifically for NVIDIA RTX 3060 Laptop (6 GB VRAM) + 32+ GB System RAM.

Steps:
  1. Loads Qwen/Qwen3-4B in 4-bit NF4 (~2.6 GB VRAM) with gradient checkpointing.
  2. Fine-tunes LoRA adapters (r=16, alpha=32) on training/data/train.jsonl (~5 GB peak VRAM).
  3. Frees GPU and merges LoRA weights into FP16 safetensors on CPU RAM (~8 GB RAM).
  4. Saves merged HuggingFace model ready for Ollama `ollama create -q Q4_K_M` -> :11435 Fast GPU!
"""

import argparse
import gc
import json
import os
import time
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
)
from trl import SFTConfig, SFTTrainer


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main():
    parser = argparse.ArgumentParser(description="Train btc-neon-lite-4b QLoRA on RTX 3060 6GB")
    parser.add_argument("--base-model", default="Qwen/Qwen3-4B")
    parser.add_argument("--train-file", default="training/data/train.jsonl")
    parser.add_argument("--eval-file", default="training/data/eval.jsonl")
    parser.add_argument("--output-dir", default="training/outputs/btc-neon-lite-4b-lora")
    parser.add_argument("--merged-dir", default="training/outputs/btc-neon-lite-4b-merged")
    parser.add_argument("--max-steps", type=int, default=80, help="Optimizer steps (batch*grad_accum=8 -> 80 steps = 640 examples)")
    parser.add_argument("--max-seq-len", type=int, default=1408)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--skip-merge", action="store_true")
    args = parser.parse_args()

    assert torch.cuda.is_available(), "CUDA GPU is required for QLoRA training!"
    gpu_name = torch.cuda.get_device_name(0)
    vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
    print(f"[btc-neon-lite-4b] GPU: {gpu_name} ({vram_gb:.1f} GiB VRAM)")

    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    train_rows = load_jsonl(Path(args.train_file))
    eval_rows = load_jsonl(Path(args.eval_file))
    print(f"[btc-neon-lite-4b] Loaded train={len(train_rows)}, eval={len(eval_rows)}")

    def format_row(row: dict) -> dict:
        msgs = row["messages"]
        prompt_text = tokenizer.apply_chat_template(
            msgs[:-1],
            tokenize=False,
            add_generation_prompt=True,
        )
        completion_text = msgs[-1]["content"] + (tokenizer.eos_token or "<|im_end|>")
        return {"prompt": prompt_text, "completion": completion_text}

    train_ds = Dataset.from_list([format_row(r) for r in train_rows])
    eval_ds = Dataset.from_list([format_row(r) for r in eval_rows[:32]])

    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    )

    print(f"[btc-neon-lite-4b] Loading {args.base_model} in 4-bit NF4 ({compute_dtype})...")
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        quantization_config=bnb_config,
        device_map={"": 0},
        trust_remote_code=True,
        attn_implementation="sdpa",
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_r * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    sft_args = SFTConfig(
        output_dir=str(out_dir),
        max_steps=args.max_steps,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=8,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="paged_adamw_8bit",
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=max(4, int(args.max_steps * 0.08)),
        weight_decay=0.01,
        logging_steps=5,
        eval_strategy="steps",
        eval_steps=max(20, args.max_steps // 2),
        save_strategy="no",
        bf16=(compute_dtype == torch.bfloat16),
        fp16=(compute_dtype == torch.float16),
        max_length=args.max_seq_len,
        completion_only_loss=True,
        packing=False,
        report_to="none",
        seed=42,
    )

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        args=sft_args,
    )

    print(f"[btc-neon-lite-4b] Starting QLoRA training ({args.max_steps} steps, eff_batch=8)...")
    train_res = trainer.train()
    eval_metrics = trainer.evaluate()
    print(f"[btc-neon-lite-4b] Training done in {(time.time() - t0)/60:.1f}m | train_loss={train_res.training_loss:.4f} | eval_loss={eval_metrics.get('eval_loss', 0):.4f}")

    model.save_pretrained(str(out_dir))
    tokenizer.save_pretrained(str(out_dir))
    print(f"[btc-neon-lite-4b] Saved LoRA adapter -> {out_dir}")

    if args.skip_merge:
        return

    # Free GPU completely before merging on CPU RAM (38 GB RAM easily holds FP16 4B model)
    del trainer
    del model
    gc.collect()
    torch.cuda.empty_cache()

    print("[btc-neon-lite-4b] Merging LoRA adapter into FP16 base model on CPU RAM...")
    t_merge = time.time()
    base_fp16 = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        dtype=torch.float16,
        device_map="cpu",
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    )
    merged = PeftModel.from_pretrained(base_fp16, str(out_dir), device_map="cpu")
    merged = merged.merge_and_unload()

    merged_dir = Path(args.merged_dir)
    merged_dir.mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(str(merged_dir), safe_serialization=True, max_shard_size="4GB")
    tokenizer.save_pretrained(str(merged_dir))
    print(f"[btc-neon-lite-4b] Merged model saved in {time.time() - t_merge:.1f}s -> {merged_dir}")


if __name__ == "__main__":
    main()
