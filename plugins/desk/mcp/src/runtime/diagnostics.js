const reasonDetails = {
  unsupported_target: {
    summary: "Desk does not ship an offline runtime dependency pack for the current platform, architecture, and Node ABI.",
    remediation: [
      {
        action: "use_shipped_node",
        message: "Start Desk with a local Node runtime listed in the shipped runtime support matrix.",
      },
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin if a runtime pack for this machine should be present.",
      },
    ],
  },
  missing_pack: {
    summary: "Desk's offline runtime dependency pack is missing for the current Node runtime.",
    remediation: [
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin to restore the committed runtime dependency pack.",
      },
      {
        action: "rebuild_pack",
        message: "Maintainers can run `npm --prefix plugins/desk/mcp run runtime:deps-pack:build` and commit the generated pack.",
      },
    ],
  },
  corrupt_pack: {
    summary: "Desk found an offline runtime dependency pack, but its checksum, manifest, or archive is invalid.",
    remediation: [
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin to replace the corrupt runtime dependency pack.",
      },
      {
        action: "rebuild_pack",
        message: "Maintainers can rebuild and verify the runtime pack before republishing it.",
      },
    ],
  },
  runtime_restore_failed: {
    summary: "Desk validated its offline runtime pack but could not restore a usable runtime cache.",
    remediation: [
      {
        action: "repair_cache",
        message: "Check that the reported runtime cache path is writable, then restart Desk.",
      },
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin if runtime restoration continues to fail.",
      },
    ],
  },
  runtime_inspection_failed: {
    summary: "Desk could not inspect its committed offline runtime metadata safely.",
    remediation: [
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin to restore readable runtime support metadata.",
      },
    ],
  },
  node_selection_failed: {
    summary: "Desk could not complete bounded discovery of a compatible local Node runtime.",
    remediation: [
      {
        action: "use_shipped_node",
        message: "Start Desk directly with a Node runtime listed in the shipped runtime support matrix.",
      },
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin if local Node discovery continues to fail.",
      },
    ],
  },
  no_compatible_node: {
    summary: "Desk could not find a local Node runtime matching a shipped offline dependency pack.",
    remediation: [
      {
        action: "use_shipped_node",
        message: "Start Desk with a local Node runtime whose module ABI appears in the shipped runtime support matrix.",
      },
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin if the committed runtime support matrix or pack is missing.",
      },
    ],
  },
  guarded_reexec_failure: {
    summary: "Desk's one-time compatible-Node handoff did not produce a healthy runtime.",
    remediation: [
      {
        action: "use_shipped_node",
        message: "Start Desk directly with a Node runtime listed in the shipped runtime support matrix.",
      },
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin if the compatible runtime pack is incomplete or stale.",
      },
    ],
  },
  maintenance_unavailable: {
    summary: "Desk could not bind the shared maintenance coordinator required for safe index access.",
    remediation: [
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin to restore a complete runtime, then restart the MCP server.",
      },
    ],
  },
}

export function createRuntimeDiagnostic({
  reason,
  failureKind,
  currentTarget,
  shippedTargets = [],
  pathsChecked = [],
  runtimeCachePath = null,
  supportMatrixPath = null,
} = {}) {
  const details = reasonDetails[reason] ?? {
    summary: "Desk could not prepare its local runtime.",
    remediation: [
      {
        action: "refresh_plugin",
        message: "Refresh the Desk plugin and restart the MCP server.",
      },
    ],
  }
  const diagnostic = {
    status: "degraded",
    mode: "diagnostic",
    reason,
    summary: details.summary,
    runtime: {
      current_target: currentTarget,
      shipped_targets: shippedTargets,
      paths_checked: pathsChecked,
      runtime_cache_path: runtimeCachePath,
      support_matrix_path: supportMatrixPath,
    },
    remediation: details.remediation.map((item) => ({ ...item })),
  }
  if (failureKind !== undefined) {
    diagnostic.failure_kind = failureKind
  }
  return diagnostic
}
