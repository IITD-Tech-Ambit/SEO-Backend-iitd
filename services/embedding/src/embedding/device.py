import logging

from . import config

logger = logging.getLogger(__name__)


def get_device() -> str:
    if config.EMBED_BACKEND == "onnx":
        return "cpu"

    import torch

    if config.USE_GPU == "false":
        return "cpu"

    if config.USE_GPU == "true":
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
        logger.warning("GPU requested but not available, falling back to CPU")
        return "cpu"

    # auto
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"
