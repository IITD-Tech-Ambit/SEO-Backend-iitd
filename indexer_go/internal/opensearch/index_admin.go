package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/opensearch-project/opensearch-go/v2/opensearchapi"
)

// indexMappingJSON is the canonical mapping for research_documents (single concrete index).
const indexMappingJSON = `{
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
					"dimension": 1024,
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

// aliasBackingIndices returns concrete index names that hold the given alias.
func (c *Client) aliasBackingIndices(ctx context.Context, alias string) ([]string, error) {
	req := opensearchapi.IndicesGetAliasRequest{Name: []string{alias}}
	res, err := req.Do(ctx, c.client)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return nil, nil
	}
	if res.IsError() {
		return nil, fmt.Errorf("get alias %s: %s", alias, res.String())
	}
	var parsed map[string]json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode alias response: %w", err)
	}
	out := make([]string, 0, len(parsed))
	for indexName := range parsed {
		out = append(out, indexName)
	}
	return out, nil
}

// listResearchDocumentIndices returns all concrete indices matching research_documents*.
func (c *Client) listResearchDocumentIndices(ctx context.Context) ([]string, error) {
	pattern := c.cfg.OpenSearchIndex + "*"
	res, err := c.client.Cat.Indices(
		c.client.Cat.Indices.WithIndex(pattern),
		c.client.Cat.Indices.WithFormat("json"),
		c.client.Cat.Indices.WithH("index"),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return nil, nil
	}
	if res.IsError() {
		return nil, fmt.Errorf("cat indices %s: %s", pattern, res.String())
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Index string `json:"index"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("decode cat indices: %w", err)
	}
	seen := make(map[string]struct{})
	var out []string
	for _, row := range rows {
		name := strings.TrimSpace(row.Index)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out, nil
}

func (c *Client) removeAlias(ctx context.Context, alias string, indices []string) error {
	if len(indices) == 0 {
		return nil
	}
	actions := make([]map[string]interface{}, 0, len(indices))
	for _, idx := range indices {
		actions = append(actions, map[string]interface{}{
			"remove": map[string]interface{}{
				"index": idx,
				"alias": alias,
			},
		})
	}
	payload, _ := json.Marshal(map[string]interface{}{"actions": actions})
	res, err := c.client.Indices.UpdateAliases(bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("remove alias: %w", err)
	}
	defer res.Body.Close()
	// Alias already gone (concrete-only index) — not an error.
	if res.StatusCode == 404 {
		return nil
	}
	if res.IsError() {
		return fmt.Errorf("remove alias error: %s", res.String())
	}
	return nil
}

func (c *Client) deleteConcreteIndices(ctx context.Context, indices []string) error {
	if len(indices) == 0 {
		return nil
	}
	res, err := c.client.Indices.Delete(indices, c.client.Indices.Delete.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("delete indices: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() && res.StatusCode != 404 {
		return fmt.Errorf("delete indices error: %s", res.String())
	}
	return nil
}

// collectIndicesToRemove gathers every concrete index tied to research_documents (alias + legacy v*).
func (c *Client) collectIndicesToRemove(ctx context.Context) ([]string, error) {
	name := c.cfg.OpenSearchIndex
	seen := make(map[string]struct{})

	backing, err := c.aliasBackingIndices(ctx, name)
	if err != nil {
		return nil, err
	}
	for _, idx := range backing {
		seen[idx] = struct{}{}
	}

	legacy, err := c.listResearchDocumentIndices(ctx)
	if err != nil {
		return nil, err
	}
	for _, idx := range legacy {
		seen[idx] = struct{}{}
	}

	out := make([]string, 0, len(seen))
	for idx := range seen {
		out = append(out, idx)
	}
	return out, nil
}

// concreteIndexExists is true when OPENSEARCH_INDEX is a real index (not only an alias).
func (c *Client) concreteIndexExists(ctx context.Context) (bool, error) {
	name := c.cfg.OpenSearchIndex

	// If name is an alias, it is not our single concrete target yet.
	backing, err := c.aliasBackingIndices(ctx, name)
	if err != nil {
		return false, err
	}
	if len(backing) > 0 {
		return false, nil
	}

	res, err := c.client.Indices.Exists(
		[]string{name},
		c.client.Indices.Exists.WithContext(ctx),
	)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	return res.StatusCode == 200, nil
}
