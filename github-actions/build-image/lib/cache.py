#!/usr/bin/env python3
"""Local BuildKit generations with short POSIX locks and conservative reader leases."""
import fcntl
import json
import os
import re
import shutil
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


def segment(value):
    if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", value) or value in (".", ".."):
        raise ValueError("Invalid cache namespace or scope")
    return value


def contained(root, path):
    real = path.resolve()
    if root != real and root not in real.parents:
        raise ValueError("Cache path escapes its root")
    return real


@contextmanager
def locked(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.coord.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def atomic_json(path, value):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex)
    temp.write_text(json.dumps(value))
    os.replace(temp, path)


def current(root, scope):
    pointer = root / segment(scope) / 'current'
    if not pointer.exists():
        return None
    target = contained(root, pointer)
    if target.parent != (root / scope).resolve() or not target.name.startswith('complete-') or not (target / 'index.json').is_file():
        raise ValueError('Cache has no complete index')
    json.loads((target / 'index.json').read_text())
    return target


def prepare(config):
    platforms = config.get('platforms', '').strip()
    if platforms and not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?', platforms):
        raise ValueError('Docker load requires exactly one platform')
    limits = {}
    for key, default, minimum in [('max-generation-bytes', 0, 0), ('max-total-bytes', 0, 0), ('keep-generations', 2, 1)]:
        value = str(config.get(key, default))
        if not re.fullmatch(r'[0-9]+', value) or int(value) < minimum:
            raise ValueError('Invalid cache limit: ' + key)
        limits[key] = int(value)
    raw = config.get('cache-root', '')
    if not raw:
        return {'enabled': False, 'imports': '', 'export': '', 'token': ''}
    if any(char in raw for char in '\n\r,'):
        raise ValueError('Cache root contains a BuildKit delimiter')
    base = Path(raw).resolve()
    namespace = config.get('cache-namespace', '').split('/')
    if not namespace or any(not part for part in namespace):
        raise ValueError('Explicit cache namespace is required')
    root = contained(base, base.joinpath(*(segment(part) for part in namespace)))
    root.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    readers, imports = [], []
    write_scope = config.get('write-scope', '')
    with locked(root):
        for scope in dict.fromkeys(config.get('read-scopes', '').split()):
            target = current(root, scope)
            if target:
                leases = root / scope / '.leases'
                leases.mkdir(exist_ok=True)
                lease = leases / (token + '.json')
                atomic_json(lease, {'generation': target.name, 'token': token,
                                    'execution': config.get('execution', ''), 'created': time.time()})
                readers.append(str(lease))
                imports.append('type=local,src=' + str(target))
        export = ''
        if write_scope:
            scope_dir = contained(root, root / segment(write_scope))
            scope_dir.mkdir(exist_ok=True)
            pending = scope_dir / ('pending-' + token)
            pending.mkdir()
            atomic_json(pending / '.owner.json', {'token': token})
            export = str(pending)
    return {'enabled': True, 'root': str(root), 'token': token, 'readers': readers,
            'imports': '\n'.join(imports), 'export': export, 'scope': write_scope,
            'max_bytes': limits['max-generation-bytes'],
            'max_total': limits['max-total-bytes'], 'base': str(base),
            'keep': limits['keep-generations']}


def size(path):
    return sum(item.stat().st_size for item in path.rglob('*') if item.is_file() and not item.is_symlink())


def gc_scope(root, scope, keep):
    directory = contained(root, root / segment(scope))
    selected = current(root, scope)
    protected = {selected.name} if selected else set()
    for lease in (directory / '.leases').glob('*.json'):
        try:
            value = json.loads(lease.read_text())
            protected.add(segment(value['generation']))
        except (ValueError, KeyError, OSError):
            return  # Unknown liveness is never permission to delete a generation.
    generations = sorted(directory.glob('complete-*'), key=lambda p: p.stat().st_mtime, reverse=True)
    protected.update(path.name for path in generations[:keep])
    for path in generations:
        if path.name not in protected:
            shutil.rmtree(contained(root, path))


def commit(state):
    if not state.get('export'):
        return {'published': False, 'reason': 'read-only'}
    root = Path(state['root']).resolve()
    pending = contained(root, Path(state['export']))
    if pending.name != 'pending-' + state['token'] or json.loads((pending / '.owner.json').read_text())['token'] != state['token']:
        raise ValueError('Export ownership mismatch')
    index = pending / 'index.json'
    if not index.is_file():
        raise ValueError('Incomplete cache export')
    json.loads(index.read_text())
    with locked(root):
        if (state['max_bytes'] and size(pending) > state['max_bytes']) or (state['max_total'] and size(Path(state['base'])) > state['max_total']):
            shutil.rmtree(pending)
            return {'published': False, 'reason': 'capacity-limit'}
        (pending / '.owner.json').unlink()
        complete = pending.with_name('complete-' + state['token'])
        os.replace(pending, complete)
        temporary = complete.parent / ('current.' + state['token'])
        temporary.symlink_to(complete.name)
        os.replace(temporary, complete.parent / 'current')
        gc_scope(root, state['scope'], state['keep'])
    return {'published': True, 'generation': complete.name}


def release(state):
    if not state.get('enabled'):
        return {'released': True}
    root = Path(state['root']).resolve()
    with locked(root):
        for raw in state.get('readers', []):
            lease = contained(root, Path(raw))
            if lease.name != state['token'] + '.json':
                raise ValueError('Reader ownership mismatch')
            if lease.exists():
                if json.loads(lease.read_text())['token'] != state['token']:
                    raise ValueError('Reader lease mismatch')
                lease.unlink()
        if state.get('export'):
            pending = contained(root, Path(state['export']))
            if pending.exists():
                if pending.name != 'pending-' + state['token']:
                    raise ValueError('Pending path mismatch')
                shutil.rmtree(pending)
        for scope in set(Path(raw).parent.parent.name for raw in state.get('readers', [])) | ({state['scope']} if state.get('scope') else set()):
            gc_scope(root, scope, state['keep'])
    return {'released': True}


if __name__ == '__main__':
    try:
        value = json.load(sys.stdin)
        result = {'prepare': prepare, 'commit': commit, 'release': release}[sys.argv[1]](value)
        print(json.dumps(result))
    except Exception as error:
        print('Cache operation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
