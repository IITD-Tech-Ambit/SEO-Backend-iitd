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
		action := map[string]interface{}{
			"index": map[string]interface{}{
				"_index": c.cfg.OpenSearchIndex,
			},
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

// CreateIndex creates the OpenSearch index with enhanced mappings
// Features:
// - Custom BM25 parameters (k1=1.8, b=0.6) tuned for academic text
// - Shingle analyzer for phrase matching
// - Nested author mapping with name variants
// - Subject area count for interdisciplinary filtering
func (c *Client) CreateIndex(ctx context.Context) error {
	// Check if index exists
	res, err := c.client.Indices.Exists([]string{c.cfg.OpenSearchIndex})
	if err != nil {
		return fmt.Errorf("check index exists: %w", err)
	}
	res.Body.Close()

	if res.StatusCode == 200 {
		fmt.Printf("Index %s already exists\n", c.cfg.OpenSearchIndex)
		return nil
	}

	mapping := `{
		"settings": {
			"index": {
				"knn": true,
				"knn.algo_param.ef_search": 300,
				"number_of_shards": 3,
				"number_of_replicas": 1,
				"max_ngram_diff": 8,
				"max_shingle_diff": 2
			},
			"similarity": {
				"custom_bm25": {
					"type": "BM25",
					"k1": 1.8,
					"b": 0.6
				}
			},
			"analysis": {
				"filter": {
					"ngram_filter": {
						"type": "ngram",
						"min_gram": 2,
						"max_gram": 4
					},
					"edge_ngram_filter": {
						"type": "edge_ngram",
						"min_gram": 2,
						"max_gram": 10
					},
					"shingle_filter": {
						"type": "shingle",
						"min_shingle_size": 2,
						"max_shingle_size": 3,
						"output_unigrams": true
					},
					"minimal_english_stemmer": {
						"type": "stemmer",
						"language": "minimal_english"
					}
				},
				"analyzer": {
					"ngram_analyzer": {
						"type": "custom",
						"tokenizer": "standard",
						"filter": ["lowercase", "ngram_filter"]
					},
					"edge_ngram_analyzer": {
						"type": "custom",
						"tokenizer": "standard",
						"filter": ["lowercase", "edge_ngram_filter"]
					},
					"shingle_analyzer": {
						"type": "custom",
						"tokenizer": "standard",
						"filter": ["lowercase", "shingle_filter"]
					},
					"minimal_english_analyzer": {
						"type": "custom",
						"tokenizer": "standard",
						"filter": ["lowercase", "minimal_english_stemmer"]
					}
				}
			}
		},
		"mappings": {
			"properties": {
				"mongo_id": {
					"type": "keyword",
					"doc_values": true
				},
				"title": {
				"type": "text",
				"analyzer": "english",
				"similarity": "custom_bm25",
				"fields": {
					"exact": {"type": "keyword"},
					"standard": {
						"type": "text",
						"analyzer": "minimal_english_analyzer"
					},
					"autocomplete": {
						"type": "text",
						"analyzer": "edge_ngram_analyzer",
						"search_analyzer": "standard"
					},
					"shingles": {
						"type": "text",
						"analyzer": "shingle_analyzer"
					}
				}
			},
			"abstract": {
				"type": "text",
				"analyzer": "english",
				"similarity": "custom_bm25",
				"fields": {
					"standard": {
						"type": "text",
						"analyzer": "minimal_english_analyzer"
					},
					"shingles": {
						"type": "text",
						"analyzer": "shingle_analyzer"
					}
				}
			},
				"authors": {
					"type": "nested",
					"properties": {
						"author_id": {"type": "keyword"},
						"author_name": {
							"type": "text",
							"analyzer": "standard",
							"fields": {
								"keyword": {"type": "keyword"},
								"ngram": {
									"type": "text",
									"analyzer": "ngram_analyzer"
								}
							}
						},
						"author_name_variants": {
							"type": "text",
							"analyzer": "standard",
							"fields": {
								"keyword": {"type": "keyword"},
								"ngram": {
									"type": "text",
									"analyzer": "ngram_analyzer"
								}
							}
						},
						"author_position": {"type": "integer"}
					}
				},
				"author_names": {
					"type": "text",
					"analyzer": "standard",
					"fields": {
						"keyword": {"type": "keyword"},
						"ngram": {
							"type": "text",
							"analyzer": "ngram_analyzer"
						},
						"autocomplete": {
							"type": "text",
							"analyzer": "edge_ngram_analyzer",
							"search_analyzer": "standard"
						}
					}
				},
				"author_name_variants": {
					"type": "text",
					"analyzer": "standard",
					"fields": {
						"keyword": {"type": "keyword"},
						"ngram": {
							"type": "text",
							"analyzer": "ngram_analyzer"
						}
					}
				},
				"author_ids": {
					"type": "keyword"
				},
				"expert_id": {"type": "keyword"},
				"publication_year": {"type": "integer"},
				"field_associated": {
					"type": "text",
					"analyzer": "standard",
					"fields": {
						"keyword": {"type": "keyword"},
						"ngram": {
							"type": "text",
							"analyzer": "ngram_analyzer"
						}
					}
				},
				"document_type": {"type": "keyword"},
				"subject_area": {
					"type": "text",
					"analyzer": "standard",
					"fields": {
						"keyword": {"type": "keyword"},
						"ngram": {
							"type": "text",
							"analyzer": "ngram_analyzer"
						}
					}
				},
				"subject_area_count": {"type": "integer"},
				"citation_count": {"type": "integer"},
				"reference_count": {"type": "integer"},
				"kerberos": {"type": "keyword"},
				"embedding": {
					"type": "knn_vector",
					"dimension": 768,
					"method": {
						"name": "hnsw",
						"space_type": "innerproduct",
						"engine": "faiss",
						"parameters": {
							"ef_construction": 512,
							"m": 32
						}
					}
				}
			}
		}
	}`

	createReq := opensearchapi.IndicesCreateRequest{
		Index: c.cfg.OpenSearchIndex,
		Body:  strings.NewReader(mapping),
	}

	res, err = createReq.Do(ctx, c.client)
	if err != nil {
		return fmt.Errorf("create index: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("create index error: %s", res.String())
	}

	fmt.Printf("Created index %s with enhanced mapping\n", c.cfg.OpenSearchIndex)
	return nil
}

// DeleteIndex deletes the OpenSearch index (for reindexing)
func (c *Client) DeleteIndex(ctx context.Context) error {
	res, err := c.client.Indices.Delete([]string{c.cfg.OpenSearchIndex})
	if err != nil {
		return fmt.Errorf("delete index: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() && res.StatusCode != 404 {
		return fmt.Errorf("delete index error: %s", res.String())
	}

	fmt.Printf("Deleted index %s\n", c.cfg.OpenSearchIndex)
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
