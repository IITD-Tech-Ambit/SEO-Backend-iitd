package indexer

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sudarshan/indexer/internal/cache"
	"github.com/sudarshan/indexer/internal/cli"
	"github.com/sudarshan/indexer/internal/config"
	"github.com/sudarshan/indexer/internal/embedding"
	"github.com/sudarshan/indexer/internal/mongodb"
	"github.com/sudarshan/indexer/internal/opensearch"
)

// Indexer handles batch indexing from MongoDB to OpenSearch
type Indexer struct {
	cfg         *config.Config
	mongoDB     *mongodb.Client
	openSearch  *opensearch.Client
	embedClient *embedding.Client
	cache       *cache.Cache
	cli         *cli.CLI
}

// NewForPhase1 creates an Indexer for Phase 1 (only MongoDB + embedding needed)
func NewForPhase1(cfg *config.Config, quiet bool) (*Indexer, error) {
	output := cli.New(quiet)

	output.Info("Connecting to MongoDB...")
	mongoDB, err := mongodb.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("mongodb connect: %w", err)
	}
	output.Success("Connected to MongoDB")

	output.Info("Initializing embedding client...")
	embedClient := embedding.NewClient(cfg)
	output.Success("Embedding client initialized")

	output.Info("Setting up cache...")
	c, err := cache.NewCache(cfg.CacheDir)
	if err != nil {
		mongoDB.Close(context.Background())
		return nil, fmt.Errorf("cache init: %w", err)
	}
	output.Success(fmt.Sprintf("Cache directory: %s", cfg.CacheDir))

	return &Indexer{
		cfg:         cfg,
		mongoDB:     mongoDB,
		embedClient: embedClient,
		cache:       c,
		cli:         output,
	}, nil
}

// NewForPhase2 creates an Indexer for Phase 2 (only OpenSearch + MongoDB needed)
func NewForPhase2(cfg *config.Config, quiet bool) (*Indexer, error) {
	output := cli.New(quiet)

	output.Info("Connecting to MongoDB...")
	mongoDB, err := mongodb.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("mongodb connect: %w", err)
	}
	output.Success("Connected to MongoDB")

	output.Info("Connecting to OpenSearch...")
	osClient, err := opensearch.NewClient(cfg)
	if err != nil {
		mongoDB.Close(context.Background())
		return nil, fmt.Errorf("opensearch connect: %w", err)
	}
	output.Success("Connected to OpenSearch")

	output.Info("Setting up cache...")
	c, err := cache.NewCache(cfg.CacheDir)
	if err != nil {
		mongoDB.Close(context.Background())
		return nil, fmt.Errorf("cache init: %w", err)
	}
	output.Success(fmt.Sprintf("Cache directory: %s", cfg.CacheDir))

	return &Indexer{
		cfg:        cfg,
		mongoDB:    mongoDB,
		openSearch: osClient,
		cache:      c,
		cli:        output,
	}, nil
}

// New creates a full Indexer with all connections (for run, reindex-full)
func New(cfg *config.Config, quiet bool) (*Indexer, error) {
	output := cli.New(quiet)

	output.Info("Connecting to MongoDB...")
	mongoDB, err := mongodb.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("mongodb connect: %w", err)
	}
	output.Success("Connected to MongoDB")

	output.Info("Connecting to OpenSearch...")
	osClient, err := opensearch.NewClient(cfg)
	if err != nil {
		mongoDB.Close(context.Background())
		return nil, fmt.Errorf("opensearch connect: %w", err)
	}
	output.Success("Connected to OpenSearch")

	output.Info("Initializing embedding client...")
	embedClient := embedding.NewClient(cfg)
	output.Success("Embedding client initialized")

	output.Info("Setting up cache...")
	c, err := cache.NewCache(cfg.CacheDir)
	if err != nil {
		mongoDB.Close(context.Background())
		return nil, fmt.Errorf("cache init: %w", err)
	}
	output.Success(fmt.Sprintf("Cache directory: %s", cfg.CacheDir))

	return &Indexer{
		cfg:         cfg,
		mongoDB:     mongoDB,
		openSearch:  osClient,
		embedClient: embedClient,
		cache:       c,
		cli:         output,
	}, nil
}

// NewCacheOnly creates an Indexer with only cache access (for status, clean)
func NewCacheOnly(cfg *config.Config, quiet bool) (*Indexer, error) {
	output := cli.New(quiet)

	c, err := cache.NewCache(cfg.CacheDir)
	if err != nil {
		return nil, fmt.Errorf("cache init: %w", err)
	}

	return &Indexer{
		cfg:   cfg,
		cache: c,
		cli:   output,
	}, nil
}

// Close cleans up all connections
func (idx *Indexer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if idx.mongoDB != nil {
		idx.mongoDB.Close(ctx)
	}
	if idx.openSearch != nil {
		idx.openSearch.Close()
	}
	idx.cli.Success("Connections closed")
}

// Phase1FetchAndEmbed fetches documents from MongoDB and generates embeddings
// Results are cached to disk for Phase 2
func (idx *Indexer) Phase1FetchAndEmbed(ctx context.Context, limit int, reindexAll bool) error {
	idx.cli.StartPhase("Phase 1: Fetch & Embed")

	// Step 1: Load existing cache if resuming
	idx.cli.Step(1, 5, "Loading cache")
	if err := idx.cache.Load(); err != nil {
		idx.cli.Warning(fmt.Sprintf("Could not load cache: %v (starting fresh)", err))
	} else {
		cached := idx.cache.Count()
		if cached > 0 {
			idx.cli.Info(fmt.Sprintf("Resuming from cache: %d documents already processed", cached))
		}
	}

	// Step 2: Count documents
	idx.cli.Step(2, 5, "Counting documents to process")
	total, err := idx.mongoDB.CountDocumentsToIndex(ctx, reindexAll)
	if err != nil {
		return fmt.Errorf("count documents: %w", err)
	}
	if limit > 0 && int64(limit) < total {
		total = int64(limit)
	}
	idx.cli.Info(fmt.Sprintf("Total documents: %d", total))

	// Calculate how many still need processing
	alreadyCached := int64(idx.cache.Count())
	remaining := total - alreadyCached
	if remaining <= 0 {
		idx.cli.Success("All documents already cached!")
		idx.cli.EndPhase()
		return nil
	}
	idx.cli.Info(fmt.Sprintf("Remaining to process: %d", remaining))

	// Step 3: Stream documents
	idx.cli.Step(3, 5, "Streaming documents from MongoDB")
	docChan, err := idx.mongoDB.StreamDocuments(ctx, reindexAll, limit)
	if err != nil {
		return fmt.Errorf("stream documents: %w", err)
	}

	// Set metadata
	idx.cache.SetMetadata(total, reindexAll)

	// Step 4: Generate embeddings
	idx.cli.Step(4, 5, "Generating embeddings")
	idx.cli.Running(fmt.Sprintf("Using %d workers with batch size %d", idx.cfg.NumWorkers, idx.cfg.EmbedBatchSize))

	var (
		processed int64
		errors    int64
		skipped   int64
	)

	// Create progress tracker
	progress := cli.NewProgress(remaining)

	// Batch collector channel
	batchChan := make(chan []mongodb.Document, idx.cfg.NumWorkers*2)

	// Collect documents into batches
	go func() {
		defer close(batchChan)
		batch := make([]mongodb.Document, 0, idx.cfg.MongoBatchSize)

		for doc := range docChan {
			// Skip if already cached
			if idx.cache.IsProcessed(doc.ID.Hex()) {
				atomic.AddInt64(&skipped, 1)
				continue
			}

			batch = append(batch, doc)
			if len(batch) >= idx.cfg.MongoBatchSize {
				toSend := make([]mongodb.Document, len(batch))
				copy(toSend, batch)
				select {
				case batchChan <- toSend:
				case <-ctx.Done():
					return
				}
				batch = batch[:0]
			}
		}
		if len(batch) > 0 {
			select {
			case batchChan <- batch:
			case <-ctx.Done():
			}
		}
	}()

	// Process batches with workers
	var wg sync.WaitGroup
	workers := max(2, idx.cfg.NumWorkers)

	// Progress update ticker
	progressCtx, cancelProgress := context.WithCancel(ctx)
	progressTicker := time.NewTicker(500 * time.Millisecond)

	go func() {
		defer progressTicker.Stop()
		for {
			select {
			case <-progressTicker.C:
				idx.cli.Progress(progress)
			case <-progressCtx.Done():
				return
			}
		}
	}()

	// Background cache saver (avoids blocking workers during gob serialization)
	saveCtx, cancelSave := context.WithCancel(ctx)
	saveDone := make(chan struct{})
	go func() {
		defer close(saveDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := idx.cache.Save(); err != nil {
					idx.cli.Warning(fmt.Sprintf("Periodic cache save failed: %v", err))
				}
			case <-saveCtx.Done():
				return
			}
		}
	}()

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()

			for docs := range batchChan {
				select {
				case <-ctx.Done():
					return
				default:
				}

				// Build embedding texts
				texts := make([]string, len(docs))
				for i, doc := range docs {
					texts[i] = embedding.BuildEmbeddingText(doc.Title, doc.Abstract)
				}

				// Get embeddings in sub-batches
				allEmbeddings := make([][]float32, 0, len(docs))
				failed := false

				for i := 0; i < len(texts); i += idx.cfg.EmbedBatchSize {
					end := min(i+idx.cfg.EmbedBatchSize, len(texts))
					embeddings, err := idx.embedClient.GetEmbeddings(ctx, texts[i:end])
					if err != nil {
						atomic.AddInt64(&errors, int64(len(docs)))
						failed = true
						break
					}
					allEmbeddings = append(allEmbeddings, embeddings...)
				}

				if failed {
					progress.Update(int64(len(docs)))
					continue
				}

				// Create cache entries
				entries := make([]cache.CacheEntry, len(docs))
				for i, doc := range docs {
					authors := make([]cache.CachedAuthor, len(doc.Authors))
					for j, a := range doc.Authors {
						authors[j] = cache.CachedAuthor{
							AuthorID:             a.AuthorID,
							AuthorPosition:       a.AuthorPosition,
							AuthorName:           a.AuthorName,
							AuthorAvailableNames: a.AuthorAvailableNames,
						}
					}
				entries[i] = cache.CacheEntry{
					MongoID:         doc.ID,
					DocumentEID:     doc.DocumentEID,
					Title:           doc.Title,
					Abstract:        doc.Abstract,
					Authors:         authors,
					ExpertID:        doc.ExpertID,
					Kerberos:        doc.Kerberos,
					PublicationYear: doc.PublicationYear,
					FieldAssociated: doc.FieldAssociated,
					DocumentType:    doc.DocumentType,
					SubjectArea:     doc.SubjectArea,
					CitationCount:   doc.CitationCount,
					ReferenceCount:  doc.ReferenceCount,
					Embedding:       allEmbeddings[i],
				}
				}

				idx.cache.AddEntries(entries)
				atomic.AddInt64(&processed, int64(len(docs)))
				progress.Update(int64(len(docs)))
			}
		}()
	}

	wg.Wait()
	cancelSave()
	<-saveDone
	cancelProgress()
	idx.cli.ProgressDone()

	// Step 5: Save cache
	idx.cli.Step(5, 5, "Saving cache to disk")
	if err := idx.cache.Save(); err != nil {
		return fmt.Errorf("save cache: %w", err)
	}

	entries, size, _ := idx.cache.Stats()
	idx.cli.Success(fmt.Sprintf("Cache saved: %d entries, %s", entries, formatBytes(size)))

	elapsed := idx.cli.EndPhase()

	// Print summary
	idx.cli.Summary("Phase 1 Complete", map[string]string{
		"Processed":  fmt.Sprintf("%d", processed),
		"Errors":     fmt.Sprintf("%d", errors),
		"Skipped":    fmt.Sprintf("%d (already cached)", skipped),
		"Total Time": elapsed.String(),
		"Rate":       fmt.Sprintf("%.1f docs/sec", float64(processed)/elapsed.Seconds()),
	})

	return nil
}

// Phase2IndexAndUpdate reads from cache and indexes to OpenSearch
func (idx *Indexer) Phase2IndexAndUpdate(ctx context.Context) error {
	idx.cli.StartPhase("Phase 2: Index & Update")

	// Step 1: Load cache
	idx.cli.Step(1, 5, "Loading cache")
	if err := idx.cache.Load(); err != nil {
		return fmt.Errorf("load cache: %w", err)
	}

	entries := idx.cache.GetEntries()
	if len(entries) == 0 {
		idx.cli.Warning("No entries in cache. Run Phase 1 first.")
		idx.cli.EndPhase()
		return nil
	}
	idx.cli.Info(fmt.Sprintf("Loaded %d entries from cache", len(entries)))

	// Step 2: Ensure index exists
	idx.cli.Step(2, 5, "Checking OpenSearch index")
	if err := idx.openSearch.CreateIndex(ctx); err != nil {
		return fmt.Errorf("ensure index: %w", err)
	}

	// Step 3: Index to OpenSearch (parallel)
	bulkWorkers := max(1, idx.cfg.BulkIndexWorkers)
	idx.cli.Step(3, 5, "Indexing to OpenSearch")
	idx.cli.Running(fmt.Sprintf("Bulk indexing: batch size %d, %d workers", idx.cfg.OpenSearchBulkSize, bulkWorkers))

	var (
		indexed int64
		errors  int64
	)

	progress := cli.NewProgress(int64(len(entries)))

	progressCtx, cancelProgress := context.WithCancel(ctx)
	progressTicker := time.NewTicker(500 * time.Millisecond)
	go func() {
		defer progressTicker.Stop()
		for {
			select {
			case <-progressTicker.C:
				idx.cli.Progress(progress)
			case <-progressCtx.Done():
				return
			}
		}
	}()

	type indexResult struct {
		updates []mongodb.IDUpdate
		indexed int64
		errors  int64
		count   int64
	}

	batchChan := make(chan []cache.CacheEntry, bulkWorkers*2)
	resultChan := make(chan indexResult, bulkWorkers*2)

	var bulkWg sync.WaitGroup
	for w := 0; w < bulkWorkers; w++ {
		bulkWg.Add(1)
		go func() {
			defer bulkWg.Done()
			for batch := range batchChan {
				select {
				case <-ctx.Done():
					resultChan <- indexResult{errors: int64(len(batch)), count: int64(len(batch))}
					continue
				default:
				}

				osDocs := idx.buildOSDocuments(batch)
				idMap, err := idx.openSearch.BulkIndex(ctx, osDocs)

				r := indexResult{count: int64(len(batch))}
				if err != nil {
					r.errors = int64(len(batch))
				} else {
					r.indexed = int64(len(idMap))
					r.errors = int64(len(batch) - len(idMap))
					for _, entry := range batch {
						if osID, ok := idMap[entry.MongoID.Hex()]; ok {
							r.updates = append(r.updates, mongodb.IDUpdate{
								MongoID:      entry.MongoID,
								OpenSearchID: osID,
							})
						}
					}
				}
				resultChan <- r
			}
		}()
	}

	// Producer: feed batches to workers
	go func() {
		defer func() {
			close(batchChan)
			bulkWg.Wait()
			close(resultChan)
		}()
		for i := 0; i < len(entries); i += idx.cfg.OpenSearchBulkSize {
			end := min(i+idx.cfg.OpenSearchBulkSize, len(entries))
			select {
			case batchChan <- entries[i:end]:
			case <-ctx.Done():
				return
			}
		}
	}()

	// Collector (single goroutine — no atomics needed)
	var mongoUpdates []mongodb.IDUpdate
	for r := range resultChan {
		indexed += r.indexed
		errors += r.errors
		mongoUpdates = append(mongoUpdates, r.updates...)
		progress.Update(r.count)
	}

	cancelProgress()
	idx.cli.ProgressDone()
	idx.cli.Success(fmt.Sprintf("Indexed %d documents to OpenSearch", indexed))

	// Step 4: Single refresh (replaces per-batch Refresh:"true")
	idx.cli.Step(4, 5, "Refreshing OpenSearch index")
	if err := idx.openSearch.RefreshIndex(ctx); err != nil {
		idx.cli.Warning(fmt.Sprintf("Index refresh failed: %v", err))
	} else {
		idx.cli.Success("Index refreshed")
	}

	// Step 5: Update MongoDB (parallel)
	idx.cli.Step(5, 5, "Updating MongoDB")
	idx.cli.Running(fmt.Sprintf("Updating %d documents, %d workers", len(mongoUpdates), bulkWorkers))

	mongoProgress := cli.NewProgress(int64(len(mongoUpdates)))
	mongoProgressCtx, cancelMongoProgress := context.WithCancel(ctx)
	mongoProgressTicker := time.NewTicker(500 * time.Millisecond)
	go func() {
		defer mongoProgressTicker.Stop()
		for {
			select {
			case <-mongoProgressTicker.C:
				idx.cli.Progress(mongoProgress)
			case <-mongoProgressCtx.Done():
				return
			}
		}
	}()

	updateChan := make(chan []mongodb.IDUpdate, bulkWorkers*2)
	var updateWg sync.WaitGroup
	for w := 0; w < bulkWorkers; w++ {
		updateWg.Add(1)
		go func() {
			defer updateWg.Done()
			for batch := range updateChan {
				if err := idx.mongoDB.BulkUpdateOpenSearchIDs(ctx, batch); err != nil {
					idx.cli.Warning(fmt.Sprintf("MongoDB update batch failed: %v", err))
				}
				mongoProgress.Update(int64(len(batch)))
			}
		}()
	}

	for i := 0; i < len(mongoUpdates); i += idx.cfg.OpenSearchBulkSize {
		end := min(i+idx.cfg.OpenSearchBulkSize, len(mongoUpdates))
		updateChan <- mongoUpdates[i:end]
	}
	close(updateChan)
	updateWg.Wait()

	cancelMongoProgress()
	idx.cli.ProgressDone()
	idx.cli.Success(fmt.Sprintf("Updated %d MongoDB documents", len(mongoUpdates)))

	elapsed := idx.cli.EndPhase()

	idx.cli.Summary("Phase 2 Complete", map[string]string{
		"Indexed":    fmt.Sprintf("%d", indexed),
		"Errors":     fmt.Sprintf("%d", errors),
		"MongoDB":    fmt.Sprintf("%d updated", len(mongoUpdates)),
		"Total Time": elapsed.String(),
		"Rate":       fmt.Sprintf("%.1f docs/sec", float64(indexed)/elapsed.Seconds()),
	})

	return nil
}

// buildOSDocuments converts a batch of cache entries into OpenSearch documents
func (idx *Indexer) buildOSDocuments(batch []cache.CacheEntry) []opensearch.OSDocument {
	osDocs := make([]opensearch.OSDocument, len(batch))
	for j, entry := range batch {
		osAuthors := make([]opensearch.OSAuthor, len(entry.Authors))
		authorNames := make([]string, len(entry.Authors))
		allVariants := make([]string, 0)
		authorIDs := make([]string, 0, len(entry.Authors))

		for k, a := range entry.Authors {
			authorNames[k] = a.AuthorName
			if len(a.AuthorAvailableNames) > 0 {
				allVariants = append(allVariants, a.AuthorAvailableNames...)
			}
			position := 0
			if a.AuthorPosition != "" {
				fmt.Sscanf(a.AuthorPosition, "%d", &position)
			}
			osAuthors[k] = opensearch.OSAuthor{
				AuthorID:           a.AuthorID,
				AuthorName:         a.AuthorName,
				AuthorNameVariants: a.AuthorAvailableNames,
				AuthorPosition:     position,
			}
			if id := strings.TrimSpace(a.AuthorID); id != "" {
				authorIDs = append(authorIDs, id)
			}
		}

		osDocs[j] = opensearch.OSDocument{
			MongoID:            entry.MongoID.Hex(),
			Title:              entry.Title,
			Abstract:           entry.Abstract,
			Authors:            osAuthors,
			AuthorNames:        authorNames,
			AuthorNameVariants: allVariants,
			AuthorIDs:          authorIDs,
			ExpertID:           entry.ExpertID,
			Kerberos:           entry.Kerberos,
			PublicationYear:    entry.PublicationYear,
			FieldAssociated:    entry.FieldAssociated,
			DocumentType:       entry.DocumentType,
			SubjectArea:        entry.SubjectArea,
			SubjectAreaCount:   len(entry.SubjectArea),
			CitationCount:      entry.CitationCount,
			ReferenceCount:     entry.ReferenceCount,
			Embedding:          entry.Embedding,
		}
	}
	return osDocs
}

// RunBothPhases runs Phase 1 and Phase 2 sequentially
func (idx *Indexer) RunBothPhases(ctx context.Context, limit int, reindexAll bool) error {
	if err := idx.Phase1FetchAndEmbed(ctx, limit, reindexAll); err != nil {
		return fmt.Errorf("phase 1: %w", err)
	}

	if err := idx.Phase2IndexAndUpdate(ctx); err != nil {
		return fmt.Errorf("phase 2: %w", err)
	}

	return nil
}

// CacheStatus prints cache status
func (idx *Indexer) CacheStatus() {
	if err := idx.cache.Load(); err != nil {
		idx.cli.CacheStatus(false, 0, 0, nil)
		return
	}

	entries, size, _ := idx.cache.Stats()
	meta := idx.cache.GetMetadata()

	metadata := map[string]string{}
	if !meta.CreatedAt.IsZero() {
		metadata["Created"] = meta.CreatedAt.Format(time.RFC3339)
	}
	if !meta.LastModified.IsZero() {
		metadata["Modified"] = meta.LastModified.Format(time.RFC3339)
	}
	if meta.TotalDocs > 0 {
		metadata["Total Docs"] = fmt.Sprintf("%d", meta.TotalDocs)
	}

	idx.cli.CacheStatus(idx.cache.Exists(), entries, size, metadata)
}

// ClearCache removes all cache files
func (idx *Indexer) ClearCache() error {
	if err := idx.cache.Clear(); err != nil {
		return err
	}
	idx.cli.Success("Cache cleared")
	return nil
}

// CreateIndex creates the OpenSearch index
func (idx *Indexer) CreateIndex(ctx context.Context) error {
	idx.cli.Info("Creating OpenSearch index...")
	if err := idx.openSearch.CreateIndex(ctx); err != nil {
		return err
	}
	idx.cli.Success("Index created")
	return nil
}

// DeleteIndex deletes the OpenSearch index
func (idx *Indexer) DeleteIndex(ctx context.Context) error {
	idx.cli.Info("Deleting OpenSearch index...")
	if err := idx.openSearch.DeleteIndex(ctx); err != nil {
		return err
	}
	idx.cli.Success("Index deleted")
	return nil
}

// ClearMongoIDs clears all OpenSearch IDs in MongoDB
func (idx *Indexer) ClearMongoIDs(ctx context.Context) error {
	idx.cli.Info("Clearing MongoDB OpenSearch IDs...")
	if err := idx.mongoDB.ClearOpenSearchIDs(ctx); err != nil {
		return err
	}
	idx.cli.Success("MongoDB IDs cleared")
	return nil
}

// ReindexFull performs a complete reindex
func (idx *Indexer) ReindexFull(ctx context.Context) error {
	idx.cli.StartPhase("Full Reindex")

	idx.cli.Step(1, 5, "Deleting existing index")
	if err := idx.DeleteIndex(ctx); err != nil {
		idx.cli.Warning(fmt.Sprintf("Delete failed (may not exist): %v", err))
	}

	idx.cli.Step(2, 5, "Creating new index")
	if err := idx.CreateIndex(ctx); err != nil {
		return err
	}

	idx.cli.Step(3, 5, "Clearing MongoDB IDs")
	if err := idx.ClearMongoIDs(ctx); err != nil {
		return err
	}

	idx.cli.Step(4, 5, "Clearing cache")
	idx.cache.Clear()

	idx.cli.Step(5, 5, "Running two-phase indexing")
	idx.cli.EndPhase()

	return idx.RunBothPhases(ctx, 0, true)
}

// formatBytes formats bytes in human-readable format
func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
