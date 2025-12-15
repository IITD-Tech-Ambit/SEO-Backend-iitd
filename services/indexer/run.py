#!/usr/bin/env python
"""
Entry point for the Indexer Service
Run with: python run.py [--limit N] [--reindex-all]
"""
import sys
import os
import argparse

# Add src to path for package imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

if __name__ == "__main__":
    from indexer.indexer import BatchIndexer
    
    parser = argparse.ArgumentParser(description='Index research documents to OpenSearch')
    parser.add_argument('--limit', type=int, help='Limit number of documents to index')
    parser.add_argument('--reindex-all', action='store_true', help='Reindex all documents')
    parser.add_argument('--create-index', action='store_true', help='Create the OpenSearch index if it doesn\'t exist')
    args = parser.parse_args()
    
    if args.create_index:
        from indexer.indexer import create_index_if_not_exists, config
        from opensearchpy import OpenSearch
        
        # Create temporary client for index creation
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
