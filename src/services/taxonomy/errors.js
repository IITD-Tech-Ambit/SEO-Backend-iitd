/**
 * Typed errors for the taxonomy read path, so the controller can map
 * domain failures to HTTP statuses without string-matching messages.
 */
export class TaxonomyNotFoundError extends Error {
    constructor(kind, value) {
        super(`Unknown ${kind}: "${value}"`);
        this.name = 'TaxonomyNotFoundError';
        this.kind = kind;
        this.value = value;
    }
}

export class TaxonomyBadRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TaxonomyBadRequestError';
    }
}
