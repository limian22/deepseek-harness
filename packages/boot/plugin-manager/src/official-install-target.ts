/** Select Official bundle packages from the running installation without importing provider code. */
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bundlePatchPaths, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'

interface WorkspaceManifest extends ProfileManifest {
  main?: string
}

/** One workspace package the source checkout holds, parsed from its own manifest. */
interface WorkspacePackage {
  /** Absolute path of the package manifest the target was read from. */
  readonly file: string
  readonly manifest: WorkspaceManifest
}

/** What the installation anchor establishes about where Official bundles come from. */
type InstallationSource =
  /** A packed installation: every Official bundle installs from the registry at the running version. */
  | { readonly kind: 'registry' }
  /** A source CLI whose checkout is not a complete workspace, so no target can be offered. */
  | { readonly kind: 'incomplete'; readonly anchor: string }
  /** A complete source checkout and the workspace packages its manifests declare. */
  | { readonly kind: 'workspace'; readonly root: string; readonly anchor: string; readonly packages: readonly WorkspacePackage[] }

/** One Official bundle's installation target: a package-manager spec and the version it installs. */
export interface OfficialBundleInstallTarget {
  /** A registry spec, or the `link:` spec of the workspace package a source checkout holds. */
  readonly spec: string
  /** The DSH version the target installs; a source checkout links its own workspace version. */
  readonly version: string
}

function manifestAt(file: string): WorkspaceManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceManifest
}

/**
 * Establish where this installation's Official bundles come from.
 * A source checkout is scanned once here; its failures name no package, so the caller can attribute them to the name it
 * is resolving.
 * @param installAnchor Running application's DSH package.json, possibly reached through a symlink.
 * @returns The packed installation, an incomplete checkout, or a complete checkout with its workspace packages.
 * @throws when the anchor is unreadable or a workspace manifest cannot be read or parsed.
 */
function installationSource(installAnchor: string): InstallationSource {
  const anchor = realpathSync(installAnchor)
  const installation = manifestAt(anchor)
  const source = installation.name === '@deepseek-ai/dsh'
    && Object.values(installation.dependencies ?? {}).some(value => value.startsWith('workspace:'))
  if (!source) return { kind: 'registry' }
  const root = resolve(dirname(anchor), '../..')
  const incomplete: InstallationSource = { kind: 'incomplete', anchor }
  if (anchor !== join(root, 'apps', 'cli', 'package.json')
    || !existsSync(join(root, 'package.json'))
    || manifestAt(join(root, 'package.json')).name !== '@deepseek-ai/dsh-root') {
    return incomplete
  }
  const packages = globSync('packages/*/*/package.json', { cwd: root })
    .map(file => ({ file: join(root, file), manifest: manifestAt(join(root, file)) }))
  return { kind: 'workspace', root, anchor, packages }
}

/**
 * Validate one workspace package and offer its link target.
 * @param source The complete source checkout the package belongs to.
 * @param name Official catalog package name.
 * @param version Running DSH version used by its release family.
 * @returns An ordinary package-manager spec and its package version.
 * @throws when the checkout holds no single package with that name, or it is not a built public bundle at this version.
 */
function workspaceTarget(
  source: Extract<InstallationSource, { kind: 'workspace' }>, name: string, version: string,
): OfficialBundleInstallTarget {
  const matches = source.packages.filter(entry => entry.manifest.name === name)
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) {
    throw new Error(`Official bundle ${name}: expected one workspace package in ${source.root}, found ${matches.length}; restore the checkout and run pnpm install`)
  }
  const { file, manifest } = selected
  const directory = realpathSync(dirname(file))
  if (manifest.version !== version || manifest.private === true || manifest.dsh?.bundle === undefined) {
    throw new Error(`Official bundle ${name}: ${file} must declare a public bundle at DSH version ${version}`)
  }
  const main = typeof manifest.main === 'string' ? resolve(directory, manifest.main) : undefined
  if (main === undefined || !existsSync(main) || !statSync(main).isFile()) {
    throw new Error(`Official bundle ${name}: built runtime is missing in ${directory}; run pnpm install and pnpm run build in ${source.root}`)
  }
  for (const patch of bundlePatchPaths(directory, manifest.dsh.bundle)) {
    if (!existsSync(patch) || !statSync(patch).isFile()) {
      throw new Error(`Official bundle ${name}: bundle patch ${patch} is missing; restore the checkout`)
    }
  }
  return { spec: `link:${directory}`, version }
}

/**
 * Resolve the installation targets of several Official bundles from one installation reading.
 * The returned resolver establishes the source checkout lazily, on the first name it resolves, and answers later names
 * from that reading: one workspace scan serves every offered name, so each name's validation stays separate while the
 * workspace is read once. A resolver is scoped to one caller's reading — a later call reads the installation again — and
 * a source checkout whose establishment failed or proved incomplete is established again for the next name, so every
 * error names the package that was being resolved.
 * @param installAnchor Running application's DSH package.json, possibly reached through a symlink.
 * @param version Running DSH version used by its release family.
 * @returns A resolver from an Official catalog package name to its installation target.
 *   A packed installation resolves every name to its registry spec; a source checkout throws for each name that is
 *   absent, duplicated, unbuilt, or not a public bundle at this version instead of falling back to the registry.
 */
export function officialBundleInstallTargets(
  installAnchor: string, version: string,
): (name: string) => OfficialBundleInstallTarget {
  let source: InstallationSource | undefined
  return (name) => {
    const established = source ?? installationSource(installAnchor)
    if (established.kind !== 'incomplete') source = established
    if (established.kind === 'registry') return { spec: `${name}@${version}`, version }
    if (established.kind === 'incomplete') {
      throw new Error(`Official bundle ${name}: source DSH installation ${established.anchor} requires its complete workspace checkout`)
    }
    return workspaceTarget(established, name, version)
  }
}
