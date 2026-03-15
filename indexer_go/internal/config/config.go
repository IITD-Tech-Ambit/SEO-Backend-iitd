package config

import (
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config holds all configuration values
type Config struct {
	// MongoDB
	MongoURI          string
	MongoCollection   string
	MongoMaxPoolSize  int // Connection pool limit for free tier
	MongoFetchDelayMs int // Delay between fetches to avoid overwhelming free tier
	MongoBulkDelayMs  int // Delay between bulk writes

	// OpenSearch
	OpenSearchHosts       []string
	OpenSearchUser        string
	OpenSearchPassword    string
	OpenSearchIndex       string
	OpenSearchVerifyCerts bool

	// Embedding Service
	EmbeddingServiceURL string
	EmbeddingTimeout    int

	// Batch sizes
	MongoBatchSize     int
	EmbedBatchSize     int
	OpenSearchBulkSize int

	// Workers
	NumWorkers int

	// Retry
	MaxRetries int
	RetryDelay int

	// Cache (for two-phase indexing)
	CacheDir string
}

// Load reads configuration from environment variables
func Load() *Config {
	// Load .env file if present
	_ = godotenv.Load()

	return &Config{
		// MongoDB
		MongoURI:          getEnv("MONGODB_URI", "mongodb://localhost:27017/research_db"),
		MongoCollection:   getEnv("MONGODB_COLLECTION", "researchmetadatascopuses"),
		MongoMaxPoolSize:  getEnvInt("MONGO_MAX_POOL_SIZE", 20), // Increased for higher concurrency
		MongoFetchDelayMs: getEnvInt("MONGO_FETCH_DELAY_MS", 5), // Small delay between cursor reads
		MongoBulkDelayMs:  getEnvInt("MONGO_BULK_DELAY_MS", 50), // Delay between bulk writes

		// OpenSearch
		OpenSearchHosts:       strings.Split(getEnv("OPENSEARCH_HOSTS", "https://localhost:9200"), ","),
		OpenSearchUser:        getEnv("OPENSEARCH_USER", "admin"),
		OpenSearchPassword:    getEnv("OPENSEARCH_PASSWORD", "admin"),
		OpenSearchIndex:       getEnv("OPENSEARCH_INDEX", "research_documents"),
		OpenSearchVerifyCerts: getEnv("OPENSEARCH_VERIFY_CERTS", "false") == "true",

		// Embedding
		EmbeddingServiceURL: getEnv("EMBEDDING_SERVICE_URL", "http://localhost:8001"),
		EmbeddingTimeout:    getEnvInt("EMBEDDING_TIMEOUT", 60), // Increased from 30s for slower services

		// Batch sizes - smaller for free tier
		MongoBatchSize:     getEnvInt("MONGO_BATCH_SIZE", 100),     // Increased from 50
		EmbedBatchSize:     getEnvInt("EMBED_BATCH_SIZE", 128),     // Optimal for TEI
		OpenSearchBulkSize: getEnvInt("OPENSEARCH_BULK_SIZE", 100), // Increased from 50

		// Workers - fewer for free tier to reduce concurrent MongoDB load
		NumWorkers: getEnvInt("NUM_WORKERS", 8), // Increased for TEI

		// Retry
		MaxRetries: getEnvInt("MAX_RETRIES", 3),
		RetryDelay: getEnvInt("RETRY_DELAY", 5),

		// Cache
		CacheDir: getEnv("CACHE_DIR", ".cache"),
	}
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return defaultVal
}
