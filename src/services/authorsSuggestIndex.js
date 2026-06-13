/**
 * authors_suggest index helpers.
 *
 * Shared between the Node bootstrap seeder (scripts/seedAuthorsSuggest.js) and any
 * other consumer. Keeps the OpenSearch mapping and the name-variant generation in one
 * place so the index stays consistent.
 *
 * Field selection (intentionally small — smaller index = faster typeahead):
 *  - Searchable (analyzed): name (+ .autocomplete edge_ngram, + .keyword), name_variants (+ .autocomplete)
 *  - Ranking numerics (doc_values, not analyzed): h_index, citation_count, paper_count
 *  - Display only (index:false, in _source): expert_id, scopus_id, department, designation, image_url
 *  - NOT indexed at all: email, gender, ids (orcid/researcher/scholar), expertise/subjects/wos_subjects.
 *    Topic matching belongs to the paper side, not author typeahead.
 */

// Reuses the same edge_ngram analyzer style already defined for research_documents
// (edge_ngram_analyzer with search_analyzer=standard) so prefix behaviour matches titles.
export const authorsSuggestMapping = {
    settings: {
        index: {
            number_of_shards: 1,
            number_of_replicas: 1,
            max_ngram_diff: 8
        },
        analysis: {
            filter: {
                edge_ngram_filter: {
                    type: 'edge_ngram',
                    min_gram: 2,
                    max_gram: 10
                }
            },
            analyzer: {
                edge_ngram_analyzer: {
                    type: 'custom',
                    tokenizer: 'standard',
                    filter: ['lowercase', 'edge_ngram_filter']
                }
            },
            normalizer: {
                lowercase_normalizer: {
                    type: 'custom',
                    filter: ['lowercase']
                }
            }
        }
    },
    mappings: {
        properties: {
            // Display-only identifiers/fields — stored in _source, never analyzed.
            expert_id: { type: 'keyword', index: false },
            scopus_id: { type: 'keyword', index: false },
            department: { type: 'keyword', index: false },
            designation: { type: 'keyword', index: false },
            image_url: { type: 'keyword', index: false },

            // Searchable name fields.
            name: {
                type: 'text',
                analyzer: 'standard',
                fields: {
                    autocomplete: {
                        type: 'text',
                        analyzer: 'edge_ngram_analyzer',
                        search_analyzer: 'standard'
                    },
                    keyword: {
                        type: 'keyword',
                        normalizer: 'lowercase_normalizer'
                    }
                }
            },
            name_variants: {
                type: 'text',
                analyzer: 'standard',
                fields: {
                    autocomplete: {
                        type: 'text',
                        analyzer: 'edge_ngram_analyzer',
                        search_analyzer: 'standard'
                    }
                }
            },

            // Ranking signals — numeric doc_values only.
            h_index: { type: 'integer', doc_values: true },
            citation_count: { type: 'integer', doc_values: true },
            paper_count: { type: 'integer', doc_values: true }
        }
    }
};

const TITLE_PREFIX = /^(prof\.?|dr\.?|mr\.?|ms\.?|mrs\.?|shri|smt\.?)\s+/i;

function clean(s) {
    return (s || '').toString().replace(/\s+/g, ' ').trim();
}

function initialsOf(name) {
    return clean(name)
        .split(' ')
        .filter(Boolean)
        .map((tok) => tok[0].toUpperCase());
}

/**
 * Build a deduped list of name variants from title/firstName/lastName.
 * Examples for ("Prof.", "Sanjeev Kumar", "Gupta"):
 *   "Sanjeev Kumar Gupta", "Prof. Sanjeev Kumar Gupta", "Gupta Sanjeev Kumar",
 *   "S. K. Gupta", "S K Gupta", "SK Gupta", "Gupta, Sanjeev Kumar"
 */
export function buildNameVariants(title, firstName, lastName) {
    const t = clean(title).replace(/\.$/, '');
    const first = clean(firstName);
    const last = clean(lastName);
    const variants = new Set();

    const full = clean(`${first} ${last}`);
    if (full) variants.add(full);
    if (t && full) variants.add(`${t}. ${full}`);
    if (first && last) {
        variants.add(`${last} ${first}`);
        variants.add(`${last}, ${first}`);
    }

    // Initials forms: combine first-name initials with the (full) last name.
    const firstInitials = initialsOf(first);
    if (firstInitials.length && last) {
        variants.add(`${firstInitials.map((i) => `${i}.`).join(' ')} ${last}`);
        variants.add(`${firstInitials.join(' ')} ${last}`);
        variants.add(`${firstInitials.join('')} ${last}`);
    }

    // Strip any leading honorific from the primary full name as an extra variant.
    const stripped = full.replace(TITLE_PREFIX, '');
    if (stripped && stripped !== full) variants.add(stripped);

    return Array.from(variants).filter(Boolean);
}

/** The canonical display/search name for an author. */
export function buildPrimaryName(firstName, lastName) {
    return clean(`${clean(firstName)} ${clean(lastName)}`);
}
