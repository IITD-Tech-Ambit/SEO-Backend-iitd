package opensearch

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/opensearch-project/opensearch-go/v2"
	"github.com/opensearch-project/opensearch-go/v2/opensearchapi"

	"github.com/sudarshan/indexer/internal/config"
)

// Client wraps OpenSearch operations
type Client struct {
	client *opensearch.Client
	cfg    *config.Config
}

// OSAuthor represents a nested author document in OpenSearch
type OSAuthor struct {
	AuthorID           string   `json:"author_id"`
	AuthorName         string   `json:"author_name"`
	AuthorNameVariants []string `json:"author_name_variants"`
	AuthorPosition     int      `json:"author_position"`
}

// OSDocument represents a document to be indexed in OpenSearch
type OSDocument struct {
	MongoID            string     `json:"mongo_id"`
	Title              string     `json:"title"`
	Abstract           string     `json:"abstract"`
	Authors            []OSAuthor `json:"authors"`
	AuthorNames        []string   `json:"author_names"`         // Flat list for backward compatibility
	AuthorNameVariants []string   `json:"author_name_variants"` // All name variants
	// AuthorIDs: flat Scopus author IDs for terms aggregations (faculty-for-query). Mirrors Python indexer.
	AuthorIDs []string `json:"author_ids"`
	ExpertID  string   `json:"expert_id"`
	Kerberos  string   `json:"kerberos"`
	PublicationYear    int        `json:"publication_year"`
	FieldAssociated    string     `json:"field_associated"`
	DocumentType       string     `json:"document_type"`
	SubjectArea        []string   `json:"subject_area"`
	SubjectAreaCount   int        `json:"subject_area_count"`
	CitationCount      int        `json:"citation_count"`
	ReferenceCount     int        `json:"reference_count"`
	Embedding          []float32  `json:"embedding"`
}

// NewClient creates a new OpenSearch client
func NewClient(cfg *config.Config) (*Client, error) {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: !cfg.OpenSearchVerifyCerts,
		},
	}

	client, err := opensearch.NewClient(opensearch.Config{
		Addresses: cfg.OpenSearchHosts,
		Username:  cfg.OpenSearchUser,
		Password:  cfg.OpenSearchPassword,
		Transport: transport,
	})
	if err != nil {
		return nil, fmt.Errorf("create opensearch client: %w", err)
	}

	// Verify connection
	res, err := client.Info()
	if err != nil {
		return nil, fmt.Errorf("opensearch info: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("opensearch error: %s", res.String())
	}

	return &Client{
		client: client,
		cfg:    cfg,
	}, nil
}

// BulkIndex indexes multiple documents at once
// Returns map of mongo_id -> opensearch_id for successful indexes
func (c *Client) BulkIndex(ctx context.Context, docs []OSDocument) (map[string]string, error) {
	if len(docs) == 0 {
		return map[string]string{}, nil
	}

	var buf bytes.Buffer
	for _, doc := range docs {
		// Action line
		indexMeta := map[string]interface{}{
			"_index": c.cfg.OpenSearchIndex,
		}
		if doc.MongoID != "" {
			indexMeta["_id"] = doc.MongoID
		}
		action := map[string]interface{}{
			"index": indexMeta,
		}
		actionBytes, _ := json.Marshal(action)
		buf.Write(actionBytes)
		buf.WriteByte('\n')

		// Document line
		docBytes, _ := json.Marshal(doc)
		buf.Write(docBytes)
		buf.WriteByte('\n')
	}

	req := opensearchapi.BulkRequest{
		Body: bytes.NewReader(buf.Bytes()),
	}

	res, err := req.Do(ctx, c.client)
	if err != nil {
		return nil, fmt.Errorf("bulk request: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("bulk error: %s", res.String())
	}

	// Parse response to get IDs
	var bulkRes struct {
		Items []struct {
			Index struct {
				ID     string `json:"_id"`
				Result string `json:"result"`
				Status int    `json:"status"`
			} `json:"index"`
		} `json:"items"`
	}
	if err := json.NewDecoder(res.Body).Decode(&bulkRes); err != nil {
		return nil, fmt.Errorf("decode bulk response: %w", err)
	}

	// Build mongo_id -> os_id map
	idMap := make(map[string]string)
	for i, item := range bulkRes.Items {
		if item.Index.Status >= 200 && item.Index.Status < 300 {
			idMap[docs[i].MongoID] = item.Index.ID
		}
	}

	return idMap, nil
}

// CreateIndex ensures a single concrete index named OPENSEARCH_INDEX (no alias).
func (c *Client) CreateIndex(ctx context.Context) error {
	exists, err := c.concreteIndexExists(ctx)
	if err != nil {
		return fmt.Errorf("check index exists: %w", err)
	}
	if exists {
		fmt.Printf("Index %s already exists (concrete)\n", c.cfg.OpenSearchIndex)
		return nil
	}

	createReq := opensearchapi.IndicesCreateRequest{
		Index: c.cfg.OpenSearchIndex,
		Body:  strings.NewReader(indexMappingJSON),
	}

	res, err := createReq.Do(ctx, c.client)
	if err != nil {
		return fmt.Errorf("create index: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("create index error: %s", res.String())
	}

	fmt.Printf("Created concrete index %s (no alias)\n", c.cfg.OpenSearchIndex)
	return nil
}

// DeleteIndex removes legacy aliases and deletes all research_documents* concrete indices
// so reindex-full leaves exactly one target index name for CreateIndex.
func (c *Client) DeleteIndex(ctx context.Context) error {
	name := c.cfg.OpenSearchIndex

	// Only remove alias when it actually exists (skip for concrete-only setup).
	backing, err := c.aliasBackingIndices(ctx, name)
	if err != nil {
		return fmt.Errorf("lookup alias %s: %w", name, err)
	}
	if len(backing) > 0 {
		if err := c.removeAlias(ctx, name, backing); err != nil {
			return fmt.Errorf("remove alias %s: %w", name, err)
		}
		fmt.Printf("Removed alias %s from: %s\n", name, strings.Join(backing, ", "))
	}

	toDelete, err := c.collectIndicesToRemove(ctx)
	if err != nil {
		return fmt.Errorf("collect indices to remove: %w", err)
	}

	if len(toDelete) > 0 {
		if err := c.deleteConcreteIndices(ctx, toDelete); err != nil {
			return fmt.Errorf("delete concrete indices: %w", err)
		}
		fmt.Printf("Deleted concrete indices: %s\n", strings.Join(toDelete, ", "))
	}

	// Verify: no alias and no concrete index with that name.
	backing, err = c.aliasBackingIndices(ctx, name)
	if err != nil {
		return err
	}
	if len(backing) > 0 {
		return fmt.Errorf("alias %s still points at %v after delete", name, backing)
	}
	exists, err := c.concreteIndexExists(ctx)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("index %s still exists after delete", name)
	}

	fmt.Printf("OpenSearch ready for single index %s (aliases and legacy indices removed)\n", name)
	return nil
}

// RefreshIndex forces a refresh so recently indexed documents become searchable.
// Call once at the end of bulk indexing instead of per-batch Refresh:"true".
func (c *Client) RefreshIndex(ctx context.Context) error {
	res, err := c.client.Indices.Refresh(
		c.client.Indices.Refresh.WithContext(ctx),
		c.client.Indices.Refresh.WithIndex(c.cfg.OpenSearchIndex),
	)
	if err != nil {
		return fmt.Errorf("refresh index: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return fmt.Errorf("refresh index error: %s", res.String())
	}
	return nil
}

// Close closes the client (no-op for opensearch-go but kept for interface consistency)
func (c *Client) Close() error {
	return nil
}
