import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  main,
  resolveMcpServerVersion,
  resolveRuntimeInspector,
} from "../../index.js"
import {
  importRuntimeServer,
  inspectRuntimeDependencyPack,
} from "../../src/runtime/bootstrap.js"
import {
  createMaintenanceCoordinator,
  isMaintenanceCoordinator,
} from "../../src/indexer/maintenance.js"

function makeRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

test("startup reads the diagnostic server version without making metadata failure fatal", () => {
  assert.equal(resolveMcpServerVersion({
    mcpRoot: "/plugin",
    readFile: () => JSON.stringify({ version: "7.8.9" }),
  }), "7.8.9")
  assert.equal(resolveMcpServerVersion({
    mcpRoot: "/plugin",
    readFile: () => JSON.stringify({ version: "" }),
  }), "0.0.0")
  assert.equal(resolveMcpServerVersion({
    mcpRoot: "/plugin",
    readFile: () => JSON.stringify({ version: "not-semver" }),
  }), "0.0.0")
  assert.equal(resolveMcpServerVersion({
    mcpRoot: "/plugin",
    readFile: () => JSON.stringify({ version: "7.8.9-beta.1+build.2" }),
  }), "7.8.9-beta.1+build.2")
  assert.equal(resolveMcpServerVersion({
    mcpRoot: "/plugin",
    readFile: () => {
      throw new Error("package metadata unavailable")
    },
  }), "0.0.0")
})

test("startup assembles inspected runtime status and falls back to diagnostics when restoration fails", async () => {
  const root = makeRoot("desk-startup-inspected-runtime-")
  const startCalls = []
  const runtimeServer = {
    isMaintenanceCoordinator,
    maintenanceCoordinator: createMaintenanceCoordinator({
      ensureIndex: async () => ({ built: false, reason: "fresh" }),
    }),
    async startServer(args) {
      startCalls.push(args)
    },
  }
  try {
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => runtimeServer,
      runtimeInspector: () => ({
        ok: true,
        current_target: "darwin-arm64-node-127",
        support_matrix_path: "/plugin/support-matrix.json",
      }),
    })

    assert.equal(startCalls.length, 1)
    assert.deepEqual(startCalls[0].statusContext.runtime, {
      runtime_cache_dir: null,
      source_mirror_path: null,
      target: null,
      loaded_from_source_mirror: false,
      state: "ready",
      current_target: "darwin-arm64-node-127",
      shipped_targets: [],
      paths_checked: [],
      runtime_cache_path: null,
      support_matrix_path: "/plugin/support-matrix.json",
    })
    assert.equal(startCalls[0].statusContext.startup.fallback_mode, "not_checked")

    let maintenanceDiagnostic
    await main({
      argv: ["--root", root],
      env: { DESK_RUNTIME_CACHE_DIR: "/maintenance-env-cache" },
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => ({
        isMaintenanceCoordinator,
        maintenanceCoordinator: {},
        async startServer() {
          assert.fail("incomplete maintenance must not start the runtime server")
        },
      }),
      runtimeInspector: () => ({
        ok: true,
        runtime: {
          current_target: {
            id: "darwin-arm64-node-127",
            platform: "darwin",
            arch: "arm64",
            node_abi: "127",
          },
          shipped_targets: [{ id: "darwin-arm64-node-127" }],
          paths_checked: ["/maintenance-pack"],
          support_matrix_path: "/maintenance-matrix",
        },
      }),
      diagnosticServerStarter: (options) => {
        maintenanceDiagnostic = options.diagnostic
        return "maintenance-diagnostic-started"
      },
    })
    assert.equal(maintenanceDiagnostic.reason, "maintenance_unavailable")
    assert.equal(
      maintenanceDiagnostic.runtime.current_target.id,
      "darwin-arm64-node-127",
    )
    assert.deepEqual(
      maintenanceDiagnostic.runtime.shipped_targets,
      [{ id: "darwin-arm64-node-127" }],
    )
    assert.deepEqual(
      maintenanceDiagnostic.runtime.paths_checked,
      ["/maintenance-pack"],
    )
    assert.equal(
      maintenanceDiagnostic.runtime.runtime_cache_path,
      "/maintenance-env-cache",
    )
    assert.equal(
      maintenanceDiagnostic.runtime.support_matrix_path,
      "/maintenance-matrix",
    )

    let diagnostic
    await main({
      argv: ["--root", root],
      env: { DESK_RUNTIME_CACHE_DIR: "/env-cache" },
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => {
        throw new Error("restore failed")
      },
      runtimeInspector: () => ({
        ok: true,
        runtime: {
          current_target: "darwin-arm64-node-127",
          shipped_targets: ["darwin-arm64-node-127"],
          paths_checked: ["/pack"],
          support_matrix_path: "/matrix",
        },
      }),
      diagnosticServerStarter: (options) => {
        diagnostic = options.diagnostic
        return "diagnostic-started"
      },
    })
    assert.equal(diagnostic.reason, "runtime_restore_failed")
    assert.equal(diagnostic.runtime.runtime_cache_path, "/env-cache")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup handles unavailable runtime through diagnostics and guarded compatible-Node handoff", async () => {
  const root = makeRoot("desk-startup-unavailable-runtime-")
  const diagnosticServerStarter = ({ diagnostic }) => diagnostic
  const baseInspection = {
    ok: false,
    reason: "missing_pack",
    failure_kind: "missing_artifact",
    current_target: "darwin-arm64-node-115",
    shipped_targets: ["darwin-arm64-node-127"],
    paths_checked: ["/pack"],
    support_matrix_path: "/matrix",
  }
  try {
    const customImporter = async () => {}
    const explicitInspector = () => baseInspection
    assert.equal(resolveRuntimeInspector({
      runtimeImporter: importRuntimeServer,
    }), inspectRuntimeDependencyPack)
    assert.equal(resolveRuntimeInspector({
      runtimeImporter: customImporter,
    }), null)
    assert.equal(resolveRuntimeInspector({
      runtimeImporter: customImporter,
      runtimeInspector: explicitInspector,
    }), explicitInspector)

    const missingPack = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => baseInspection,
      diagnosticServerStarter,
    })
    assert.equal(missingPack.reason, "missing_pack")
    assert.equal(missingPack.failure_kind, "missing_artifact")

    const handoff = { code: 0, signal: null }
    const reexecuted = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      mcpRoot: "/plugin",
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => ({ ...baseInspection, reason: "unsupported_target" }),
      diagnosticServerStarter,
      nodeCandidateDiscoverer: () => ["/node-22"],
      nodeSelector: ({ candidates }) => ({
        mode: "reexec",
        executable: candidates[0],
        paths_checked: candidates,
      }),
      nodeReexecutor: async (options) => {
        assert.equal(options.executable, "/node-22")
        assert.equal(options.entrypointPath, "/plugin/index.js")
        return handoff
      },
    })
    assert.equal(reexecuted, handoff)

    const failedHandoff = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => ({ ...baseInspection, reason: "unsupported_target" }),
      diagnosticServerStarter,
      nodeCandidateDiscoverer: () => ["/node-22"],
      nodeSelector: () => ({
        mode: "reexec",
        executable: "/node-22",
        paths_checked: ["/node-22"],
      }),
      nodeReexecutor: async () => ({ code: null, signal: "SIGTERM" }),
    })
    assert.equal(failedHandoff.reason, "guarded_reexec_failure")
    assert.deepEqual(failedHandoff.runtime.paths_checked, ["/pack", "/node-22"])

    const failedHandoffByCode = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => ({ ...baseInspection, reason: "unsupported_target" }),
      diagnosticServerStarter,
      nodeCandidateDiscoverer: () => ["/node-22"],
      nodeSelector: () => ({
        mode: "reexec",
        executable: "/node-22",
        paths_checked: ["/node-22"],
      }),
      nodeReexecutor: async () => ({ code: 7, signal: null }),
    })
    assert.equal(failedHandoffByCode.reason, "guarded_reexec_failure")

    let selectionInput
    const nestedRuntime = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => ({
        ok: false,
        reason: "unsupported_target",
        runtime: {
          current_target: "darwin-arm64-node-115",
          shipped_targets: ["darwin-arm64-node-127"],
        },
      }),
      diagnosticServerStarter,
      nodeCandidateDiscoverer: () => [],
      nodeSelector: (input) => {
        selectionInput = input
        return {
          mode: "diagnostic",
          reason: "no_compatible_node",
          paths_checked: [],
        }
      },
    })
    assert.equal(selectionInput.currentTarget, "darwin-arm64-node-115")
    assert.deepEqual(selectionInput.shippedTargets, ["darwin-arm64-node-127"])
    assert.equal(nestedRuntime.reason, "no_compatible_node")

    const sparseRuntime = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => ({
        ok: false,
        reason: "unsupported_target",
        runtime: {
          current_target: "darwin-arm64-node-115",
        },
      }),
      diagnosticServerStarter,
      nodeCandidateDiscoverer: () => [],
      nodeSelector: ({ shippedTargets }) => {
        assert.deepEqual(shippedTargets, [])
        return {
          mode: "diagnostic",
          reason: "no_compatible_node",
          paths_checked: [],
        }
      },
    })
    assert.deepEqual(sparseRuntime.runtime.shipped_targets, [])
    assert.deepEqual(sparseRuntime.runtime.paths_checked, [])
    assert.equal(sparseRuntime.runtime.support_matrix_path, null)

    const noCompatibleNode = await main({
      argv: ["--root", root],
      env: { DESK_MCP_REEXEC_ATTEMPT: "1" },
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => baseInspection,
      diagnosticServerStarter,
      nodeCandidateDiscoverer: () => [],
      nodeSelector: () => ({
        mode: "diagnostic",
        reason: "no_compatible_node",
        paths_checked: ["/missing-node"],
      }),
    })
    assert.equal(noCompatibleNode.reason, "no_compatible_node")
    assert.equal(noCompatibleNode.failure_kind, undefined)

    const forwardedTermination = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => ({ ...baseInspection, reason: "unsupported_target" }),
      diagnosticServerStarter: () => assert.fail("termination should not start diagnostics"),
      nodeCandidateDiscoverer: () => ["/node-22"],
      nodeSelector: () => ({
        mode: "reexec",
        executable: "/node-22",
        paths_checked: ["/node-22"],
      }),
      nodeReexecutor: async () => ({
        code: null,
        signal: "SIGTERM",
        forwardedSignal: "SIGTERM",
      }),
    })
    assert.equal(forwardedTermination.forwardedSignal, "SIGTERM")

    const inspectionFailure = await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      mcpRoot: "/plugin",
      runtimeImporter: async () => assert.fail("runtime import should not run"),
      runtimeInspector: () => {
        throw new Error("corrupt support metadata")
      },
      diagnosticServerStarter,
    })
    assert.equal(inspectionFailure.reason, "runtime_inspection_failed")
    assert.equal(inspectionFailure.runtime.current_target.id, `${process.platform}-${process.arch}-node-${process.versions.modules}`)
    assert.deepEqual(inspectionFailure.runtime.paths_checked, ["/plugin"])

    for (const failingSelection of [
      {
        nodeCandidateDiscoverer: () => {
          throw new Error("candidate discovery failed")
        },
        nodeSelector: () => assert.fail("selector should not run"),
      },
      {
        nodeCandidateDiscoverer: () => ["/node-22"],
        nodeSelector: () => {
          throw new Error("selection failed")
        },
      },
    ]) {
      const selectionFailure = await main({
        argv: ["--root", root],
        env: {},
        cwd: root,
        homeDir: root,
        runtimeImporter: async () => assert.fail("runtime import should not run"),
        runtimeInspector: () => ({ ...baseInspection, reason: "unsupported_target" }),
        diagnosticServerStarter,
        ...failingSelection,
      })
      assert.equal(selectionFailure.reason, "node_selection_failed")
      assert.equal(selectionFailure.runtime.current_target, baseInspection.current_target)
      assert.deepEqual(selectionFailure.runtime.paths_checked, ["/pack"])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
