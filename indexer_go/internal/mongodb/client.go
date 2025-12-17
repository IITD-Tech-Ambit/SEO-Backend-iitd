package mongodb

import (
	"context"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/sudarshan/indexer/internal/config"
)

// Author represents an author in a research document
type Author struct {
	AuthorID          string `bson:"author_id"`
	AuthorName        string `bson:"author_name"`
	AuthorAffiliation string `bson:"author_affiliation"`
}

// Document represents a research document from MongoDB
type Document struct {
	ID              primitive.ObjectID `bson:"_id"`
	Title           string             `bson:"title"`
	Abstract        string             `bson:"abstract"`
	Authors         []Author           `bson:"authors"`
	PublicationYear int                `bson:"publication_year"`
	FieldAssociated string             `bson:"field_associated"`
	DocumentType    string             `bson:"document_type"`
	SubjectArea     []string           `bson:"subject_area"`
	CitationCount   int                `bson:"citation_count"`
	OpenSearchID    string             `bson:"open_search_id"`
}

// Client wraps MongoDB operations
type Client struct {
	client     *mongo.Client
	collection *mongo.Collection
	cfg        *config.Config
}

// NewClient creates a new MongoDB client
func NewClient(cfg *config.Config) (*Client, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Configure client options with connection pool limits for free tier
	clientOpts := options.Client().
		ApplyURI(cfg.MongoURI).
		SetMaxPoolSize(uint64(cfg.MongoMaxPoolSize)). // Limit connections for free tier
		SetMinPoolSize(1).                            // Keep minimal connections
		SetMaxConnIdleTime(30 * time.Second).         // Close idle connections quickly
		SetServerSelectionTimeout(5 * time.Second).   // Fail fast on connection issues
		SetSocketTimeout(30 * time.Second)            // Timeout long operations

	client, err := mongo.Connect(ctx, clientOpts)
	if err != nil {
		return nil, err
	}

	// Ping to verify connection
	if err := client.Ping(ctx, nil); err != nil {
		return nil, err
	}

	// Get database name from URI (last part after /)
	dbName := "research_db"
	if parts := splitDBName(cfg.MongoURI); parts != "" {
		dbName = parts
	}

	log.Printf("  Database: %s, Collection: %s", dbName, cfg.MongoCollection)

	collection := client.Database(dbName).Collection(cfg.MongoCollection)

	// Debug: count all documents
	count, _ := collection.CountDocuments(ctx, bson.M{})
	log.Printf("  Total documents in collection: %d", count)

	return &Client{
		client:     client,
		collection: collection,
		cfg:        cfg,
	}, nil
}

// Close disconnects from MongoDB
func (c *Client) Close(ctx context.Context) error {
	return c.client.Disconnect(ctx)
}

// CountDocumentsToIndex returns the number of documents that need indexing
func (c *Client) CountDocumentsToIndex(ctx context.Context, reindexAll bool) (int64, error) {
	filter := bson.M{}
	if !reindexAll {
		filter["open_search_id"] = bson.M{"$in": []interface{}{nil, ""}}
	}
	return c.collection.CountDocuments(ctx, filter)
}

// StreamDocuments returns a channel of documents to index
// Optimized: no per-doc delay, backpressure via channel buffer handles throttling
func (c *Client) StreamDocuments(ctx context.Context, reindexAll bool, limit int) (<-chan Document, error) {
	filter := bson.M{}
	if !reindexAll {
		filter["open_search_id"] = bson.M{"$in": []interface{}{nil, ""}}
	}

	opts := options.Find().
		SetBatchSize(int32(c.cfg.MongoBatchSize)) // Control cursor batch size
	if limit > 0 {
		opts.SetLimit(int64(limit))
	}

	cursor, err := c.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}

	docChan := make(chan Document, c.cfg.MongoBatchSize*2) // Larger buffer for smoother flow

	go func() {
		defer close(docChan)
		defer cursor.Close(ctx)

		for cursor.Next(ctx) {
			var doc Document
			if err := cursor.Decode(&doc); err != nil {
				continue
			}
			select {
			case docChan <- doc:
				// Channel backpressure naturally throttles - no artificial delay needed
			case <-ctx.Done():
				return
			}
		}
	}()

	return docChan, nil
}

// IDUpdate holds a MongoDB ID and its corresponding OpenSearch ID
type IDUpdate struct {
	MongoID      primitive.ObjectID
	OpenSearchID string
}

// UpdateOpenSearchID updates the open_search_id field for a document
func (c *Client) UpdateOpenSearchID(ctx context.Context, mongoID primitive.ObjectID, osID string) error {
	_, err := c.collection.UpdateOne(
		ctx,
		bson.M{"_id": mongoID},
		bson.M{"$set": bson.M{"open_search_id": osID}},
	)
	return err
}

// BulkUpdateOpenSearchIDs updates multiple documents' open_search_id fields in a single bulk operation
// Includes throttling for MongoDB free tier
func (c *Client) BulkUpdateOpenSearchIDs(ctx context.Context, updates []IDUpdate) error {
	if len(updates) == 0 {
		return nil
	}

	models := make([]mongo.WriteModel, len(updates))
	for i, u := range updates {
		models[i] = mongo.NewUpdateOneModel().
			SetFilter(bson.M{"_id": u.MongoID}).
			SetUpdate(bson.M{"$set": bson.M{"open_search_id": u.OpenSearchID}})
	}

	opts := options.BulkWrite().SetOrdered(false) // Unordered for better performance
	_, err := c.collection.BulkWrite(ctx, models, opts)

	// Throttle between bulk writes for free tier
	if c.cfg.MongoBulkDelayMs > 0 {
		time.Sleep(time.Duration(c.cfg.MongoBulkDelayMs) * time.Millisecond)
	}

	return err
}

func splitDBName(uri string) string {
	// Simple extraction of database name from MongoDB URI
	// Format: mongodb://host:port/dbname
	for i := len(uri) - 1; i >= 0; i-- {
		if uri[i] == '/' {
			result := uri[i+1:]
			// Remove query params if any
			for j, c := range result {
				if c == '?' {
					return result[:j]
				}
			}
			return result
		}
	}
	return ""
}
