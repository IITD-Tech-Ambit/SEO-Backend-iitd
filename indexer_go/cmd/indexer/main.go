package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/sudarshan/indexer/internal/config"
	"github.com/sudarshan/indexer/internal/indexer"
)

func main() {
	// Parse command line flags
	limit := flag.Int("limit", 0, "Limit number of documents to index (0 = all)")
	reindexAll := flag.Bool("reindex-all", false, "Reindex all documents (keeps existing index)")
	reindexFull := flag.Bool("reindex-full", false, "Full reindex: delete index, create new with enhanced mapping, reindex all docs")
	createIndex := flag.Bool("create-index", false, "Create the OpenSearch index if it doesn't exist")
	workers := flag.Int("workers", 0, "Number of parallel workers (0 = use config default)")
	flag.Parse()

	// Load configuration
	cfg := config.Load()
	if *workers > 0 {
		cfg.NumWorkers = *workers
	}

	log.Println("═══════════════════════════════════════════════════════")
	log.Println("  Research Document Indexer (Go) - Enhanced")
	log.Println("═══════════════════════════════════════════════════════")
	log.Printf("  Index:    %s", cfg.OpenSearchIndex)
	log.Printf("  Workers:  %d", cfg.NumWorkers)
	log.Printf("  Batch:    %d docs", cfg.MongoBatchSize)
	log.Println("═══════════════════════════════════════════════════════")

	// Create indexer
	idx, err := indexer.New(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize indexer: %v", err)
	}
	defer idx.Close()

	// Setup context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		log.Println("\nReceived shutdown signal, cancelling...")
		cancel()
	}()

	// Full reindex mode: delete, create, clear, reindex
	if *reindexFull {
		log.Println("🔄 Full reindex mode: Will delete existing index and recreate with enhanced mapping")
		if err := idx.ReindexFull(ctx); err != nil {
			log.Fatalf("Full reindex failed: %v", err)
		}
		return
	}

	// Create index if requested
	if *createIndex {
		if err := idx.CreateIndex(ctx); err != nil {
			log.Fatalf("Failed to create index: %v", err)
		}
	}

	// Run indexer
	if err := idx.Run(ctx, *limit, *reindexAll); err != nil {
		log.Fatalf("Indexing failed: %v", err)
	}
}
