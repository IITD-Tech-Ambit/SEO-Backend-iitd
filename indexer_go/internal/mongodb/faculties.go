package mongodb

import (
	"context"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

// Faculty represents a faculty document from the `faculties` collection.
// Only the fields needed for the authors_suggest index are decoded.
type Faculty struct {
	ID            primitive.ObjectID  `bson:"_id"`
	ExpertID      string              `bson:"expert_id"`
	Title         string              `bson:"title"`
	FirstName     string              `bson:"firstName"`
	LastName      string              `bson:"lastName"`
	Designation   string              `bson:"designation"`
	ProfileImage  string              `bson:"profile_image_url"`
	Department    primitive.ObjectID  `bson:"department"`
	HIndex        int                 `bson:"h_index"`
	CitationCount int                 `bson:"citation_count"`
	ScopusID      []string            `bson:"scopus_id"`
}

// LoadDepartmentNames returns a map of department ObjectId hex -> department name.
func (c *Client) LoadDepartmentNames(ctx context.Context) (map[string]string, error) {
	cursor, err := c.db.Collection("departments").Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	out := make(map[string]string)
	for cursor.Next(ctx) {
		var d struct {
			ID   primitive.ObjectID `bson:"_id"`
			Name string             `bson:"name"`
		}
		if err := cursor.Decode(&d); err != nil {
			continue
		}
		out[d.ID.Hex()] = d.Name
	}
	return out, cursor.Err()
}

// StreamFaculties returns a channel of all faculty documents.
func (c *Client) StreamFaculties(ctx context.Context) (<-chan Faculty, error) {
	cursor, err := c.db.Collection("faculties").Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}

	ch := make(chan Faculty, 256)
	go func() {
		defer close(ch)
		defer cursor.Close(ctx)
		for cursor.Next(ctx) {
			var f Faculty
			if err := cursor.Decode(&f); err != nil {
				continue
			}
			select {
			case ch <- f:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}
