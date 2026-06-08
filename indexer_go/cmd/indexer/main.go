package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/sudarshan/indexer/internal/config"
	"github.com/sudarshan/indexer/internal/indexer"
)

const usage = `Research Document Indexer - Two Phase Architecture

Usage:
  indexer <command> [options]

Commands:
  phase1          Run Phase 1: Fetch documents and generate embeddings (cached)
  phase2          Run Phase 2: Index to OpenSearch and update MongoDB (from cache)
  run             Run both phases sequentially
  status          Show cache status
  clean           Clear cache
  create-index    Create single concrete OpenSearch index (no alias)
  delete-index    Remove alias + legacy indices; prepare for one concrete index
  reindex-full    Full reindex: delete index, recreate, clear IDs, run both phases
  index-authors   Build the authors_suggest index from MongoDB faculties (typeahead)

Options:
  --limit N       Limit number of documents (0 = all, default: 0)
  --reindex-all   Reindex all documents (ignore existing IDs)
  --workers N     Number of parallel workers (0 = use config, default: 0)
  --recreate      (index-authors) Delete + recreate the authors_suggest index first
  --no-paper-count (index-authors) Skip deriving paper_count from research_documents
  --quiet         Minimal output

Examples:
  indexer phase1 --limit 1000     # Fetch and embed first 1000 docs
  indexer phase2                   # Index cached embeddings to OpenSearch
  indexer run --reindex-all        # Full run, reindex everything
  indexer status                   # Check cache status
`

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(1)
	}

	command := os.Args[1]

	// Parse flags manually for simplicity
	var (
		limit        int
		reindexAll   bool
		workers      int
		quiet        bool
		recreate     bool
		noPaperCount bool
	)

	for i := 2; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--limit":
			if i+1 < len(os.Args) {
				fmt.Sscanf(os.Args[i+1], "%d", &limit)
				i++
			}
		case "--reindex-all":
			reindexAll = true
		case "--workers":
			if i+1 < len(os.Args) {
				fmt.Sscanf(os.Args[i+1], "%d", &workers)
				i++
			}
		case "--recreate":
			recreate = true
		case "--no-paper-count":
			noPaperCount = true
		case "--quiet":
			quiet = true
		case "--help", "-h":
			fmt.Print(usage)
			os.Exit(0)
		default:
			if os.Args[i][0] == '-' {
				fmt.Printf("Unknown option: %s\n\n", os.Args[i])
				fmt.Print(usage)
				os.Exit(1)
			}
		}
	}

	// Load configuration
	cfg := config.Load()
	if workers > 0 {
		cfg.NumWorkers = workers
	}

	// Print header
	if !quiet {
		fmt.Println()
		fmt.Println("============================================================")
		fmt.Println(" Research Document Indexer (Go) - Two Phase Architecture")
		fmt.Println("============================================================")
		fmt.Printf(" Index:    %s\n", cfg.OpenSearchIndex)
		fmt.Printf(" Workers:  %d\n", cfg.NumWorkers)
		fmt.Printf(" Cache:    %s\n", cfg.CacheDir)
		fmt.Println("============================================================")
	}

	// Setup context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Println("\n => Received shutdown signal, saving state and exiting...")
		cancel()
	}()

	// Execute command
	switch command {
	case "phase1":
		runPhase1(ctx, cfg, limit, reindexAll, quiet)

	case "phase2":
		runPhase2(ctx, cfg, quiet)

	case "run":
		runBoth(ctx, cfg, limit, reindexAll, quiet)

	case "status":
		showStatus(cfg, quiet)

	case "clean":
		cleanCache(cfg, quiet)

	case "create-index":
		createIndex(ctx, cfg, quiet)

	case "delete-index":
		deleteIndex(ctx, cfg, quiet)

	case "reindex-full":
		runReindexFull(ctx, cfg, quiet)

	case "index-authors":
		runIndexAuthors(ctx, cfg, recreate, !noPaperCount, quiet)

	case "help", "--help", "-h":
		fmt.Print(usage)

	default:
		fmt.Printf("Unknown command: %s\n\n", command)
		fmt.Print(usage)
		os.Exit(1)
	}
}

// Phase 1: Only needs MongoDB + Embedding (no OpenSearch)
func runPhase1(ctx context.Context, cfg *config.Config, limit int, reindexAll, quiet bool) {
	idx, err := indexer.NewForPhase1(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.Phase1FetchAndEmbed(ctx, limit, reindexAll); err != nil {
		fmt.Printf("Error: Phase 1 failed: %v\n", err)
		os.Exit(1)
	}
}

// Phase 2: Only needs MongoDB + OpenSearch (no Embedding)
func runPhase2(ctx context.Context, cfg *config.Config, quiet bool) {
	idx, err := indexer.NewForPhase2(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.Phase2IndexAndUpdate(ctx); err != nil {
		fmt.Printf("Error: Phase 2 failed: %v\n", err)
		os.Exit(1)
	}
}

// Run both: Needs everything
func runBoth(ctx context.Context, cfg *config.Config, limit int, reindexAll, quiet bool) {
	idx, err := indexer.New(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.RunBothPhases(ctx, limit, reindexAll); err != nil {
		fmt.Printf("Error: Indexing failed: %v\n", err)
		os.Exit(1)
	}
}

// Status: Only needs cache
func showStatus(cfg *config.Config, quiet bool) {
	idx, err := indexer.NewCacheOnly(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	idx.CacheStatus()
}

// Clean: Only needs cache
func cleanCache(cfg *config.Config, quiet bool) {
	idx, err := indexer.NewCacheOnly(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.ClearCache(); err != nil {
		fmt.Printf("Error: Failed to clear cache: %v\n", err)
		os.Exit(1)
	}
}

// Delete index: Needs OpenSearch only (removes alias + research_documents*)
func deleteIndex(ctx context.Context, cfg *config.Config, quiet bool) {
	idx, err := indexer.NewForPhase2(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.DeleteIndex(ctx); err != nil {
		fmt.Printf("Error: Failed to delete index: %v\n", err)
		os.Exit(1)
	}
}

// Create index: Needs OpenSearch only
func createIndex(ctx context.Context, cfg *config.Config, quiet bool) {
	idx, err := indexer.NewForPhase2(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.CreateIndex(ctx); err != nil {
		fmt.Printf("Error: Failed to create index: %v\n", err)
		os.Exit(1)
	}
}

// Index authors: Needs MongoDB + OpenSearch (Phase2-style deps)
func runIndexAuthors(ctx context.Context, cfg *config.Config, recreate, withPaperCounts, quiet bool) {
	idx, err := indexer.NewForPhase2(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.IndexAuthors(ctx, recreate, withPaperCounts); err != nil {
		fmt.Printf("Error: Index authors failed: %v\n", err)
		os.Exit(1)
	}
}

// Full reindex: Needs everything
func runReindexFull(ctx context.Context, cfg *config.Config, quiet bool) {
	idx, err := indexer.New(cfg, quiet)
	if err != nil {
		fmt.Printf("Error: Failed to initialize: %v\n", err)
		os.Exit(1)
	}
	defer idx.Close()

	if err := idx.ReindexFull(ctx); err != nil {
		fmt.Printf("Error: Full reindex failed: %v\n", err)
		os.Exit(1)
	}
}
