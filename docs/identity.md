# Scholarly identity

OpenPapers uses one canonical identity policy for scholarly identifiers.

## DOI

`normalizeDoi` in `src/research/citations.ts` is the authoritative DOI normalizer. It trims surrounding whitespace, accepts bare DOI values, `doi:` prefixes, and `doi.org`/`dx.doi.org` HTTP(S) URLs, removes citation-terminal punctuation, and lowercases the result. Values must match the DOI registration prefix form (`10.<registrant>/<suffix>`); invalid DOI-like values raise an error instead of becoming an identity.

Provider adapters must call this utility rather than applying provider-specific DOI transformations. DOI-derived `paperId` values are deterministic, so equivalent representations reconcile to one work identity.

## arXiv

`normalizeArxivId` accepts bare IDs, `arXiv:` prefixes, `abs` and `pdf` URLs, `www` host variants, modern IDs, supported legacy category-style IDs such as `cond-mat/9703183`, and revision suffixes such as `v1` and `v7`. Revision suffixes are removed for the work identity: `1706.03762`, `1706.03762v1`, and `1706.03762v7` identify one scholarly work. Provider-specific version metadata belongs in `ResearchWork.versions`; the current arXiv adapter records the latest source URL and submission timestamp without asserting that revisions are separate works.

Invalid arXiv values raise an error and remain provider/input failures rather than being guessed into a work ID.

## Reconciliation rules

1. Normalized DOI is the strongest cross-provider key.
2. Normalized arXiv ID is the next stable key.
3. Identifier-free title/author similarity is comparison evidence only; it is never a definitive merge key.
4. Conflicting metadata for one stable identifier remains visible in `transparency.conflicts`.
5. Canonical identifiers and evidence source IDs must remain resolvable through the local store.

The contract is covered by `tests/citations.test.ts` and the adversarial identity cases in `tests/adversarial/full-flow.test.ts`.

## Limitations

A conference publication and its arXiv preprint may not share an identifier. OpenPapers does not silently merge those records from title similarity alone. A future explicit version/lineage model may link them while retaining uncertainty and both source records.
