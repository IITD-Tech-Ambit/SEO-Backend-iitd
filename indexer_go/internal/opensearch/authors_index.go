package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/opensearch-project/opensearch-go/v2/opensearchapi"
)

// authorsSuggestMappingJSON is the canonical mapping for the authors_suggest index.
// Intentionally small (smaller index = faster typeahead): only name fields are analyzed,
// ranking numerics use doc_values, and display-only fields are index:false (still in _source).
// Reuses the same edge_ngram analyzer style as research_documents.
const authorsSuggestMappingJSON = `{
	"settings": {
		"index": {
			"number_of_shards": 1,
			"number_of_replicas": 1,
			"max_ngram_diff": 8
		},
		"analysis": {
			"filter": {
				"edge_ngram_filter": {
					"type": "edge_ngram",
					"min_gram": 2,
					"max_gram": 10
				}
			},
			"analyzer": {
				"edge_ngram_analyzer": {
					"type": "custom",
					"tokenizer": "standard",
					"filter": ["lowercase", "edge_ngram_filter"]
				}
			},
			"normalizer": {
				"lowercase_normalizer": {
					"type": "custom",
					"filter": ["lowercase"]
				}
			}
		}
	},
	"mappings": {
		"properties": {
			"expert_id": {"type": "keyword", "index": false},
			"scopus_id": {"type": "keyword", "index": false},
			"department": {"type": "keyword", "index": false},
			"designation": {"type": "keyword", "index": false},
			"image_url": {"type": "keyword", "index": false},
			"name": {
				"type": "text",
				"analyzer": "standard",
				"fields": {
					"autocomplete": {
						"type": "text",
						"analyzer": "edge_ngram_analyzer",
						"search_analyzer": "standard"
					},
					"keyword": {
						"type": "keyword",
						"normalizer": "lowercase_normalizer"
					}
				}
			},
			"name_variants": {
				"type": "text",
				"analyzer": "standard",
				"fields": {
					"autocomplete": {
						"type": "text",
						"analyzer": "edge_ngram_analyzer",
						"search_analyzer": "standard"
					}
				}
			},
			"h_index": {"type": "integer", "doc_values": true},
			"citation_count": {"type": "integer", "doc_values": true},
			"paper_count": {"type": "integer", "doc_values": true}
		}
	}
}`

// OSAuthorSuggest represents one author document in the authors_suggest index.
type OSAuthorSuggest struct {
	ExpertID      string   `json:"expert_id"`
	ScopusID      string   `json:"scopus_id"`
	Name          string   `json:"name"`
	NameVariants  []string `json:"name_variants"`
	Department    string   `json:"department"`
	Designation   string   `json:"designation"`
	ImageURL      string   `json:"image_url"`
	HIndex        int      `json:"h_index"`
	CitationCount int      `json:"citation_count"`
	PaperCount    int      `json:"paper_count"`
}

// CreateAuthorsIndex creates the authors_suggest index if it does not already exist.
// If recreate is true the index is deleted first.
func (c *Client) CreateAuthorsIndex(ctx context.Context, recreate bool) error {
	index := c.cfg.OpenSearchAuthorsIndex

	if recreate {
		delRes, err := c.client.Indices.Delete([]string{index}, c.client.Indices.Delete.WithContext(ctx))
		if err == nil {
			delRes.Body.Close()
		}
	}

	existsRes, err := c.client.Indices.Exists([]string{index}, c.client.Indices.Exists.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("check authors index exists: %w", err)
	}
	existsRes.Body.Close()
	if existsRes.StatusCode == 200 {
		fmt.Printf("Index %s already exists\n", index)
		return nil
	}

	createReq := opensearchapi.IndicesCreateRequest{
		Index: index,
		Body:  strings.NewReader(authorsSuggestMappingJSON),
	}
	res, err := createReq.Do(ctx, c.client)
	if err != nil {
		return fmt.Errorf("create authors index: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return fmt.Errorf("create authors index error: %s", res.String())
	}
	fmt.Printf("Created index %s\n", index)
	return nil
}

// BulkIndexAuthors bulk-indexes author docs (uses expert_id as _id so re-runs upsert).
func (c *Client) BulkIndexAuthors(ctx context.Context, docs []OSAuthorSuggest) (int, error) {
	if len(docs) == 0 {
		return 0, nil
	}

	var buf bytes.Buffer
	for _, doc := range docs {
		indexMeta := map[string]interface{}{"_index": c.cfg.OpenSearchAuthorsIndex}
		if doc.ExpertID != "" {
			indexMeta["_id"] = doc.ExpertID
		}
		action := map[string]interface{}{"index": indexMeta}
		actionBytes, _ := json.Marshal(action)
		buf.Write(actionBytes)
		buf.WriteByte('\n')
		docBytes, _ := json.Marshal(doc)
		buf.Write(docBytes)
		buf.WriteByte('\n')
	}

	req := opensearchapi.BulkRequest{Body: bytes.NewReader(buf.Bytes())}
	res, err := req.Do(ctx, c.client)
	if err != nil {
		return 0, fmt.Errorf("bulk authors request: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return 0, fmt.Errorf("bulk authors error: %s", res.String())
	}

	var bulkRes struct {
		Items []struct {
			Index struct {
				Status int `json:"status"`
			} `json:"index"`
		} `json:"items"`
	}
	if err := json.NewDecoder(res.Body).Decode(&bulkRes); err != nil {
		return 0, fmt.Errorf("decode bulk authors response: %w", err)
	}
	indexed := 0
	for _, item := range bulkRes.Items {
		if item.Index.Status >= 200 && item.Index.Status < 300 {
			indexed++
		}
	}
	return indexed, nil
}

// RefreshAuthorsIndex makes recently indexed author docs searchable.
func (c *Client) RefreshAuthorsIndex(ctx context.Context) error {
	res, err := c.client.Indices.Refresh(
		c.client.Indices.Refresh.WithContext(ctx),
		c.client.Indices.Refresh.WithIndex(c.cfg.OpenSearchAuthorsIndex),
	)
	if err != nil {
		return fmt.Errorf("refresh authors index: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return fmt.Errorf("refresh authors index error: %s", res.String())
	}
	return nil
}

// AuthorPaperCounts returns a map of scopus_author_id -> paper count derived from a single
// terms aggregation over the flat author_ids field on research_documents.
func (c *Client) AuthorPaperCounts(ctx context.Context) (map[string]int, error) {
	query := `{"size":0,"aggs":{"by_author":{"terms":{"field":"author_ids","size":100000}}}}`
	res, err := c.client.Search(
		c.client.Search.WithContext(ctx),
		c.client.Search.WithIndex(c.cfg.OpenSearchIndex),
		c.client.Search.WithBody(strings.NewReader(query)),
	)
	if err != nil {
		return nil, fmt.Errorf("author paper counts: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("author paper counts error: %s", res.String())
	}

	var parsed struct {
		Aggregations struct {
			ByAuthor struct {
				Buckets []struct {
					Key      string `json:"key"`
					DocCount int    `json:"doc_count"`
				} `json:"buckets"`
			} `json:"by_author"`
		} `json:"aggregations"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode author paper counts: %w", err)
	}
	out := make(map[string]int, len(parsed.Aggregations.ByAuthor.Buckets))
	for _, b := range parsed.Aggregations.ByAuthor.Buckets {
		out[b.Key] = b.DocCount
	}
	return out, nil
}
