"""
Batch Indexer for Research Documents
Indexes MongoDB documents into OpenSearch with SPECTER2 embeddings
"""

import asyncio
import logging
import time
from typing import List, Dict, Any, Optional
from datetime import datetime

import httpx
from pymongo import MongoClient
from opensearchpy import OpenSearch, helpers
from tqdm import tqdm

from . import config

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class BatchIndexer:
    """
    Handles batch indexing from MongoDB to OpenSearch with embeddings
    """
    
    def __init__(self):
        self.mongo_client = None
        self.mongo_collection = None
        self.os_client = None
        self.http_client = None
        
    def connect(self):
        """Initialize connections to MongoDB and OpenSearch"""
        logger.info("Connecting to MongoDB...")
        self.mongo_client = MongoClient(config.MONGODB_URI)
        db_name = config.MONGODB_URI.split("/")[-1].split("?")[0]
        self.mongo_collection = self.mongo_client[db_name][config.MONGODB_COLLECTION]
        
        # Verify MongoDB connection
        self.mongo_client.admin.command('ping')
        doc_count = self.mongo_collection.count_documents({})
        logger.info(f"MongoDB connected. Collection has {doc_count} documents")
        
        logger.info("Connecting to OpenSearch...")
        self.os_client = OpenSearch(
            hosts=config.OPENSEARCH_HOSTS,
            http_auth=(config.OPENSEARCH_USER, config.OPENSEARCH_PASSWORD),
            verify_certs=config.OPENSEARCH_VERIFY_CERTS,
            ssl_show_warn=False
        )
        
        # Verify OpenSearch connection
        health = self.os_client.cluster.health()
        logger.info(f"OpenSearch connected. Cluster status: {health['status']}")
        
        # HTTP client for embedding service
        self.http_client = httpx.Client(timeout=config.EMBEDDING_TIMEOUT)
        
    def close(self):
        """Close all connections"""
        if self.mongo_client:
            self.mongo_client.close()
        if self.os_client:
            self.os_client.close()
        if self.http_client:
            self.http_client.close()
        logger.info("All connections closed")
        
    def build_embedding_text(self, doc: Dict[str, Any]) -> str:
        """
        Build text for embedding using SPECTER2 format
        Format: title [SEP] abstract
        """
        title = doc.get("title", "").strip()
        abstract = doc.get("abstract", "").strip()
        
        if not title:
            return abstract
        if not abstract:
            return title
            
        return f"{title} [SEP] {abstract}"
    
    def get_embeddings(self, texts: List[str]) -> Optional[List[List[float]]]:
        """
        Get embeddings from the embedding service
        """
        if not texts:
            return []
            
        for attempt in range(config.MAX_RETRIES):
            try:
                response = self.http_client.post(
                    f"{config.EMBEDDING_SERVICE_URL}/embed",
                    json={"texts": texts},
                    timeout=config.EMBEDDING_TIMEOUT
                )
                response.raise_for_status()
                return response.json()["embeddings"]
                
            except Exception as e:
                logger.warning(f"Embedding request failed (attempt {attempt + 1}): {e}")
                if attempt < config.MAX_RETRIES - 1:
                    time.sleep(config.RETRY_DELAY)
                    
        return None
    
    def build_opensearch_document(
        self, 
        doc: Dict[str, Any], 
        embedding: List[float]
    ) -> Dict[str, Any]:
        """
        Build OpenSearch document from MongoDB document
        """
        return {
            "_index": config.OPENSEARCH_INDEX,
            "_source": {
                "mongo_id": str(doc["_id"]),
                "title": doc.get("title", ""),
                "abstract": doc.get("abstract", ""),
                "author_names": [
                    a.get("author_name", "") 
                    for a in doc.get("authors", [])
                ],
                "publication_year": doc.get("publication_year"),
                "field_associated": doc.get("field_associated"),
                "document_type": doc.get("document_type"),
                "subject_area": doc.get("subject_area", []),
                "citation_count": doc.get("citation_count", 0),
                "embedding": embedding
            }
        }
    
    def process_batch(self, docs: List[Dict[str, Any]]) -> tuple[int, int]:
        """
        Process a batch of documents:
        1. Generate embedding texts
        2. Get embeddings in sub-batches
        3. Bulk index to OpenSearch
        4. Update MongoDB with OpenSearch IDs
        
        Returns: (success_count, error_count)
        """
        success_count = 0
        error_count = 0
        
        # Step 1: Build embedding texts
        texts = [self.build_embedding_text(d) for d in docs]
        
        # Step 2: Get embeddings in sub-batches
        all_embeddings = []
        for i in range(0, len(texts), config.EMBED_BATCH_SIZE):
            batch_texts = texts[i:i + config.EMBED_BATCH_SIZE]
            batch_embeddings = self.get_embeddings(batch_texts)
            
            if batch_embeddings is None:
                logger.error(f"Failed to get embeddings for batch {i // config.EMBED_BATCH_SIZE}")
                return success_count, len(docs)
                
            all_embeddings.extend(batch_embeddings)
        
        # Step 3: Build OpenSearch actions
        actions = []
        for doc, embedding in zip(docs, all_embeddings):
            actions.append(self.build_opensearch_document(doc, embedding))
        
        # Step 4: Bulk index
        try:
            success, errors = helpers.bulk(
                self.os_client, 
                actions, 
                refresh=True,
                raise_on_error=False,
                raise_on_exception=False
            )
            
            if errors:
                logger.warning(f"Bulk indexing had {len(errors)} errors")
                error_count = len(errors)
                
            success_count = success
            
        except Exception as e:
            logger.error(f"Bulk indexing failed: {e}")
            return 0, len(docs)
        
        # Step 5: Get OpenSearch IDs and update MongoDB
        for doc in docs:
            try:
                # Search for the document we just indexed
                result = self.os_client.search(
                    index=config.OPENSEARCH_INDEX,
                    body={
                        "query": {"term": {"mongo_id": str(doc["_id"])}},
                        "_source": False,
                        "size": 1
                    }
                )
                
                if result["hits"]["hits"]:
                    os_id = result["hits"]["hits"][0]["_id"]
                    self.mongo_collection.update_one(
                        {"_id": doc["_id"]},
                        {"$set": {"open_search_id": os_id}}
                    )
                    
            except Exception as e:
                logger.warning(f"Failed to update MongoDB for doc {doc['_id']}: {e}")
        
        return success_count, error_count
    
    def get_documents_to_index(self, limit: Optional[int] = None):
        """
        Get documents that haven't been indexed yet
        """
        query = {
            "$or": [
                {"open_search_id": None},
                {"open_search_id": {"$exists": False}}
            ]
        }
        
        cursor = self.mongo_collection.find(query).batch_size(config.MONGO_BATCH_SIZE)
        
        if limit:
            cursor = cursor.limit(limit)
            
        return cursor
    
    def run(self, limit: Optional[int] = None, reindex_all: bool = False):
        """
        Run the indexing process
        
        Args:
            limit: Maximum number of documents to index (None = all)
            reindex_all: If True, reindex all documents (ignores open_search_id status)
        """
        start_time = time.time()
        
        self.connect()
        
        try:
            # Determine which documents to index
            if reindex_all:
                logger.info("Reindex all mode: Processing all documents...")
                count_query = {}  # All documents
            else:
                count_query = {
                    "$or": [
                        {"open_search_id": None},
                        {"open_search_id": {"$exists": False}}
                    ]
                }
            
            total_to_index = self.mongo_collection.count_documents(count_query)
            
            if limit:
                total_to_index = min(total_to_index, limit)
                
            if total_to_index == 0:
                logger.info("No documents to index")
                return
                
            logger.info(f"Starting indexing of {total_to_index} documents...")
            
            # Get cursor based on mode
            if reindex_all:
                cursor = self.mongo_collection.find({}).batch_size(config.MONGO_BATCH_SIZE)
                if limit:
                    cursor = cursor.limit(limit)
            else:
                cursor = self.get_documents_to_index(limit)
            
            batch = []
            total_success = 0
            total_errors = 0
            
            with tqdm(total=total_to_index, desc="Indexing") as pbar:
                for doc in cursor:
                    batch.append(doc)
                    
                    if len(batch) >= config.MONGO_BATCH_SIZE:
                        success, errors = self.process_batch(batch)
                        total_success += success
                        total_errors += errors
                        pbar.update(len(batch))
                        batch = []
                
                # Process remaining documents
                if batch:
                    success, errors = self.process_batch(batch)
                    total_success += success
                    total_errors += errors
                    pbar.update(len(batch))
            
            elapsed = time.time() - start_time
            
            logger.info(f"""
╔═══════════════════════════════════════════════════════════╗
║  Indexing Complete                                         ║
║  ─────────────────────────────────────────────────────────  ║
║  Total Processed: {total_to_index:>10}                              ║
║  Successful:      {total_success:>10}                              ║
║  Errors:          {total_errors:>10}                              ║
║  Time Elapsed:    {elapsed:>10.2f}s                            ║
║  Rate:            {total_success/elapsed:>10.1f} docs/sec                    ║
╚═══════════════════════════════════════════════════════════╝
            """)
            
        finally:
            self.close()


def create_index_if_not_exists(os_client: OpenSearch):
    """
    Create the OpenSearch index with proper mapping if it doesn't exist.
    Includes custom analyzers for N-gram and Phonetic matching.
    """
    index_name = config.OPENSEARCH_INDEX
    
    if os_client.indices.exists(index=index_name):
        logger.info(f"Index {index_name} already exists")
        return
    
    mapping = {
        "settings": {
            "index": {
                "knn": True,
                "number_of_shards": 3,
                "number_of_replicas": 1,
                "max_ngram_diff": 2
            },
            "analysis": {
                "filter": {
                    "ngram_filter": {
                        "type": "ngram",
                        "min_gram": 2,
                        "max_gram": 4
                    }
                },
                "analyzer": {
                    "ngram_analyzer": {
                        "type": "custom",
                        "tokenizer": "standard",
                        "filter": ["lowercase", "ngram_filter"]
                    }
                }
            }
        },
        "mappings": {
            "properties": {
                "mongo_id": {
                    "type": "keyword",
                    "doc_values": True
                },
                "title": {
                    "type": "text",
                    "analyzer": "english",
                    "fields": {
                        "exact": {"type": "keyword"}
                    }
                },
                "abstract": {
                    "type": "text",
                    "analyzer": "english"
                },
                "author_names": {
                    "type": "text",
                    "analyzer": "standard",
                    "fields": {
                        "keyword": {"type": "keyword"},
                        "ngram": {
                            "type": "text",
                            "analyzer": "ngram_analyzer"
                        }
                    }
                },
                "publication_year": {
                    "type": "integer"
                },
                "field_associated": {
                    "type": "text",
                    "analyzer": "standard",
                    "fields": {
                        "keyword": {"type": "keyword"},
                        "ngram": {
                            "type": "text",
                            "analyzer": "ngram_analyzer"
                        }
                    }
                },
                "document_type": {
                    "type": "keyword"
                },
                "subject_area": {
                    "type": "text",
                    "analyzer": "standard",
                    "fields": {
                        "keyword": {"type": "keyword"},
                        "ngram": {
                            "type": "text",
                            "analyzer": "ngram_analyzer"
                        }
                    }
                },
                "citation_count": {
                    "type": "integer"
                },
                "embedding": {
                    "type": "knn_vector",
                    "dimension": 768,
                    "method": {
                        "name": "hnsw",
                        "space_type": "cosinesimil",
                        "engine": "lucene",
                        "parameters": {
                            "ef_construction": 128,
                            "m": 16
                        }
                    }
                }
            }
        }
    }
    
    os_client.indices.create(index=index_name, body=mapping)
    logger.info(f"Created index {index_name}")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Index research documents to OpenSearch")
    parser.add_argument(
        "--limit", 
        type=int, 
        default=None,
        help="Maximum number of documents to index"
    )
    parser.add_argument(
        "--reindex-all",
        action="store_true",
        help="Reindex all documents (clears existing open_search_id)"
    )
    parser.add_argument(
        "--create-index",
        action="store_true",
        help="Create the OpenSearch index if it doesn't exist"
    )
    
    args = parser.parse_args()
    
    if args.create_index:
        logger.info("Creating OpenSearch index...")
        os_client = OpenSearch(
            hosts=config.OPENSEARCH_HOSTS,
            http_auth=(config.OPENSEARCH_USER, config.OPENSEARCH_PASSWORD),
            verify_certs=config.OPENSEARCH_VERIFY_CERTS,
            ssl_show_warn=False
        )
        create_index_if_not_exists(os_client)
        os_client.close()
    
    indexer = BatchIndexer()
    indexer.run(limit=args.limit, reindex_all=args.reindex_all)
