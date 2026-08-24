import { test } from "node:test"
import { strict as assert } from "node:assert"

import { projectDocumentVectors } from "../../src/tools/status.js"

test("document vector projection collapses unavailable states only for search responses", () => {
  assert.deepEqual(projectDocumentVectors({
    state: "missing_local_db",
  }, {
    operationalOnly: true,
    vectorsTableExists: false,
  }), {
    state: "missing",
    chunks_total: 0,
    vectors_indexed: 0,
    missing_vectors: 0,
    known_unembeddable_vectors: 0,
    repairable_missing_vectors: 0,
    coverage: 0,
  })
  assert.deepEqual(projectDocumentVectors({
    state: "partial",
    chunks_total: 2,
    vectors_indexed: 1,
    missing_vectors: 1,
    known_unembeddable_vectors: 0,
    repairable_missing_vectors: 1,
  }, {
    operationalOnly: true,
  }), {
    state: "partial",
    chunks_total: 2,
    vectors_indexed: 1,
    missing_vectors: 1,
    known_unembeddable_vectors: 0,
    repairable_missing_vectors: 1,
    coverage: 0.5,
  })
  assert.deepEqual(projectDocumentVectors(), {
    state: "available",
    chunks_total: 0,
    vectors_indexed: 0,
    missing_vectors: 0,
    known_unembeddable_vectors: 0,
    repairable_missing_vectors: 0,
    coverage: 0,
  })
})
