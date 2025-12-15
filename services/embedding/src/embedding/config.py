import os
from dotenv import load_dotenv

load_dotenv()

# Model configuration
MODEL_NAME = os.getenv("MODEL_NAME", "allenai/specter2_base")
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "512"))
MAX_BATCH_SIZE = int(os.getenv("MAX_BATCH_SIZE", "64"))

# Server configuration
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8001"))

# GPU/CPU configuration
USE_GPU = os.getenv("USE_GPU", "auto").lower()  # "auto", "true", "false"
