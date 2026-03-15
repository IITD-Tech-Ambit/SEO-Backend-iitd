#!/usr/bin/env python
"""
Entry point for the Embedding Service
Run with: python run.py
"""
import sys
import os

# Add src to path for package imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

if __name__ == "__main__":
    import uvicorn
    from embedding.main import app
    from embedding.config import PORT, HOST
    
    uvicorn.run(app, host=HOST, port=PORT)
