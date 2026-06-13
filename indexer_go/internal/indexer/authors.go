package indexer

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/sudarshan/indexer/internal/opensearch"
)

var titlePrefixRe = regexp.MustCompile(`(?i)^(prof\.?|dr\.?|mr\.?|ms\.?|mrs\.?|shri|smt\.?)\s+`)

func cleanStr(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func initialsOf(name string) []string {
	parts := strings.Fields(cleanStr(name))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, strings.ToUpper(p[:1]))
	}
	return out
}

// buildNameVariants mirrors the Node helper so the Go-built index matches the seeder.
func buildNameVariants(title, firstName, lastName string) []string {
	t := strings.TrimSuffix(cleanStr(title), ".")
	first := cleanStr(firstName)
	last := cleanStr(lastName)

	seen := make(map[string]struct{})
	var order []string
	add := func(v string) {
		v = cleanStr(v)
		if v == "" {
			return
		}
		if _, ok := seen[v]; ok {
			return
		}
		seen[v] = struct{}{}
		order = append(order, v)
	}

	full := cleanStr(first + " " + last)
	add(full)
	if t != "" && full != "" {
		add(t + ". " + full)
	}
	if first != "" && last != "" {
		add(last + " " + first)
		add(last + ", " + first)
	}

	inits := initialsOf(first)
	if len(inits) > 0 && last != "" {
		dotted := make([]string, len(inits))
		for i, c := range inits {
			dotted[i] = c + "."
		}
		add(strings.Join(dotted, " ") + " " + last)
		add(strings.Join(inits, " ") + " " + last)
		add(strings.Join(inits, "") + " " + last)
	}

	if stripped := titlePrefixRe.ReplaceAllString(full, ""); stripped != full {
		add(stripped)
	}

	return order
}

// IndexAuthors builds (or rebuilds) the authors_suggest index from MongoDB faculties.
func (idx *Indexer) IndexAuthors(ctx context.Context, recreate bool, withPaperCounts bool) error {
	idx.cli.StartPhase("Index Authors (authors_suggest)")

	idx.cli.Step(1, 4, "Creating authors_suggest index")
	if err := idx.openSearch.CreateAuthorsIndex(ctx, recreate); err != nil {
		return fmt.Errorf("create authors index: %w", err)
	}

	idx.cli.Step(2, 4, "Loading departments and (optional) paper counts")
	deptNames, err := idx.mongoDB.LoadDepartmentNames(ctx)
	if err != nil {
		return fmt.Errorf("load departments: %w", err)
	}
	var paperCounts map[string]int
	if withPaperCounts {
		paperCounts, err = idx.openSearch.AuthorPaperCounts(ctx)
		if err != nil {
			idx.cli.Warning(fmt.Sprintf("paper counts unavailable: %v (using 0)", err))
			paperCounts = map[string]int{}
		}
	} else {
		paperCounts = map[string]int{}
	}

	idx.cli.Step(3, 4, "Streaming faculties from MongoDB")
	facChan, err := idx.mongoDB.StreamFaculties(ctx)
	if err != nil {
		return fmt.Errorf("stream faculties: %w", err)
	}

	idx.cli.Step(4, 4, "Bulk indexing authors")
	const batchSize = 500
	batch := make([]opensearch.OSAuthorSuggest, 0, batchSize)
	total := 0
	indexed := 0

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		n, err := idx.openSearch.BulkIndexAuthors(ctx, batch)
		if err != nil {
			return err
		}
		indexed += n
		batch = batch[:0]
		return nil
	}

	for f := range facChan {
		name := cleanStr(f.FirstName + " " + f.LastName)
		scopus := ""
		paperCount := 0
		for _, sid := range f.ScopusID {
			sid = strings.TrimSpace(sid)
			if sid == "" {
				continue
			}
			if scopus == "" {
				scopus = sid
			}
			paperCount += paperCounts[sid]
		}

		doc := opensearch.OSAuthorSuggest{
			ExpertID:      f.ExpertID,
			ScopusID:      scopus,
			Name:          name,
			NameVariants:  buildNameVariants(f.Title, f.FirstName, f.LastName),
			Department:    deptNames[f.Department.Hex()],
			Designation:   f.Designation,
			ImageURL:      f.ProfileImage,
			HIndex:        f.HIndex,
			CitationCount: f.CitationCount,
			PaperCount:    paperCount,
		}
		batch = append(batch, doc)
		total++
		if len(batch) >= batchSize {
			if err := flush(); err != nil {
				return fmt.Errorf("bulk index authors: %w", err)
			}
		}
	}
	if err := flush(); err != nil {
		return fmt.Errorf("bulk index authors: %w", err)
	}

	if err := idx.openSearch.RefreshAuthorsIndex(ctx); err != nil {
		idx.cli.Warning(fmt.Sprintf("refresh authors index failed: %v", err))
	}

	idx.cli.EndPhase()
	idx.cli.Summary("Index Authors Complete", map[string]string{
		"Faculties": fmt.Sprintf("%d", total),
		"Indexed":   fmt.Sprintf("%d", indexed),
	})
	return nil
}
