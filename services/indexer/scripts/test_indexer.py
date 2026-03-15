import logging
import random
from pymongo import MongoClient
from opensearchpy import OpenSearch, helpers
import config
from indexer import BatchIndexer

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def run_test_batch(limit=5):
    indexer = BatchIndexer()
    indexer.connect()
    
    try:
        # 1. Fetch random documents (ignoring whether they have an ID or not)
        logger.info(f"Fetching {limit} random documents for testing...")
        pipeline = [{"$sample": {"size": limit}}]
        docs = list(indexer.mongo_collection.aggregate(pipeline))
        
        if not docs:
            logger.warning("No documents found in collection")
            return

        logger.info(f"Found {len(docs)} documents. Starting indexing...")

        # 2. Process them using the existing logic
        # process_batch handles embedding generation, OS indexing, and Mongo update
        success, errors = indexer.process_batch(docs)
        
        logger.info(f"Test Complete. Success: {success}, Errors: {errors}")

    finally:
        indexer.close()

if __name__ == "__main__":
    run_test_batch()
