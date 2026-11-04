/**
 * Host de CI do Blog CMS para o SAC mantido no Data_libray.
 * Sem comandos externos derivados de contratos e sem deploy.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBuild, sealBuild, auditPipeline } from '../_sac/packages/angular-pipeline/src/index.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspace = path.join(root, 'apps/web');
const dist = 'dist/blog-web/browser';
const reportPath = path.join(root, 'reports/sac-static.json');
const sourceSha = process.env.GITHUB_SHA ?? '0'.repeat(40);
const safeSources = ['package.json', 'package-lock.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json'];

async function sourceTree(directory) {
  const found = [];
  const entries = await readdir(path.join(workspace, directory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceTree(relative));
    else if (entry.isFile()) found.push(relative);
    else throw new Error('A origem possui link ou arquivo especial não permitido.');
  }
  return found;
}

async function saveReport(report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}

async function main() {
  const core = JSON.parse(await readFile(path.join(workspace, 'node_modules/@angular/core/package.json'), 'utf8'));
  const profile = {
    schema_version: 1,
    profile_id: 'blog-cms-angular',
    angular_version: core.version,
    capabilities: ['angular', 'workspace', 'static-dist'],
    mode: 'angular-only',
    mount: '/',
    bundle_hints: {
      index: 'index.html',
      angular_host: 'blog-root',
      angular_entrypoints: ['main.js'],
      assets: ['styles.css'],
      legacy_react_entrypoints: [],
    },
    rules: ['SAC-PRE001', 'SAC-P001'].map(rule_id => ({
      rule_id, version: '1.0.0', required: true, enforcement: 'blocking',
    })),
  };
  const resources = {
    workspace, dist,
    sourceFiles: [...safeSources, ...await sourceTree('src')],
  };
  const key = randomBytes(32);
  const args = { profile, resources, sourceSha, key };
  const prepared = await prepareBuild(args);
  if (!prepared.session) {
    await saveReport(prepared.report);
    throw new Error('SAC bloqueou o pré-build; consulte o relatório.');
  }
  await rm(path.join(workspace, 'dist'), { recursive: true, force: true });
  const compiled = spawnSync(process.execPath, [
    'node_modules/@angular/cli/bin/ng.js',
    'build', '--configuration', 'production',
  ], {
    cwd: workspace, shell: false, timeout: 120_000,
    stdio: 'inherit', env: { ...process.env, NG_CLI_ANALYTICS: 'false' },
  });
  const receipt = await sealBuild({
    ...args, session: prepared.session,
    buildStatus: compiled.status === 0 ? 'pass' : 'fail',
  });
  const report = await auditPipeline({ ...args, receipt });
  await saveReport(report);
  if (!report.static_pipeline_pass) {
    throw new Error('SAC bloqueou o build/postflight; consulte o relatório.');
  }
  process.stdout.write('SAC: pré-build, build oficial e pós-build aprovados. Deploy NÃO autorizado.\n');
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Falha inesperada na auditoria SAC.');
  process.exitCode = 1;
});

