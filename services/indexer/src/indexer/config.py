import os
from dotenv import load_dotenv

load_dotenv()

# MongoDB configuration
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/research_db")
MONGODB_COLLECTION = os.getenv("MONGODB_COLLECTION", "researchmetadatascopuses")

# OpenSearch configuration
OPENSEARCH_HOSTS = os.getenv("OPENSEARCH_HOSTS", "https://localhost:9200").split(",")
OPENSEARCH_USER = os.getenv("OPENSEARCH_USER", "admin")
OPENSEARCH_PASSWORD = os.getenv("OPENSEARCH_PASSWORD", "admin")
OPENSEARCH_INDEX = os.getenv("OPENSEARCH_INDEX", "research_documents")
OPENSEARCH_VERIFY_CERTS = os.getenv("OPENSEARCH_VERIFY_CERTS", "false").lower() == "true"

# Embedding service configuration
EMBEDDING_SERVICE_URL = os.getenv("EMBEDDING_SERVICE_URL", "http://localhost:8001")
EMBEDDING_TIMEOUT = int(os.getenv("EMBEDDING_TIMEOUT", "30"))

# Batch configuration
MONGO_BATCH_SIZE = int(os.getenv("MONGO_BATCH_SIZE", "100"))
EMBED_BATCH_SIZE = int(os.getenv("EMBED_BATCH_SIZE", "32"))
OPENSEARCH_BULK_SIZE = int(os.getenv("OPENSEARCH_BULK_SIZE", "100"))

# Retry configuration
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
RETRY_DELAY = int(os.getenv("RETRY_DELAY", "5"))
