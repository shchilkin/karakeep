#!/usr/bin/env python3
"""Pull only green main releases. Installed controller never executes PR workflows."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request

REPO = 'shchilkin/karakeep'
ROOT = Path('/srv/appdata/karakeep')
STATE = ROOT / 'autodeploy'
DATA = Path('/srv/storage/karakeep-data')
WEB = 'karakeep-web-1'
SIDECAR = 'karakeep-social-enricher-social-enricher-1'
COMPOSE = ['docker', 'compose', '-f', str(ROOT / 'compose.yaml')]
PROTECTED = ('deploy/', 'docker/', 'packages/db/drizzle/', 'packages/db/migrate.ts')


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, **kwargs).strip()


def api(path):
    req = urllib.request.Request('https://api.github.com/repos/' + REPO + '/' + path,
                                 headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'karakeep-homeserver-deploy'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def green_run(runs, sha):
    # Latest attempt wins; a failed rerun cannot inherit an earlier green attempt.
    candidates = [r for r in runs if r.get('head_sha') == sha and r.get('event') == 'push'
                  and r.get('head_branch') == 'main' and r.get('path') == '.github/workflows/ci.yml'
                  and (r.get('head_repository') or {}).get('full_name') == REPO]
    if not candidates:
        return None
    latest = max(candidates, key=lambda r: (r['id'], r.get('run_attempt', 1)))
    return latest if latest.get('status') == 'completed' and latest.get('conclusion') == 'success' else None


def head():
    sha = api('commits/main')['sha']
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise RuntimeError('invalid_revision')
    return sha


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def emit(status, **values):
    result = dict(status=status, utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **values)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    (STATE / 'status.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def git(*args):
    return run(['git', '--git-dir', str(STATE / 'repo.git'), *args])


def fetch_main(sha):
    if not (STATE / 'repo.git').exists():
        run(['git', 'init', '--bare', str(STATE / 'repo.git')])
    git('fetch', '--no-tags', 'https://github.com/' + REPO + '.git', 'refs/heads/main')
    if git('rev-parse', 'FETCH_HEAD') != sha:
        raise RuntimeError('superseded')


def protected_digest(sha):
    return hashlib.sha256(git('ls-tree', '-r', sha, '--', *PROTECTED).encode()).hexdigest()


def idle():
    with sqlite3.connect(f'file:{DATA}/db.db?mode=ro', uri=True) as db:
        busy = db.execute("select count(*) from bookmarks where json_extract(mediaAi,'$.status') in ('pending','checking_local','processing','processing_local','local_checked') or json_extract(mediaAi,'$.localRecheckRequested')=1").fetchone()[0]
    with sqlite3.connect(f'file:{ROOT}/social-enricher/state/jobs.sqlite3?mode=ro', uri=True) as db:
        busy += db.execute("select count(*) from jobs where status in ('pending','processing')").fetchone()[0]
    return busy == 0


def db_snapshot(destination):
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ['db.db', 'queue.db']:
        with sqlite3.connect(f'file:{DATA/name}?mode=ro', uri=True) as source, sqlite3.connect(destination/name) as target:
            source.backup(target)
            if target.execute('pragma integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('backup_integrity')


def api_key():
    for line in (ROOT/'social-enricher/.env').read_text().splitlines():
        if line.startswith('KARAKEEP_API_KEY='):
            return line.split('=', 1)[1].strip().strip('\"\'')
    raise RuntimeError('api_key_missing')


PROBE = r'''
let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',async()=>{
try {
 const {key}=JSON.parse(data);const base='http://127.0.0.1:3000';
 const health=await fetch(base+'/api/health');if(!health.ok)throw Error();
 const path='/api/v1/bookmarks?limit=1';
 const anon=await fetch(base+path);if(anon.status!==401)throw Error();
 const response=await fetch(base+path,{headers:{Authorization:'Bearer '+key}});if(!response.ok)throw Error();
 const body=await response.json();if(!Array.isArray(body.bookmarks))throw Error();
 console.log(JSON.stringify({health:true,authenticated:true,anonymousDenied:true}));
}catch{process.exitCode=1;}
});
'''


def health(name, seconds=180):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            result = json.loads(run(['docker', 'exec', '-i', name, 'node', '-e', PROBE],
                                    input=json.dumps({'key': api_key()}), timeout=20))
            if result.get('health'):
                return result
        except (subprocess.SubprocessError, ValueError):
            pass
        time.sleep(3)
    raise RuntimeError('health_failed')


def canary(image, folder):
    target = folder/'canary'
    db_snapshot(target)
    env = target/'canary.env'
    env.write_text('DATA_DIR=/data\nNEXTAUTH_URL=http://127.0.0.1:3000\nNEXTAUTH_SECRET='+secrets.token_urlsafe(48)+
                   '\nDISABLE_SIGNUPS=true\nDISABLE_NEW_RELEASE_CHECK=true\nWORKERS_ENABLED_WORKERS=deployment-canary-none\nMEDIA_AI_ENABLED=false\n')
    name = 'karakeep-release-canary'
    run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--env-file', str(env),
         '-v', str(target)+':/data', '-v', str(DATA/'assets')+':/data/assets:ro', image])
    try:
        proof = health(name)
        with sqlite3.connect(f'file:{target}/db.db?mode=ro', uri=True) as new, sqlite3.connect(f'file:{DATA}/db.db?mode=ro', uri=True) as old:
            if new.execute('pragma integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('canary_integrity')
            if list(new.execute('select * from __drizzle_migrations')) != list(old.execute('select * from __drizzle_migrations')):
                raise RuntimeError('migration_requires_manual_rollout')
        return proof
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def build(sha, folder):
    source = folder/'source'
    source.mkdir(parents=True, exist_ok=True)
    archive = subprocess.Popen(['git', '--git-dir', str(STATE/'repo.git'), 'archive', sha], stdout=subprocess.PIPE)
    extracted = subprocess.run(['tar', '-x', '-C', str(source)], stdin=archive.stdout)
    archive.stdout.close()
    if extracted.returncode or archive.wait():
        raise RuntimeError('source_export')
    image = 'karakeep-fork:'+sha
    with (folder/'build.log').open('w') as log:
        command = ['docker', 'build', '--target', 'aio', '--build-arg', 'SERVER_VERSION='+sha[:8],
                   '--label', 'org.opencontainers.image.revision='+sha, '-t', image, '-f', 'docker/Dockerfile', '.']
        result = subprocess.run(command, cwd=source, stdout=log, stderr=subprocess.STDOUT, timeout=3600)
    if result.returncode:
        raise RuntimeError('build_failed')
    return image


def replacement(compose, image):
    # Scope the mutation to the web service, not any sidecar or GPU service.
    lines = compose.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if line.rstrip() == '  web:']
    if len(starts) != 1:
        raise RuntimeError('unsupported_compose')
    start = starts[0]
    end = next((i for i in range(start+1, len(lines)) if re.match(r'^\S|^  \S', lines[i])), len(lines))
    images = [i for i in range(start+1, end) if lines[i].startswith('    image: ')]
    if len(images) != 1:
        raise RuntimeError('unsupported_compose')
    lines[images[0]] = '    image: '+image+'\n'
    return ''.join(lines)


def resume_services(stopped):
    failures=[]
    for name in reversed(stopped):
        try:
            if not inspect(name)['State']['Running']:run(['docker','start',name])
        except Exception:
            failures.append(name)
    if failures:
        raise RuntimeError('restore_failed:'+','.join(failures))


def cutover(sha, image, folder):
    if head() != sha:
        raise RuntimeError('superseded')
    query=urllib.parse.urlencode({'branch':'main','event':'push','head_sha':sha,'per_page':20})
    if not green_run(api('actions/workflows/ci.yml/runs?'+query)['workflow_runs'],sha):
        raise RuntimeError('ci_not_green')
    if not idle():
        return False
    old = inspect(WEB)
    original = (ROOT/'compose.yaml').read_text()
    updated = replacement(original, image)
    backup = folder/'backup';backup.mkdir(mode=0o700, exist_ok=True)
    # Exact old image ID, not a mutable tag, is used for automatic rollback.
    (backup/'previous-image.txt').write_text(old['Image']+'\n')
    for name in ['compose.yaml', '.env', '.env.smtp', '.env.media-ai', '.env.media-local']:
        shutil.copy2(ROOT/name, backup/name)
        (backup/name).chmod(0o600)
    stopped=[];switched=False
    try:
        for name in [SIDECAR, WEB]:
            if inspect(name)['State']['Running']:
                run(['docker','stop','--time','60',name]);stopped.append(name)
        if not idle():
            return False
        db_snapshot(backup/'data')
        switched=True
        (ROOT/'compose.yaml').write_text(updated)
        run(COMPOSE+['config','--quiet'])
        run(COMPOSE+['up','-d','--no-deps','--no-build','--pull','never','web'])
        proof=health(WEB)
        live=inspect(WEB)
        expected=json.loads(run(['docker','image','inspect',image]))[0]
        if live['Image'] != expected['Id']:
            raise RuntimeError('image_mismatch')
        with sqlite3.connect(f'file:{DATA}/db.db?mode=ro',uri=True) as db:
            if db.execute('pragma integrity_check').fetchone()[0] != 'ok':raise RuntimeError('live_integrity')
        receipt=dict(sha=sha,imageId=live['Image'],previousImageId=old['Image'],backup=str(backup),checks=proof)
        (STATE/'deployed.json').write_text(json.dumps(receipt,indent=2)+'\n')
        (folder/'deployed.json').write_text(json.dumps(receipt,indent=2)+'\n')
        return True
    except BaseException:
        if switched:
            (ROOT/'compose.yaml').write_text(replacement(original,old['Image']))
            run(COMPOSE+['up','-d','--no-deps','--no-build','--pull','never','web'])
            health(WEB)
            # Keep the original human-readable Compose once the exact old ID is running.
            (ROOT/'compose.yaml').write_text(original)
        raise
    finally:
        resume_services(stopped)


def poll():
    sha=head()
    deployed=STATE/'deployed.json'
    if deployed.exists() and json.loads(deployed.read_text())['sha']==sha:
        return
    if (STATE/('failed-'+sha)).exists():
        return
    query=urllib.parse.urlencode({'branch':'main','event':'push','head_sha':sha,'per_page':20})
    checked=green_run(api('actions/workflows/ci.yml/runs?'+query)['workflow_runs'],sha)
    if not checked:
        emit('waiting_for_ci',sha=sha);return
    fetch_main(sha)
    if protected_digest(sha)!=(STATE/'approved-protected-tree').read_text().strip():
        emit('manual_rollout_required',sha=sha);return
    if not idle():
        emit('waiting_for_idle',sha=sha);return
    folder=STATE/'releases'/sha;folder.mkdir(parents=True,exist_ok=True)
    try:
        image=build(sha,folder)
        canary(image,folder)
        if cutover(sha,image,folder):emit('deployed',sha=sha,ci=checked['html_url'])
        else:emit('waiting_for_idle',sha=sha)
    except Exception as error:
        # No raw subprocess diagnostics in journal. Logs and backups stay private.
        code=str(error) if type(error) is RuntimeError else type(error).__name__
        if code not in ['superseded', 'ci_not_green']:(STATE/('failed-'+sha)).write_text(code+'\n')
        emit('failed',sha=sha,reason=code)
        raise SystemExit(1) from None


if __name__=='__main__':
    os.umask(0o077)
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (ROOT/'.fork-deploy.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:sys.exit(0)
        poll()
