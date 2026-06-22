import logging
import os
import platform
import shutil
from typing import Any, Tuple

from . import config

logger = logging.getLogger(__name__)

_Tokenizer = Any
_Model = Any


def ort_session_options():
    import onnxruntime as ort

    opts = ort.SessionOptions()
    if config.ORT_NUM_THREADS > 0:
        opts.intra_op_num_threads = config.ORT_NUM_THREADS
        opts.inter_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return opts


def onnx_cache_dir(model_name: str) -> str:
    return os.path.join(config.ONNX_CACHE_DIR, model_name.replace("/", "--"))


def onnx_int8_cache_dir(model_name: str) -> str:
    return os.path.join(config.ONNX_INT8_CACHE_DIR, model_name.replace("/", "--"))


def onnx_artifacts_exist(model_dir: str) -> bool:
    if not os.path.isdir(model_dir):
        return False
    return any(f.endswith(".onnx") for f in os.listdir(model_dir))


def _hf_attempts() -> list:
    if config.HF_OFFLINE == "true":
        return [True]
    if config.HF_OFFLINE == "false":
        return [False]
    return [True, False]


def load_onnx(model_cls, model_name: str, label: str) -> Tuple[_Tokenizer, _Model]:
    from transformers import AutoTokenizer

    session_opts = ort_session_options()
    local_dir = onnx_cache_dir(model_name)

    if onnx_artifacts_exist(local_dir):
        logger.info("ONNX cache hit: %s", label)
        tokenizer = AutoTokenizer.from_pretrained(local_dir)
        model = model_cls.from_pretrained(local_dir, export=False, session_options=session_opts)
        return tokenizer, model

    last_err = None
    for local_only in _hf_attempts():
        try:
            logger.info("Exporting ONNX (one-time): %s", label)
            tokenizer = AutoTokenizer.from_pretrained(model_name, local_files_only=local_only)
            model = model_cls.from_pretrained(
                model_name, export=True, local_files_only=local_only,
                session_options=session_opts,
            )
            os.makedirs(local_dir, exist_ok=True)
            model.save_pretrained(local_dir)
            tokenizer.save_pretrained(local_dir)
            logger.info("ONNX cache saved: %s", label)
            return tokenizer, model
        except OSError as e:
            last_err = e
            if local_only and len(_hf_attempts()) > 1:
                logger.info("HF local cache miss for %s — downloading", label)
                continue
            raise
    raise last_err


def load_embedding_model() -> Tuple[_Tokenizer, _Model]:
    if config.EMBED_BACKEND == "onnx":
        from optimum.onnxruntime import ORTModelForFeatureExtraction
        return load_onnx(ORTModelForFeatureExtraction, config.MODEL_NAME, config.MODEL_NAME)

    from transformers import AutoModel, AutoTokenizer

    last_err = None
    for local_only in _hf_attempts():
        try:
            tokenizer = AutoTokenizer.from_pretrained(config.MODEL_NAME, local_files_only=local_only)
            model = AutoModel.from_pretrained(config.MODEL_NAME, local_files_only=local_only)
            logger.info("PyTorch model loaded: %s", config.MODEL_NAME)
            return tokenizer, model
        except OSError as e:
            last_err = e
            if local_only and len(_hf_attempts()) > 1:
                logger.info("HF local cache miss for %s — downloading", config.MODEL_NAME)
                continue
            raise
    raise last_err


def load_reranker() -> Tuple[_Tokenizer, _Model]:
    from optimum.onnxruntime import ORTModelForSequenceClassification
    from transformers import AutoTokenizer

    fp32_dir = onnx_cache_dir(config.RERANK_MODEL_NAME)
    int8_dir = onnx_int8_cache_dir(config.RERANK_MODEL_NAME)
    session_opts = ort_session_options()

    if config.RERANK_QUANTIZE:
        if not onnx_artifacts_exist(fp32_dir):
            load_onnx(ORTModelForSequenceClassification, config.RERANK_MODEL_NAME, "reranker-fp32")

        if not onnx_artifacts_exist(int8_dir):
            _quantize_to_int8(fp32_dir, int8_dir)

        logger.info("Loading INT8 reranker from %s", int8_dir)
        tokenizer = AutoTokenizer.from_pretrained(int8_dir)
        model = ORTModelForSequenceClassification.from_pretrained(
            int8_dir, file_name="model_quantized.onnx",
            export=False, session_options=session_opts,
        )
        return tokenizer, model

    return load_onnx(ORTModelForSequenceClassification, config.RERANK_MODEL_NAME, "reranker-fp32")


def _quantize_to_int8(fp32_dir: str, int8_dir: str) -> None:
    import logging as _logging

    from optimum.onnxruntime import ORTQuantizer
    from optimum.onnxruntime.configuration import AutoQuantizationConfig

    machine = platform.machine().lower()
    if "arm" in machine or "aarch64" in machine:
        qconfig = AutoQuantizationConfig.arm64(is_static=False, per_channel=False)
    else:
        qconfig = AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=False)

    logger.info("Quantizing reranker to INT8 (one-time) → %s", int8_dir)
    quantizer = ORTQuantizer.from_pretrained(fp32_dir, file_name="model.onnx")
    os.makedirs(int8_dir, exist_ok=True)

    # Dynamic quantization emits one INFO line per activation tensor it skips
    # (expected — activations have no calibration params in dynamic mode).
    _ort_logger = _logging.getLogger("onnxruntime")
    _prev_level = _ort_logger.level
    _ort_logger.setLevel(_logging.WARNING)
    try:
        quantizer.quantize(save_dir=int8_dir, quantization_config=qconfig)
    finally:
        _ort_logger.setLevel(_prev_level)

    for fname in os.listdir(fp32_dir):
        if not fname.endswith(".onnx"):
            shutil.copy2(os.path.join(fp32_dir, fname), os.path.join(int8_dir, fname))

    logger.info("INT8 reranker saved: %s", int8_dir)


def tune_cpu_threads() -> None:
    if config.EMBED_BACKEND == "onnx":
        threads = config.ORT_NUM_THREADS if config.ORT_NUM_THREADS > 0 else (os.cpu_count() or 1)
        logger.info("ORT threads: %d of %d cores", threads, os.cpu_count() or 0)
        return

    import torch

    threads = config.TORCH_THREADS if config.TORCH_THREADS > 0 else (os.cpu_count() or 1)
    try:
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(max(1, config.TORCH_INTEROP_THREADS))
    except RuntimeError:
        pass
    logger.info(
        "Torch threads: intra-op=%d, inter-op=%d",
        torch.get_num_threads(),
        config.TORCH_INTEROP_THREADS,
    )
