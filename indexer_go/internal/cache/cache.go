package cache

import (
	"encoding/gob"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson/primitive"
)

// CacheEntry holds a document with its computed embedding
type CacheEntry struct {
	MongoID         primitive.ObjectID
	DocumentEID     string
	Title           string
	Abstract        string
	Authors         []CachedAuthor
	PublicationYear int
	FieldAssociated string
	DocumentType    string
	SubjectArea     []string
	CitationCount   int
	ReferenceCount  int
	Embedding       []float32
	ProcessedAt     time.Time
}

// CachedAuthor holds author info for cache
type CachedAuthor struct {
	AuthorID             string
	AuthorPosition       string
	AuthorName           string
	AuthorEmail          string
	AuthorAvailableNames []string
	AuthorAffiliation    string
	HasMatchedProfile    bool
}

// CacheMetadata stores information about the cache state
type CacheMetadata struct {
	Version      int
	CreatedAt    time.Time
	LastModified time.Time
	TotalDocs    int64
	ProcessedAt  time.Time
	ReindexAll   bool
}

// Cache manages the intermediate cache file for embeddings
type Cache struct {
	dir          string
	mu           sync.RWMutex
	metadata     CacheMetadata
	entries      []CacheEntry
	processedIDs map[string]bool // Quick lookup of processed MongoDB IDs
}

// NewCache creates a new cache instance
func NewCache(cacheDir string) (*Cache, error) {
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return nil, fmt.Errorf("create cache dir: %w", err)
	}

	c := &Cache{
		dir:          cacheDir,
		entries:      make([]CacheEntry, 0),
		processedIDs: make(map[string]bool),
	}

	return c, nil
}

// cacheFilePath returns the path to the cache file
func (c *Cache) cacheFilePath() string {
	return filepath.Join(c.dir, "embeddings.gob")
}

// metadataFilePath returns the path to the metadata file
func (c *Cache) metadataFilePath() string {
	return filepath.Join(c.dir, "metadata.gob")
}

// Load reads the cache from disk
func (c *Cache) Load() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Load metadata
	metaFile, err := os.Open(c.metadataFilePath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil // No cache exists yet
		}
		return fmt.Errorf("open metadata: %w", err)
	}
	defer metaFile.Close()

	if err := gob.NewDecoder(metaFile).Decode(&c.metadata); err != nil {
		return fmt.Errorf("decode metadata: %w", err)
	}

	// Load entries
	cacheFile, err := os.Open(c.cacheFilePath())
	if err != nil {
		return fmt.Errorf("open cache: %w", err)
	}
	defer cacheFile.Close()

	if err := gob.NewDecoder(cacheFile).Decode(&c.entries); err != nil {
		return fmt.Errorf("decode cache: %w", err)
	}

	// Build processed IDs map
	c.processedIDs = make(map[string]bool, len(c.entries))
	for _, e := range c.entries {
		c.processedIDs[e.MongoID.Hex()] = true
	}

	return nil
}

// Save writes the cache to disk
func (c *Cache) Save() error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Update metadata
	c.metadata.LastModified = time.Now()
	c.metadata.Version = 1

	// Save metadata
	metaFile, err := os.Create(c.metadataFilePath())
	if err != nil {
		return fmt.Errorf("create metadata: %w", err)
	}
	defer metaFile.Close()

	if err := gob.NewEncoder(metaFile).Encode(c.metadata); err != nil {
		return fmt.Errorf("encode metadata: %w", err)
	}

	// Save entries
	cacheFile, err := os.Create(c.cacheFilePath())
	if err != nil {
		return fmt.Errorf("create cache: %w", err)
	}
	defer cacheFile.Close()

	if err := gob.NewEncoder(cacheFile).Encode(c.entries); err != nil {
		return fmt.Errorf("encode cache: %w", err)
	}

	return nil
}

// AddEntry adds a new entry to the cache (thread-safe)
func (c *Cache) AddEntry(entry CacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry.ProcessedAt = time.Now()
	c.entries = append(c.entries, entry)
	c.processedIDs[entry.MongoID.Hex()] = true
}

// AddEntries adds multiple entries to the cache (thread-safe)
func (c *Cache) AddEntries(entries []CacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	for i := range entries {
		entries[i].ProcessedAt = now
		c.processedIDs[entries[i].MongoID.Hex()] = true
	}
	c.entries = append(c.entries, entries...)
}

// IsProcessed checks if a document ID has already been processed
func (c *Cache) IsProcessed(mongoID string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.processedIDs[mongoID]
}

// GetEntries returns all cached entries
func (c *Cache) GetEntries() []CacheEntry {
	c.mu.RLock()
	defer c.mu.RUnlock()

	result := make([]CacheEntry, len(c.entries))
	copy(result, c.entries)
	return result
}

// Count returns the number of cached entries
func (c *Cache) Count() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}

// SetMetadata updates cache metadata
func (c *Cache) SetMetadata(totalDocs int64, reindexAll bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.metadata.CreatedAt.IsZero() {
		c.metadata.CreatedAt = time.Now()
	}
	c.metadata.TotalDocs = totalDocs
	c.metadata.ReindexAll = reindexAll
}

// GetMetadata returns cache metadata
func (c *Cache) GetMetadata() CacheMetadata {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.metadata
}

// Clear removes all cache files
func (c *Cache) Clear() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries = make([]CacheEntry, 0)
	c.processedIDs = make(map[string]bool)
	c.metadata = CacheMetadata{}

	// Remove files
	os.Remove(c.cacheFilePath())
	os.Remove(c.metadataFilePath())

	return nil
}

// Exists checks if cache files exist
func (c *Cache) Exists() bool {
	_, err := os.Stat(c.cacheFilePath())
	return err == nil
}

// Stats returns cache statistics
func (c *Cache) Stats() (entries int, sizeBytes int64, err error) {
	c.mu.RLock()
	entries = len(c.entries)
	c.mu.RUnlock()

	info, err := os.Stat(c.cacheFilePath())
	if err != nil {
		if os.IsNotExist(err) {
			return entries, 0, nil
		}
		return 0, 0, err
	}
	return entries, info.Size(), nil
}
