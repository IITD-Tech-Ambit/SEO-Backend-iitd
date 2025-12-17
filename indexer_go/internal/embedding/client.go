package embedding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/sudarshan/indexer/internal/config"
)

// EmbedRequest is the request body for the embedding service
type EmbedRequest struct {
	Texts []string `json:"texts"`
}

// EmbedResponse is the response from the embedding service
type EmbedResponse struct {
	Embeddings [][]float32 `json:"embeddings"`
}

// Client handles communication with the embedding service
type Client struct {
	httpClient *http.Client
	baseURL    string
	cfg        *config.Config
	semaphore  chan struct{} // Limits concurrent requests to embedding service
	mu         sync.Mutex    // Protects request timing
	lastReq    time.Time     // Time of last request for rate limiting
}

// NewClient creates a new embedding service client with connection pooling and rate limiting
func NewClient(cfg *config.Config) *Client {
	// Allow max 2 concurrent embedding requests to avoid overwhelming the service
	maxConcurrent := 2

	return &Client{
		httpClient: &http.Client{
			Timeout: time.Duration(cfg.EmbeddingTimeout) * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: maxConcurrent,
				IdleConnTimeout:     60 * time.Second,
			},
		},
		baseURL:   cfg.EmbeddingServiceURL,
		cfg:       cfg,
		semaphore: make(chan struct{}, maxConcurrent),
	}
}

// GetEmbeddings fetches embeddings for the given texts with retry logic and rate limiting
func (c *Client) GetEmbeddings(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}

	// Acquire semaphore to limit concurrent requests
	select {
	case c.semaphore <- struct{}{}:
		defer func() { <-c.semaphore }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	// Rate limiting: ensure minimum gap between requests
	c.mu.Lock()
	elapsed := time.Since(c.lastReq)
	if elapsed < 100*time.Millisecond {
		time.Sleep(100*time.Millisecond - elapsed)
	}
	c.lastReq = time.Now()
	c.mu.Unlock()

	var lastErr error
	for attempt := 0; attempt < c.cfg.MaxRetries; attempt++ {
		embeddings, err := c.doRequest(ctx, texts)
		if err == nil {
			return embeddings, nil
		}
		lastErr = err

		if attempt < c.cfg.MaxRetries-1 {
			// Exponential backoff: 1s, 2s, 4s...
			backoff := time.Duration(1<<attempt) * time.Second
			if backoff > 10*time.Second {
				backoff = 10 * time.Second
			}
			time.Sleep(backoff)
		}
	}

	return nil, fmt.Errorf("failed after %d retries: %w", c.cfg.MaxRetries, lastErr)
}

func (c *Client) doRequest(ctx context.Context, texts []string) ([][]float32, error) {
	reqBody, err := json.Marshal(EmbedRequest{Texts: texts})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/embed", bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}

	var result EmbedResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return result.Embeddings, nil
}

// BuildEmbeddingText creates the text for embedding using SPECTER2 format
func BuildEmbeddingText(title, abstract string) string {
	if abstract == "" {
		return title
	}
	return title + " [SEP] " + abstract
}
