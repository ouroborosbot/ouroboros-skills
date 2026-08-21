import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"

const PROCESS_PHASE_SEED_BASE = Object.freeze({
  phase1: 100,
  phase2: 200,
})

export function deterministicRepairVector(seed = 1) {
  return Array.from(
    { length: ACTIVE_EMBEDDING_SPEC.dimension },
    (_, index) => ((seed + index) % 23) / 23,
  )
}

export function deterministicProcessRepairVector(phase, ordinal) {
  const seedBase = PROCESS_PHASE_SEED_BASE[phase]
  if (seedBase === undefined) {
    throw new Error(`unknown semantic repair process phase: ${String(phase)}`)
  }
  return deterministicRepairVector(seedBase + ordinal)
}
