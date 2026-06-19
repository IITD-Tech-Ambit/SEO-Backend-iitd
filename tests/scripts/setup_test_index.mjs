#!/usr/bin/env node
/**
 * Set up a 1000-document test index.
 *
 * This script:
 *   1. Connects to MongoDB to verify documents exist
 *   2. Prints instructions for running the Go indexer with --limit 1000
 *   3. After indexing, dumps the corpus for retrieval testing
 *
 * Prerequisites:
 *   - MongoDB running with research documents
 *   - OpenSearch running
 *   - Embedding service running
 *   - Go indexer built (cd indexer_go && go build -o indexer ./cmd/indexer)
 *
 * Usage:
 *   MONGODB_URI=mongodb://localhost:27017/research_db node tests/scripts/setup_test_index.mjs
 */

import mongoose from 'mongoose';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/research_db';
const INDEXER_DIR = path.resolve(__dirname, '../../indexer_go');
const INDEXER_BIN = path.join(INDEXER_DIR, 'indexer');

async function main() {
    console.log('=== Test Index Setup (1000 documents) ===\n');

    // 1. Check MongoDB connection and document count
    console.log(`Connecting to MongoDB: ${MONGODB_URI}`);
    try {
        await mongoose.connect(MONGODB_URI);
        const db = mongoose.connection.db;
        const collection = db.collection('researchmetadatascopuses');
        const totalDocs = await collection.countDocuments();
        const indexedDocs = await collection.countDocuments({
            open_search_id: { $nin: [null, '', /^pending_/] }
        });
        console.log(`  Total documents in MongoDB: ${totalDocs}`);
        console.log(`  Already indexed: ${indexedDocs}`);
        console.log(`  Available for indexing: ${totalDocs - indexedDocs}\n`);

        if (totalDocs < 1000) {
            console.log(`WARNING: Only ${totalDocs} documents available. Will index all of them.\n`);
        }
    } catch (err) {
        console.error(`Failed to connect to MongoDB: ${err.message}`);
        console.error('Set MONGODB_URI environment variable.\n');
        process.exit(1);
    } finally {
        await mongoose.disconnect();
    }

    // 2. Check indexer binary
    if (!existsSync(INDEXER_BIN)) {
        console.log('Go indexer binary not found. Build it first:');
        console.log(`  cd ${INDEXER_DIR}`);
        console.log('  go build -o indexer ./cmd/indexer\n');

        console.log('Then run these commands to create a 1000-doc test index:\n');
    } else {
        console.log('Go indexer binary found.\n');
        console.log('Run these commands to create a 1000-doc test index:\n');
    }

    // 3. Print the commands
    console.log('  # Step 1: Clean cache and delete existing index');
    console.log(`  cd ${INDEXER_DIR}`);
    console.log('  ./indexer clean');
    console.log('  ./indexer delete-index');
    console.log('');
    console.log('  # Step 2: Create fresh index and index 1000 documents');
    console.log('  ./indexer create-index');
    console.log('  ./indexer run --limit 1000 --reindex-all');
    console.log('');
    console.log('  # Step 3: Verify index');
    console.log('  ./indexer status');
    console.log('');
    console.log('  # Step 4: Dump the corpus for testing');
    console.log('  cd ..  # back to opensearch/');
    console.log('  npm run test:dump');
    console.log('');
    console.log('  # Step 5: Run the eval harness');
    console.log('  npm run test:eval');
    console.log('');

    // 4. Attempt auto-run if indexer exists and --auto flag is set
    if (process.argv.includes('--auto') && existsSync(INDEXER_BIN)) {
        console.log('--auto flag detected. Running indexer...\n');
        try {
            console.log('Cleaning cache...');
            execSync('./indexer clean', { cwd: INDEXER_DIR, stdio: 'inherit' });

            console.log('\nDeleting existing index...');
            try {
                execSync('./indexer delete-index', { cwd: INDEXER_DIR, stdio: 'inherit' });
            } catch {
                console.log('(Index may not exist yet, continuing)');
            }

            console.log('\nCreating index...');
            execSync('./indexer create-index', { cwd: INDEXER_DIR, stdio: 'inherit' });

            console.log('\nIndexing 1000 documents...');
            execSync('./indexer run --limit 1000 --reindex-all', {
                cwd: INDEXER_DIR,
                stdio: 'inherit',
                timeout: 600000,
            });

            console.log('\nIndex status:');
            execSync('./indexer status', { cwd: INDEXER_DIR, stdio: 'inherit' });

            console.log('\n=== Test index created successfully! ===');
            console.log('Run: npm run test:dump  to export the corpus');
        } catch (err) {
            console.error(`\nIndexer failed: ${err.message}`);
            process.exit(1);
        }
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
