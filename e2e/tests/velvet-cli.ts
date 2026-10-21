import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from './fixtures'

const here = dirname(fileURLToPath(import.meta.url))
let built: string | undefined

/** Builds the real velvet CLI once per worker, from this checkout. */
export function velvetBinary(): string {
  if (!built) {
    const out = join(mkdtempSync(join(tmpdir(), 'velvet-bin-')), 'velvet')
    execFileSync('go', ['build', '-o', out, './cmd/velvet'], { cwd: resolve(here, '..', '..', 'cli'), stdio: 'inherit' })
    built = out
  }
  return built
}

/**
 * A repository linked to one project, as `velvet init` leaves it: a
 * velvet.yaml and a project-scoped key. The key is minted straight into the
 * database (hash only) so specs that are about something else skip the
 * browser approval, which cli.spec.ts covers end to end.
 */
export function linkedRepo(baseURL: string, email: string, slug: string, project: string) {
  const token = `velvet_${randomBytes(32).toString('hex')}`
  sql(`
    INSERT INTO api_token (user_id, name, token_hash, workspace_id, project_id)
    SELECT u.id, 'velvet CLI ${randomBytes(3).toString('hex')}', '${createHash('sha256').update(token).digest('hex')}', w.id, p.id
    FROM app_user u, workspace w JOIN project p ON p.workspace_id = w.id
    WHERE u.email = '${email}' AND w.slug = '${slug}' AND p.key = '${project}';
  `)
  const dir = mkdtempSync(join(tmpdir(), 'velvet-repo-'))
  mkdirSync(join(dir, '.config'), { recursive: true })
  writeFileSync(join(dir, 'velvet.yaml'), `server: ${baseURL}\norganisation: ${slug}\nproject: ${project}\n`)
  const env = { ...process.env, VELVET_TOKEN: token, VELVET_NO_KEYCHAIN: '1', HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }
  const run = (args: string[]) => {
    const r = spawnSync(velvetBinary(), args, { cwd: dir, env, encoding: 'utf8' })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  return { dir, token, run }
}
