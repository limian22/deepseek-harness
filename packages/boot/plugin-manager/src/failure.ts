/** Localizable rejections shared by profile management operations. */
import type { PluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import type { IncompatiblePlugin, ManagementError } from './types.ts'

/** Expected management rejection; presentation belongs to the caller's locale. */
export class ManagementFailure extends Error {
  /** Code rendered by the caller's locale dictionary. */
  readonly code: ManagementError['code']
  /** The packages an `incompatible-version` rejection names. */
  readonly incompatible: IncompatiblePlugin[] | undefined
  /** The observed facts a `duplicate-entry` rejection names: the ids and the layers that already insert them. */
  readonly diagnostic: string | undefined
  /**
   * @param code Localizable management rejection.
   * @param incompatible Packages the running DSH version rejects, for `incompatible-version`.
   * @param diagnostic Observed facts for `duplicate-entry`, which the locale cannot enumerate.
   */
  constructor(code: ManagementError['code'], incompatible?: IncompatiblePlugin[], diagnostic?: string) {
    super(code)
    this.code = code
    this.incompatible = incompatible
    this.diagnostic = diagnostic
  }
}

/**
 * Drop the exemption status from an unexempted compatibility result.
 * @param issue Result whose exemption is not active.
 * @returns The package, runtime, and unmet DSH requirements.
 */
export function incompatiblePlugin(issue: PluginCompatibility): IncompatiblePlugin {
  return { name: issue.name, version: issue.version, runtimeVersion: issue.runtimeVersion, requirements: issue.requirements }
}
