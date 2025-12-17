package indexer

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/schollz/progressbar/v3"

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
}

// New creates a new Indexer instance
func New(cfg *config.Config) (*Indexer, error) {
	mongoDB, err := mongodb.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("mongodb connect: %w", err)
	}
	log.Println("✓ Connected to MongoDB")

	osClient, err := opensearch.NewClient(cfg)
	if err != nil {
		mongoDB.Close(context.Background())
		return nil, fmt.Errorf("opensearch connect: %w", err)
	}
	log.Println("✓ Connected to OpenSearch")

	embedClient := embedding.NewClient(cfg)
	log.Println("✓ Embedding client initialized")

	return &Indexer{
		cfg:         cfg,
		mongoDB:     mongoDB,
		openSearch:  osClient,
		embedClient: embedClient,
	}, nil
}

// Close cleans up all connections
func (idx *Indexer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	idx.mongoDB.Close(ctx)
	idx.openSearch.Close()
	log.Println("✓ All connections closed")
}

// embeddedBatch holds a batch of documents with their embeddings ready for indexing
type embeddedBatch struct {
	docs       []mongodb.Document
	embeddings [][]float32
}

// mongoUpdate holds MongoDB update info for async processing
type mongoUpdate struct {
	updates []mongodb.IDUpdate
}

// pipelineStats tracks live stats for each pipeline stage
type pipelineStats struct {
	batchesInFetch int64 // batches being collected from MongoDB
	batchesInEmbed int64 // batches being embedded
	batchesInIndex int64 // batches being indexed to OpenSearch
	batchesInSync  int64 // batches being synced back to MongoDB
	docsInEmbed    int64 // total docs currently embedding
	docsInIndex    int64 // total docs currently indexing
	docsInSync     int64 // total docs pending/syncing to MongoDB
}

// Run executes the indexing process with optimized pipeline parallelism
// Pipeline stages run concurrently:
//  1. MongoDB streaming → batchChan (fetches docs)
//  2. Embedding workers → embeddedChan (generates embeddings)
//  3. OpenSearch indexing → mongoUpdateChan (bulk indexes)
//  4. MongoDB update workers (async updates, non-blocking)
func (idx *Indexer) Run(ctx context.Context, limit int, reindexAll bool) error {
	startTime := time.Now()

	// Count documents
	total, err := idx.mongoDB.CountDocumentsToIndex(ctx, reindexAll)
	if err != nil {
		return fmt.Errorf("count documents: %w", err)
	}

	if limit > 0 && int64(limit) < total {
		total = int64(limit)
	}

	if total == 0 {
		log.Println("No documents to index")
		return nil
	}

	log.Printf("Found %d documents to index", total)
	log.Println("⚡ Pipeline mode: MongoDB fetch || Embedding || OpenSearch index || MongoDB update")

	// Stream documents from MongoDB
	docChan, err := idx.mongoDB.StreamDocuments(ctx, reindexAll, limit)
	if err != nil {
		return fmt.Errorf("stream documents: %w", err)
	}

	// Create progress bar
	bar := progressbar.NewOptions64(total,
		progressbar.OptionSetDescription("[cyan]Starting...[reset]"),
		progressbar.OptionShowCount(),
		progressbar.OptionShowIts(),
		progressbar.OptionSetWriter(os.Stdout),
		progressbar.OptionSetRenderBlankState(true),
		progressbar.OptionEnableColorCodes(true),
		progressbar.OptionFullWidth(),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "[green]█[reset]",
			SaucerHead:    "[green]█[reset]",
			SaucerPadding: "░",
			BarStart:      "|",
			BarEnd:        "|",
		}),
	)

	var (
		successCount int64
		errorCount   int64
		stats        pipelineStats
	)

	// Status updater goroutine - updates progress bar description with live pipeline status
	statusCtx, cancelStatus := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond) // Faster updates for responsiveness
		defer ticker.Stop()
		for {
			select {
			case <-statusCtx.Done():
				return
			case <-ticker.C:
				bFetch := atomic.LoadInt64(&stats.batchesInFetch)
				bEmbed := atomic.LoadInt64(&stats.batchesInEmbed)
				bIndex := atomic.LoadInt64(&stats.batchesInIndex)
				bSync := atomic.LoadInt64(&stats.batchesInSync)
				dEmbed := atomic.LoadInt64(&stats.docsInEmbed)
				dIndex := atomic.LoadInt64(&stats.docsInIndex)
				dSync := atomic.LoadInt64(&stats.docsInSync)

				// Build status string showing active stages with batch counts
				var parts []string
				if bFetch > 0 {
					parts = append(parts, fmt.Sprintf("[cyan]📥Fetch[reset]"))
				}
				if bEmbed > 0 || dEmbed > 0 {
					parts = append(parts, fmt.Sprintf("[yellow]🧠Embed:%d[reset]", dEmbed))
				}
				if bIndex > 0 || dIndex > 0 {
					parts = append(parts, fmt.Sprintf("[green]⚡Index:%d[reset]", dIndex))
				}
				if bSync > 0 || dSync > 0 {
					parts = append(parts, fmt.Sprintf("[magenta]💾Sync:%d[reset]", dSync))
				}

				status := "[cyan]Starting...[reset]"
				if len(parts) > 0 {
					status = ""
					for i, p := range parts {
						if i > 0 {
							status += " → "
						}
						status += p
					}
				}
				bar.Describe(status)
			}
		}
	}()

	// ═══════════════════════════════════════════════════════════════════
	// STAGE 1: Batch collector - collects docs into batches
	// ═══════════════════════════════════════════════════════════════════
	batchChan := make(chan []mongodb.Document, idx.cfg.NumWorkers*2)
	go func() {
		defer close(batchChan)
		atomic.StoreInt64(&stats.batchesInFetch, 1) // Mark fetching active

		batch := make([]mongodb.Document, 0, idx.cfg.MongoBatchSize)
		for doc := range docChan {
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
		atomic.StoreInt64(&stats.batchesInFetch, 0) // Mark fetching done
	}()

	// ═══════════════════════════════════════════════════════════════════
	// STAGE 2: Embedding workers - process batches and generate embeddings
	// NOTE: Embedding client has internal semaphore (max 2 concurrent requests)
	// So we can have more workers - they'll queue at the semaphore
	// ═══════════════════════════════════════════════════════════════════
	embeddedChan := make(chan embeddedBatch, idx.cfg.NumWorkers*2) // Larger buffer
	var embedWg sync.WaitGroup

	// Workers for embedding - semaphore in client limits actual concurrency
	embedWorkers := max(2, idx.cfg.NumWorkers)
	for i := 0; i < embedWorkers; i++ {
		embedWg.Add(1)
		go func() {
			defer embedWg.Done()
			for docs := range batchChan {
				select {
				case <-ctx.Done():
					return
				default:
				}

				atomic.AddInt64(&stats.batchesInEmbed, 1)
				atomic.AddInt64(&stats.docsInEmbed, int64(len(docs)))

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
						log.Printf("Embedding error: %v", err)
						atomic.AddInt64(&errorCount, int64(len(docs)))
						bar.Add(len(docs))
						failed = true
						break
					}
					allEmbeddings = append(allEmbeddings, embeddings...)
				}

				atomic.AddInt64(&stats.batchesInEmbed, -1)
				atomic.AddInt64(&stats.docsInEmbed, -int64(len(docs)))

				if !failed {
					select {
					case embeddedChan <- embeddedBatch{docs: docs, embeddings: allEmbeddings}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}

	// Close embeddedChan when all embedding workers done
	go func() {
		embedWg.Wait()
		close(embeddedChan)
	}()

	// ═══════════════════════════════════════════════════════════════════
	// STAGE 3: MongoDB update workers - async, non-blocking updates
	// Fire-and-forget: don't block indexing pipeline waiting for MongoDB updates
	// NOTE: Limited workers for free tier to reduce concurrent connections
	// ═══════════════════════════════════════════════════════════════════
	mongoUpdateChan := make(chan mongoUpdate, idx.cfg.NumWorkers*4) // Large buffer for async
	var mongoWg sync.WaitGroup

	// Single worker for MongoDB updates on free tier to avoid connection overload
	mongoWorkers := 1 // Fixed to 1 for free tier - bulk writes are already batched
	for i := 0; i < mongoWorkers; i++ {
		mongoWg.Add(1)
		go func() {
			defer mongoWg.Done()
			for update := range mongoUpdateChan {
				if len(update.updates) > 0 {
					atomic.AddInt64(&stats.batchesInSync, 1)
					if err := idx.mongoDB.BulkUpdateOpenSearchIDs(ctx, update.updates); err != nil {
						log.Printf("MongoDB bulk update error (async): %v", err)
					}
					atomic.AddInt64(&stats.docsInSync, -int64(len(update.updates)))
					atomic.AddInt64(&stats.batchesInSync, -1)
				}
			}
		}()
	}

	// ═══════════════════════════════════════════════════════════════════
	// STAGE 4: OpenSearch indexing workers
	// Processes embedded batches and sends MongoDB updates asynchronously
	// Can have more workers since OpenSearch handles bulk well
	// ═══════════════════════════════════════════════════════════════════
	var indexWg sync.WaitGroup
	indexWorkers := max(2, idx.cfg.NumWorkers)
	for i := 0; i < indexWorkers; i++ {
		indexWg.Add(1)
		go func() {
			defer indexWg.Done()
			for batch := range embeddedChan {
				select {
				case <-ctx.Done():
					return
				default:
				}

				atomic.AddInt64(&stats.batchesInIndex, 1)
				atomic.AddInt64(&stats.docsInIndex, int64(len(batch.docs)))

				// Build OpenSearch documents
				osDocs := make([]opensearch.OSDocument, len(batch.docs))
				for i, doc := range batch.docs {
					authorNames := make([]string, len(doc.Authors))
					for j, a := range doc.Authors {
						authorNames[j] = a.AuthorName
					}
					osDocs[i] = opensearch.OSDocument{
						MongoID:         doc.ID.Hex(),
						Title:           doc.Title,
						Abstract:        doc.Abstract,
						AuthorNames:     authorNames,
						PublicationYear: doc.PublicationYear,
						FieldAssociated: doc.FieldAssociated,
						DocumentType:    doc.DocumentType,
						SubjectArea:     doc.SubjectArea,
						CitationCount:   doc.CitationCount,
						Embedding:       batch.embeddings[i],
					}
				}

				// Bulk index to OpenSearch
				idMap, err := idx.openSearch.BulkIndex(ctx, osDocs)
				atomic.AddInt64(&stats.batchesInIndex, -1)
				atomic.AddInt64(&stats.docsInIndex, -int64(len(batch.docs)))

				if err != nil {
					log.Printf("Bulk index error: %v", err)
					atomic.AddInt64(&errorCount, int64(len(batch.docs)))
					bar.Add(len(batch.docs))
					continue
				}

				atomic.AddInt64(&successCount, int64(len(idMap)))
				atomic.AddInt64(&errorCount, int64(len(batch.docs)-len(idMap)))
				bar.Add(len(batch.docs))

				// Queue MongoDB update asynchronously - DON'T WAIT
				updates := make([]mongodb.IDUpdate, 0, len(idMap))
				for _, doc := range batch.docs {
					if osID, ok := idMap[doc.ID.Hex()]; ok {
						updates = append(updates, mongodb.IDUpdate{MongoID: doc.ID, OpenSearchID: osID})
					}
				}
				if len(updates) > 0 {
					atomic.AddInt64(&stats.docsInSync, int64(len(updates)))
					select {
					case mongoUpdateChan <- mongoUpdate{updates: updates}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}

	// Wait for indexing to complete
	indexWg.Wait()

	// Close MongoDB update channel and wait for updates to finish
	close(mongoUpdateChan)

	// Update status to show we're finishing MongoDB updates
	bar.Describe("[magenta]💾 Finishing MongoDB sync...[reset]")
	mongoWg.Wait()

	// Stop status updater
	cancelStatus()

	bar.Describe("[green]✓ Complete[reset]")
	bar.Finish()

	// Print summary
	elapsed := time.Since(startTime)
	rate := float64(successCount) / elapsed.Seconds()

	fmt.Println()
	fmt.Println("╔═══════════════════════════════════════════════════════════╗")
	fmt.Println("║  Indexing Complete (Pipeline Mode)                        ║")
	fmt.Println("║  ─────────────────────────────────────────────────────────║")
	fmt.Printf("║  Total Processed:     %6d                              ║\n", successCount+errorCount)
	fmt.Printf("║  Successful:          %6d                              ║\n", successCount)
	fmt.Printf("║  Errors:              %6d                              ║\n", errorCount)
	fmt.Printf("║  Time Elapsed:      %7.2fs                            ║\n", elapsed.Seconds())
	fmt.Printf("║  Rate:              %7.1f docs/sec                    ║\n", rate)
	fmt.Println("╚═══════════════════════════════════════════════════════════╝")

	return nil
}

// CreateIndex creates the OpenSearch index
func (idx *Indexer) CreateIndex(ctx context.Context) error {
	return idx.openSearch.CreateIndex(ctx)
}
